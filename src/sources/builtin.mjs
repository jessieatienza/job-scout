import * as cheerio from 'cheerio';
import { fetchText, sleep } from '../lib/http.mjs';
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function parseAgo(s) {
  const m = clean(s).match(/(\d+)\s+(minute|hour|day)s?\s+ago/i);
  if (!m) return null;
  const unit = { minute: 60e3, hour: 3600e3, day: 86400e3 }[m[2].toLowerCase()];
  return new Date(Date.now() - Number(m[1]) * unit).toISOString();
}

export async function searchBuiltIn({ log = () => {}, maxPages = 6 } = {}) {
  const lists = [
    { label: 'remote', path: '/jobs/remote/product' },
    { label: 'remote-program', path: '/jobs/remote/project-mgmt' },
    { label: 'sf-hybrid', path: '/jobs/san-francisco/hybrid/product' },
    { label: 'sf-hybrid-program', path: '/jobs/san-francisco/hybrid/project-mgmt' },
  ];
  const out = new Map();
  for (const l of lists) {
    for (let page = 1; page <= maxPages; page++) {
      const url = `https://builtin.com${l.path}?daysSinceUpdated=1${page > 1 ? `&page=${page}` : ''}`;
      let res; try { res = await fetchText(url); } catch (e) { log(`builtin ${l.label} p${page}: ${e.message}`); break; }
      if (res.status !== 200) { log(`builtin ${l.label} p${page}: HTTP ${res.status}`); break; }
      const $ = cheerio.load(res.text);
      const cards = $('[data-id="job-card"]');
      if (!cards.length) break;
      cards.each((_, el) => {
        const $el = $(el);
        const a = $el.find('a[data-id="job-card-title"]');
        const href = a.attr('href') || '';
        const id = href.split('/').pop();
        if (!id || out.has(id)) return;
        const spans = $el.find('span.font-barlow.text-gray-04').map((_, s) => clean($(s).text())).get();
        const workplace = spans.find((t) => /remote|hybrid|in-office|office/i.test(t)) || '';
        const location = spans.find((t) => t !== workplace && !/ago/i.test(t) && t.length < 60) || '';
        out.set(id, {
          source: 'builtin', id, title: clean(a.text()), company: clean($el.find('[data-id="company-title"]').text()),
          location, workplaceText: workplace, postedAt: parseAgo($el.find('span:contains("Ago")').first().text()),
          postedText: clean($el.find('span:contains("Ago")').first().text()), url: `https://builtin.com${href}`,
          workplaceHint: /hybrid/i.test(workplace) ? 'hybrid' : /remote/i.test(workplace) ? 'remote' : 'onsite',
          description: '',
        });
      });
      await sleep(400);
    }
  }
  log(`builtin: ${out.size} candidate postings`);
  return [...out.values()];
}
