# Job Scout

A local job pipeline for one person. Three times a day it collects fresh product-leadership openings that fit a profile, and one page at `http://127.0.0.1:4747` carries each posting from *New* through *Shortlist*, *Tailoring*, *Ready*, *Applied* or *Passed*. Tailoring drafts resume bullets for the posting next to the closest bullets from your own bank, with the changed words marked, and scores your finals against the posting's keywords. Generation runs through [Claude Code](https://claude.com/claude-code) on your own subscription, so there is no API key.

Everything personal (your profile, bank, postings, picks) lives in `data/` and `config/profile.json`, which are gitignored.

## Setup

```bash
git clone https://github.com/jessieatienza/job-scout ~/job-scout
cd ~/job-scout && npm install
cp config/profile.example.json config/profile.json   # then edit titles, cities, queries
npm run schedule      # installs two launchd agents: the scout at 08:00, 13:00, 18:00, and the page server
npm run open          # http://127.0.0.1:4747
```

Requirements: macOS, Node 20+, Google Chrome (for the two headless sources), and the `claude` CLI signed in (for tailoring).

Add your bank: open the page, paste a posting, or write `data/bank.json` as `{ "summary": "...", "facts": [], "avoid": [], "items": [{ "id": "b1", "role": "Company, title (years)", "group": "Accomplishment", "lean": "angle", "text": "The bullet." }] }`. `facts` are true things the model may use; `avoid` are phrasings it must not produce.

## What passes the scout

- **Title**: regexes in `config/profile.json` → `titles.include` / `exclude`.
- **Age**: posted within `maxAgeHours`. Postings with no date are kept and flagged; sources without dates (YC) are dated by first sighting.
- **Workplace**: remote (in `remoteCountries`) or hybrid near `hybridCities` / `hybridRegions`. On-site is dropped. A Bay-Area-style office with workplace unstated is kept and flagged.
- **Applicants**: under `maxApplicants` where LinkedIn reports a number; unknown counts pass and are flagged.

## Sources

| Source | How | Login |
|---|---|---|
| topstartups.io startup list → each company's Ashby / Greenhouse / Lever / Workable / SmartRecruiters / Rippling board | public APIs | none |
| topstartups.io jobs board | HTML | none |
| LinkedIn jobs, past 24 h, remote and hybrid | guest API | none |
| Built In | HTML | none |
| Wellfound, Work at a Startup (YC) | headless Chrome | none |
| Indeed, Glassdoor | block automated browsers at the edge; collectors exist and return nothing | — |

The scout runs as plain headless Chrome and does not hide that it is automated. A site that blocks it stays blocked and is named in the run log on the page.

## Commands

```bash
npm run run        # one scout run now (all sources)
npm run fast       # fetch-only sources, no browser
npm run serve      # the page server in the foreground (launchd normally keeps it up)
npm run open       # open the page
npm run schedule   # install or refresh both launchd agents
npm run unschedule # remove them
npm run login      # open the scout's own Chrome profile, if a site ever needs a sign-in
```

`node src/run.mjs --only=linkedin,builtin` runs a subset; `--headed` shows the browser.

## Layout

- `src/run.mjs` the scout: sources → `src/match.mjs` → `data/jobs.json`
- `src/server.mjs` the page server and JSON API (`/api/state`, `/api/jobs/:key`, stage, fetch, tailor, take, bank, tracks, run)
- `src/tailor.mjs` the tailoring prompts and the Claude Code call (`claude -p --json-schema`)
- `app/` the page: one HTML file, one stylesheet (light and dark follow the system), one script
- `config/profile.json` your filters, queries and `tailorModel` (default `sonnet`)
- `data/` jobs, stages, runs, bank, tracks, per-posting tailor results (gitignored)
