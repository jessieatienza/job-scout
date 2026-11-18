import { withPage } from './launch.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Y Combinator Work at a Startup, public listing. Cards carry no posted date; the runner dates them by first sighting.
export async function searchYC(ctx, { log = () => {} } = {}) {
  const out = new Map();
  for (const role of ['product', 'operations']) {
    const url = `https://www.workatastartup.com/jobs/v2?role=${role}`;
    try {
      const rows = await withPage(ctx, async (page) => {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await sleep(3500);
        for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 4000); await sleep(700); }
        return page.evaluate(() => [...document.querySelectorAll('a[href^="/jobs/"]')].filter((a) => /^\/jobs\/\d+$/.test(a.getAttribute('href'))).map((a) => ({
          url: a.href, company: a.querySelector('p.font-semibold')?.textContent.trim() || '', blurb: a.querySelector('p.truncate:not(.font-semibold)')?.textContent.trim() || '',
          title: a.querySelector('h3')?.textContent.trim() || '', meta: a.querySelector('h3 + p, .line-clamp-2')?.textContent.trim() || '' })));
      });
      for (const r of rows) {
        const id = (r.url.match(/\/jobs\/(\d+)/) || [])[1]; if (!id || out.has(id) || !r.title) continue;
        const parts = r.meta.split('·').map((s) => s.trim());
        const location = parts[1] || '';
        out.set(id, { source: 'yc', id, title: r.title, company: r.company, location, workplaceHint: /remote/i.test(location) ? 'remote' : undefined, postedAt: null, dateless: true,
          url: r.url, description: '', compensation: parts[2] || '', companyBlurb: r.blurb, employmentType: parts[0] || '' });
      }
    } catch (e) { log(`yc ${url}: ${e.message}`); }
  }
  log(`yc: ${out.size} candidate postings`);
  return [...out.values()];
}
