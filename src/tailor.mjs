// Tailoring engine: runs Claude Code non-interactively on the user's subscription.
// Two calls per posting: "read" (title, track, what it weighs, skills, keywords, summary) and "bullets" (items matched against the bank).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function readBank(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'data/bank.json'), 'utf8')); } catch { return { items: [], summary: '', facts: [], avoid: [] }; }
}

export function callClaude(prompt, { model = 'sonnet', schema = null, system = 'You are a resume writing assistant. Reply only with the JSON requested, nothing else.', signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--model', model, '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', system];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; onProgress && onProgress(out.length); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      let parsed; try { parsed = JSON.parse(out); } catch { return reject(new Error(`claude returned non-JSON (exit ${code}): ${(err || out).slice(0, 300)}`)); }
      if (parsed.is_error || parsed.subtype === 'error') return reject(new Error(parsed.result || parsed.error || 'claude error'));
      let data = parsed.structured_output;
      if (data == null) {
        const text = String(parsed.result || '');
        const m = text.match(/\{[\s\S]*\}/); try { data = JSON.parse(m ? m[0] : text); } catch { return reject(new Error('answer was not JSON')); }
      }
      resolve({ data, cost: parsed.total_cost_usd, ms: parsed.duration_api_ms });
    });
    if (signal) signal.addEventListener('abort', () => child.kill('SIGTERM'));
    child.stdin.end(prompt);
  });
}

const STYLE = 'Style for everything you write: one sentence, about 35 words at most, leading with the result, the decision or the scale. Plain words. No em dashes. No self-praising adjectives. No "not X, but Y" constructions. Lead with what was built or decided, never with what was stopped.';

function bankText(bank) { return bank.items.map((b) => `${b.id} | ${b.group} | ${b.text}`).join('\n'); }
function facts(bank) { return (bank.facts || []).length ? 'FACTS ABOUT HER (true; use when they help, never contradict)\n' + bank.facts.join('\n') : ''; }
function avoid(bank) { return (bank.avoid || []).length ? 'AVOID\n' + bank.avoid.join('\n') : ''; }

export function readPrompt(jd, bank, trackNames) {
  return [
    'You are reading a job posting for a product leader who will tailor her resume to it. Return what the posting weighs, the skills and keywords it asks for, its title, company and the kind of role it is, and two summaries.',
    'RULES\n' +
    '1. weighs: up to 6 phrases of at most 4 words each, naming what this posting weighs most, most important first.\n' +
    '2. skills: read only the parts of the posting that state what the candidate needs (requirements, qualifications, must-haves, what you bring). List up to 20 skills they call for, most emphasized first, each worded as the standard skill name a recruiter or applicant tracking system would search for, 1 to 4 words, in the form it takes on a resume skills line, such as Product Roadmapping, Stakeholder Management, A/B Testing or SQL. Keep tool, platform and method names exactly as the posting spells them. Skip personality traits.\n' +
    '3. keywords: up to 30 keywords an applicant tracking system or recruiter would search a resume for, taken from the posting: tools, methods, domains, metrics and named practices. Each is the short searchable term, 1 to 3 words. Never a clause. Skip the job title itself and generic words like team, experience or stakeholders. For each give up to 3 other spellings or close equivalents, and must=true if it comes from required or must-have parts.\n' +
    '4. summary.posting: the resume summary a strong candidate for this exact role would open with, faithful to the posting. Two or three sentences, about 60 words, resume style without "I", in the posting\'s vocabulary, with a short bracketed slot such as [X years] or [industry] where a personal specific belongs. ' + STYLE + '\n' +
    '5. summary.matched: if REAL SUMMARY is not empty, her summary rebuilt so it works for this posting. A real rewrite, not a trim: (a) open with the part of her real background closest to what this posting weighs most; (b) organize the rest around the posting\'s top two or three priorities, in the posting\'s vocabulary wherever it is true of her; (c) bring in specifics from BANK or FACTS that prove the fit; (d) drop what this posting does not care about; (e) keep her voice and roughly her length, 90 words at most. Every fact must come from REAL SUMMARY, BANK or FACTS. Never claim experience in the posting\'s own domain when nothing shows it; bridge honestly from the nearest thing she has done. No bracketed slots. If REAL SUMMARY is empty, return an empty string.\n' +
    '6. title: the role title as the posting states it. company: the company name. Empty strings if not stated.\n' +
    '7. track: the kind of role this is, meaning the kind of product work she would send one version of her resume to, such as Growth PM, Platform PM, AI PM, Consumer PM, Commerce PM, B2B SaaS PM or Product Leadership, in 2 to 3 words. Never name it after the industry. If one of EXISTING TRACKS is the same kind of work, return that track\'s name exactly.',
    'JOB POSTING\n' + jd.slice(0, 24000),
    'EXISTING TRACKS\n' + (trackNames.length ? trackNames.join('\n') : 'none'),
    'REAL SUMMARY\n' + (bank.summary || '').slice(0, 3000),
    facts(bank), avoid(bank),
    'BANK (id | accomplishment | text), for summary.matched only\n' + bankText(bank),
  ].filter(Boolean).join('\n\n');
}

