import { getWarmContext } from './browser.js';
import { fuzzyFind } from './fuzzy.js';

const CATALOG_URL =
  'https://services.rainbet.com/v1/public/games/list?grouping=slots';
const TTL_MS = 60 * 60 * 1000;

let cached = null;
let cachedAt = 0;
let loading = null;

function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.data || payload?.games || payload?.results || [];
}

function gameName(g) {
  return g.name || g.title || g.slug || '';
}

function gameRtp(g) {
  if (typeof g.rtp === 'number' && g.rtp > 50) return g.rtp;
  if (typeof g.return_to_player === 'number') return g.return_to_player;
  if (typeof g.edge === 'number') return (10000 - g.edge) / 100;
  return null;
}

function gameProvider(g) {
  if (typeof g.provider === 'string') return g.provider;
  return g.provider?.name || g.provider_name || g.studio || null;
}

async function loadCatalog() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  if (loading) return loading;

  loading = (async () => {
    const context = await getWarmContext(
      'rainbet',
      'https://rainbet.com/casino'
    );
    const page = await context.newPage();
    try {
      const payload = await page.evaluate(async (url) => {
        const r = await fetch(url);
        if (!r.ok) return { __status: r.status };
        return await r.json();
      }, CATALOG_URL);
      if (payload?.__status) {
        throw new Error(`Rainbet catalog HTTP ${payload.__status}`);
      }
      const list = extractList(payload);
      cached = list;
      cachedAt = Date.now();
      return list;
    } finally {
      await page.close().catch(() => {});
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export async function searchRainbet(query) {
  const dbg = { catalogUrl: CATALOG_URL, catalogSize: null, matchScore: null, matchKeys: null };
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (err) {
    return { found: false, error: err.message, _debug: dbg };
  }
  dbg.catalogSize = Array.isArray(catalog) ? catalog.length : 0;
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return { found: false, error: 'empty catalog', _debug: dbg };
  }
  const hit = fuzzyFind(query, catalog, gameName);
  if (!hit) return { found: false, _debug: dbg };
  const g = hit.item;
  dbg.matchScore = hit.score;
  dbg.matchKeys = Object.keys(g);
  return {
    found: true,
    name: gameName(g),
    slug: g.slug || null,
    rtp: gameRtp(g),
    provider: gameProvider(g),
    _debug: dbg
  };
}
