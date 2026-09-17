// Dicey schema canary. Hits the GameList GraphQL query for a known-good
// slot; exits non-zero if the response shape regresses or the game can't be
// found. Run daily from GitHub Actions; on failure, the workflow posts to the
// Slack errors channel.

import { searchDicey } from '../src/dicey.js';

interface Probe {
  query: string;
  expectSlug: string;
  description: string;
}

const PROBES: Probe[] = [
  {
    query: 'Sweet Bonanza 1000',
    expectSlug: 'SweetBonanza1000',
    description: 'Common Pragmatic Play slot — proxy for catalog availability'
  },
  {
    query: 'Wanted Dead or a Wild',
    expectSlug: 'WantedDeadoraWild',
    description: 'Hacksaw Gaming flagship — proxy for non-Pragmatic provider'
  }
];

const failures: string[] = [];
const t0 = Date.now();

for (const probe of PROBES) {
  const r = await searchDicey(probe.query);
  if (!r.found) {
    failures.push(
      `❌ ${probe.query} — not found (${probe.description}). _debug: ${JSON.stringify(r._debug)}`
    );
    continue;
  }
  if (r.slug !== probe.expectSlug) {
    failures.push(
      `❌ ${probe.query} — slug mismatch: got "${r.slug}", expected "${probe.expectSlug}"`
    );
    continue;
  }
  console.log(`✅ ${probe.query} → ${r.slug} (${probe.description})`);
}

const dt = Date.now() - t0;
if (failures.length > 0) {
  console.error(`\nDicey canary FAILED (${dt}ms):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`\nDicey canary OK (${dt}ms)`);
process.exit(0);
