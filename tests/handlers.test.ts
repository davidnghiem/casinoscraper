// Release-flow tests: drive formatReleaseReply with fixture site results and
// assert the rendered Slack output. The real fan-out happens in handleRelease,
// which is exercised end-to-end by `npm run dryrun:alerts --include-releases`;
// here we cover the per-game section composition + Gate 1 wiring without
// touching the network.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  formatReleaseReply,
  type CheckedReleaseGame
} from '../src/handlers.js';
import { computeGate } from '../src/gate.js';

function makeRelease(
  override: Partial<CheckedReleaseGame> & {
    game: string;
    matchedProviders: string[];
  }
): CheckedReleaseGame {
  const results = override.results ?? {
    shuffle: { found: false },
    stake: { found: false },
    rainbet: { found: false },
    roobet: { found: false }
  };
  return {
    providerRaw: override.providerRaw ?? override.matchedProviders[0]!,
    provider: override.matchedProviders[0],
    location: 'Curacao+Malta',
    rtp: null,
    fee: null,
    certs: null,
    dicey: override.dicey ?? { found: false },
    results,
    gate: override.gate ?? computeGate(results),
    ...override
  };
}

describe('formatReleaseReply — release flow', () => {
  it('reports 4/4 aligned RTPs as proceed + active on Dicey', () => {
    const game = makeRelease({
      game: 'The Big Dog House',
      matchedProviders: ['Pragmatic Play'],
      rtp: 96.53,
      dicey: {
        found: true,
        name: 'The Big Dog House',
        slug: 'TheBigDogHouse',
        isActive: true,
        isGeoRestricted: false
      },
      results: {
        shuffle: { found: true, rtp: 96.53 },
        stake: { found: true, rtp: 96.51 },
        rainbet: { found: true, rtp: 96.5 },
        roobet: { found: true, rtp: null }
      }
    });
    const reply = formatReleaseReply([game]);
    assert.match(reply, /1 matched release checked/);
    assert.match(reply, /\*The Big Dog House\* \(Pragmatic Play\)/);
    assert.match(reply, /Already on Dicey \(slug: TheBigDogHouse\)/);
    assert.match(reply, /Source RTP: 96\.53%/);
    assert.match(reply, /Shuffle — RTP 96\.53%/);
    assert.match(reply, /Stake — RTP 96\.51%/);
    assert.match(reply, /Roobet — listed \(RTP not published\)/);
    assert.match(reply, /Gate 1:\*.*Proceed to Phase 2/);
  });

  it('reports 0/4 listed as escalate + not-on-Dicey', () => {
    const game = makeRelease({
      game: 'Phantom Slot XYZ',
      matchedProviders: ['Hacksaw Gaming'],
      rtp: 96.0
    });
    const reply = formatReleaseReply([game]);
    assert.match(reply, /Not on Dicey yet/);
    assert.match(reply, /Shuffle — not found/);
    assert.match(reply, /Stake — not found/);
    assert.match(reply, /Rainbet — not found/);
    assert.match(reply, /Roobet — not found/);
    assert.match(
      reply,
      /Gate 1:\*.*Escalate to Enhanced Due Diligence/
    );
  });

  it('reports RTP mismatch > 0.5 pp as reject', () => {
    const game = makeRelease({
      game: 'Mismatched Slot',
      matchedProviders: ['Pragmatic Play'],
      rtp: 96.5,
      results: {
        shuffle: { found: true, rtp: 96.5 },
        stake: { found: true, rtp: 94.0 },
        rainbet: { found: true, rtp: 96.5 },
        roobet: { found: false }
      }
    });
    const reply = formatReleaseReply([game]);
    assert.match(reply, /Gate 1:\*.*Do NOT proceed/);
    assert.match(reply, /RTP mismatch/);
    assert.match(reply, /Δ 2\.50pp/);
  });

  it('preserves slash provider in display, with Matched note for partial hit', () => {
    const game = makeRelease({
      game: 'Jackpot Train',
      providerRaw: 'Evolution/Redtiger',
      matchedProviders: ['Evolution', 'Red Tiger']
    });
    const reply = formatReleaseReply([game]);
    assert.match(reply, /\*Jackpot Train\* \(Evolution\/Redtiger\)/);
    // Both sides matched → no "Matched:" annotation line.
    assert.ok(!reply.includes('Matched:'), 'no Matched line when both sides hit');
  });

  it('shows Matched: note when only one slash side hits allowlist', () => {
    const game = makeRelease({
      game: 'Mystery Game',
      providerRaw: 'UnknownStudio/Pragmaticplay',
      matchedProviders: ['Pragmatic Play']
    });
    const reply = formatReleaseReply([game]);
    assert.match(reply, /UnknownStudio\/Pragmaticplay/);
    assert.match(reply, /Matched: Pragmatic Play/);
  });

  it('multi-game release renders one section per game', () => {
    const games = [
      makeRelease({ game: 'Game A', matchedProviders: ['NetEnt'] }),
      makeRelease({ game: 'Game B', matchedProviders: ['Yggdrasil'] }),
      makeRelease({ game: 'Game C', matchedProviders: ['Playtech'] })
    ];
    const reply = formatReleaseReply(games);
    assert.match(reply, /3 matched releases checked/);
    assert.match(reply, /\*Game A\*/);
    assert.match(reply, /\*Game B\*/);
    assert.match(reply, /\*Game C\*/);
  });

  it('On Dicey but inactive surfaces the correct line', () => {
    const game = makeRelease({
      game: 'Inactive Slot',
      matchedProviders: ['NetEnt'],
      dicey: {
        found: true,
        name: 'Inactive Slot',
        slug: 'InactiveSlot',
        isActive: false,
        isGeoRestricted: false
      }
    });
    const reply = formatReleaseReply([game]);
    assert.match(reply, /On Dicey but inactive \(slug: InactiveSlot\)/);
  });

  it('Site error surfaces the error in the line', () => {
    const game = makeRelease({
      game: 'Errored Slot',
      matchedProviders: ['NetEnt'],
      results: {
        shuffle: { found: false, error: 'HTTP 503' },
        stake: { found: false },
        rainbet: { found: false },
        roobet: { found: false }
      }
    });
    const reply = formatReleaseReply([game]);
    assert.match(reply, /Shuffle — error: HTTP 503/);
  });
});

