import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (iso) => { if (!iso) return '—'; const h = (Date.now() - Date.parse(iso)) / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };
const fmt = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function renderPage({ outDir, matches, runs, profile }) {
  fs.mkdirSync(outDir, { recursive: true });
  const run = runs[0];
  const sourcesOf = (m) => (m.sources || [m.source]).map((s) => s.replace('ats:', '')).join(', ');
  const rows = matches.map((m) => {
    const v = m.verdict || {};
    const isNew = m.firstSeenRun === run?.id;
    const funding = m.companyMeta?.funding?.slice(-1)[0] || '';
    const flags = (v.flags || []).map((f) => `<span class="flag">${esc(f)}</span>`).join('');
    return `<li class="job ${isNew ? 'new' : ''}" data-mode="${esc(v.mode)}" data-src="${esc(sourcesOf(m))}" data-new="${isNew}">
  <div class="main">
    <a class="title" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>
    <span class="company">${esc(m.company)}</span>${funding ? `<span class="funding">${esc(funding)}</span>` : ''}
  </div>
  <div class="meta">
    <span class="mode mode-${esc(v.mode)}">${esc(v.mode === 'unknown' ? 'workplace unstated' : v.mode)}</span>
    <span>${esc(m.location || 'location not stated')}</span>
    <span title="${esc(m.postedAt || '')}">posted ${ago(m.postedAt)} ago</span>
    <span>${m.applicants != null ? esc(m.applicantsText || m.applicants) + ' applicants' : 'applicants unknown'}</span>
    <span class="src">${esc(sourcesOf(m))}</span>
    ${isNew ? '<span class="badge-new">new this run</span>' : ''}
    ${flags}
  </div>
</li>`;
  }).join('\n');

  const runLog = runs.slice(0, 12).map((r) => `<li><b>${esc(fmt(r.startedAt))}</b> · ${r.matches} matches (${r.newMatches} new) · ${r.candidates} candidates seen · ${Math.round(r.durationMs / 1000)}s
    <div class="runsrc">${Object.entries(r.sources || {}).map(([k, v]) => `<span>${esc(k)}: ${esc(v)}</span>`).join('')}</div>
    ${(r.notes || []).length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</li>`).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Scout</title>
<style>
:root{--bg:#ffffff;--fg:#111;--mute:#666;--line:#e5e5e5;--accent:#1f4fd8;--new:#0a7d3b;--chip:#f2f2f2}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--mute:#9a9a9a;--line:#2a2a2a;--accent:#7aa2ff;--new:#5ad38a;--chip:#1f1f1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 20px}
.controls{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:0 0 16px;color:var(--mute);font-size:14px}
.controls label{display:inline-flex;gap:6px;align-items:center;cursor:pointer}
ul.jobs{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
li.job{padding:14px 0;border-bottom:1px solid var(--line)}li.job.new{border-left:3px solid var(--new);padding-left:12px;margin-left:-15px}
.title{font-weight:600;color:var(--accent);text-decoration:none;font-size:16px}.title:hover{text-decoration:underline}
.company{margin-left:10px;font-weight:500}.funding{margin-left:8px;color:var(--mute);font-size:13px}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;color:var(--mute);font-size:13px}
.mode{padding:1px 8px;border-radius:10px;background:var(--chip);color:var(--fg)}.mode-remote{outline:1px solid var(--new)}.mode-hybrid{outline:1px solid var(--accent)}
.badge-new{color:var(--new);font-weight:600}.flag{color:#b36b00}.src{font-variant:small-caps;letter-spacing:.02em}
details{margin-top:36px;color:var(--mute);font-size:13px}details ul{padding-left:18px}.runsrc span{margin-right:12px}.notes{color:#b36b00}
.empty{padding:32px 0;color:var(--mute)}
</style></head><body><main>
<h1>Job Scout</h1>
<p class="sub">${run ? `Last run ${esc(fmt(run.startedAt))} · ${matches.length} open matches · ${run.newMatches} new` : 'No runs yet'} · remote, or hybrid near ${esc(profile.home?.region || profile.home?.city || 'home')} · posted under ${profile.maxAgeHours} h · under ${profile.maxApplicants} applicants where known</p>
<div class="controls">
  <label><input type="checkbox" id="onlyNew"> new this run only</label>
  <label><input type="checkbox" id="onlyRemote"> remote only</label>
  <label>sort <select id="sort"><option value="score">best match</option><option value="posted">newest</option><option value="applicants">fewest applicants</option></select></label>
  <span id="count"></span>
</div>
${matches.length ? `<ul class="jobs" id="jobs">${rows}</ul>` : '<p class="empty">Nothing passed the filters in the last run.</p>'}
<details><summary>Run log</summary><ul>${runLog}</ul></details>
</main>
<script>
const data=${JSON.stringify(matches.map((m) => ({ s: m.verdict?.score || 0, p: m.postedAt ? Date.parse(m.postedAt) : 0, a: m.applicants ?? 9999 })))};
const ul=document.getElementById('jobs');if(ul){const items=[...ul.children];items.forEach((li,i)=>li.dataset.i=i);
function apply(){const on=document.getElementById('onlyNew').checked,or=document.getElementById('onlyRemote').checked,s=document.getElementById('sort').value;
let vis=0;items.forEach(li=>{const ok=(!on||li.dataset.new==='true')&&(!or||li.dataset.mode==='remote');li.style.display=ok?'':'none';if(ok)vis++;});
items.sort((x,y)=>{const a=data[x.dataset.i],b=data[y.dataset.i];return s==='posted'?b.p-a.p:s==='applicants'?a.a-b.a:b.s-a.s}).forEach(li=>ul.appendChild(li));
document.getElementById('count').textContent=vis+' shown';}
['onlyNew','onlyRemote','sort'].forEach(id=>document.getElementById(id).addEventListener('change',apply));apply();}
</script></body></html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
}