export const READ_SCHEMA = { type: 'object', properties: {
  title: { type: 'string' }, company: { type: 'string' }, track: { type: 'string' },
  weighs: { type: 'array', items: { type: 'string' } }, skills: { type: 'array', items: { type: 'string' } },
  keywords: { type: 'array', items: { type: 'object', properties: { term: { type: 'string' }, also: { type: 'array', items: { type: 'string' } }, must: { type: 'boolean' } }, required: ['term', 'also', 'must'] } },
  summary: { type: 'object', properties: { posting: { type: 'string' }, matched: { type: 'string' } }, required: ['posting', 'matched'] },
}, required: ['title', 'company', 'track', 'weighs', 'skills', 'keywords', 'summary'] };

export function bulletsPrompt(jd, bank, n, weighs) {
  return [
    'You are drafting first-pass resume bullets from a job posting. The person using this will rewrite each one to fit her real experience, or skip it. For each thing the posting weighs you give her two starting points: a bullet written purely from the posting, and the closest bullet from her own bank reworded to carry the posting\'s keywords.',
    'RULES\n' +
    `1. Work through the posting's responsibilities and qualifications. Make one item for each thing the posting weighs, most important first. Write ${n} items.\n` +
    '2. For each item write text: the bullet a strong candidate for this exact role would have, in the posting\'s own vocabulary. Start from the posting, not from her history. A concrete accomplishment with an action, a scope and a result. Never restate a requirement, never a skill claim or a trait.\n' +
    '3. In text, do not invent specifics only she could know. No company names, product names, numbers, dates or tools the posting does not name. Where a number, scale or name belongs, put a short bracketed slot such as [metric], [scale], [team size] or [product].\n' +
    '4. ' + STYLE + '\n' +
    '5. Then, for each item, read all of BANK and look for a bullet about the same work the item asks for: the same kind of activity, problem or outcome. A shared theme such as leadership, strategy, stakeholders or AI is not enough. Test: if a recruiter read the posting line and then the BANK bullet, would they say she has done this specific thing? If yes, fit is strong. Partial only when the activity is the same and what differs is domain, audience or scale; then say in why, under 15 words, what it covers and what it does not. Partial is not a fallback: a different activity that merely shares a word is a no, and then bank is null. Expect several items to have no match, often a third or more. Use each BANK accomplishment (middle column) for at most one item, the one it fits best.\n' +
    '6. For the picked BANK bullet write matched: the same bullet reworded so it carries the posting\'s own keywords and phrases. Keep every fact, number, name and scope exactly as the BANK bullet has it, add none. Swap in a posting keyword only where it truthfully names what the bullet already describes. No bracketed slots. Returning the BANK text unchanged, or with only punctuation changed, is a failure: matched must differ from the BANK bullet by at least one posting keyword or phrase swapped in, and if no posting keyword can truthfully go in, return matched as an empty string instead. In keywords list only posting keywords that literally appear in matched.\n' +
    '7. theme: a 2 to 4 word label for the part of the posting the item serves. Reuse labels so there are 3 to 6 themes in total. answers: the posting line or requirement it answers, shortened.\n' +
    '8. relevant: up to 5 other BANK bullets relevant to the posting but not attached to any item, at most one per accomplishment, each with why, a matched version and keywords under rule 6. Same test as rule 5; empty list if nothing passes.',
    'WHAT THE POSTING WEIGHS\n' + (weighs || []).join('; '),
    'JOB POSTING\n' + jd.slice(0, 24000),
    facts(bank), avoid(bank),
    'BANK (id | accomplishment | text)\n' + bankText(bank),
  ].filter(Boolean).join('\n\n');
}

