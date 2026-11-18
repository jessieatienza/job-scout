import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

export const PROFILE_DIR = path.join(os.homedir(), 'job-scout', '.chrome-profile');

// Plain headless Chrome with its own profile. No fingerprint masking: a site that blocks automated browsers is reported, not evaded.
export async function launchBrowser({ headed = false } = {}) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome', headless: !headed, viewport: { width: 1360, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
    locale: 'en-US', timezoneId: 'America/Los_Angeles',
  });
}

export async function withPage(ctx, fn, { timeout = 45000 } = {}) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeout);
  try { return await fn(page); } finally { await page.close().catch(() => {}); }
}

export const looksBlocked = (text) => /verify you are human|are you a human|unusual traffic|access denied|captcha|just a moment|security check|please verify|humans only|request blocked/i.test(text || '');
