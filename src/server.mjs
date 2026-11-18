// Local server: serves the pipeline page and a small JSON API over the scout's data.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import * as cheerio from 'cheerio';
import { fetchText } from './lib/http.mjs';
import { detectAts, fetchAtsJobs } from './sources/ats.mjs';
import { enrichLinkedIn } from './sources/linkedin.mjs';
import { readBank, callClaude, readPrompt, READ_SCHEMA, bulletsPrompt, BULLETS_SCHEMA, takePrompt, TAKE_SCHEMA, tidyRead, tidyBullets } from './tailor.mjs';

const ROOT = path.join(os.homedir(), 'job-scout');
const PORT = Number(process.env.PORT || 4747);
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(path.join(DATA, 'tailor'), { recursive: true });
const profile = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config/profile.json'), 'utf8'));

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
const J = { jobs: () => readJson(path.join(DATA, 'jobs.json'), {}), stages: () => readJson(path.join(DATA, 'stages.json'), {}), tracks: () => readJson(path.join(DATA, 'tracks.json'), { v: 1, tracks: [] }), runs: () => readJson(path.join(DATA, 'runs.json'), []) };
const tailorFile = (key) => path.join(DATA, 'tailor', key.replace(/::/g, '__').replace(/[^A-Za-z0-9_\-.]/g, '_') + '.json');
const readTailor = (key) => readJson(tailorFile(key), null);

const STAGES = ['new', 'shortlist', 'tailoring', 'ready', 'applied', 'passed'];
const WINDOW_H = () => profile().maxAgeHours || 24;

function listJobs() {
  const jobs = J.jobs(), stages = J.stages(), now = Date.now(), win = WINDOW_H() * 3600e3;
  const out = [];
  for (const j of Object.values(jobs)) {
    const st = stages[j.key];
    const stage = st ? st.stage : 'new';
    const fresh = j.verdict?.pass && (j.postedAt ? now - Date.parse(j.postedAt) <= win : j.lastSeenAt && now - Date.parse(j.lastSeenAt) <= win);
    if (stage === 'new' && !fresh) continue;
    if (stage === 'passed' && st && now - st.at > 7 * 86400e3) continue;
    const t = readTailor(j.key);
    out.push({ key: j.key, title: j.title, company: j.company, location: j.location, url: j.url, source: j.source, sources: j.sources || [j.source], postedAt: j.postedAt, firstSeenAt: j.firstSeenAt,
      applicants: j.applicants ?? null, applicantsText: j.applicantsText || '', verdict: j.verdict, funding: j.companyMeta?.funding?.slice(-1)[0] || '', size: j.companyMeta?.size || '', tags: j.companyMeta?.tags || [],
      compensation: j.compensation || '', stage, stageAt: st?.at || null, hasDescription: !!(j.description && j.description.length > 200), tailored: !!(t && t.result && t.result.bullets), trackId: j.trackId || t?.trackId || null,
      finals: t?.result ? countFinals(t.result) : 0 });
  }
  out.sort((a, b) => (b.verdict?.score || 0) - (a.verdict?.score || 0));
  return out;
}
function countFinals(r) { let n = 0; (r.bullets || []).forEach((b) => { if (b.pick && !b.skip) n++; }); (r.relevant || []).forEach((b) => { if (b.pick) n++; }); return n; }

async function ensureDescription(job) {
  if (job.description && job.description.length > 200) return job;
  try {
    const ats = detectAts(job.url);
    if (ats && job.url) {
      const r = await fetchAtsJobs(ats, { name: job.company });
      const hit = r.jobs.find((x) => x.url && job.url.startsWith(x.url.split('?')[0])) || r.jobs.find((x) => x.title === job.title);
      if (hit?.description) { job.description = hit.description; return job; }
    }
    if (job.source === 'linkedin' && job.id) { const t = { id: job.id }; await enrichLinkedIn(t); if (t.description) { job.description = t.description; return job; } }
    if (job.url) {
      const res = await fetchText(job.url);
      if (res.status === 200) {
        const $ = cheerio.load(res.text); $('script,style,nav,header,footer,noscript').remove();
        const main = $('main, article, [class*="description"], [class*="posting"], [id*="content"]').first();
        const text = (main.length ? main : $('body')).text().replace(/\s+/g, ' ').trim();
        if (text.length > 200) job.description = text.slice(0, 12000);
      }
    }
  } catch (e) { job.descriptionError = e.message; }
  return job;
}