export const BULLETS_SCHEMA = { type: 'object', properties: {
  bullets: { type: 'array', items: { type: 'object', properties: {
    theme: { type: 'string' }, answers: { type: 'string' }, text: { type: 'string' },
    bank: { type: ['object', 'null'], properties: { id: { type: 'string' }, fit: { type: 'string' }, why: { type: 'string' }, matched: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } }, required: ['id', 'fit', 'why', 'matched', 'keywords'] },
  }, required: ['theme', 'answers', 'text', 'bank'] } },
  relevant: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' }, matched: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } }, required: ['id', 'why', 'matched', 'keywords'] } },
}, required: ['bullets', 'relevant'] };

export function takePrompt(bullet, weighs) {
  return [
    'Write one different first-pass resume bullet for the posting requirement below. It should read like a bullet a strong candidate for this role would have. She will rewrite it to fit her real experience.',
    STYLE + ' Do not invent company names, product names or numbers: use short bracketed slots such as [metric] or [scale]. Take a clearly different angle and opening from CURRENT.',
    'POSTING THEMES\n' + (weighs || []).join('; ') + '\nPART OF THE POSTING\n' + bullet.theme + '\nREQUIREMENT THIS BULLET ANSWERS\n' + bullet.answers,
    'CURRENT\n' + bullet.text,
  ].join('\n\n');
}
export const TAKE_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };

const sameText = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Normalize model output into the result shape the page uses (same shape as the original Bullet Tailor, so picks carry the same fields).
export function tidyRead(d) {
  const out = { title: String(d.title || '').slice(0, 120), company: String(d.company || '').slice(0, 80), track: String(d.track || '').slice(0, 40), weighs: [], skills: [], keywords: [], summary: null };
  (d.weighs || []).slice(0, 6).forEach((w) => w && out.weighs.push(String(w)));
  (d.skills || []).slice(0, 24).forEach((k) => k && out.skills.push(String(k).trim()));
  (d.keywords || []).slice(0, 40).forEach((k) => k && k.term && out.keywords.push({ term: String(k.term), also: (k.also || []).slice(0, 4).map(String), must: !!k.must }));
  if (d.summary && d.summary.posting) out.summary = { posting: String(d.summary.posting), matched: String(d.summary.matched || ''), mine: '', pick: null };
  return out;
}
export function tidyBullets(d, bank) {
  const byId = {}; bank.items.forEach((b) => { byId[b.id] = b; });
  const bullets = [], relevant = [], seen = {};
  (d.bullets || []).forEach((b) => {
    if (!b || !b.text) return;
    let bk = null;
    if (b.bank && byId[String(b.bank.id || '')]) {
      bk = { id: String(b.bank.id), fit: String(b.bank.fit || '').toLowerCase() === 'partial' ? 'partial' : 'strong', why: String(b.bank.why || ''), matched: String(b.bank.matched || ''), keywords: (b.bank.keywords || []).slice(0, 8).map(String) };
      if (!bk.matched.trim() || sameText(bk.matched, byId[bk.id].text)) { bk.matched = ''; bk.keywords = []; }
      else { const t = ' ' + bk.matched.toLowerCase() + ' '; bk.keywords = bk.keywords.filter((k) => t.includes(String(k).toLowerCase())); }
      seen[bk.id] = 1;
    }
    bullets.push({ theme: String(b.theme || 'Other'), answers: String(b.answers || ''), text: String(b.text), bank: bk, mine: '', pick: null, skip: false });
  });
  (d.relevant || []).slice(0, 5).forEach((x) => {
    const id = x && String(x.id || ''); if (!byId[id] || seen[id]) return; seen[id] = 1;
    const r = { id, why: String(x.why || ''), matched: String(x.matched || ''), keywords: (x.keywords || []).slice(0, 8).map(String), mine: '', pick: null };
    if (!r.matched.trim() || sameText(r.matched, byId[id].text)) { r.matched = ''; r.keywords = []; }
    relevant.push(r);
  });
  return { bullets, relevant };
}
