const rx = (arr, flags = 'i') => arr.map((s) => new RegExp(s, flags));
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function makeMatcher(profile) {
  const inc = rx(profile.titles.include);
  const exc = rx(profile.titles.exclude);
  const excOverride = rx(profile.titles.excludeOverrides || []);
  const strong = rx(profile.domainKeywords.strong);
  const medium = rx(profile.domainKeywords.medium);
  const hybridCities = rx(profile.location.hybridCities.map((c) => `\\b${c}\\b`));
  const hybridRegions = rx(profile.location.hybridRegions);
  const remoteCountries = rx(profile.location.remoteCountries);
  const remoteOutside = rx(profile.location.excludeRemoteOutside);
  const maxAgeMs = profile.maxAgeHours * 3600e3;

  function titleMatch(title) {
    const t = norm(title);
    if (!inc.some((r) => r.test(t))) return { ok: false, reason: 'title not in scope' };
    if (exc.some((r) => r.test(t)) && !excOverride.some((r) => r.test(t))) return { ok: false, reason: 'title excluded' };
    return { ok: true };
  }

  // Returns {mode: 'remote'|'hybrid'|'onsite'|'unknown', near: bool, ok: bool, reason}
  function locationCheck(job) {
    const loc = norm(job.location);
    const desc = norm(job.description || '');
    const hint = job.workplaceHint;
    const wt = norm(job.workplaceType || job.workplaceText || '');
    let mode = 'unknown';
    if (job.isRemote === true || /remote/.test(wt) || /\bremote\b/.test(loc) || hint === 'remote') mode = 'remote';
    if (/hybrid/.test(wt) || /\bhybrid\b/.test(loc) || hint === 'hybrid') mode = 'hybrid';
    if (mode === 'unknown' && (/on-?site|in[- ]office|in[- ]person/.test(wt) || hint === 'onsite')) mode = 'onsite';
    if (mode === 'unknown' && /\bhybrid\b/.test(desc) && !/\bremote\b/.test(desc)) mode = 'hybrid';
    if (mode === 'unknown' && /fully remote|remote-first|remote first|work from anywhere|100% remote/.test(desc)) mode = 'remote';
    const near = hybridCities.some((r) => r.test(loc)) || hybridRegions.some((r) => r.test(loc));
    if (mode === 'remote') {
      // Remote but restricted to another region?
      const outside = remoteOutside.some((r) => r.test(loc)) && !remoteCountries.some((r) => r.test(loc)) && !near;
      if (outside) return { mode, near, ok: false, reason: `remote outside US (${job.location})` };
      return { mode, near, ok: true };
    }
    if (mode === 'hybrid') return near ? { mode, near, ok: true } : { mode, near, ok: false, reason: `hybrid away from Bay Area (${job.location})` };
    if (mode === 'onsite') return { mode, near, ok: false, reason: `on-site (${job.location})` };
    // unknown
    if (near) return { mode, near, ok: true, flag: 'workplace not stated; Bay Area office' };
    if (!loc) return { mode, near, ok: true, flag: 'location not stated' };
    return { mode, near, ok: false, reason: `location ${job.location}, workplace not stated` };
  }

  function ageCheck(job) {
    if (!job.postedAt) return { ok: true, flag: 'posted date unknown' };
    const age = Date.now() - Date.parse(job.postedAt);
    return age <= maxAgeMs ? { ok: true, ageHours: Math.round(age / 3600e3) } : { ok: false, reason: `posted ${Math.round(age / 3600e3)}h ago` };
  }

  function applicantCheck(job) {
    if (job.applicants == null) return { ok: true, flag: 'applicant count unknown' };
    return job.applicants < profile.maxApplicants ? { ok: true } : { ok: false, reason: `${job.applicantsText || job.applicants} applicants` };
  }

  function score(job, loc) {
    const t = norm(job.title);
    let s = 0;
    if (/principal|director|head of|group product|staff/.test(t)) s += 4;
    else if (/senior|sr\.?|lead|founding/.test(t)) s += 3;
    else s += 2;
    const text = `${t} ${norm(job.description || '')} ${norm(job.department || '')} ${norm(job.companyMeta?.blurb || '')} ${(job.companyMeta?.tags || []).join(' ').toLowerCase()}`;
    const sh = strong.filter((r) => r.test(text)).length;
    const mh = medium.filter((r) => r.test(text)).length;
    s += Math.min(sh * 2, 10) + Math.min(mh, 5);
    if (job.companyMeta) s += 2;
    if (loc.mode === 'remote') s += 1;
    if (job.applicants != null && job.applicants < profile.maxApplicants) s += 1;
    return s;
  }

  return {
    evaluate(job) {
      const t = titleMatch(job.title);
      if (!t.ok) return { pass: false, stage: 'title', reason: t.reason };
      const a = ageCheck(job);
      if (!a.ok) return { pass: false, stage: 'age', reason: a.reason };
      const l = locationCheck(job);
      if (!l.ok) return { pass: false, stage: 'location', reason: l.reason };
      const p = applicantCheck(job);
      if (!p.ok) return { pass: false, stage: 'applicants', reason: p.reason };
      const flags = [a.flag, l.flag, p.flag].filter(Boolean);
      return { pass: true, mode: l.mode, near: l.near, ageHours: a.ageHours, flags, score: score(job, l) };
    },
    titleMatch,
  };
}

export function dedupeKey(job) {
  const c = norm(job.company).replace(/[^a-z0-9]/g, '').slice(0, 24);
  const t = norm(job.title).replace(/\(.*?\)|[-–,|].*$/g, '').replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, ' ').slice(0, 48);
  return `${c}::${t}`;
}
