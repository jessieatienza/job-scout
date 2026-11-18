"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, fn) => { const b = el("button", cls, text); b.type = "button"; b.onclick = fn; return b; };
const has = (v) => !!(v && String(v).trim());
const api = async (method, url, body) => { const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const enc = (k) => encodeURIComponent(k);
const ago = (iso) => { if (!iso) return "—"; const h = (Date.now() - Date.parse(iso)) / 3600e3; return h < 1 ? Math.max(1, Math.round(h * 60)) + "m" : h < 48 ? Math.round(h) + "h" : Math.round(h / 24) + "d"; };
const fmt = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });

const STAGES = [["new", "New"], ["shortlist", "Shortlist"], ["tailoring", "Tailoring"], ["ready", "Ready"], ["applied", "Applied"], ["passed", "Passed"]];
const S = { state: null, stage: "new", key: null, detail: null, q: "", tview: "bullets", sel: 0, fold: {}, poll: null };

/* word diff: mark words in b that are not in a */
function diffMark(a, b) {
  const tok = (s) => String(s || "").match(/[A-Za-z0-9$%+.'’-]+|[^\sA-Za-z0-9]+|\s+/g) || [];
  const A = tok(a), B = tok(b), norm = (t) => t.toLowerCase().replace(/[^a-z0-9$%+]/g, "");
  const aw = A.map(norm), bw = B.map(norm);
  const n = aw.length, m = bw.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = aw[i] && aw[i] === bw[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const keep = new Set(); let i = 0, j = 0;
  while (i < n && j < m) { if (aw[i] && aw[i] === bw[j]) { keep.add(j); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  const frag = document.createDocumentFragment(); let run = null;
  B.forEach((t, k) => {
    const changed = bw[k] && !keep.has(k);
    if (changed) { if (!run) { run = el("mark"); frag.append(run); } run.append(t); }
    else { if (run && /^\s+$/.test(t)) { run.append(t); return; } run = null; frag.append(t); }
  });
  return frag;
}
function kwMark(text, keywords) {
  const terms = []; (keywords || []).forEach((k) => { [k.term].concat(k.also || []).forEach((t) => { if (t && t.length > 2) terms.push(t); }); });
  if (!terms.length) return document.createTextNode(text);
  const re = new RegExp("(" + terms.sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  const frag = document.createDocumentFragment();
  String(text).split(re).forEach((p, i) => { if (i % 2) frag.append(el("mark", null, p)); else frag.append(p); });
  return frag;
}
function slotMark(text) {
  const frag = document.createDocumentFragment();
  String(text).split(/(\[[^\]]{1,40}\])/).forEach((p) => { if (/^\[.*\]$/.test(p)) frag.append(el("span", "slot", p)); else frag.append(p); });
  return frag;
}

/* state */
async function loadState() { S.state = await api("GET", "/api/state"); renderRail(); }
function stageJobs(st) { const q = S.q.toLowerCase(); return S.state.jobs.filter((j) => j.stage === st && (!q || (j.title + " " + j.company + " " + j.location).toLowerCase().includes(q))); }
function renderRail() {
  const st = S.state, run = st.runs[0];
  $("runline").textContent = run ? "run " + fmt(Date.parse(run.startedAt)).replace(/^\w+ /, "") + (st.inflight.length ? " · tailoring" : "") : "";
  const sb = $("stages"); sb.textContent = "";
  STAGES.forEach(([k, label]) => { const n = st.jobs.filter((j) => j.stage === k).length; const b = btn("stage", null, () => { S.stage = k; renderRail(); }); b.append(el("span", null, label), el("b", null, String(n))); if (k === S.stage) b.setAttribute("aria-current", "true"); sb.append(b); });
  const list = $("list"); list.textContent = "";
  const jobs = stageJobs(S.stage);
  if (!jobs.length) { list.append(el("p", "empty", S.stage === "new" ? "Nothing new inside the window." : "Nothing here.")); }
  jobs.forEach((j) => {
    const b = btn("job", null, () => openJob(j.key));
    const t = el("span", "t"); if (j.stage === "new" && j.firstSeenAt && Date.now() - Date.parse(j.firstSeenAt) < 9 * 3600e3) t.append(el("i", "dot")); t.append(j.title);
    const bits = [j.company, j.verdict?.mode === "unknown" ? (j.location || "location unstated") : j.verdict?.mode + (j.verdict?.mode === "hybrid" && j.location ? " " + j.location.split(",")[0] : ""), j.postedAt ? ago(j.postedAt) : null, j.applicants != null ? "<" + Math.max(j.applicants + 1, 1) + " appl." : null].filter(Boolean);
    b.append(t, el("span", "c", bits.join(" · ")));
    if (j.key === S.key) b.setAttribute("aria-current", "true");
    list.append(b);
  });
}

/* job detail */
async function openJob(key) {
  S.key = key; S.sel = 0; S.fold = {};
  S.detail = await api("GET", "/api/jobs/" + enc(key));
  const r = S.detail.tailor?.result;
  S.tview = r && r.bullets && r.bullets.length ? (countDone(r) ? "finals" : "summary") : "summary";
  renderRail(); renderWork();
  if (S.detail.inflight && S.detail.inflight.phase !== "error") pollTailor();
}
function pollTailor() {
  clearTimeout(S.poll);
  S.poll = setTimeout(async () => {
    if (!S.key) return;
    const d = await api("GET", "/api/jobs/" + enc(S.key));
    const was = S.detail?.inflight?.phase;
    S.detail = d;
    if (d.inflight && d.inflight.phase !== "error") { if (was !== d.inflight.phase) renderWork(); else renderProgress(); pollTailor(); }
    else { S.tview = "summary"; S.sel = 0; renderWork(); loadState(); }
  }, 2500);
}
const job = () => S.detail?.job, result = () => S.detail?.tailor?.result;
const bankById = () => { const m = {}; (S.detail?.bank || []).forEach((b) => { m[b.id] = b; }); return m; };

async function setStage(stage) { await api("POST", "/api/jobs/" + enc(S.key) + "/stage", { stage }); S.detail.stage = { stage, at: Date.now() }; await loadState(); renderWork(); }
async function startTailor() {
  try { await api("POST", "/api/jobs/" + enc(S.key) + "/tailor", { n: 12 }); S.detail.inflight = { phase: "reading", startedAt: Date.now() }; renderWork(); pollTailor(); loadState(); }
  catch (e) { alert(e.message); }
}
let saveT = null;
function save() { clearTimeout(saveT); const key = S.key, r = result(); if (!r) return; saveT = setTimeout(() => api("PUT", "/api/jobs/" + enc(key) + "/tailor", { result: r, trackId: S.detail.tailor.trackId ?? null }).catch(() => {}), 400); }

function renderWork() {
  const w = $("work"); w.textContent = "";
  const j = job();
  if (!j) { w.append(emptyWork()); return; }
  const inner = el("div", "inner"); w.append(inner);
  const head = el("header", "jobhead");
  const top = el("div"); top.append(el("h1", null, j.title));
  const sub = el("p", "sub"); const bits = [j.company, j.companyMeta?.funding?.slice(-1)[0], j.companyMeta?.size, j.compensation].filter(Boolean); sub.append(bits.join(" · "));
  if (j.url) { sub.append(" · "); const a = el("a", null, "open posting ↗"); a.href = j.url; a.target = "_blank"; a.rel = "noopener"; sub.append(a); }
  top.append(sub); head.append(top);
  const v = j.verdict || {}, chips = el("div", "chips");
  const modeTxt = v.mode === "unknown" ? "workplace unstated" : v.mode === "hybrid" ? "hybrid · " + (j.location || "") : v.mode === "remote" ? "remote" + (j.location ? " · " + j.location : "") : (j.location || "");
  chips.append(chipEl(modeTxt, v.mode === "remote" || v.mode === "hybrid" ? "ok" : "flag"));
  if (j.postedAt) chips.append(chipEl("posted " + ago(j.postedAt) + " ago"));
  chips.append(chipEl(j.applicants != null ? (j.applicantsText || j.applicants) + " applicants" : "applicants unknown", j.applicants != null && j.applicants < 25 ? "ok" : ""));
  chips.append(chipEl((j.sources || [j.source]).map((s) => s.replace("ats:", "")).join(" + ")));
  (v.flags || []).filter((f) => !/applicant count unknown|workplace not stated/.test(f)).forEach((f) => chips.append(chipEl(f, "flag")));
  head.append(chips, actionRow());
  inner.append(head);
  inner.append(postingSection());
  inner.append(tailorSection());
  inner.append(hintRow());
}
function chipEl(t, cls) { return el("span", "chip" + (cls ? " " + cls : ""), t); }
function emptyWork() {
  const d = el("div", "inner"); const run = S.state?.runs?.[0];
  d.append(el("h1", null, "Scout"));
  d.append(el("p", "note", run ? `Last run ${fmt(Date.parse(run.startedAt))}: ${run.matches} open, ${run.newMatches} new. Pick a job on the left.` : "No runs yet. Press Run now."));
  return d;
}
function actionRow() {
  const st = S.detail.stage?.stage || "new", row = el("div", "row"), r = result(), busy = S.detail.inflight && S.detail.inflight.phase !== "error";
  const tailorBtn = btn("pri", r && r.bullets?.length ? "Tailor again" : "Tailor", () => { if (r && r.bullets?.length && !confirm("Generate again? Your picks and rewrites for this posting are replaced.")) return; startTailor(); });
  if (busy) tailorBtn.disabled = true;
  const go = (s, label, cls) => btn(cls || "ghost", label, () => setStage(s));
  if (st === "new") row.append(tailorBtn, go("shortlist", "Shortlist"), go("passed", "Pass"));
  else if (st === "shortlist") row.append(tailorBtn, go("passed", "Pass"), go("new", "Back to new"));
  else if (st === "tailoring") row.append(go("ready", "Mark ready", "pri"), tailorBtn, go("passed", "Pass"));
  else if (st === "ready") row.append(go("applied", "Applied", "pri"), go("tailoring", "Back to tailoring"), go("passed", "Pass"));
  else if (st === "applied") row.append(go("ready", "Back to ready"));
  else if (st === "passed") row.append(go("new", "Restore"));
  return row;
}

/* posting */
function postingSection() {
  const j = job(), sec = el("section"); sec.append(el("h2", null, "Posting"));
  if (S.fold.editPosting) {
    const ta = el("textarea", "posting-edit"); ta.value = j.description || "";
    const row = el("div", "row"); row.append(btn("pri small", "Save", async () => { await api("PUT", "/api/jobs/" + enc(S.key) + "/description", { description: ta.value }); j.description = ta.value; S.fold.editPosting = false; renderWork(); }), btn("ghost small", "Cancel", () => { S.fold.editPosting = false; renderWork(); }));
    sec.append(ta, row); return sec;
  }
  if (!has(j.description) || j.description.length < 200) {
    const row = el("div", "row");
    row.append(btn("ghost small", "Fetch the posting", async (e) => { e.target.disabled = true; e.target.textContent = "Fetching"; const r = await api("POST", "/api/jobs/" + enc(S.key) + "/fetch"); j.description = r.description; if (!has(r.description)) { S.fold.editPosting = true; } renderWork(); }),
      btn("ghost small", "Paste it", () => { S.fold.editPosting = true; renderWork(); }));
    sec.append(el("p", "note", j.descriptionError ? "Couldn't fetch it: " + j.descriptionError : "No posting text yet."), row);
    return sec;
  }
  const p = el("div", "posting" + (S.fold.posting ? "" : " clip"), j.description);
  sec.append(p);
  const row = el("div", "fold");
  row.append(btn("link", S.fold.posting ? "Show less" : "Read all", () => { S.fold.posting = !S.fold.posting; renderWork(); }), btn("link", "Edit text", () => { S.fold.editPosting = true; renderWork(); }));
  sec.append(row);
  return sec;
}

/* tailor */
function countDone(r) { let n = 0; (r.bullets || []).forEach((b) => { if (b.pick && !b.skip) n++; }); return n; }
function tailorSection() {
  const sec = el("section", "tailor"); const r = result(), inf = S.detail.inflight;
  if (inf && inf.phase !== "error") { sec.append(el("h2", null, "Tailoring")); sec.append(progressEl()); return sec; }
  if (inf && inf.phase === "error") { sec.append(el("h2", null, "Tailoring")); sec.append(el("p", "err", inf.error)); return sec; }
  if (!r || !r.bullets) { if (r && r.summary) { sec.append(el("h2", null, "Tailoring")); sec.append(el("p", "note", "Read the posting, but the bullets never came. Tailor again.")); } return sec; }
  const nav = el("div", "tnav"), done = countDone(r), sc = score(r), picked = (r.skills || []).filter((k) => r.picked && r.picked[k]).length;
  [["summary", "Summary", has(finalOf(r.summary, "s")) ? "✓" : ""], ["skills", "Skills", picked + "/" + (r.skills || []).length], ["bullets", "Bullets", done + "/" + r.bullets.length], ["finals", "Finals", has(finalsText(r)) ? sc.pct + "%" : ""]].forEach(([k, l, c]) => {
    const b = btn(null, null, () => { S.tview = k; renderWork(); }); b.append(l); if (c) b.append(el("b", null, c)); if (S.tview === k) b.setAttribute("aria-current", "true"); nav.append(b);
  });
  const head = el("div", "row between"); head.append(nav);
  const w = el("div", "chips"); (r.weighs || []).slice(0, 4).forEach((t) => { const c = chipEl(t.length > 36 ? t.slice(0, 34).trim() + "…" : t); c.title = t; w.append(c); }); head.append(w);
  sec.append(head);
  if (S.tview === "summary") sec.append(summaryView(r));
  if (S.tview === "skills") sec.append(skillsView(r));
  if (S.tview === "bullets") sec.append(bulletsView(r));
  if (S.tview === "finals") sec.append(finalsView(r));
  return sec;
}
function progressEl() {
  const inf = S.detail.inflight, box = el("div", "progress"); box.id = "progress";
  const t = Math.round((Date.now() - inf.startedAt) / 1000);
  box.append(el("span", null, inf.phase === "reading" ? "Reading the posting" : "Writing bullets against your bank"), (() => { const b = el("div", "bar"); b.append(el("i")); return b; })(), el("span", "mono", t + "s"));
  return box;
}
function renderProgress() { const p = $("progress"); if (p) p.replaceWith(progressEl()); }

/* picking */
function candText(it, type, kind) {
  if (!it) return "";
  if (kind === "mine") return it.mine || "";
  if (kind === "track") return type === "s" ? (it.track || "") : type === "c" ? (it.text || "") : "";
  if (type === "s") return kind === "posting" ? it.posting : kind === "matched" ? it.matched : kind === "original" ? it.real : "";
  const B = bankById();
  if (type === "b") { if (kind === "posting") return it.text; const bk = it.bank && B[it.bank.id] ? it.bank : null; if (!bk) return ""; return kind === "matched" ? bk.matched : kind === "original" ? B[bk.id].text : ""; }
  const b = B[it.id]; if (!b) return ""; return kind === "matched" ? it.matched : kind === "original" ? b.text : "";
}
function finalOf(it, type) { if (!it || !it.pick || (type === "b" && it.skip)) return ""; return (candText(it, type, it.pick) || "").trim(); }
const KIND = { posting: "from the posting", matched: "bank, matched", original: "bank, as written", mine: "your rewrite", track: "from your track" };

function verCard(it, type, kind, label, opts = {}) {
  const text = candText(it, type, kind); if (!has(text)) return null;
  const card = el("article", "ver"); card.setAttribute("aria-pressed", it.pick === kind ? "true" : "false");
  const lab = el("span", "lab", label); if (opts.tag) lab.append(el("i", null, opts.tag)); card.append(lab);
  const p = el("p");
  if (opts.diffFrom) p.append(diffMark(opts.diffFrom, text)); else if (opts.keywords) p.append(kwMark(text, opts.keywords)); else if (kind === "posting") p.append(slotMark(text)); else p.textContent = text;
  card.append(p);
  if (opts.why) card.append(el("p", "why", opts.why));
  card.onclick = () => { it.pick = it.pick === kind ? null : kind; save(); renderWork(); };
  return card;
}
function foldRow(it, type, after) {
  const row = el("div", "fold"), body = el("div", "foldbody"), key = type + (S.sel || 0);
  const orig = candText(it, type, "original");
  const f = S.fold[key] || "";
  const toggle = (name, label) => btn("link", label, () => { S.fold[key] = f === name ? "" : name; renderWork(); });
  if (has(orig) && type !== "s") row.append(toggle("original", f === "original" ? "Hide original" : "Your original"));
  if (type === "s" && has(orig)) row.append(toggle("original", f === "original" ? "Hide your summary" : "Your summary as written"));
  row.append(toggle("mine", f === "mine" ? "Hide" : (has(it.mine) ? "Your rewrite" : "Write your own")));
  if (after) after(row);
  const wrap = el("div"); wrap.append(row);
  if (f === "original") { const c = verCard(it, type, "original", type === "s" ? "Your summary, as written" : "From your bank, as written"); if (c) { body.append(c); wrap.append(body); } }
  if (f === "mine") {
    const ta = el("textarea", "mine"); ta.value = it.mine || ""; ta.placeholder = type === "s" ? "Write the summary for this posting your way." : "Rewrite it to fit what you did.";
    ta.oninput = () => { it.mine = ta.value; it.pick = has(it.mine) ? "mine" : (it.pick === "mine" ? null : it.pick); save(); };
    body.append(ta); wrap.append(body); setTimeout(() => ta.focus(), 0);
  }
  return wrap;
}

function summaryView(r) {
  const box = el("div"), sm = r.summary;
  if (!sm) { box.append(el("p", "note", "No summary came back. Tailor again.")); return box; }
  const pair = el("div", "pair");
  const a = verCard(sm, "s", "posting", "Written from the posting"); if (a) pair.append(a);
  const b = verCard(sm, "s", "matched", "Your summary, matched", { keywords: r.keywords }); if (b) pair.append(b);
  if (b) b.append(el("p", "why", "Marked: the posting's own keywords."));
  if (!has(sm.matched)) box.append(el("p", "note", "Add your summary to the bank to get it matched to each posting."));
  box.append(pair, foldRow(sm, "s"));
  if (has(it_mine(sm))) {}
  const pg = el("div", "pager"); pg.append(el("span"), btn("pri", "Next: Skills", () => { S.tview = "skills"; renderWork(); })); box.append(pg);
  return box;
}
const it_mine = (it) => it.mine;
function skillsView(r) {
  const box = el("div"); r.picked = r.picked || {};
  box.append(el("p", "note", "What the posting requires, as a recruiter would search it. Pick the ones that are true for you."));
  const ch = el("div", "chips"); ch.style.marginTop = "12px";
  (r.skills || []).forEach((k) => { const c = btn("chip pick", k, () => { r.picked[k] = !r.picked[k]; save(); renderWork(); }); c.setAttribute("aria-pressed", r.picked[k] ? "true" : "false"); ch.append(c); });
  box.append(ch);
  const pg = el("div", "pager"), left = el("div", "row");
  left.append(btn("ghost small", "All", () => { r.skills.forEach((k) => { r.picked[k] = true; }); save(); renderWork(); }), btn("ghost small", "None", () => { r.picked = {}; save(); renderWork(); }));
  pg.append(left, btn("pri", "Next: Bullets", () => { S.tview = "bullets"; renderWork(); })); box.append(pg);
  return box;
}

/* bullets, one at a time */
function order(r) { const keys = []; (r.carried || []).forEach((_, i) => keys.push("c" + i)); r.bullets.forEach((_, i) => keys.push("b" + i)); const B = bankById(); (r.relevant || []).forEach((x, i) => { if (B[x.id]) keys.push("r" + i); }); return keys; }
function item(r, key) { const c = key[0], i = +key.slice(1); return c === "b" ? r.bullets[i] : c === "c" ? r.carried[i] : r.relevant[i]; }
function bulletsView(r) {
  const box = el("div"), keys = order(r); if (!keys.length) { box.append(el("p", "note", "No bullets came back. Tailor again.")); return box; }
  if (S.sel >= keys.length) S.sel = keys.length - 1;
  const key = keys[S.sel], it = item(r, key), type = key[0], B = bankById();
  const dots = el("div", "dots");
  keys.forEach((k, i) => { const x = item(r, k), t = k[0]; const d = btn(null, null, () => { S.sel = i; renderWork(); }); d.title = t === "b" ? (x.answers || x.text) : t === "r" ? B[x.id].group : (x.group || ""); if (t === "b" && x.skip) d.className = "skip"; else if (has(finalOf(x, t))) d.className = "done"; if (i === S.sel) d.setAttribute("aria-current", "true"); dots.append(d); });
  box.append(dots);
  const asks = el("div", "asks");
  if (type === "b") { asks.append(el("span", "lab", "The posting asks for"), el("p", null, it.answers || it.theme)); }
  else if (type === "r") { asks.append(el("span", "lab", "Also from your bank"), el("p", null, B[it.id].group)); }
  else { asks.append(el("span", "lab", "From your track"), el("p", null, it.group || "A final from an earlier posting")); }
  asks.append(el("span", "pos", (S.sel + 1) + " of " + keys.length)); box.append(asks);
  const pair = el("div", "pair");
  if (type === "b") {
    if (it.skip) box.append(el("p", "note", "Skipped."));
    const a = verCard(it, "b", "posting", "Written from the posting"); if (a) pair.append(a);
    const bk = it.bank && B[it.bank.id] ? it.bank : null;
    if (bk) {
      const src = B[bk.id], partial = bk.fit === "partial";
      const c = verCard(it, "b", has(bk.matched) ? "matched" : "original", (partial ? "Partial match from your bank" : "Your bank, matched"), { tag: src.group, diffFrom: has(bk.matched) ? src.text : null, why: partial && has(bk.why) ? bk.why : (has(bk.matched) ? null : "No keyword of the posting fits this one truthfully, so it is shown as written.") });
      if (c) pair.append(c);
    } else { const n = el("article", "ver"); n.style.cursor = "default"; n.append(el("span", "lab", "Your bank"), el("p", "why", "Nothing in your bank does this. Write it if you have, or skip it.")); pair.append(n); }
  } else if (type === "r") {
    const b = B[it.id];
    const c1 = verCard(it, "r", has(it.matched) ? "matched" : "original", has(it.matched) ? "Rewritten to match the posting" : "From your bank, as written", { tag: b.group, diffFrom: has(it.matched) ? b.text : null, why: it.why }); if (c1) pair.append(c1);
  } else { const c = verCard(it, "c", "track", "Your final from this track", { tag: it.role || "" }); if (c) pair.append(c); }
  box.append(pair);
  box.append(foldRow(it, type, (row) => {
    if (type === "b") {
      row.append(btn("link", "Another take", async (e) => { e.target.disabled = true; e.target.textContent = "Writing"; try { await api("POST", "/api/jobs/" + enc(S.key) + "/take", { index: +key.slice(1) }); S.detail = await api("GET", "/api/jobs/" + enc(S.key)); } catch (err) { alert(err.message); } renderWork(); }));
      if (has(it.mine)) row.append(btn("link", "Save rewrite to bank", async (e) => { const bank = await api("GET", "/api/bank"); const src = it.bank && B[it.bank.id]; bank.items.push({ id: "u" + Date.now().toString(36), role: src ? src.role : "Unsorted", group: src ? src.group : it.theme, lean: "my rewrite", text: it.mine.trim() }); await api("PUT", "/api/bank", bank); e.target.textContent = "Saved"; e.target.disabled = true; }));
    }
  }));
  const pg = el("div", "pager"), left = el("div", "row");
  left.append(btn("ghost", "Back", () => { if (S.sel > 0) { S.sel--; renderWork(); } }));
  if (type === "b") left.append(btn("ghost", it.skip ? "Bring back" : "Skip", () => { it.skip = !it.skip; save(); if (it.skip && S.sel < keys.length - 1) S.sel++; renderWork(); }));
  const sc = score(r), right = el("div", "row"); right.append(el("span", "score", "match " + sc.pct + "%"));
  right.append(btn("pri", S.sel === keys.length - 1 ? "Finals" : "Next", () => { if (S.sel === keys.length - 1) { S.tview = "finals"; } else S.sel++; renderWork(); }));
  pg.append(left, right); box.append(pg);
  return box;
}

/* finals */
function syncOrder(r) { if (!Array.isArray(r.forder)) r.forder = []; const ok = order(r).filter((k) => has(finalOf(item(r, k), k[0]))); r.forder = r.forder.filter((k) => ok.includes(k)); ok.forEach((k) => { if (!r.forder.includes(k)) r.forder.push(k); }); return r.forder; }
function pickedSkills(r) { return (r.skills || []).filter((k) => r.picked && r.picked[k]); }
function finalsText(r) {
  const lines = []; const sm = finalOf(r.summary, "s"); if (has(sm)) lines.push("SUMMARY", sm);
  const p = pickedSkills(r); if (p.length) { if (lines.length) lines.push(""); lines.push("SKILLS", p.join(", ")); }
  const keys = syncOrder(r); if (keys.length) { if (lines.length) lines.push(""); lines.push("BULLETS"); keys.forEach((k) => lines.push("• " + finalOf(item(r, k), k[0]))); }
  return lines.join("\n");
}
function normKw(t) { return " " + String(t).toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim().split(" ").map((w) => w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w).join(" ") + " "; }
function score(r) {
  const text = normKw(finalsText(r).replace(/^(SUMMARY|SKILLS|BULLETS)$/gm, "")), out = { found: [], missMust: [], miss: [], w: 0, tw: 0, pct: 0 };
  const kws = r.keywords && r.keywords.length ? r.keywords : (r.skills || []).map((k) => ({ term: k, also: [], must: true }));
  kws.forEach((k) => { const hit = [k.term].concat(k.also || []).some((t) => { const n = normKw(t); return n.trim() && text.includes(n); }); const w = k.must ? 2 : 1; out.tw += w; if (hit) { out.w += w; out.found.push(k); } else if (k.must) out.missMust.push(k); else out.miss.push(k); });
  out.pct = out.tw ? Math.round(100 * out.w / out.tw) : 0; return out;
}
function finalsView(r) {
  const box = el("div", "finals"), left = el("div"), side = el("aside", "side");
  const sm = finalOf(r.summary, "s");
  left.append(el("h2", null, "Summary"));
  if (has(sm)) left.append(finalRow(r, r.summary, "s", null)); else { const n = el("div", "row"); n.append(el("span", "note", "No summary picked."), btn("link", "Go to Summary", () => { S.tview = "summary"; renderWork(); })); left.append(n); }
  left.append(el("h2", null, "Skills"));
  const ps = pickedSkills(r); if (ps.length) { const ch = el("div", "chips"); ps.forEach((k) => ch.append(chipEl(k))); left.append(ch); } else left.append(el("span", "note", "No skills picked."));
  const keys = syncOrder(r); left.append(el("h2", null, "Bullets · " + keys.length));
  if (keys.length) keys.forEach((k) => left.append(finalRow(r, item(r, k), k[0], k))); else { const n = el("div", "row"); n.append(el("span", "note", "No finals picked yet."), btn("link", "Go to Bullets", () => { S.tview = "bullets"; renderWork(); })); left.append(n); }
  const sc = score(r), must = (r.keywords || []).filter((k) => k.must).length;
  side.append(el("span", "lab", "Keyword match"), el("div", "big", sc.pct + "%"));
  const m = el("div", "meter"); const i = el("i"); i.style.width = sc.pct + "%"; m.append(i); side.append(m);
  side.append(el("p", "note", sc.found.length + " of " + (sc.found.length + sc.missMust.length + sc.miss.length) + " found" + (must ? ", " + (must - sc.missMust.length) + " of " + must + " required" : "")));
  if (sc.missMust.length) {
    side.append(el("span", "lab", "Missing, required · " + sc.missMust.length)); const ch = el("div", "chips");
    const show = S.fold.missMust ? sc.missMust : sc.missMust.slice(0, 8);
    show.forEach((k) => ch.append(chipEl(k.term, "miss")));
    if (sc.missMust.length > 8) ch.append(btn("link", S.fold.missMust ? "fewer" : "+" + (sc.missMust.length - 8) + " more", () => { S.fold.missMust = !S.fold.missMust; renderWork(); }));
    side.append(ch);
  }
  if (sc.miss.length) { const f = S.fold.miss; side.append(btn("link", f ? "Hide preferred" : sc.miss.length + " preferred missing", () => { S.fold.miss = !f; renderWork(); })); if (f) { const ch = el("div", "chips"); sc.miss.forEach((k) => ch.append(chipEl(k.term))); side.append(ch); } }
  side.append(el("p", "note", "Only add a missing keyword if it is true for you."));
  const copy = btn("pri", "Copy everything", () => { navigator.clipboard.writeText(finalsText(r)).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy everything"; }, 1500); }); }); copy.disabled = !has(finalsText(r)); side.append(copy);
  side.append(trackBox(r));
  box.append(left, side); return box;
}
function finalRow(r, it, type, key) {
  const row = el("div", "frow"), ta = el("textarea"), meta = el("div", "meta");
  ta.value = finalOf(it, type); ta.rows = 1; const grow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }; setTimeout(grow, 0);
  ta.oninput = () => { it.mine = ta.value; it.pick = has(it.mine) ? "mine" : null; grow(); save(); };
  const left = el("span", "mono", (KIND[it.pick] || "") + (/\[[^\]]{1,40}\]/.test(ta.value) ? " · still has a [slot]" : "")), acts = el("div", "row");
  if (key) { acts.append(btn("ghost small", "↑", () => move(r, key, -1)), btn("ghost small", "↓", () => move(r, key, 1)), btn("ghost small", "Open", () => { S.sel = order(r).indexOf(key); S.tview = "bullets"; renderWork(); })); }
  acts.append(btn("ghost small", "Remove", () => { it.pick = null; save(); renderWork(); }));
  meta.append(left, acts); row.append(ta, meta); return row;
}
function move(r, key, d) { const o = syncOrder(r), i = o.indexOf(key), j = i + d; if (i === -1 || j < 0 || j >= o.length) return; o.splice(i, 1); o.splice(j, 0, key); save(); renderWork(); }

/* tracks */
function trackBox(r) {
  const box = el("div"), tracks = S.state.tracks, cur = S.detail.tailor.trackId, sel = el("select", "sel");
  const o0 = el("option", null, "No track"); o0.value = ""; sel.append(o0);
  const sug = (r.track || "").trim(), match = tracks.find((t) => t.name.toLowerCase() === sug.toLowerCase());
  tracks.forEach((t) => { const o = el("option", null, t.name); o.value = t.id; sel.append(o); });
  if (sug && !match) { const o = el("option", null, "New: " + sug); o.value = "__new"; sel.append(o); }
  sel.value = cur || (match ? match.id : (sug ? "__new" : ""));
  box.append(el("span", "lab", "Track"), sel);
  const b = btn("ghost small", "Save finals to track", async () => {
    let id = sel.value; let list = tracks;
    if (id === "__new") { const t = { id: "t" + Date.now().toString(36), name: sug, created: Date.now(), set: null }; list = tracks.concat(t); id = t.id; }
    if (!id) return;
    const t = list.find((x) => x.id === id); const B = bankById();
    t.set = { updated: Date.now(), from: S.key, summary: finalOf(r.summary, "s"), skills: pickedSkills(r), bullets: syncOrder(r).map((k) => { const it = item(r, k), ty = k[0], src = ty === "b" ? (it.bank && B[it.bank.id]) : ty === "r" ? B[it.id] : null; return { text: finalOf(it, ty), role: src ? src.role : (it.role || ""), group: src ? src.group : (it.group || it.theme || "") }; }) };
    await api("PUT", "/api/tracks", { v: 1, tracks: list }); S.detail.tailor.trackId = id; save(); await loadState(); b.textContent = "Saved"; setTimeout(() => renderWork(), 1200);
  });
  b.style.marginTop = "6px"; box.append(b);
  const t = tracks.find((x) => x.id === sel.value);
  if (t && t.set) box.append(el("p", "note", t.set.bullets.length + " bullets in this track, from " + new Date(t.set.updated).toLocaleDateString() + "."));
  return box;
}

/* misc */
function hintRow() { const h = el("p", "hint"); h.append("Keys: "); [["j", "next job"], ["k", "previous"], ["t", "tailor"], ["s", "shortlist"], ["p", "pass"], ["/", "filter"]].forEach(([k, l], i) => { if (i) h.append(" · "); h.append(el("kbd", null, k), " " + l); }); return h; }
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,textarea,select") || e.metaKey || e.ctrlKey) return;
  const jobs = stageJobs(S.stage), i = jobs.findIndex((j) => j.key === S.key);
  if (e.key === "j" && jobs[i + 1]) openJob(jobs[i + 1].key);
  else if (e.key === "k" && jobs[i - 1]) openJob(jobs[i - 1].key);
  else if (e.key === "/") { e.preventDefault(); $("q").focus(); }
  else if (!S.key) return;
  else if (e.key === "t") startTailor();
  else if (e.key === "s") setStage("shortlist");
  else if (e.key === "p") setStage("passed");
});
$("q").oninput = () => { S.q = $("q").value; renderRail(); };
$("pasteBtn").onclick = () => $("pasteDlg").showModal();
$("pasteCancel").onclick = () => $("pasteDlg").close();
$("pasteForm").onsubmit = async (e) => { const f = new FormData(e.target); const text = f.get("text"); if (!text || text.length < 200) { e.preventDefault(); alert("Paste the whole posting."); return; } const r = await api("POST", "/api/jobs", { title: f.get("title"), company: f.get("company"), url: f.get("url"), text }); e.target.reset(); await loadState(); S.stage = "shortlist"; openJob(r.key); };
$("runBtn").onclick = async () => { await api("POST", "/api/run"); $("runBtn").textContent = "Running"; setTimeout(() => { $("runBtn").textContent = "Run now"; loadState(); }, 60000); };
loadState().then(() => { renderWork(); setInterval(loadState, 120000); });
