import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fetchStartups, fetchBoardJobs } from './sources/topstartups.mjs';
import { detectAts, fetchAtsJobs } from './sources/ats.mjs';
import { searchLinkedIn, enrichLinkedIn } from './sources/linkedin.mjs';
import { searchBuiltIn } from './sources/builtin.mjs';
import { makeMatcher, dedupeKey } from './match.mjs';
import { openStore } from './store.mjs';
import { renderPage } from './render.mjs';
import { pmap, sleep } from './lib/http.mjs';

const ROOT = path.join(os.homedir(), 'job-scout');
const args = new Set(process.argv.slice(2));
const noBrowser = args.has('--no-browser');
const headed = args.has('--headed');
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7)?.split(',');
const renderOnly = args.has('--render');
const use = (name) => !renderOnly && (!only || only.includes(name));

const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/profile.json'), 'utf8'));
const runId = new Date().toISOString();
const startedAt = Date.now();
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const logFile = fs.createWriteStream(path.join(ROOT, 'logs', `run-${runId.slice(0, 10)}.log`), { flags: 'a' });
const notes = [];
const log = (m) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; console.log(line); logFile.write(line + '\n'); if (/blocked|sign in|HTTP [45]|error|challenge/i.test(m)) notes.push(m); };

const matcher = makeMatcher(profile);
const store = openStore(path.join(ROOT, 'data'));
const sourceCounts = {};
let candidates = [];

