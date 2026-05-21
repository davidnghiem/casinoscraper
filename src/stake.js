import { getWarmContext, shutdownBrowser } from './browser.js';
import { normalize } from './fuzzy.js';

const NAV_TIMEOUT_MS = 30_000;
const RTP_TIMEOUT_MS = 6_000;

function toSlug(name) {
  return normalize(name).replace(/\s+/g, '-');
}

function parseRtpFromText(text) {
  if (!text) return null;
  const match = text.match(/(\d{2}(?:\.\d{1,2})?)\s*%/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  if (val < 80 || val > 100) return null;
  return val;
}

async function extractRtpFromPage(page) {
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
  const body = await page.locator('body').textContent().catch(() => '');
  const match = body && body.match(/RTP[^%]{0,40}(\d{2}(?:\.\d{1,2})?)\s*%/i);
  if (match) {
    const val = parseFloat(match[1]);
    if (val >= 80 && val <= 100) return val;
  }
  return null;
}

export async function searchStake(gameName) {
  const context = await getWarmContext('stake', 'https://stake.com/casino');
  const slug = toSlug(gameName);
  const url = `https://stake.com/casino/games/${slug}`;
  const page = await context.newPage();
  const dbg = { url, status: null, title: null };
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS
    });
    if (!response) return { found: false, _debug: dbg };
    dbg.status = response.status();
    if (dbg.status === 404) return { found: false, _debug: dbg };
    if (dbg.status >= 400) return { found: false, error: `HTTP ${dbg.status}`, _debug: dbg };
    dbg.title = (await page.title()) || '';
    if (/page not found|not found/i.test(dbg.title)) return { found: false, _debug: dbg };
    const rtp = await extractRtpFromPage(page);
    return { found: true, name: gameName, slug, rtp, _debug: dbg };
  } catch (err) {
    return { found: false, error: err.message, _debug: dbg };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function shutdownStake() {
  await shutdownBrowser();
}
