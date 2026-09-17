// Dryrun: runs each fixture in tests/fixtures/ through parseAlert → dispatch,
// printing the would-be Slack reply. Hits real Dicey for availability checks;
// the four competitor sites are only used by the 'released' alert, and from
// a US IP they'll return "not found" — that's expected, ship from a Toronto
// VPS for real signal.
//
// Uses a tmp state file so it doesn't touch state/recalls.json. Demonstrates
// the recall → enabled-back loop by running a Skywind recall first, then a
// synthetic Skywind enabled-back message.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Set sandboxed state path + default usergroup BEFORE importing handlers
// (state.ts and handlers.ts read these at module-load time).
const TMP_DIR = mkdtempSync(join(tmpdir(), 'casinoscraper-dryrun-'));
process.env.STATE_PATH = join(TMP_DIR, 'recalls.json');
process.env.SLACK_ALERT_USERGROUP_ID =
  process.env.SLACK_ALERT_USERGROUP_ID || 'S09Q4GUKX4Y';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', 'tests', 'fixtures');

const { parseAlert } = await import('../src/extract.js');
const { dispatch } = await import('../src/handlers.js');
const { shutdownBrowser } = await import('../src/browser.js');

const FIXTURES = [
  { file: 'recall-single.txt', label: 'Single-game recall (Skywind)' },
  { file: 'recall-multi.txt', label: 'Multi-game recall (Playtech)' },
  { file: 'urgent.txt', label: 'URGENT disabled (BGaming)' },
  { file: 'rtp-change-dot.txt', label: 'RTP change, dot decimal' },
  { file: 'rtp-change-comma.txt', label: 'RTP change, comma decimal' },
  { file: 'enabled-back.txt', label: 'Spinomenal enabled back (no prior recalls)' },
  { file: 'maintenance.txt', label: 'Maintenance (Yggdrasil)' }
] as const;

function sep(label: string): string {
  const bar = '═'.repeat(70);
  return `\n${bar}\n  ${label}\n${bar}`;
}

const args = process.argv.slice(2);
const includeReleases = args.includes('--include-releases');

if (includeReleases) {
  console.log(sep('Release (multi-game catalog scan, hits 4 competitor sites)'));
  await runFixture('release.txt', 'TS-release');
  console.log(sep('Release with multiple fee/RTP configs per game'));
  await runFixture('release-multiconfig.txt', 'TS-release-multiconfig');
  console.log(sep('Release with repeated fee labels + title edge cases'));
  await runFixture('release-multiconfig-2.txt', 'TS-release-multiconfig-2');
  console.log(sep('Release in the prose "Dear team!" dialect'));
  await runFixture('release-prose.txt', 'TS-release-prose');
  console.log(sep('Prose release with a trailing postponement note'));
  await runFixture('release-prose-2.txt', 'TS-release-prose-2');
} else {
  console.log(sep('Release fixture skipped by default'));
  console.log(
    '  Pass --include-releases to also run the multi-game release fixture.\n' +
      '  Note: this opens Playwright contexts for Stake/Roobet/Rainbet and takes ~30s.'
  );
}

for (const fx of FIXTURES) {
  console.log(sep(fx.label));
  await runFixture(fx.file, `TS-${fx.file}`);
}

console.log(sep('Replay loop: Skywind recall, then Skywind enabled back'));
await runFixture('recall-single.txt', 'TS-replay-seed');
const skywindBack = 'Skywind games have been enabled back for all clients.';
console.log('\nProcessing synthetic message: Skywind enabled back');
const skywindReply = await dispatch(parseAlert(skywindBack), 'TS-replay');
print(skywindReply);

await shutdownBrowser();
rmSync(TMP_DIR, { recursive: true, force: true });
process.exit(0);

async function runFixture(filename: string, sourceTs: string): Promise<void> {
  const text = readFileSync(join(fixtureDir, filename), 'utf-8');
  const alert = parseAlert(text);
  console.log(`Alert type: ${alert.type}`);
  if (alert.type === null) {
    console.log('(no reply — message did not match any alert pattern)');
    return;
  }
  const reply = await dispatch(alert, sourceTs);
  print(reply);
}

function print(reply: string | null): void {
  if (!reply) {
    console.log('(no reply — handler returned null)');
    return;
  }
  console.log('\n' + reply.split('\n').map((l) => '  ' + l).join('\n'));
}
