import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parseAlert,
  parseReleaseMessage,
  detectAlertType,
  matchProvider,
  type ParsedAlert
} from '../src/extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(resolve(here, 'fixtures', name), 'utf-8');

describe('detectAlertType', () => {
  it('classifies each fixture to the right type', () => {
    const cases: Array<[string, string]> = [
      ['release.txt', 'released'],
      ['release-multiconfig.txt', 'released'],
      ['release-multiconfig-2.txt', 'released'],
      ['release-prose.txt', 'released'],
      ['recall-single.txt', 'recall'],
      ['recall-multi.txt', 'recall'],
      ['urgent.txt', 'urgent'],
      ['rtp-change-dot.txt', 'rtp_change'],
      ['rtp-change-comma.txt', 'rtp_change'],
      ['enabled-back.txt', 'enabled_back'],
      ['maintenance.txt', 'maintenance']
    ];
    for (const [file, expected] of cases) {
      assert.equal(
        detectAlertType(fixture(file)),
        expected,
        `${file} should be ${expected}`
      );
    }
  });

  it('returns null on a non-SOFTSWISS message', () => {
    assert.equal(detectAlertType('hello team, how was the weekend?'), null);
  });
});

describe('parseAlert — release', () => {
  it('extracts every allowlisted game and drops the others', () => {
    const a = parseAlert(fixture('release.txt')) as Extract<
      ParsedAlert,
      { type: 'released' }
    >;
    assert.equal(a.type, 'released');
    const games = a.games;
    const names = games.map((g) => g.game);
    // Allowlisted: Red Rascal, The Big Dog House, Jackpot Train, Phoenix Heat,
    // Treats of Terror II, What's Up? Witches, Cricket Legacy BB, Blazing
    // Roulette, Fortune Ways X10, Red Dragon of Luck, Classic Chilli Hold And Win
    assert.equal(games.length, 11);
    // PoggiPlay (Football Mines) should NOT be in the list — it's not in our allowlist.
    assert.ok(
      !names.includes('Football Mines'),
      'PoggiPlay game should be filtered out'
    );
    // Variant resolution
    const bigDog = games.find((g) => g.game === 'The Big Dog House')!;
    assert.equal(bigDog.matchedProviders[0], 'Pragmatic Play');
    // Slash provider keeps raw, picks first allowlisted
    const jackpot = games.find((g) => g.game === 'Jackpot Train')!;
    assert.equal(jackpot.providerRaw, 'Evolution/Redtiger');
    assert.deepEqual(jackpot.matchedProviders, ['Evolution', 'Red Tiger']);
    // Location header propagates
    assert.equal(bigDog.location, 'Curacao+Malta');
    const dragon = games.find((g) => g.game === 'Red Dragon of Luck')!;
    assert.equal(dragon.location, 'Only Curacao');
  });
});

describe('parseAlert — recall', () => {
  it('single-game recall uses Detected Game preamble', () => {
    const a = parseAlert(fixture('recall-single.txt')) as Extract<
      ParsedAlert,
      { type: 'recall' }
    >;
    assert.equal(a.type, 'recall');
    assert.equal(a.games.length, 1);
    assert.equal(a.games[0]!.game, 'Hook, Line and Poker');
    assert.equal(a.games[0]!.providerRaw, 'Skywind/Slotfactory');
    assert.deepEqual(a.games[0]!.matchedProviders, ['Skywind']);
  });

  it('multi-game recall extracts every game line under the header', () => {
    const a = parseAlert(fixture('recall-multi.txt')) as Extract<
      ParsedAlert,
      { type: 'recall' }
    >;
    assert.equal(a.type, 'recall');
    assert.equal(a.games.length, 2);
    assert.equal(a.games[0]!.game, 'Cat in Vegas');
    assert.equal(a.games[1]!.game, 'Fortunate Five');
    for (const g of a.games) {
      assert.deepEqual(g.matchedProviders, ['Playtech']);
    }
  });
});

