// Guards that sit on top of fuse.js in the catalog-based adapters. fuse.js's
// composite score alone is loose enough to return a different game — the
// documented case being "Cat in Vegas" -> "Weekend In Vegas" on the shared
// tail tokens. Dicey has had a floor since the start; Shuffle and Rainbet did
// not, so a wrong hit counted toward the Gate 1 listed count and could turn a
// game no competitor carries into "Proceed to Phase 2".

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fuzz from 'fuzzball';
import { normName } from '../src/shuffle.js';
import { coversAllTokens, tokensOf } from '../src/rainbet.js';

describe('Shuffle name floor', () => {
  const ratio = (a: string, b: string) => fuzz.ratio(normName(a), normName(b));

  it('accepts real matches at or above the 85 floor', () => {
    assert.ok(ratio('Sweet Bonanza', 'Sweet Bonanza') >= 85);
    assert.ok(ratio('Le Bandit Hold & Win', 'Le Bandit Hold and Win') >= 85);
  });

  it('rejects the documented Cat in Vegas false positive', () => {
    assert.ok(ratio('Cat in Vegas', 'Weekend In Vegas') < 85);
  });

  it('folds apostrophes rather than splitting them', () => {
    assert.equal(normName('Thor’s Thunder Strike'), 'thors thunder strike');
    assert.equal(normName("Goblin's Restaurant"), 'goblins restaurant');
  });
});

describe('Rainbet token coverage', () => {
  // Rainbet names are sitemap slugs, so they carry a provider prefix. A plain
  // ratio floor would reject every genuine match (they measure 68-84), so the
  // prefix is tolerated and coverage does the rejecting instead.
  it('accepts a provider-prefixed slug for the same game', () => {
    assert.ok(
      coversAllTokens("Lawn n' Complete Disorder", 'playn go lawn n complete disorder')
    );
    assert.ok(
      coversAllTokens('Jack and the Beanstalk 2', 'netent jack and the beanstalk 2 goat enterprise')
    );
    assert.ok(coversAllTokens('81 Fruits Fire Blaze', 'spinomenal 81 fruits fire blaze'));
  });

  it('accepts a curly apostrophe against an apostrophe-less slug', () => {
    // normalize() alone splits "Thor's" into "thor" + "s"; no slug covers both.
    assert.deepEqual(tokensOf('Thor’s Thunder Strike'), [
      'thors',
      'thunder',
      'strike'
    ]);
    assert.ok(
      coversAllTokens('Thor’s Thunder Strike', 'spinomenal thors thunder strike')
    );
  });

  it('rejects a different game sharing only a tail', () => {
    assert.ok(!coversAllTokens('Cat in Vegas', 'betsoft weekend in vegas'));
  });

  it('rejects a hit missing any query token', () => {
    assert.ok(!coversAllTokens('Big Bass Bonanza', 'pragmatic big bass splash'));
  });
});
