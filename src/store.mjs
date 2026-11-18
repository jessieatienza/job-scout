import fs from 'node:fs';
import path from 'node:path';

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'jobs.json');
  const runsFile = path.join(dir, 'runs.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const jobs = read(file, {});
  const runs = read(runsFile, []);
  return {
    jobs, runs,
    upsert(key, job, verdict, runId) {
      const prev = jobs[key];
      const rec = { ...(prev || {}), ...job, key, verdict, lastSeenRun: runId, lastSeenAt: new Date().toISOString() };
      if (!prev) { rec.firstSeenRun = runId; rec.firstSeenAt = rec.lastSeenAt; }
      // keep best known applicant info
      if (prev && prev.applicants != null && job.applicants == null) { rec.applicants = prev.applicants; rec.applicantsText = prev.applicantsText; }
      if (prev?.sources && !prev.sources.includes(job.source)) rec.sources = [...prev.sources, job.source]; else rec.sources = prev?.sources || [job.source];
      jobs[key] = rec;
      return { isNew: !prev, rec };
    },
    addRun(run) { runs.unshift(run); if (runs.length > 60) runs.length = 60; },
    save() { fs.writeFileSync(file, JSON.stringify(jobs, null, 1)); fs.writeFileSync(runsFile, JSON.stringify(runs, null, 1)); },
  };
}
