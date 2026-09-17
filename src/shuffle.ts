import { fuzzyFind } from './fuzzy.js';
import type { SiteResult } from './types.js';

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
