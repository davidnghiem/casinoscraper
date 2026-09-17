import * as fuzz from 'fuzzball';
import { fuzzyFind } from './fuzzy.js';
import type { DiceyResult } from './types.js';

// Post-check on top of fuse.js: require fuzz.ratio ≥ NAME_RATIO_FLOOR between
// the query and the matched candidate name. fuse.js's composite score is
// loose enough that "Cat in Vegas" matches "Weekend In Vegas" (shared tail
// tokens). For recall/urgent paths a false positive means we'd tell the team
// to deactivate the wrong game — strictly worse than missing a match, so we
// err on the side of "Not on Dicey".
const NAME_RATIO_FLOOR = 85;

const GRAPHQL_URL = 'https://api.dicey.com/graphql';

// GameList accepts { search }; provider and pagination fields exist but we
// don't need them — server-side search returns a small superset and fuse.js
// picks the best name match below. RTP is not in the catalog schema, so we
// only report availability.
const GAME_LIST_QUERY = `query GameList($input: GameFiltersInput) {
  gameList(input: $input) {
    items {
      id
      slug
      name
      provider
      isActive
      isGeoRestricted
    }
  }
}`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

interface DiceyGame {
  id: string;
  slug: string;
  name: string;
  provider: string;
  isActive: boolean;
  isGeoRestricted: boolean;
}

interface DiceyResponse {
  data?: { gameList?: { items?: DiceyGame[] } };
  errors?: Array<{ message: string }>;
}

async function fetchCandidates(gameName: string): Promise<DiceyGame[]> {
  const r = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT
    },
    body: JSON.stringify({
      operationName: 'GameList',
      query: GAME_LIST_QUERY,
      variables: { input: { search: gameName } }
    })
  });
  if (!r.ok) throw new Error(`Dicey HTTP ${r.status}`);
  const payload = (await r.json()) as DiceyResponse;
  if (payload.errors?.length) {
    throw new Error(`Dicey GraphQL: ${payload.errors[0]!.message}`);
  }
  return payload.data?.gameList?.items || [];
}

export async function searchDicey(gameName: string): Promise<DiceyResult> {
  const dbg: Record<string, unknown> = {
    url: GRAPHQL_URL,
    candidateCount: 0,
    matchScore: null
  };
  let candidates: DiceyGame[];
  try {
    candidates = await fetchCandidates(gameName);
  } catch (err) {
    return { found: false, error: (err as Error).message, _debug: dbg };
  }
  dbg.candidateCount = candidates.length;
  if (candidates.length === 0) return { found: false, _debug: dbg };

  const hit = fuzzyFind(gameName, candidates, (g) => g.name);
  if (!hit) return { found: false, _debug: dbg };
  const g = hit.item;
  dbg.matchScore = hit.score;
  const ratio = fuzz.ratio(gameName, g.name);
  dbg.nameRatio = ratio;
  if (ratio < NAME_RATIO_FLOOR) {
    dbg.rejectedBy = `name ratio ${ratio} < ${NAME_RATIO_FLOOR}`;
    return { found: false, _debug: dbg };
  }
  return {
    found: true,
    name: g.name,
    slug: g.slug,
    provider: g.provider,
    isActive: g.isActive,
    isGeoRestricted: g.isGeoRestricted,
    rtp: null,
    _debug: dbg
  };
}
