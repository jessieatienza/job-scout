import * as cheerio from 'cheerio';
import { fetchText, sleep } from '../lib/http.mjs';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const GEO_US = '103644278';

// Guest search: no login. f_TPR=r86400 = past 24h; f_WT 2=remote, 3=hybrid.
export async function searchLinkedIn(queries, { log = () => {}, maxPerQuery = 50, area = {} } = {}) {
  const seen = new Map();
  const variants = [
    { label: 'remote-us', params: { f_WT: '2', geoId: GEO_US, location: 'United States' } },
    { label: 'hybrid-near', params: { f_WT: '3', geoId: area.linkedinGeoId || GEO_US, location: area.linkedinLocation || 'United States' } },
  ];
  for (const q of queries) {
    for (const v of variants) {
      for (let start = 0; start < maxPerQuery; start += 25) {
        const p = new URLSearchParams({ keywords: `"${q}"`, f_TPR: 'r86400', start: String(start), ...v.params });
        const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p}`;
        let res;
        try { res = await fetchText(url); } catch (e) { log(`linkedin search error ${q}/${v.label}: ${e.message}`); break; }
        if (res.status !== 200) { if (res.status !== 400) log(`linkedin search ${q}/${v.label} start=${start}: HTTP ${res.status}`); break; }
        const $ = cheerio.load(res.text);
        const cards = $('[data-entity-urn]');
        if (!cards.length) break;
        cards.each((_, el) => {
          const $el = $(el);
          const id = ($el.attr('data-entity-urn') || '').split(':').pop();
          if (!id || seen.has(id)) return;
          const href = ($el.find('a.base-card__full-link').attr('href') || '').split('?')[0];
          seen.set(id, {
            source: 'linkedin', id,
            title: clean($el.find('.base-search-card__title').text()),
            company: clean($el.find('.base-search-card__subtitle').text()),
            location: clean($el.find('.job-search-card__location').text()),
            postedAt: $el.find('time').attr('datetime') ? new Date($el.find('time').attr('datetime')).toISOString() : null,
            url: href || `https://www.linkedin.com/jobs/view/${id}`,
            workplaceHint: v.label === 'remote-us' ? 'remote' : 'hybrid',
            query: q,
          });
        });
        await sleep(400);
      }
    }
  }
  log(`linkedin: ${seen.size} candidate postings`);
  return [...seen.values()];
}

// Guest detail: applicant count, criteria, description, precise posted time.
let cooldownUntil = 0;
export async function enrichLinkedIn(job, { log = () => {} } = {}) {
  try {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = cooldownUntil - Date.now(); if (wait > 0) await sleep(wait);
      res = await fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${job.id}`, { retries: 0 });
      if (res.status !== 429) break;
      cooldownUntil = Date.now() + 40000 * (attempt + 1);
      log(`linkedin: rate limited, pausing ${40 * (attempt + 1)}s`);
    }
    if (res.status !== 200) { job.enrichError = `HTTP ${res.status}`; return job; }
    const $ = cheerio.load(res.text);
    const text = clean($('body').text());
    const m1 = text.match(/Be among the first (\d+) applicants/i);
    const m2 = text.match(/Over (\d+) applicants/i);
    const m3 = text.match(/(\d+) applicants/i);
    if (m1) { job.applicants = Number(m1[1]) - 1; job.applicantsText = `under ${m1[1]}`; }
    else if (m2) { job.applicants = Number(m2[1]) + 1; job.applicantsText = `over ${m2[1]}`; }
    else if (m3) { job.applicants = Number(m3[1]); job.applicantsText = m3[1]; }
    const posted = clean($('.posted-time-ago__text').first().text());
    if (posted) job.postedText = posted;
    const ago = posted.match(/(\d+)\s+(minute|hour|day|week)s?\s+ago/i);
    if (ago) { const n = Number(ago[1]); const unit = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3 }[ago[2].toLowerCase()]; job.postedAt = new Date(Date.now() - n * unit).toISOString(); }
    const crit = {};
    $('.description__job-criteria-item').each((_, li) => { const k = clean($(li).find('h3').text()); const v = clean($(li).find('span').text()); if (k) crit[k] = v; });
    job.criteria = crit;
    job.description = clean($('.show-more-less-html__markup').text()).slice(0, 6000);
    const loc = clean($('.topcard__flavor--bullet').first().text());
    if (loc) job.location = loc;
  } catch (e) { job.enrichError = e.message; log(`linkedin enrich ${job.id}: ${e.message}`); }
  return job;
}
