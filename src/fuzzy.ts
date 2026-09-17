import Fuse from 'fuse.js';

export function normalize(name: string | null | undefined): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digitTokens(s: string): string[] {
  return (s.match(/\d+/g) || []).sort();
}

function digitTokensMatch(a: string, b: string): boolean {
  const ta = digitTokens(a);
  const tb = digitTokens(b);
  if (ta.length !== tb.length) return false;
  return ta.every((tok, i) => tok === tb[i]);
}

export interface FuzzyHit<T> {
  item: T;
  score: number;
}

export function fuzzyFind<T>(
  query: string,
  items: readonly T[],
  getName: (item: T) => string
): FuzzyHit<T> | null {
  if (!query) return null;
  const qNorm = normalize(query);

  for (const item of items) {
    if (normalize(getName(item)) === qNorm) return { item, score: 0 };
  }

  const fuse = new Fuse(items as T[], {
    keys: [{ name: 'name', getFn: getName as (obj: T) => string }],
    threshold: 0.25,
    distance: 100,
    ignoreLocation: true,
    includeScore: true
  });

  const hits = fuse.search(query);
  if (hits.length === 0) return null;

  const best = hits[0]!;
  const score = best.score ?? 1;
  if (!digitTokensMatch(query, getName(best.item))) {
    if (score > 0.1) return null;
  }
  return { item: best.item, score };
}
