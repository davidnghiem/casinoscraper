// Pure-function tests for the Gate 1 verdict logic. These are the rules the
// bot's release-flow output is built on, so test every decision branch.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  computeGate,
  matchConfig,
  type CompetitorResults
} from '../src/gate.js';
import type { ReleaseConfig } from '../src/extract.js';

const FOUND_WITH_RTP = (rtp: number) => ({ found: true, rtp });
const FOUND_NO_RTP = { found: true };
const NOT_FOUND = { found: false };

describe('computeGate — verdicts', () => {
  it('0/4 listed → escalate', () => {
    const v = computeGate({
      shuffle: NOT_FOUND,
      stake: NOT_FOUND,
      rainbet: NOT_FOUND,
      roobet: NOT_FOUND
    });
    assert.equal(v.verdict, 'escalate');
    assert.match(v.summary, /Not offered by any competitor/);
  });

  it('1/4 listed → escalate', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.5),
      stake: NOT_FOUND,
      rainbet: NOT_FOUND,
      roobet: NOT_FOUND
    });
    assert.equal(v.verdict, 'escalate');
    assert.match(v.summary, /Only 1\/4/);
  });

  it('2/4 listed with aligned RTP → escalate (not enough)', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.5),
      stake: FOUND_WITH_RTP(96.51),
      rainbet: NOT_FOUND,
      roobet: NOT_FOUND
    });
    assert.equal(v.verdict, 'escalate');
    assert.match(v.summary, /Only 2\/4/);
  });

  it('3/4 listed with aligned RTPs → proceed', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.5),
      stake: FOUND_WITH_RTP(96.51),
      rainbet: FOUND_WITH_RTP(96.5),
      roobet: NOT_FOUND
    });
    assert.equal(v.verdict, 'proceed');
    assert.match(v.summary, /Widely offered \+ RTPs aligned/);
  });

  it('4/4 listed with aligned RTPs (Roobet has no RTP) → proceed', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.5),
      stake: FOUND_WITH_RTP(96.51),
      rainbet: FOUND_WITH_RTP(96.5),
      roobet: FOUND_NO_RTP
    });
    assert.equal(v.verdict, 'proceed');
  });

  it('RTP variance > 0.5 pp → reject, regardless of listing count', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.5),
      stake: FOUND_WITH_RTP(95.0),
      rainbet: FOUND_WITH_RTP(96.5),
      roobet: FOUND_NO_RTP
    });
    assert.equal(v.verdict, 'reject');
    assert.match(v.summary, /RTP mismatch/);
  });

  it('RTP variance exactly 0.5 pp → still proceed (boundary)', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.0),
      stake: FOUND_WITH_RTP(96.5),
      rainbet: FOUND_WITH_RTP(96.3),
      roobet: NOT_FOUND
    });
    assert.equal(v.verdict, 'proceed');
  });

  it('RTP variance > 0.5 pp on only 2 sites still rejects', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.5),
      stake: FOUND_WITH_RTP(94.0),
      rainbet: NOT_FOUND,
      roobet: NOT_FOUND
    });
    assert.equal(v.verdict, 'reject');
  });

  it('all sites listed but only one publishes RTP → proceed without variance check', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.5),
      stake: FOUND_NO_RTP,
      rainbet: FOUND_NO_RTP,
      roobet: FOUND_NO_RTP
    });
    assert.equal(v.verdict, 'proceed');
  });

  it('error result counts as not-listed', () => {
    const v = computeGate({
      shuffle: { found: false, error: 'HTTP 500' },
      stake: NOT_FOUND,
      rainbet: NOT_FOUND,
      roobet: NOT_FOUND
    });
    assert.equal(v.verdict, 'escalate');
  });
});

