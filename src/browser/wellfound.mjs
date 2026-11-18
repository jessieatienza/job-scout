import { withPage, looksBlocked } from './launch.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wellfound (ex-AngelList Talent). Reads the Apollo cache embedded in the page once Chrome passes the challenge.
export async function searchWellfound(ctx, { log = () => {}, pagesPerList = 3 } = {}) {
  const out = new Map();
  const lists = [
    { base: 'https://wellfound.com/role/r/product-manager', hint: 'remote' },
    { base: 'https://wellfound.com/role/r/program-manager', hint: 'remote' },
    { base: 'https://wellfound.com/role/l/product-manager/san-francisco', hint: undefined },
  ];
  for (const l of lists) {
    for (let page = 1; page <= pagesPerList; page++) {
      const url = page === 1 ? l.base : `${l.base}?page=${page}`;
      try {
        const res = await withPage(ctx, async (p) => {
          await p.goto(url, { waitUntil: 'domcontentloaded' });
          await sleep(3500);
          const body = await p.evaluate(() => document.body.innerText.slice(0, 1500));
          const data = await p.evaluate(() => { const el = document.getElementById('__NEXT_DATA__'); return el ? el.textContent : null; });
          return { body, data };
        });
        if (!res.data) { log(`wellfound: no embedded data at ${url}${looksBlocked(res.body) ? ' (challenge page)' : ''}`); break; }
        const d = JSON.parse(res.data);
        const ap = d?.props?.pageProps?.apolloState?.data || d?.props?.pageProps?.apolloState || {};
        let added = 0;
        for (const st of Object.values(ap)) {
          if (!st || st.__typename !== 'StartupResult') continue;
          for (const ref of st.highlightedJobListings || []) {
            const j = ap[ref.__ref]; if (!j || out.has(j.id)) continue;
            const live = j.liveStartAt ? new Date(j.liveStartAt * 1000).toISOString() : null;
            const locs = [...(j.locationNames || [])];
            const remoteLocs = j.acceptedRemoteLocationNames || [];
            const location = (j.remote ? ['Remote', ...remoteLocs.length ? [`(${remoteLocs.join(', ')})`] : []] : []).concat(locs).join(' ');
            out.set(j.id, { source: 'wellfound', id: j.id, title: j.title, company: st.name, location, isRemote: !!j.remote, workplaceHint: j.remote ? 'remote' : l.hint,
              postedAt: live, url: `https://wellfound.com/jobs/${j.id}-${j.slug || ''}`, description: (j.description || '').slice(0, 4000), compensation: j.compensation || '',
              companyBlurb: st.highConcept || '' });
            added++;
          }
        }
        if (!added) break;
      } catch (e) { log(`wellfound ${url}: ${e.message}`); break; }
      await sleep(1200);
    }
  }
  log(`wellfound: ${out.size} candidate postings`);
  return [...out.values()];
}