describe('parseAlert — urgent', () => {
  it('extracts game from body when no Detected Game preamble', () => {
    const a = parseAlert(fixture('urgent.txt')) as Extract<
      ParsedAlert,
      { type: 'urgent' }
    >;
    assert.equal(a.type, 'urgent');
    assert.equal(a.games.length, 1);
    assert.equal(a.games[0]!.game, 'Star Trek The Next Generation');
    assert.deepEqual(a.games[0]!.matchedProviders, ['BGaming']);
    assert.equal(a.games[0]!.reason, 'temporarily disabled by SOFTSWISS');
  });

  it('beats recall in classification when both keywords appear', () => {
    // URGENT messages can contain "disabled"/"recalled" colloquially — urgent should win.
    const text =
      'Star Trek has been temporarily disabled. Please freeze withdrawals.\n#URGENT';
    assert.equal(detectAlertType(text), 'urgent');
  });
});

describe('parseAlert — rtp_change', () => {
  it('parses dot-decimal RTPs', () => {
    const a = parseAlert(fixture('rtp-change-dot.txt')) as Extract<
      ParsedAlert,
      { type: 'rtp_change' }
    >;
    assert.equal(a.type, 'rtp_change');
    assert.equal(a.game, 'Gunslinger Glory');
    assert.equal(a.providerRaw, 'Yggdrasil/Boomerang');
    assert.equal(a.oldRtp, 96.0);
    assert.equal(a.newRtp, 94.0);
  });

  it('parses comma-decimal RTPs (European format)', () => {
    const a = parseAlert(fixture('rtp-change-comma.txt')) as Extract<
      ParsedAlert,
      { type: 'rtp_change' }
    >;
    assert.equal(a.type, 'rtp_change');
    assert.equal(a.game, 'Blazing Fire Pots Hold & Spin');
    assert.equal(a.oldRtp, 94.11);
    assert.equal(a.newRtp, 96.27);
  });
});

describe('parseAlert — enabled_back', () => {
  it('extracts provider from enabled-back message', () => {
    const a = parseAlert(fixture('enabled-back.txt')) as Extract<
      ParsedAlert,
      { type: 'enabled_back' }
    >;
    assert.equal(a.type, 'enabled_back');
    assert.equal(a.providerRaw, 'Spinomenal');
    assert.equal(a.matchedProvider, 'Spinomenal');
  });
});

describe('parseAlert — maintenance', () => {
  it('extracts provider + window', () => {
    const a = parseAlert(fixture('maintenance.txt')) as Extract<
      ParsedAlert,
      { type: 'maintenance' }
    >;
    assert.equal(a.type, 'maintenance');
    assert.equal(a.matchedProvider, 'Yggdrasil');
    assert.equal(a.window.releaseDate, '19.05.26');
    assert.equal(a.window.startTime, '08:00 UTC');
    assert.equal(a.window.duration, '30 min');
  });
});

describe('matchProvider', () => {
  it('matches exact canonical names', () => {
    assert.equal(matchProvider('Pragmatic Play'), 'Pragmatic Play');
    assert.equal(matchProvider('Hacksaw Gaming'), 'Hacksaw Gaming');
  });

  it('matches normalized variants (concat / casing / punctuation)', () => {
    assert.equal(matchProvider('Pragmaticplay'), 'Pragmatic Play');
    assert.equal(matchProvider('Playngo'), "Play'n GO");
    assert.equal(matchProvider('Redtiger'), 'Red Tiger');
    assert.equal(matchProvider('Netent'), 'NetEnt');
    assert.equal(matchProvider('Barbarabang'), 'Barbara Bang');
    assert.equal(matchProvider('1spin4win'), '1Spin4Win');
  });

  it('matches stripped-suffix variants via substring', () => {
    assert.equal(matchProvider('Hacksaw'), 'Hacksaw Gaming');
    assert.equal(matchProvider('Booming'), 'Booming Games');
  });

  it('matches realistic typos via fuzzball ratio', () => {
    assert.equal(matchProvider('Pragmatik Play'), 'Pragmatic Play');
    assert.equal(matchProvider('Hcksaw Gaming'), 'Hacksaw Gaming');
    assert.equal(matchProvider('Yggdrasill'), 'Yggdrasil');
  });

  it('rejects PoggiPlay (a real distinct provider) at our 88 threshold', () => {
    // Regression test: at upstream's 80 this confuses with Popiplay.
    assert.equal(matchProvider('PoggiPlay'), null);
  });

  it('returns null for unknown providers', () => {
    assert.equal(matchProvider('NotARealStudio'), null);
    assert.equal(matchProvider(''), null);
    assert.equal(matchProvider(null), null);
  });
});

