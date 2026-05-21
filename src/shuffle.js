import { fuzzyFind } from './fuzzy.js';

const CATALOG_URL =
  'https://shuffle.com/main-api/bp-storage/public-assets/games/games.json';
const TTL_MS = 60 * 60 * 1000;

let cached = null;
let cachedAt = 0;

async function loadCatalog() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  const r = await fetch(CATALOG_URL, {
    headers: { 'user-agent': 'casinoscraper/0.1 (slot-availability-check)' }
  });
  if (!r.ok) throw new Error(`Shuffle catalog HTTP ${r.status}`);
  cached = await r.json();
  cachedAt = Date.now();
  return cached;
}

function edgeToRtp(edge) {
  if (typeof edge !== 'number') return null;
  return (10000 - edge) / 100;
}

function isSlot(game) {
  return (game.gameAndGameCategories || []).some(
    (c) => c.gameCategoryName === 'SLOTS'
  );
}

export async function searchShuffle(gameName) {
  const catalog = await loadCatalog();
  const slots = catalog.filter(isSlot);
  const dbg = { catalogUrl: CATALOG_URL, slotCount: slots.length, matchScore: null };
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
    restrictions: g.restrictions || [],
    matchScore: hit.score,
    _debug: dbg
  };
}
