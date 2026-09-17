import * as fuzz from 'fuzzball';
import { fuzzyFind, normalize } from './fuzzy.js';
import type { SiteResult } from './types.js';

// Rainbet names come from sitemap slugs, so they carry a provider prefix
// ("playn go lawn n complete disorder"). A straight fuzz.ratio floor like
// Dicey's would reject legitimate matches — the real ones measure 68-84 — so
// the prefix has to be tolerated while still rejecting a different game.
// Measured on real data: every genuine match scores partial_ratio >= 98 and has
// full query-token coverage, while "Cat in Vegas" -> "betsoft weekend in vegas"
// scores 75 and is missing the "cat" token. Requiring both is what separates
// them; token_set_ratio does not (81 genuine vs 80 false).
const PARTIAL_RATIO_FLOOR = 90;

// Apostrophes are dropped rather than turned into a space, so "Thor's" tokenizes
// as "thors" and lines up with the slug's "thors". normalize() alone would split
// it into "thor" + "s" and no slug would ever cover both.
export function tokensOf(s: string): string[] {
  return normalize(s.replace(/['\u2018\u2019\u02BC]/g, ''))
    .split(' ')
    .filter(Boolean);
}

// Every token of the query must appear in the candidate. This is what rejects
// a hit that merely shares a tail ("in vegas") with a different game.
export function coversAllTokens(query: string, candidate: string): boolean {
  const have = new Set(tokensOf(candidate));
  return tokensOf(query).every((t) => have.has(t));
}

// Rainbet's JSON catalog API (services.rainbet.com) sits behind a Cloudflare
// Turnstile managed challenge: every call — even from the site's own frontend —
// returns 403 + a "Checking your browser..." interstitial until Turnstile issues
// a cf_clearance cookie, which a headless/stealth fetch cannot reliably obtain.
//
// The public sitemap on the MAIN domain is NOT challenged and lists every slot
// detail page as /casino/slots/<provider>-<game-slug>. We treat that as the
// catalog and fuzzy-match the game name against it. RTP isn't exposed here, so
// (like Roobet) we report availability only. See scripts/probe-rainbet.ts for
// the investigation that established this.
const CATALOG_URL = 'https://rainbet.com/sitemap/casino.xml';
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

interface RainbetGame {
  slug: string;
  name: string;
}

let cached: RainbetGame[] | null = null;
let cachedAt = 0;
let loading: Promise<RainbetGame[]> | null = null;

function parseSitemap(xml: string): RainbetGame[] {
  const games: RainbetGame[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = m[1]!;
    // Match game detail pages only, e.g. .../casino/slots/pragmatic-play-gates
    // — exclude the bare /casino/slots index and any nested category paths.
    const slugMatch = url.match(/\/casino\/slots\/([^/]+)$/);
    if (!slugMatch) continue;
    const slug = slugMatch[1]!;
    games.push({ slug, name: slug.replace(/-/g, ' ') });
  }
  return games;
}

async function loadCatalog(): Promise<RainbetGame[]> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  if (loading) return loading;

  loading = (async (): Promise<RainbetGame[]> => {
    const r = await fetch(CATALOG_URL, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml,text/xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!r.ok) throw new Error(`Rainbet sitemap HTTP ${r.status}`);
    const games = parseSitemap(await r.text());
    if (games.length === 0) throw new Error('Rainbet sitemap parsed to 0 games');
    cached = games;
    cachedAt = Date.now();
    return games;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export async function searchRainbet(query: string): Promise<SiteResult> {
  const dbg: Record<string, unknown> = {
    catalogUrl: CATALOG_URL,
    catalogSize: null,
    matchScore: null,
    matchedSlug: null
  };
  let catalog: RainbetGame[];
  try {
    catalog = await loadCatalog();
  } catch (err) {
    return { found: false, error: (err as Error).message, _debug: dbg };
  }
  dbg.catalogSize = catalog.length;

  const hit = fuzzyFind(query, catalog, (g) => g.name);
  if (!hit) return { found: false, _debug: dbg };
  const g = hit.item;
  dbg.matchScore = hit.score;
  dbg.matchedSlug = g.slug;

  const partial = fuzz.partial_ratio(
    tokensOf(query).join(' '),
    tokensOf(g.name).join(' ')
  );
  const covered = coversAllTokens(query, g.name);
  dbg.partialRatio = partial;
  dbg.tokensCovered = covered;
  if (partial < PARTIAL_RATIO_FLOOR || !covered) {
    dbg.rejectedBy = covered
      ? `partial ratio ${partial} < ${PARTIAL_RATIO_FLOOR}`
      : 'query tokens not all present in candidate';
    return { found: false, _debug: dbg };
  }

  return {
    found: true,
    name: g.name,
    slug: g.slug,
    rtp: null,
    provider: null,
    matchScore: hit.score,
    _debug: dbg
  };
}
