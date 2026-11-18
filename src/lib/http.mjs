export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url, { retries = 2, timeoutMs = 25000, headers = {} } = {}) {
  let lastErr, lastStatus = 0;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...headers }, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) { lastStatus = res.status; lastErr = new Error(`HTTP ${res.status} ${url}`); if (i < retries) await sleep(1500 * (i + 1)); continue; }
      return { status: res.status, text: await res.text(), url: res.url };
    } catch (e) {
      clearTimeout(t);
      lastErr = e; await sleep(800 * (i + 1));
    }
  }
  if (lastStatus) return { status: lastStatus, text: '', url }; // caller decides how to back off
  throw lastErr;
}

export async function fetchJson(url, opts) {
  const r = await fetchText(url, opts);
  if (r.status !== 200) return { status: r.status, json: null };
  try { return { status: r.status, json: JSON.parse(r.text) }; } catch { return { status: r.status, json: null }; }
}

// Run async tasks with limited concurrency.
export async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: String(e && e.message || e) }; } }
  });
  await Promise.all(workers);
  return out;
}