// 1. Startups behind her link, and their ATS boards.
let startups = [];
if (use('startups') || use('ats')) {
  try {
    startups = await fetchStartups(profile.topstartups.startupsQuery, { log });
    fs.writeFileSync(path.join(ROOT, 'data/startups.json'), JSON.stringify(startups, null, 1));
  } catch (e) { log(`startups list error: ${e.message}`); try { startups = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/startups.json'), 'utf8')); } catch {} }
  sourceCounts.startups = startups.length;
}
const startupByName = new Map(startups.map((s) => [s.name.toLowerCase(), s]));

if (use('ats')) {
  const boards = startups.map((s) => ({ s, ats: detectAts(s.viewJobs) })).filter((x) => x.ats);
  log(`ats: ${boards.length} boards to poll`);
  let ok = 0, miss = 0, jobs = 0;
  const results = await pmap(boards, 6, async ({ s, ats }) => { const r = await fetchAtsJobs(ats, s); await sleep(120); return r; });
  for (const r of results) { if (!r || r.error) { miss++; continue; } if (r.status === 200) ok++; else miss++; jobs += r.jobs.length; candidates.push(...r.jobs); }
  log(`ats: ${ok} boards answered, ${miss} missing/moved, ${jobs} postings`);
  sourceCounts.ats = jobs;
}

if (use('topstartups')) {
  let n = 0;
  for (const role of profile.topstartups.jobRoles) {
    try { const js = await fetchBoardJobs(role, { log }); n += js.length; for (const j of js) { j.companyMeta = startupByName.get(j.company.toLowerCase()); candidates.push(j); } } catch (e) { log(`topstartups board ${role}: ${e.message}`); }
  }
  sourceCounts.topstartups = n;
}

if (use('linkedin')) {
  try { const js = await searchLinkedIn(profile.searchQueries, { log, area: profile.location.searchArea || {} }); sourceCounts.linkedin = js.length; candidates.push(...js); } catch (e) { log(`linkedin error: ${e.message}`); }
}
if (use('builtin')) {
  try { const js = await searchBuiltIn({ log }); sourceCounts.builtin = js.length; candidates.push(...js); } catch (e) { log(`builtin error: ${e.message}`); }
}

if (!noBrowser && (use('indeed') || use('glassdoor') || use('wellfound') || use('yc'))) {
  let ctx;
  try {
    const { launchBrowser } = await import('./browser/launch.mjs');
    ctx = await launchBrowser({ headed });
    if (use('indeed')) { const { searchIndeed } = await import('./browser/indeed.mjs'); const js = await searchIndeed(ctx, profile.searchQueries, { log, area: profile.location.searchArea || {} }); sourceCounts.indeed = js.length; candidates.push(...js); }
    if (use('glassdoor')) { const { searchGlassdoor } = await import('./browser/glassdoor.mjs'); const js = await searchGlassdoor(ctx, profile.searchQueries, { log, area: profile.location.searchArea || {} }); sourceCounts.glassdoor = js.length; candidates.push(...js); }
    if (use('wellfound')) { const { searchWellfound } = await import('./browser/wellfound.mjs'); const js = await searchWellfound(ctx, { log }); sourceCounts.wellfound = js.length; candidates.push(...js); }
    if (use('yc')) { const { searchYC } = await import('./browser/yc.mjs'); const js = await searchYC(ctx, { log }); sourceCounts.yc = js.length; candidates.push(...js); }
  } catch (e) { log(`browser error: ${e.message}`); }
  finally { await ctx?.close().catch(() => {}); }
}

// Date-less sources (YC): date a posting by first sighting. The first run for a source is a baseline and shows nothing from it.
const seenFile = path.join(ROOT, 'data/seen.json');
let seen = {}; try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch {}
for (const src of [...new Set(candidates.filter((j) => j.dateless).map((j) => j.source))]) {
  const baseline = !seen[src];
  seen[src] = seen[src] || {};
  for (const j of candidates.filter((j) => j.source === src)) {
    if (!seen[src][j.id]) seen[src][j.id] = runId;
    j.postedAt = baseline ? null : seen[src][j.id];
    if (baseline) j.title = ''; // excluded from matching this run
  }
  if (baseline) log(`${src}: baseline run, ${Object.keys(seen[src]).length} postings recorded; new ones show from the next run`);
}
fs.writeFileSync(seenFile, JSON.stringify(seen));

// 2. Cheap title pass, then enrich LinkedIn candidates (applicant counts) and look up applicant counts for others.
const titled = candidates.filter((j) => j.title && matcher.titleMatch(j.title).ok);
log(`candidates: ${candidates.length} total, ${titled.length} with a matching title`);
const rejections = {};
const pre = [];
for (const j of titled) {
  // age + location before paying for enrichment
  const v = matcher.evaluate({ ...j, applicants: null });
  if (!v.pass) { rejections[v.stage] = (rejections[v.stage] || 0) + 1; continue; }
  pre.push(j);
}
log(`pre-filter: ${pre.length} pass title/age/location (${Object.entries(rejections).map(([k, v]) => `${k}:${v}`).join(', ')} dropped)`);

const liJobs = pre.filter((j) => j.source === 'linkedin');
await pmap(liJobs, 1, async (j) => { await enrichLinkedIn(j, { log }); await sleep(1500); });

// Applicant lookup on LinkedIn for non-LinkedIn postings: search by title + company, past week.
const others = pre.filter((j) => j.source !== 'linkedin' && j.applicants == null);
await pmap(others, 1, async (j) => {
  try {
    const { fetchText } = await import('./lib/http.mjs');
    const cheerio = await import('cheerio');
    const p = new URLSearchParams({ keywords: `${j.title} ${j.company}`, f_TPR: 'r604800', location: 'United States' });
    const res = await fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p}`, { retries: 1 });
    if (res.status !== 200) { if (res.status === 429) await sleep(30000); return; }
    const $ = cheerio.load(res.text);
    const want = (j.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let id = null;
    $('[data-entity-urn]').each((_, el) => { if (id) return; const c = $(el).find('.base-search-card__subtitle').text().toLowerCase().replace(/[^a-z0-9]/g, ''); const t = $(el).find('.base-search-card__title').text().toLowerCase(); if (want && c.includes(want.slice(0, 12)) && t.includes(j.title.toLowerCase().split(/[,(-]/)[0].trim().slice(0, 20))) id = ($(el).attr('data-entity-urn') || '').split(':').pop(); });
    if (!id) return;
    const tmp = { id };
    await enrichLinkedIn(tmp, { log });
    if (tmp.applicants != null) { j.applicants = tmp.applicants; j.applicantsText = tmp.applicantsText; j.linkedinUrl = `https://www.linkedin.com/jobs/view/${id}`; }
    await sleep(1500);
  } catch (e) { log(`applicant lookup ${j.company}/${j.title}: ${e.message}`); }
});

// 3. Final verdicts, dedupe, store.
const byKey = new Map();
for (const j of pre) {
  const v = matcher.evaluate(j);
  if (!v.pass) { rejections[v.stage] = (rejections[v.stage] || 0) + 1; continue; }
  if (!j.companyMeta && j.company) j.companyMeta = startupByName.get(j.company.toLowerCase());
  const key = dedupeKey(j);
  const prev = byKey.get(key);
  if (!prev) { byKey.set(key, { ...j, verdict: v, sources: [j.source] }); continue; }
  // merge: prefer the ATS/company record, keep best applicant info, union sources
  const primary = /^ats:|topstartups/.test(prev.source) ? prev : /^ats:|topstartups/.test(j.source) ? { ...j, verdict: v, sources: prev.sources } : prev;
  const other = primary === prev ? j : prev;
  if (primary.applicants == null && other.applicants != null) { primary.applicants = other.applicants; primary.applicantsText = other.applicantsText; }
  if (!primary.description && other.description) primary.description = other.description;
  if (!primary.sources.includes(other.source)) primary.sources.push(other.source);
  primary.verdict = matcher.evaluate(primary);
  byKey.set(key, primary);
}
let newCount = 0;
for (const [key, j] of byKey) { const { isNew } = store.upsert(key, j, j.verdict, runId); if (isNew) newCount++; }
// The page shows every stored match still inside the window, so partial runs add to it rather than replace it.
const windowMs = profile.maxAgeHours * 3600e3;
const matches = Object.values(store.jobs).filter((j) => j.verdict?.pass && (j.postedAt ? Date.now() - Date.parse(j.postedAt) <= windowMs : Date.now() - Date.parse(j.lastSeenAt) <= windowMs));
matches.sort((a, b) => (b.verdict?.score || 0) - (a.verdict?.score || 0));

const run = renderOnly ? null : { id: runId, startedAt: runId, durationMs: Date.now() - startedAt, candidates: candidates.length, matches: matches.length, newMatches: newCount, sources: sourceCounts, rejections, notes: notes.slice(0, 12) };
if (run) { store.addRun(run); store.save(); }
renderPage({ outDir: path.join(ROOT, 'out'), matches, runs: store.runs, profile });
log(`done: ${matches.length} matches (${newCount} new) in ${Math.round((Date.now() - startedAt) / 1000)}s → ${path.join(ROOT, 'out/index.html')}`);
if (run && newCount > 0 && !args.has('--quiet')) {
  execFile('osascript', ['-e', `display notification "${newCount} new matching role${newCount > 1 ? 's' : ''} · ${matches.length} open" with title "Job Scout"`], () => {});
}
logFile.end();