// Tailoring jobs in flight: key -> {phase, startedAt, error}
const inflight = new Map();
async function runTailor(key, n) {
  const jobs = J.jobs(); const job = jobs[key]; if (!job) throw new Error('no such job');
  await ensureDescription(job); jobs[key] = job; writeJson(path.join(DATA, 'jobs.json'), jobs);
  if (!job.description || job.description.length < 200) throw new Error('No posting text to work from. Paste it in.');
  const bank = readBank(ROOT), tracks = J.tracks().tracks.map((t) => t.name), model = profile().tailorModel || 'sonnet';
  const state = { phase: 'reading', startedAt: Date.now() }; inflight.set(key, state);
  const prev = readTailor(key) || { key };
  try {
    const r1 = await callClaude(readPrompt(job.description, bank, tracks), { model, schema: READ_SCHEMA });
    const read = tidyRead(r1.data);
    const result = { ...read, bullets: [], relevant: [], picked: {}, forder: [], generatedAt: Date.now() };
    if (read.summary) read.summary.real = bank.summary || '';
    writeJson(tailorFile(key), { ...prev, key, result, n, phase: 'bullets', cost: r1.cost });
    state.phase = 'bullets';
    const r2 = await callClaude(bulletsPrompt(job.description, bank, n, read.weighs), { model, schema: BULLETS_SCHEMA });
    const bl = tidyBullets(r2.data, bank);
    result.bullets = bl.bullets; result.relevant = bl.relevant;
    writeJson(tailorFile(key), { ...prev, key, result, n, phase: 'done', cost: (r1.cost || 0) + (r2.cost || 0), generatedAt: Date.now() });
    const st = J.stages(); if (!st[key] || ['new', 'shortlist'].includes(st[key].stage)) { st[key] = { stage: 'tailoring', at: Date.now() }; writeJson(path.join(DATA, 'stages.json'), st); }
    inflight.delete(key);
  } catch (e) { state.phase = 'error'; state.error = e.message; setTimeout(() => inflight.delete(key), 60000); throw e; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
function send(res, code, body, type = 'application/json') { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); }
function body(req) { return new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => { try { r(s ? JSON.parse(s) : {}); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname; const seg = p.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (seg[0] !== 'api') {
      const file = path.join(ROOT, 'app', p === '/' ? 'index.html' : p);
      if (!file.startsWith(path.join(ROOT, 'app')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
    const key = seg[2];
    if (req.method === 'GET' && seg[1] === 'state') {
      const runs = J.runs().slice(0, 6), bank = readBank(ROOT), pr = profile();
      return send(res, 200, { jobs: listJobs(), tracks: J.tracks().tracks, runs, bank: { items: bank.items.length, hasSummary: !!bank.summary }, profile: { maxAgeHours: pr.maxAgeHours, maxApplicants: pr.maxApplicants, home: pr.home, tailorModel: pr.tailorModel || 'sonnet' }, inflight: [...inflight.entries()].map(([k, v]) => ({ key: k, ...v })) });
    }
    if (seg[1] === 'jobs' && key && seg[3] === undefined && req.method === 'GET') {
      const job = J.jobs()[key]; if (!job) return send(res, 404, { error: 'no such job' });
      return send(res, 200, { job, tailor: readTailor(key), stage: J.stages()[key] || { stage: 'new' }, bank: readBank(ROOT).items, inflight: inflight.get(key) || null });
    }
    if (seg[1] === 'jobs' && key && seg[3] === 'stage' && req.method === 'POST') {
      const { stage } = await body(req); if (!STAGES.includes(stage)) return send(res, 400, { error: 'bad stage' });
      const st = J.stages(); if (stage === 'new') delete st[key]; else st[key] = { stage, at: Date.now() }; writeJson(path.join(DATA, 'stages.json'), st);
      return send(res, 200, { ok: true });
    }
    if (seg[1] === 'jobs' && key && seg[3] === 'fetch' && req.method === 'POST') {
      const jobs = J.jobs(); const job = jobs[key]; if (!job) return send(res, 404, { error: 'no such job' });
      await ensureDescription(job); jobs[key] = job; writeJson(path.join(DATA, 'jobs.json'), jobs);
      return send(res, 200, { description: job.description || '', error: job.descriptionError || null });
    }
    if (seg[1] === 'jobs' && key && seg[3] === 'description' && req.method === 'PUT') {
      const { description } = await body(req); const jobs = J.jobs(); const job = jobs[key]; if (!job) return send(res, 404, { error: 'no such job' });
      job.description = String(description || ''); writeJson(path.join(DATA, 'jobs.json'), jobs); return send(res, 200, { ok: true });
    }
    if (seg[1] === 'jobs' && key && seg[3] === 'tailor' && req.method === 'POST') {
      if (inflight.has(key) && inflight.get(key).phase !== 'error') return send(res, 409, { error: 'already running' });
      const { n = 12 } = await body(req);
      runTailor(key, Number(n) || 12).catch(() => {});
      return send(res, 202, { started: true });
    }
    if (seg[1] === 'jobs' && key && seg[3] === 'tailor' && req.method === 'PUT') {
      const { result, trackId } = await body(req); const t = readTailor(key) || { key };
      if (result) t.result = result; if (trackId !== undefined) t.trackId = trackId; t.savedAt = Date.now();
      writeJson(tailorFile(key), t); return send(res, 200, { ok: true });
    }
    if (seg[1] === 'jobs' && key && seg[3] === 'take' && req.method === 'POST') {
      const { index } = await body(req); const t = readTailor(key); const b = t?.result?.bullets?.[index]; if (!b) return send(res, 404, { error: 'no such bullet' });
      const r = await callClaude(takePrompt(b, t.result.weighs), { model: profile().tailorModel || 'sonnet', schema: TAKE_SCHEMA });
      b.text = String(r.data.text || b.text).trim().replace(/^[-•]\s*/, ''); writeJson(tailorFile(key), t);
      return send(res, 200, { text: b.text });
    }
    if (seg[1] === 'jobs' && seg[2] === undefined && req.method === 'POST') { // paste a posting
      const { title, company, url, text } = await body(req);
      if (!text || text.length < 200) return send(res, 400, { error: 'paste the full posting' });
      const jobs = J.jobs(); const id = 'manual::' + Date.now().toString(36);
      jobs[id] = { key: id, source: 'manual', sources: ['manual'], title: title || 'Untitled posting', company: company || '', url: url || '', location: '', description: text, postedAt: null, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), verdict: { pass: true, mode: 'unknown', flags: ['pasted posting'], score: 0 } };
      writeJson(path.join(DATA, 'jobs.json'), jobs);
      const st = J.stages(); st[id] = { stage: 'shortlist', at: Date.now() }; writeJson(path.join(DATA, 'stages.json'), st);
      return send(res, 200, { key: id });
    }
    if (seg[1] === 'bank' && req.method === 'GET') return send(res, 200, readBank(ROOT));
    if (seg[1] === 'bank' && req.method === 'PUT') { const b = await body(req); b.updated = Date.now(); writeJson(path.join(DATA, 'bank.json'), b); return send(res, 200, { ok: true }); }
    if (seg[1] === 'tracks' && req.method === 'GET') return send(res, 200, J.tracks());
    if (seg[1] === 'tracks' && req.method === 'PUT') { const t = await body(req); writeJson(path.join(DATA, 'tracks.json'), t); return send(res, 200, { ok: true }); }
    if (seg[1] === 'run' && req.method === 'POST') {
      const child = spawn(process.execPath, [path.join(ROOT, 'src/run.mjs'), '--quiet'], { cwd: ROOT, detached: true, stdio: 'ignore' }); child.unref();
      return send(res, 202, { started: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 500, { error: e.message }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`job-scout at http://127.0.0.1:${PORT}`));
