import { fetchJson, fetchText } from '../lib/http.mjs';
import * as cheerio from 'cheerio';

// Identify the ATS vendor and board slug from a careers URL.
export function detectAts(url) {
  if (!url) return null;
  let u; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (host === 'jobs.ashbyhq.com' && seg[0]) return { vendor: 'ashby', slug: seg[0] };
  if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'boards.eu.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') && seg[0]) return { vendor: 'greenhouse', slug: seg[0], eu: host.includes('.eu.') };
  if (host === 'jobs.lever.co' && seg[0]) return { vendor: 'lever', slug: seg[0] };
  if (host === 'apply.workable.com' && seg[0]) return { vendor: 'workable', slug: seg[0] };
  if (host === 'ats.rippling.com' && seg[0]) return { vendor: 'rippling', slug: seg[0] };
  if (host === 'careers.smartrecruiters.com' && seg[0]) return { vendor: 'smartrecruiters', slug: seg[0] };
  if (host === 'jobs.gem.com' && seg[0]) return { vendor: 'gem', slug: seg[0] };
  return null;
}

const strip = (html) => cheerio.load(`<div>${html || ''}</div>`)('div').text().replace(/\s+/g, ' ').trim();

export async function fetchAtsJobs(ats, company) {
  const base = { source: `ats:${ats.vendor}`, company: company.name, companyMeta: company };
  if (ats.vendor === 'ashby') {
    const { status, json } = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(ats.slug)}?includeCompensation=true`);
    if (!json || !json.jobs) return { status, jobs: [] };
    return { status, jobs: json.jobs.filter((j) => j.isListed !== false).map((j) => ({
      ...base, title: j.title, location: [j.location, ...(j.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join(' / '),
      workplaceType: j.workplaceType, isRemote: j.isRemote, postedAt: j.publishedAt, url: j.jobUrl, department: j.department, employmentType: j.employmentType,
      description: strip(j.descriptionHtml).slice(0, 6000), compensation: j.compensation?.compensationTierSummary || '' })) };
  }
  if (ats.vendor === 'greenhouse') {
    const host = ats.eu ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io';
    const { status, json } = await fetchJson(`https://${host}/v1/boards/${encodeURIComponent(ats.slug)}/jobs?content=true`);
    if (!json || !json.jobs) return { status, jobs: [] };
    return { status, jobs: json.jobs.map((j) => ({
      ...base, title: j.title, location: [j.location?.name, ...(j.offices || []).map((o) => o.name)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / '),
      postedAt: j.first_published || j.updated_at, updatedAt: j.updated_at, url: j.absolute_url, department: (j.departments || []).map((d) => d.name).join(', '),
      description: strip(decodeEntities(j.content)).slice(0, 6000), metadata: j.metadata })) };
  }
  if (ats.vendor === 'lever') {
    const { status, json } = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(ats.slug)}?mode=json`);
    if (!Array.isArray(json)) return { status, jobs: [] };
    return { status, jobs: json.map((j) => ({
      ...base, title: j.text, location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / '),
      workplaceType: j.workplaceType, postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null, url: j.hostedUrl, department: j.categories?.team || j.categories?.department || '',
      employmentType: j.categories?.commitment || '', description: ((j.descriptionPlain || '') + ' ' + (j.lists || []).map((l) => l.text + ' ' + strip(l.content)).join(' ')).slice(0, 6000) })) };
  }
  if (ats.vendor === 'workable') {
    const { status, json } = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(ats.slug)}?details=true`);
    if (!json || !json.jobs) return { status, jobs: [] };
    return { status, jobs: json.jobs.map((j) => ({
      ...base, title: j.title, location: [j.city, j.state, j.country].filter(Boolean).join(', '), isRemote: !!j.remote || /remote/i.test(j.workplace || ''), workplaceType: j.workplace,
      postedAt: j.published_on ? new Date(j.published_on).toISOString() : null, url: j.url || j.shortlink, department: j.department || '', employmentType: j.employment_type || '',
      description: strip((j.description || '') + (j.requirements || '')).slice(0, 6000) })) };
  }
  if (ats.vendor === 'smartrecruiters') {
    const { status, json } = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(ats.slug)}/postings?limit=100`);
    if (!json || !json.content) return { status, jobs: [] };
    return { status, jobs: json.content.map((j) => ({
      ...base, title: j.name, location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', '), isRemote: !!j.location?.remote,
      postedAt: j.releasedDate, url: `https://jobs.smartrecruiters.com/${ats.slug}/${j.id}`, department: j.department?.label || '', description: '' })) };
  }
  if (ats.vendor === 'rippling') {
    // Rippling boards are server-rendered; parse the listing page.
    const { status, text } = await fetchText(`https://ats.rippling.com/${encodeURIComponent(ats.slug)}/jobs`);
    if (status !== 200) return { status, jobs: [] };
    const $ = cheerio.load(text);
    const jobs = [];
    $('a[href*="/jobs/"]').each((_, a) => {
      const href = $(a).attr('href'); const title = $(a).text().replace(/\s+/g, ' ').trim();
      if (!title || !/\/jobs\/[0-9a-f-]{8,}/.test(href || '')) return;
      jobs.push({ ...base, title, location: $(a).closest('div').text().replace(title, '').replace(/\s+/g, ' ').trim().slice(0, 80), postedAt: null, url: href.startsWith('http') ? href : `https://ats.rippling.com${href}`, description: '' });
    });
    return { status, jobs };
  }
  return { status: 0, jobs: [] };
}

function decodeEntities(s) { return (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