describe('computeGate — RTP spread explained by published configs', () => {
  // Le Bandit Hold & Win ships in three builds. Two operators picking different
  // builds is normal SOFTSWISS behaviour, not a market disagreement about the
  // game, so it must not read as a Gate 1 failure.
  const LE_BANDIT: ReleaseConfig[] = [
    { fee: 'hacksaw_basic', rtp: 96.27, certs: null },
    { fee: 'hacksaw_rtp94', rtp: 94.29, certs: null },
    { fee: 'hacksaw_rtp', rtp: 92.23, certs: null }
  ];
  const FOUR: CompetitorResults = {
    rainbet: FOUND_NO_RTP,
    roobet: FOUND_NO_RTP
  };

  it('does not reject when each competitor RTP matches a published config', () => {
    const v = computeGate(
      {
        shuffle: FOUND_WITH_RTP(96.27),
        stake: FOUND_WITH_RTP(94.29),
        ...FOUR
      },
      LE_BANDIT
    );
    assert.equal(v.verdict, 'proceed');
    assert.match(v.summary, /spread explained by 3 published configs/);
  });

  it('still rejects when a competitor RTP matches no published config', () => {
    const v = computeGate(
      {
        shuffle: FOUND_WITH_RTP(96.27),
        stake: FOUND_WITH_RTP(89.5),
        ...FOUR
      },
      LE_BANDIT
    );
    assert.equal(v.verdict, 'reject');
    assert.match(v.summary, /stake matches no published config/);
  });

  it('keeps the original hard reject when no config data is supplied', () => {
    const v = computeGate({
      shuffle: FOUND_WITH_RTP(96.27),
      stake: FOUND_WITH_RTP(94.29),
      ...FOUR
    });
    assert.equal(v.verdict, 'reject');
    assert.match(v.summary, /RTP mismatch/);
  });

  it('rejects a single-config game whose competitors disagree', () => {
    const v = computeGate(
      { shuffle: FOUND_WITH_RTP(96.0), stake: FOUND_WITH_RTP(94.0), ...FOUR },
      [{ fee: 'basic', rtp: 96.0, certs: null }]
    );
    assert.equal(v.verdict, 'reject');
  });

  it('coverage still governs — explained spread with only 2/4 listed escalates', () => {
    const v = computeGate(
      { shuffle: FOUND_WITH_RTP(96.27), stake: FOUND_WITH_RTP(94.29) },
      LE_BANDIT
    );
    assert.equal(v.verdict, 'escalate');
    assert.match(v.summary, /Only 2\/4/);
  });
});

describe('computeGate — config match tolerance adapts to tightly spaced builds', () => {
  // Real NetEnt release: two `netent_basic` builds 0.13pp apart and two
  // `netent_basic_rtp94` builds 0.04pp apart. A fixed 0.5pp window would treat
  // an unpublished RTP sitting between them as a legitimate build.
  const NETENT: ReleaseConfig[] = [
    { fee: 'netent_basic', rtp: 96.45, certs: null },
    { fee: 'netent_basic', rtp: 96.32, certs: null },
    { fee: 'netent_basic_rtp94', rtp: 94.27, certs: null },
    { fee: 'netent_basic_rtp94', rtp: 94.23, certs: null }
  ];
  const FOUR: CompetitorResults = {
    rainbet: FOUND_NO_RTP,
    roobet: FOUND_NO_RTP
  };

  it('matches each published build to itself', () => {
    for (const c of NETENT) {
      assert.equal(matchConfig(c.rtp!, NETENT)?.rtp, c.rtp);
    }
  });

  it('still absorbs 2dp rounding', () => {
    assert.equal(matchConfig(96.5, NETENT)?.rtp, 96.45);
  });

  it('rejects an RTP that sits between two published builds', () => {
    assert.equal(matchConfig(96.38, NETENT), null);
    assert.equal(matchConfig(95.0, NETENT), null);
  });

  it('treats a spread across two real builds as explained', () => {
    const v = computeGate(
      { shuffle: FOUND_WITH_RTP(96.45), stake: FOUND_WITH_RTP(94.27), ...FOUR },
      NETENT
    );
    assert.equal(v.verdict, 'proceed');
  });

  it('still rejects an unpublished RTP even with many configs', () => {
    const v = computeGate(
      { shuffle: FOUND_WITH_RTP(96.45), stake: FOUND_WITH_RTP(95.0), ...FOUR },
      NETENT
    );
    assert.equal(v.verdict, 'reject');
    assert.match(v.summary, /stake matches no published config/);
  });
});

