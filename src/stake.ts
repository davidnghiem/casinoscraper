import type { Page } from 'playwright';
import { getWarmContext, shutdownBrowser } from './browser.js';
import { normalize } from './fuzzy.js';
import type { SiteResult } from './types.js';

const NAV_TIMEOUT_MS = 30_000;
const RTP_TIMEOUT_MS = 6_000;

function toSlug(name: string): string {
  return normalize(name).replace(/\s+/g, '-');
}

function parseRtpFromText(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/(\d{2}(?:\.\d{1,2})?)\s*%/);
  if (!match) return null;
  const val = parseFloat(match[1]!);
  if (val < 80 || val > 100) return null;
  return val;
}

async function extractRtpFromPage(page: Page): Promise<number | null> {
  const candidates = [
    '[data-test*="rtp" i]',
    '[data-testid*="rtp" i]',
    'span:has-text("RTP")',
    'div:has-text("RTP %")'
  ];
  for (const selector of candidates) {
    const text = await page
      .locator(selector)
      .first()
      .textContent({ timeout: RTP_TIMEOUT_MS })
      .catch(() => null);
    const rtp = parseRtpFromText(text);
    if (rtp != null) return rtp;
  }
  const body = await page
    .locator('body')
    .textContent()
    .catch(() => '');
  const match = body && body.match(/RTP[^%]{0,40}(\d{2}(?:\.\d{1,2})?)\s*%/i);
  if (match) {
    const val = parseFloat(match[1]!);
    if (val >= 80 && val <= 100) return val;
  }
  return null;
}

export async function searchStake(gameName: string): Promise<SiteResult> {
  const context = await getWarmContext('stake', 'https://stake.com/casino');
  const slug = toSlug(gameName);
  const url = `https://stake.com/casino/games/${slug}`;
  const page = await context.newPage();
  const dbg: Record<string, unknown> = { url, status: null, title: null };
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS
    });
    if (!response) return { found: false, _debug: dbg };
    const status = response.status();
    dbg.status = status;
    if (status === 404) return { found: false, _debug: dbg };
    if (status >= 400)
      return { found: false, error: `HTTP ${status}`, _debug: dbg };
    const title = (await page.title()) || '';
    dbg.title = title;
    if (/page not found|not found/i.test(title))
      return { found: false, _debug: dbg };
    const rtp = await extractRtpFromPage(page);
    return { found: true, name: gameName, slug, rtp, _debug: dbg };
  } catch (err) {
    return {
      found: false,
      error: (err as Error).message,
      _debug: dbg
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function shutdownStake(): Promise<void> {
  await shutdownBrowser();
}
