import { withPage, looksBlocked } from './launch.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseAge(s) {
  const m = (s || '').match(/(\d+)\s*(h|d|hr|hour|day)/i);
  if (/24h|^\s*24\s*h/i.test(s || '') || /today|just posted/i.test(s || '')) return new Date(Date.now() - 3600e3).toISOString();
  if (!m) return null;
  const unit = /^h/i.test(m[2]) ? 3600e3 : 86400e3;
  return new Date(Date.now() - Number(m[1]) * unit).toISOString();
}

export async function searchGlassdoor(ctx, queries, { log = () => {}, area = {} } = {}) {
  const out = new Map();
  const variants = [
    { label: 'remote', params: { remoteWorkType: '1' } },
    { label: 'near', params: area.glassdoorLocId ? { locT: 'C', locId: String(area.glassdoorLocId), locKeyword: area.glassdoorLocation || '', radius: String(area.radiusMiles || 50) } : { sc_keyword_loc: area.glassdoorLocation || '' } },
  ];
  let blocked = false;
  for (const q of queries.slice(0, 8)) {
    if (blocked) break;
    for (const v of variants) {
      const p = new URLSearchParams({ 'sc.keyword': q, fromAge: '1', sortBy: 'date_desc', ...v.params });
      const url = `https://www.glassdoor.com/Job/jobs.htm?${p}`;
      try {
        const res = await withPage(ctx, async (page) => {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await sleep(3000);
          const body = await page.evaluate(() => document.body.innerText.slice(0, 1500));
          if (looksBlocked(body) && !/jobs/i.test(body)) return { blocked: true };
          const rows = await page.evaluate(() => [...document.querySelectorAll('li[data-test="jobListing"], [data-test="jobListing"]')].map((li) => {
            const a = li.querySelector('a[data-test="job-title"], a[data-test="job-link"]');
            const emp = li.querySelector('[class*="EmployerProfile_compactEmployerName"], [data-test="employer-short-name"], [class*="employerName"]');
            const loc = li.querySelector('[data-test="emp-location"], [class*="location"]');
            const age = li.querySelector('[data-test="job-age"], [class*="listing-age"], [class*="JobCard_listingAge"]');
            return { id: li.getAttribute('data-jobid') || (a && a.href), title: a && a.textContent.trim(), url: a && a.href, company: emp && emp.textContent.trim(), location: loc && loc.textContent.trim(), ageText: age && age.textContent.trim() };
          }));
          return { rows };
        });
        if (res.blocked) { log(`glassdoor: blocked on ${q}/${v.label}; sign in to the scout Chrome profile once (npm run login)`); blocked = true; break; }
        for (const r of res.rows || []) {
          if (!r.title || !r.id || out.has(r.id)) continue;
          out.set(r.id, { source: 'glassdoor', id: r.id, title: r.title, company: r.company || '', location: r.location || '', postedAt: parseAge(r.ageText), postedText: r.ageText || '', url: r.url,
            workplaceHint: v.label === 'remote' || /remote/i.test(r.location || '') ? 'remote' : undefined, description: '' });
        }
      } catch (e) { log(`glassdoor ${q}/${v.label}: ${e.message}`); }
      await sleep(1500);
    }
  }
  log(`glassdoor: ${out.size} candidate postings`);
  return [...out.values()];
}