describe('formatReleaseReply — naming and config labels', () => {
  it('does not let Rainbet\'s slug-derived name replace the release title', () => {
    // Rainbet names come from its sitemap slug: lowercased, punctuation
    // stripped, provider prefixed. Only Rainbet lists this game.
    const out = formatReleaseReply([
      makeRelease({
        game: "Lawn n' Complete Disorder",
        matchedProviders: ["Play'n GO"],
        results: {
          shuffle: { found: false },
          stake: { found: false },
          rainbet: {
            found: true,
            name: 'playn go lawn n complete disorder',
            slug: 'playn-go-lawn-n-complete-disorder'
          },
          roobet: { found: false }
        }
      })
    ]);
    assert.match(out, /\*Lawn n' Complete Disorder\*/);
    assert.doesNotMatch(out, /playn go lawn n complete disorder/);
  });

  it('prefers a real title from Roobet over the raw alert title', () => {
    const out = formatReleaseReply([
      makeRelease({
        game: 'Sweet Bonanza',
        matchedProviders: ['Pragmatic Play'],
        results: {
          shuffle: { found: false },
          stake: { found: false },
          rainbet: { found: false },
          roobet: { found: true, name: 'Sweet Bonanza 1000' }
        }
      })
    ]);
    assert.match(out, /\*Sweet Bonanza 1000\*/);
  });

  it('omits the build tag when the fee label is shared across configs', () => {
    // Playtech ships four builds all labelled `gpas` — "(=gpas)" says nothing.
    const configs = [
      { fee: 'gpas', rtp: 95.9, certs: null },
      { fee: 'gpas', rtp: 94.91, certs: null },
      { fee: 'gpas', rtp: 93.46, certs: null },
      { fee: 'gpas', rtp: 91.96, certs: null }
    ];
    const out = formatReleaseReply([
      makeRelease({
        game: 'Cash Fortress',
        matchedProviders: ['Playtech'],
        configs,
        results: {
          shuffle: { found: true, rtp: 94.91 },
          stake: { found: false },
          rainbet: { found: false },
          roobet: { found: false }
        }
      })
    ]);
    assert.match(out, /Shuffle — RTP 94\.91%$/m);
    assert.match(out, /Configs \(4, shared fee label\)/);
  });

  it('names the build when the fee label is unique, and flags an unpublished RTP', () => {
    const configs = [
      { fee: 'hacksaw_basic', rtp: 96.23, certs: null },
      { fee: 'hacksaw_rtp94', rtp: 94.29, certs: null },
      { fee: 'hacksaw_rtp', rtp: 92.28, certs: null }
    ];
    const out = formatReleaseReply([
      makeRelease({
        game: 'Fist of Destruction Megamultiplier',
        matchedProviders: ['Hacksaw Gaming'],
        configs,
        results: {
          shuffle: { found: true, rtp: 94.29 },
          stake: { found: true, rtp: 90.0 },
          rainbet: { found: false },
          roobet: { found: false }
        }
      })
    ]);
    assert.match(out, /Shuffle — RTP 94\.29% \(=hacksaw_rtp94\)/);
    assert.match(out, /Stake — RTP 90\.00% ⚠️ no published config/);
  });
});

describe('formatReleaseReply — verdict tally header', () => {
  // A release reply is ~10 lines per game with no cap, so Slack collapses it
  // behind "Show more" from roughly ten games up. The tally puts the outcome
  // in the first line, which is what stays visible while collapsed.
  const withVerdict = (v: 'proceed' | 'escalate' | 'reject') => {
    const results: CheckedReleaseGame['results'] =
      v === 'proceed'
        ? {
            shuffle: { found: true, rtp: 96.5 },
            stake: { found: true, rtp: 96.5 },
            rainbet: { found: true },
            roobet: { found: true }
          }
        : v === 'reject'
          ? {
              shuffle: { found: true, rtp: 96.5 },
              stake: { found: true, rtp: 92.0 },
              rainbet: { found: true },
              roobet: { found: true }
            }
          : {
              shuffle: { found: false },
              stake: { found: false },
              rainbet: { found: false },
              roobet: { found: false }
            };
    return makeRelease({
      game: `Game ${v}`,
      matchedProviders: ['Evolution'],
      results
    });
  };

  it('counts each verdict in severity order', () => {
    const head = formatReleaseReply([
      withVerdict('reject'),
      ...Array.from({ length: 6 }, () => withVerdict('escalate')),
      ...Array.from({ length: 15 }, () => withVerdict('proceed'))
    ]).split('\n')[0];
    assert.match(head!, /\*22 matched releases checked\* — ❌ 1  ⚠️ 6  ✅ 15$/);
  });

  it('omits verdicts that did not occur', () => {
    const head = formatReleaseReply([
      withVerdict('escalate'),
      withVerdict('escalate')
    ]).split('\n')[0];
    assert.match(head!, /— ⚠️ 2$/);
    assert.doesNotMatch(head!, /❌|✅/);
  });

  it('keeps the singular form for one game', () => {
    const head = formatReleaseReply([withVerdict('proceed')]).split('\n')[0];
    assert.match(head!, /\*1 matched release checked\* — ✅ 1$/);
  });

  it('leaves the per-game detail untouched below the header', () => {
    const out = formatReleaseReply([withVerdict('proceed')]);
    assert.match(out, /✅ Shuffle — RTP 96\.50%/);
    assert.match(out, /✅ \*Gate 1:\* Widely offered/);
  });
});