describe('parseAlert — release with multiple fee/RTP configs', () => {
  // SOFTSWISS ships many games in several builds at once, one `Fee: … | RTP: …`
  // line each under a single game heading. Capturing only the first silently
  // drops the rest and makes the other builds look like market disagreement.
  const games = (
    parseAlert(fixture('release-multiconfig.txt')) as Extract<
      ParsedAlert,
      { type: 'released' }
    >
  ).games;

  it('keeps every config line, in message order', () => {
    const leBandit = games.find((g) => g.game === 'Le Bandit Hold & Win');
    assert.ok(leBandit);
    assert.deepEqual(
      leBandit.configs?.map((c) => [c.fee, c.rtp]),
      [
        ['hacksaw_basic', 96.27],
        ['hacksaw_rtp94', 94.29],
        ['hacksaw_rtp', 92.23]
      ]
    );
  });

  it('keeps the flat rtp/fee/certs pointing at the first config', () => {
    const leBandit = games.find((g) => g.game === 'Le Bandit Hold & Win');
    assert.equal(leBandit?.rtp, 96.27);
    assert.equal(leBandit?.fee, 'hacksaw_basic');
    assert.match(leBandit?.certs ?? '', /^BR BG CA-ON/);
  });

  it('does not bleed configs into the following game', () => {
    const seas = games.find((g) => g.game === '7 Seas Raiders');
    assert.equal(seas?.configs?.length, 1);
    assert.equal(seas?.rtp, 94);
  });

  it('still resolves providers, including slash entries', () => {
    assert.deepEqual(
      games.map((g) => g.provider),
      ['Hacksaw Gaming', 'Yggdrasil']
    );
  });

  it('gives single-config games a one-entry configs array', () => {
    const single = (
      parseAlert(fixture('release.txt')) as Extract<
        ParsedAlert,
        { type: 'released' }
      >
    ).games;
    assert.ok(single.length > 0);
    assert.ok(single.every((g) => g.configs?.length === 1));
  });
});

describe('parseAlert — release title and provider edge cases', () => {
  // Captured from a real 2026-09-17 alert: curly apostrophe, colon in the
  // title, ampersand inside a slash-provider, and 2-4 configs per game.
  const games = (
    parseAlert(fixture('release-multiconfig-2.txt')) as Extract<
      ParsedAlert,
      { type: 'released' }
    >
  ).games;

  it('parses every game in the block', () => {
    assert.equal(games.length, 10);
  });

  it('keeps a curly apostrophe in the title', () => {
    assert.ok(games.some((g) => g.game === 'Thor\u2019s Thunder Strike'));
  });

  it('keeps a colon in the title', () => {
    assert.ok(games.some((g) => g.game === 'Big Bad Wolf: High Steaks'));
  });

  it('handles an ampersand inside a slash-provider', () => {
    const wolf = games.find((g) => g.game === 'Wolf of London');
    assert.equal(wolf?.providerRaw, 'Yggdrasil/Fish&Chips');
    assert.deepEqual(wolf?.matchedProviders, ['Yggdrasil']);
  });

  it('matches both sides of a slash-provider when both are known', () => {
    const jack = games.find((g) => g.game === 'Jack and the Beanstalk 2');
    assert.deepEqual(jack?.matchedProviders, ['Evolution', 'NetEnt']);
  });

  it('captures repeated fee labels as distinct configs', () => {
    const cash = games.find((g) => g.game === 'Cash Fortress');
    assert.equal(cash?.configs?.length, 4);
    assert.deepEqual(
      cash?.configs?.map((c) => c.rtp),
      [95.9, 94.91, 93.46, 91.96]
    );
    assert.equal(new Set(cash?.configs?.map((c) => c.fee)).size, 1);
  });
});

