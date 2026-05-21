import { searchShuffle } from '../src/shuffle.js';
import { searchStake } from '../src/stake.js';
import { searchRoobet } from '../src/roobet.js';
import { searchRainbet } from '../src/rainbet.js';
import { computeGate } from '../src/gate.js';
import { shutdownBrowser } from '../src/browser.js';

const argv = process.argv.slice(2);
const debug = argv.includes('--debug');
const positional = argv.filter((a) => !a.startsWith('--'));

if (positional.length === 0) {
  console.error('Usage: node scripts/dryrun.js [--debug] "<game name>" [provider name]');
  console.error('Example: node scripts/dryrun.js --debug "Sweet Bonanza 1000" "Pragmatic Play"');
  process.exit(1);
}

const gameName = positional[0];
const provider = positional[1] || '(unspecified)';

console.log(`\n→ Looking up: ${gameName}  (provider hint: ${provider})\n`);

const t0 = Date.now();
const settled = await Promise.allSettled([
  searchShuffle(gameName),
  searchStake(gameName),
  searchRainbet(gameName),
  searchRoobet(gameName)
]);
const dt = Date.now() - t0;

const results = {
  shuffle: unwrap(settled[0]),
  stake: unwrap(settled[1]),
  rainbet: unwrap(settled[2]),
  roobet: unwrap(settled[3])
};

console.log(`Results (${dt}ms total):`);
for (const [site, r] of Object.entries(results)) {
  console.log(`  ${site.padEnd(8)} ${formatResult(r)}`);
  if (debug && r._debug) {
    for (const [k, v] of Object.entries(r._debug)) {
      const rendered = Array.isArray(v)
        ? `[${v.join(', ')}]`
        : v === null || v === undefined
          ? '(null)'
          : String(v);
      console.log(`             ${k}: ${rendered}`);
    }
  }
}

const gate = computeGate(results);
console.log(`\n${gate.icon} Gate 1: ${gate.summary}\n`);

function unwrap(s) {
  if (s.status === 'fulfilled') return s.value;
  return { found: false, error: s.reason?.message || 'unknown' };
}

function formatResult(r) {
  if (r.error) return `⚠️  error: ${r.error}`;
  if (!r.found) return '❌ not found';
  const name = r.name ? ` [${r.name}]` : '';
  if (r.rtp == null) return `✅ listed (RTP not published)${name}`;
  return `✅ RTP ${r.rtp.toFixed(2)}%${name}`;
}

await shutdownBrowser();
process.exit(0);
