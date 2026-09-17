import { getWarmContext } from './browser.js';
import { normalize } from './fuzzy.js';
import type { SiteResult } from './types.js';

const NAV_TIMEOUT_MS = 30_000;
// Roobet is a SPA: the server ships a shell whose <title> is the generic
// "Roobet Crypto Casino | …", and the client swaps in the real game title
// ~2s later. Reading the title at domcontentloaded therefore returned the
// shell for EVERY game and made every lookup a silent false negative, so we
// poll for the real title instead. There is no early "not a game" signal to
// race against — the doubled shell title is a stage that *found* games pass
// through too — so a miss costs the full timeout. The slug candidates are
// therefore tried in parallel rather than in sequence.
const TITLE_SETTLE_TIMEOUT_MS = 8_000;

// Roobet's slot detail pages settle on:
//   "Play <Game Name> Slot Online - <Provider> At Roobet Casino"
// Unknown slugs stay on the default casino page whose title contains
// "Roobet Crypto Casino" with no game name.
const GAME_TITLE_RE = /play\s+(.+?)\s+slot\s+online\s*[-—]\s*(.+?)\s+at\s+roobet/i;

function toSlug(name: string): string {
  return normalize(name).replace(/\s+/g, '-');
}

// Roobet's detail URLs are provider-prefixed — /casino/game/pragmatic-play-
// gates-of-olympus, not /casino/game/gates-of-olympus. A few big titles also
// answer on the bare slug, so try the prefixed form first and fall back.
function candidateSlugs(gameName: string, provider?: string | null): string[] {
  const game = toSlug(gameName);
  const out: string[] = [];
  if (provider) out.push(`${toSlug(provider)}-${game}`);
  out.push(game);
  return [...new Set(out)];
}

export async function searchRoobet(
  gameName: string,
  provider?: string | null
): Promise<SiteResult> {
  const slugs = candidateSlugs(gameName, provider);
  const attempts = slugs.map((s) => tryRoobetSlug(s));
  // Resolve as soon as either candidate hits, so a found game costs one title
  // settle (~2s) instead of waiting on the loser's full timeout.
  try {
    return await Promise.any(
      attempts.map(async (p) => {
        const r = await p;
        if (!r.found) throw new Error('not found');
        return r;
      })
    );
  } catch {
    const settled = await Promise.all(
      attempts.map((p) => p.catch((): SiteResult => ({ found: false })))
    );
    return settled.find((r) => r.error) ?? settled[0] ?? { found: false };
  }
}

async function tryRoobetSlug(slug: string): Promise<SiteResult> {
  const context = await getWarmContext('roobet', 'https://roobet.com/casino');
  const url = `https://roobet.com/casino/game/${slug}`;
  const page = await context.newPage();
  const dbg: Record<string, unknown> = {
    url,
    status: null,
    title: null,
    titleMatched: false
  };
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

    // Wait for the client-rendered title. Timing out is the ordinary
    // "Roobet doesn't carry this game" path, not an error.
    let settled = true;
    try {
      await page.waitForFunction(
        (src: string) => new RegExp(src, 'i').test(document.title),
        GAME_TITLE_RE.source,
        { timeout: TITLE_SETTLE_TIMEOUT_MS }
      );
    } catch {
      settled = false;
    }
    dbg.titleSettled = settled;

    const title = (await page.title()) || '';
    dbg.title = title;
    const match = title.match(GAME_TITLE_RE);
    if (!match) {
      return { found: false, _debug: dbg };
    }
    dbg.titleMatched = true;
    return {
      found: true,
      name: match[1]!.trim(),
      provider: match[2]!.trim(),
      slug,
      rtp: null,
      _debug: dbg
    };
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
