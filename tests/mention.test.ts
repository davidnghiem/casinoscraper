// handlers.ts reads SLACK_ALERT_USERGROUP_ID once at module load, so this lives
// in its own file: node --test runs each file in a separate process, letting the
// env be set before the dynamic import evaluates the module.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeGate } from '../src/gate.js';

process.env.SLACK_ALERT_USERGROUP_ID = 'S09Q4GUKX4Y';
const { formatReleaseReply } = await import('../src/handlers.js');

describe('release replies tag the alert user-group', () => {
  const results = {
    shuffle: { found: false },
    stake: { found: false },
    rainbet: { found: false },
    roobet: { found: false }
  };
  const game = {
    game: 'Free Bet Blackjack 13',
    providerRaw: 'Evolution',
    matchedProviders: ['Evolution'],
    provider: 'Evolution',
    location: 'Curacao+Malta',
    rtp: 99.29,
    fee: 'live_classic_premium',
    certs: 'CW MT EE',
    configs: [{ fee: 'live_classic_premium', rtp: 99.29, certs: 'CW MT EE' }],
    results,
    dicey: { found: false },
    gate: computeGate(results)
  };

  it('prefixes the reply with the @mops-dicey subteam mention', () => {
    const out = formatReleaseReply([game]);
    assert.ok(out.startsWith('<!subteam^S09Q4GUKX4Y> '));
    assert.match(out, /^<!subteam\^S09Q4GUKX4Y> 🎰 \*1 matched release checked\*/);
  });

  it('pluralises the count correctly', () => {
    assert.match(formatReleaseReply([game, game]), /🎰 \*2 matched releases checked\*/);
  });
});
