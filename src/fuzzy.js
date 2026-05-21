import Fuse from 'fuse.js';

export function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digitTokens(s) {
  return (s.match(/\d+/g) || []).sort();
}

function digitTokensMatch(a, b) {
  const ta = digitTokens(a);
  const tb = digitTokens(b);
  if (ta.length !== tb.length) return false;
  return ta.every((tok, i) => tok === tb[i]);
}

export function fuzzyFind(query, items, getName) {
  if (!query) return null;
  const qNorm = normalize(query);

  for (const item of items) {
    if (normalize(getName(item)) === qNorm) return { item, score: 0 };
  }

  const fuse = new Fuse(items, {
    keys: [{ name: 'name', getFn: getName }],
    threshold: 0.25,
    distance: 100,
    ignoreLocation: true,
    includeScore: true
  });

  const hits = fuse.search(query);
  if (hits.length === 0) return null;

  const best = hits[0];
  if (!digitTokensMatch(query, getName(best.item))) {
    if (best.score > 0.1) return null;
  }
  return { item: best.item, score: best.score };
}
