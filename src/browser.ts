import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext } from 'playwright';

chromium.use(StealthPlugin());

const CTX_TTL_MS = 25 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;

const COMMON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;

interface CtxEntry {
  context?: BrowserContext;
  warmedAt?: number;
  warming?: Promise<BrowserContext> | null;
}

const contexts = new Map<string, CtxEntry>();

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (starting) return starting;
  starting = chromium.launch({ headless: true }).then((b: Browser) => {
    browser = b;
    starting = null;
    return b;
  });
  return starting;
}

export async function getWarmContext(
  key: string,
  warmupUrl: string
): Promise<BrowserContext> {
  const existing = contexts.get(key);
  if (
    existing?.context &&
    existing.warmedAt != null &&
    Date.now() - existing.warmedAt < CTX_TTL_MS
  ) {
    return existing.context;
  }
  if (existing?.warming) return existing.warming;

  const warming = (async (): Promise<BrowserContext> => {
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
  })().catch((err) => {
    // Don't poison the cache with a rejected promise — without this, every
    // subsequent call returns the same Cloudflare/timeout rejection forever.
    // Delete the entry so the next call kicks off a fresh warmup.
    contexts.delete(key);
    throw err;
  });

  contexts.set(key, { ...(existing || {}), warming });
  return warming;
}

export async function shutdownBrowser(): Promise<void> {
  for (const entry of contexts.values()) {
    if (entry?.context) await entry.context.close().catch(() => {});
  }
  contexts.clear();
  if (browser) await browser.close().catch(() => {});
  browser = null;
}
