import { withPage, looksBlocked } from './launch.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchIndeed(ctx, queries, { log = () => {}, area = {} } = {}) {
  const out = new Map();
  const variants = [
    { label: 'remote', params: { l: 'Remote' } },
    { label: 'near', params: { l: area.indeedLocation || 'United States', radius: String(area.radiusMiles || 50) } },
  ];
  let blocked = false;
  for (const q of queries) {
    if (blocked) break;
    for (const v of variants) {
      const p = new URLSearchParams({ q: `"${q}"`, fromage: '1', sort: 'date', ...v.params });
      const url = `https://www.indeed.com/jobs?${p}`;
      try {
        const res = await withPage(ctx, async (page) => {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await sleep(2500);
          const body = await page.evaluate(() => document.body.innerText.slice(0, 2000));
          if (looksBlocked(body) && !/jobs?\b/i.test(body)) return { blocked: true };
          const results = await page.evaluate(() => {
            try { return window.mosaic.providerData['mosaic-provider-jobcards'].metaData.mosaicProviderJobCardsModel.results; } catch { return null; }
          });
          return { results };
        });
        if (res.blocked) { log(`indeed: blocked on ${q}/${v.label}; sign in to the scout Chrome profile once (npm run login)`); blocked = true; break; }
        for (const r of res.results || []) {
          if (!r.jobkey || out.has(r.jobkey)) continue;
          const loc = r.formattedLocation || '';
          const remote = r.remoteWorkModel?.type || r.remoteWorkModel?.text || '';
          out.set(r.jobkey, {
            source: 'indeed', id: r.jobkey, title: r.title || r.displayTitle, company: r.company || r.truncatedCompany, location: loc,
            workplaceText: remote, workplaceHint: /remote/i.test(remote + loc) ? 'remote' : /hybrid/i.test(remote + loc) ? 'hybrid' : undefined,
            postedAt: r.pubDate ? new Date(r.pubDate).toISOString() : null, postedText: r.formattedRelativeTime || '',
            url: `https://www.indeed.com/viewjob?jk=${r.jobkey}`, description: (r.snippet || '').replace(/<[^>]+>/g, ' '),
          });
        }
      } catch (e) { log(`indeed ${q}/${v.label}: ${e.message}`); }
      await sleep(1200);
    }
  }
  log(`indeed: ${out.size} candidate postings`);
  return [...out.values()];
}
