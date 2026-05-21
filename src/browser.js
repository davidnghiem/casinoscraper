import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const CTX_TTL_MS = 25 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;

const COMMON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let browser = null;
let starting = null;
const contexts = new Map();

async function getBrowser() {
  if (browser) return browser;
  if (starting) return starting;
  starting = chromium.launch({ headless: true }).then((b) => {
    browser = b;
    starting = null;
    return b;
  });
  return starting;
}

export async function getWarmContext(key, warmupUrl) {
  const existing = contexts.get(key);
  if (existing?.context && Date.now() - existing.warmedAt < CTX_TTL_MS) {
    return existing.context;
  }
  if (existing?.warming) return existing.warming;

  const warming = (async () => {
    const b = await getBrowser();
    if (existing?.context) await existing.context.close().catch(() => {});
    const ctx = await b.newContext({
      userAgent: COMMON_UA,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US'
    });
    const page = await ctx.newPage();
    try {
      await page.goto(warmupUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS
      });
      await page
        .waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS })
        .catch(() => {});
    } finally {
      await page.close();
    }
    contexts.set(key, { context: ctx, warmedAt: Date.now(), warming: null });
    return ctx;
  })();

  contexts.set(key, { ...(existing || {}), warming });
  return warming;
}

export async function shutdownBrowser() {
  for (const entry of contexts.values()) {
    if (entry?.context) await entry.context.close().catch(() => {});
  }
  contexts.clear();
  if (browser) await browser.close().catch(() => {});
  browser = null;
}
