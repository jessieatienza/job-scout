// Opens the scout's own Chrome profile so you can sign in once to LinkedIn, Indeed, Glassdoor, Wellfound and Work at a Startup.
import { launchBrowser } from '../src/browser/launch.mjs';
const ctx = await launchBrowser({ headed: true });
const sites = ['https://www.linkedin.com/login', 'https://secure.indeed.com/auth', 'https://www.glassdoor.com/profile/login_input.htm', 'https://wellfound.com/login', 'https://www.workatastartup.com/login'];
for (const s of sites) { const p = await ctx.newPage(); await p.goto(s).catch(() => {}); }
console.log('Sign in to each tab, then close the Chrome window. Sessions are kept in ~/job-scout/.chrome-profile.');
await new Promise((r) => ctx.on('close', r));