describe('parseAlert — prose "Dear team!" release dialect', () => {
  // A second release format is in circulation: colon after the game heading,
  // "fee group" instead of "Fee", a dash before the RTP, spelled-out
  // "Certifications" on its own bulleted line. Before this was handled the
  // alert classified as 'released' but parsed zero games, so the bot silently
  // posted nothing at all.
  const games = (
    parseAlert(fixture('release-prose.txt')) as Extract<
      ParsedAlert,
      { type: 'released' }
    >
  ).games;

  it('parses games instead of silently yielding none', () => {
    assert.ok(games.length > 0);
  });

  it('reads fee group and dash-separated RTP', () => {
    const tilly = games.find((g) => g.game === 'Toothrot Tilly');
    assert.deepEqual(
      tilly?.configs?.map((c) => [c.fee, c.rtp]),
      [
        ['hacksaw_basic', 96.34],
        ['hacksaw_rtp94', 94.35]
      ]
    );
  });

  it('strips the trailing colon from the location header', () => {
    assert.equal(
      games.find((g) => g.game === 'Toothrot Tilly')?.location,
      'Curacao+Malta'
    );
    assert.equal(
      games.find((g) => g.game === 'Porko Wins')?.location,
      'Only Curacao'
    );
  });

  it('does not treat salutations or sign-offs as locations', () => {
    for (const g of games) {
      assert.doesNotMatch(g.location ?? '', /dear|following|please note/i);
    }
  });

  it('keeps an ampersand in the title', () => {
    assert.ok(games.some((g) => g.game === '40 Fruits & Gold Coin Boost'));
  });

  it('drops games whose provider is not allowlisted', () => {
    // Wazdan, Push Gaming, KA Gaming, Gamzix, Fazi, 3 Oaks et al are absent
    // from PROVIDERS, so their releases are intentionally not reported.
    assert.ok(!games.some((g) => /Wazdan|Pushgaming|KAGaming/i.test(g.providerRaw ?? '')));
  });
});

describe('parseReleaseMessage — standalone Certifications lines', () => {
  const build = (body: string) =>
    parseReleaseMessage(`The following games are released today:\n\nCuracao+Malta:\n\n${body}`);

  it('applies one trailing certs line to every config above it', () => {
    const [g] = build(
      `Shared Trailing (Hacksaw):
    - fee group: hacksaw_basic ; RTP - 96.34
    - fee group: hacksaw_rtp94 ; RTP - 94.35
    - Certifications: CA-ON CW EE
`
    );
    assert.deepEqual(
      g?.configs?.map((c) => c.certs),
      ['CA-ON CW EE', 'CA-ON CW EE']
    );
  });

  it('attaches interleaved certs to their own config only', () => {
    const [g] = build(
      `Interleaved (Spinomenal):
    - fee group: basic ; RTP - 96.47
    - Certifications: BE CA-ON
    - fee group: basic_rtp94 ; RTP - 94.48
    - Certifications: BR ES IT
`
    );
    assert.deepEqual(
      g?.configs?.map((c) => [c.fee, c.certs]),
      [
        ['basic', 'BE CA-ON'],
        ['basic_rtp94', 'BR ES IT']
      ]
    );
  });
});

