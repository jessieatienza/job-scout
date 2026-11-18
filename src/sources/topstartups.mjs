import * as cheerio from 'cheerio';
import { fetchText, sleep } from '../lib/http.mjs';

const BASE = 'https://topstartups.io';

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

// All startups behind the user's filtered link. Returns [{name, website, hq, size, founded, funding, viewJobs, linkedin, tags}]
export async function fetchStartups(query, { log = () => {}, maxPages = 80 } = {}) {
  const out = [];
  const names = new Set();
  let expected = Infinity;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/?page=${page}&${query}`;
    const { status, text } = await fetchText(url);
    if (status !== 200) { log(`topstartups startups page ${page}: HTTP ${status}`); break; }
    const $ = cheerio.load(text);
    if (page === 1) { const m = clean($('#count_results').text()).match(/([\d,]+)/); if (m) expected = Number(m[1].replace(/,/g, '')); }
    const items = $('.infinite-item');
    if (!items.length || out.length >= expected) break;
    items.each((_, el) => {
      const $el = $(el);
      const name = clean($el.find('h3').first().text());
      if (!name || names.has(name) || out.length >= expected) return;
      names.add(name);
      const website = $el.find('a#startup-website-link').attr('href') || '';
      const viewJobs = $el.find('a#view-jobs').attr('href') || '';
      const linkedin = $el.find('a#social_media_link').filter((_, a) => /linkedin\.com/.test($(a).attr('href') || '')).attr('href') || '';
      const facts = clean($el.find('p:contains("Quick facts")').text());
      const hq = (facts.match(/HQ:\s*([^\n]+?)\s*(\d{1,4}-\d{1,4}|\d+\+?\s*employees|Founded|$)/) || [])[1] || '';
      const size = clean($el.find('#company-size-tags').first().text());
      const founded = (facts.match(/Founded:\s*(\d{4})/) || [])[1] || '';
      const funding = $el.find('#funding-tags').map((_, s) => clean($(s).text())).get();
      const tags = $el.find('#industry-tags').map((_, s) => clean($(s).text())).get();
      const blurb = clean($el.find('p:contains("What they do")').clone().children('b,span').remove().end().text());
      out.push({ name, website: website.replace(/\?utm_source=.*$/, ''), hq: clean(hq), size, founded, funding, viewJobs: viewJobs.replace(/\?utm_source=.*$/, ''), linkedin, tags, blurb });
    });
    await sleep(250);
  }
  log(`topstartups: ${out.length} startups`);
  return out;
}

function parsePosted(s) {
  s = clean(s).toLowerCase();
  const now = Date.now();
  if (/today|just now|hour|minute/.test(s)) return new Date(now - 2 * 3600e3).toISOString();
  const m = s.match(/(\d+)\s+day/);
  if (m) return new Date(now - Number(m[1]) * 86400e3).toISOString();
  const w = s.match(/(\d+)\s+week/);
  if (w) return new Date(now - Number(w[1]) * 7 * 86400e3).toISOString();
  const mo = s.match(/(\d+)\s+month/);
  if (mo) return new Date(now - Number(mo[1]) * 30 * 86400e3).toISOString();
  return null;
}

// Jobs board, newest first, filtered by a role substring. Stops once postings are older than maxDays.
export async function fetchBoardJobs(role, { log = () => {}, maxDays = 2, maxPages = 15 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/jobs/?page=${page}&role=${encodeURIComponent(role)}`;
    const { status, text } = await fetchText(url);
    if (status !== 200) { log(`topstartups jobs ${role} page ${page}: HTTP ${status}`); break; }
    const $ = cheerio.load(text);
    const items = $('.infinite-item');
    if (!items.length) break;
    let oldest = 0;
    items.each((_, el) => {
      const $el = $(el);
      const company = clean($el.find('h7').first().text());
      const title = clean($el.find('#job-title').text());
      const apply = $el.find('a#apply-button').attr('href') || $el.find('a:has(#job-title)').attr('href') || '';
      const h7s = $el.find('h7').map((_, h) => clean($(h).text())).get();
      const location = (h7s.find((t) => !/Experience:|Posted:/.test(t) && t !== company) || '').trim();
      const posted = (h7s.find((t) => /Posted:/.test(t)) || '').replace(/Posted:\s*/, '').replace(/📌/g, '');
      const yoe = ((h7s.find((t) => /Experience:/.test(t)) || '').match(/Experience:\s*(.*)/) || [])[1] || '';
      const description = clean($el.find('.collapse').text());
      const postedAt = parsePosted(posted);
      const ageDays = postedAt ? (Date.now() - Date.parse(postedAt)) / 86400e3 : 0;
      oldest = Math.max(oldest, ageDays);
      if (!title) return;
      out.push({ source: 'topstartups', company, title, location, postedAt, postedText: clean(posted), yoe, url: apply, description });
    });
    if (oldest > maxDays) break;
    await sleep(250);
  }
  log(`topstartups jobs[${role}]: ${out.length}`);
  return out;
}
