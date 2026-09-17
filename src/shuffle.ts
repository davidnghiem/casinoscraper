import * as fuzz from 'fuzzball';
import { fuzzyFind, normalize } from './fuzzy.js';
import type { SiteResult } from './types.js';

// Same post-check as the Dicey adapter, for the same reason: fuse.js's
// composite score is loose enough that "Cat in Vegas" comes back as
// "Weekend In Vegas" on the shared tail tokens. Shuffle's catalog stores real
// titles, so a straight ratio is the right measure. A false positive here is
// worse than a miss — it inflates the Gate 1 listed count and can turn a game
// no competitor carries into "Proceed to Phase 2".
const NAME_RATIO_FLOOR = 85;

// Drop apostrophes instead of spacing them out, so "Thor's" compares as
// "thors" against catalogs that spell it either way.
export function normName(s: string): string {
  return normalize(s.replace(/['\u2018\u2019\u02BC]/g, ''));
}

const CATALOG_URL =
  'https://shuffle.com/main-api/bp-storage/public-assets/games/games.json';
const TTL_MS = 60 * 60 * 1000;

interface ShuffleGame {
  name: string;
  slug?: string;
  edge?: number;
  provider?: { name?: string };
  restrictions?: unknown[];
  gameAndGameCategories?: Array<{ gameCategoryName?: string }>;
}

let cached: ShuffleGame[] | null = null;
let cachedAt = 0;

async function loadCatalog(): Promise<ShuffleGame[]> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  const r = await fetch(CATALOG_URL, {
    headers: { 'user-agent': 'casinoscraper/0.1 (slot-availability-check)' }
  });
  if (!r.ok) throw new Error(`Shuffle catalog HTTP ${r.status}`);
  cached = (await r.json()) as ShuffleGame[];
  cachedAt = Date.now();
  return cached;
}

function edgeToRtp(edge: number | undefined): number | null {
  if (typeof edge !== 'number') return null;
  return (10000 - edge) / 100;
}

function isSlot(game: ShuffleGame): boolean {
  return (game.gameAndGameCategories || []).some(
    (c) => c.gameCategoryName === 'SLOTS'
  );
}

export async function searchShuffle(gameName: string): Promise<SiteResult> {
  const catalog = await loadCatalog();
  const slots = catalog.filter(isSlot);
  const dbg: Record<string, unknown> = {
    catalogUrl: CATALOG_URL,
    slotCount: slots.length,
    matchScore: null
  };
  const hit = fuzzyFind(gameName, slots, (g) => g.name);
  if (!hit) return { found: false, _debug: dbg };
  const g = hit.item;
  dbg.matchScore = hit.score;

  const ratio = fuzz.ratio(normName(gameName), normName(g.name));
  dbg.nameRatio = ratio;
  if (ratio < NAME_RATIO_FLOOR) {
    dbg.rejectedBy = `name ratio ${ratio} < ${NAME_RATIO_FLOOR}`;
    return { found: false, _debug: dbg };
  }

  return {
    found: true,
    name: g.name,
    slug: g.slug,
    rtp: edgeToRtp(g.edge),
    provider: g.provider?.name || null,
    matchScore: hit.score,
    _debug: dbg
  };
}
