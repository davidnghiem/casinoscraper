import { getWarmContext } from './browser.js';
import { normalize } from './fuzzy.js';

const NAV_TIMEOUT_MS = 30_000;
const DEFAULT_TITLE_FRAGMENT = 'roobet crypto casino';

// Roobet's slot detail pages set <title> to:
//   "Play <Game Name> Slot Online - <Provider> At Roobet Casino"
// Unknown slugs land on the default casino page whose title contains
// "Roobet Crypto Casino" with no game name.
const GAME_TITLE_RE = /play\s+(.+?)\s+slot\s+online\s*[-—]\s*(.+?)\s+at\s+roobet/i;

function toSlug(name) {
  return normalize(name).replace(/\s+/g, '-');
}

export async function searchRoobet(gameName) {
  const context = await getWarmContext('roobet', 'https://roobet.com/casino');
  const slug = toSlug(gameName);
  const url = `https://roobet.com/casino/game/${slug}`;
  const page = await context.newPage();
  const dbg = { url, status: null, title: null, titleMatched: false };
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
    const match = dbg.title.match(GAME_TITLE_RE);
    if (!match) {
      return { found: false, _debug: dbg };
    }
    dbg.titleMatched = true;
    return {
      found: true,
      name: match[1].trim(),
      provider: match[2].trim(),
      slug,
      rtp: null,
      _debug: dbg
    };
  } catch (err) {
    return { found: false, error: err.message, _debug: dbg };
  } finally {
    await page.close().catch(() => {});
  }
}
