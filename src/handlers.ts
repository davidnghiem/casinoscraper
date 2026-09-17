// Per-alert-type handlers + reply formatters. Pure business logic — no Slack
// transport, no env reads beyond SLACK_ALERT_USERGROUP_ID (which only affects
// whether replies get @-prefixed). Index.ts wires this to Slack; dryrun and
// tests can call dispatch() directly.

import {
  parseAlert as _parseAlert,
  type ParsedAlert,
  type MatchedGame,
  type ReleaseConfig
} from './extract.js';
import { searchShuffle } from './shuffle.js';
import { searchStake } from './stake.js';
import { searchRoobet } from './roobet.js';
import { searchRainbet } from './rainbet.js';
import { searchDicey } from './dicey.js';
import {
  computeGate,
  matchConfig,
  type GateVerdict,
  type CompetitorResults
} from './gate.js';
import {
  recordRecall,
  clearRecallsForProvider,
  getRecallsForProvider,
  type RecallEntry
} from './state.js';
import type { SiteResult, DiceyResult } from './types.js';

const ALERT_USERGROUP_ID = process.env.SLACK_ALERT_USERGROUP_ID || null;
const FANOUT_CONCURRENCY = 4;

export interface CheckedReleaseGame extends MatchedGame {
  results: CompetitorResults;
  dicey: DiceyResult;
  gate: GateVerdict;
}

interface CheckedRecallGame extends MatchedGame {
  dicey: DiceyResult;
}

// Pure formatter: given pre-fanned-out per-game results, produce the Slack
// reply text. Split out from handleRelease so tests can drive it directly
// without hitting the network.
export function formatReleaseReply(checked: CheckedReleaseGame[]): string {
  // Releases carry a Gate 1 verdict the team has to action, and every reply
  // ends with the ack protocol, so the group is tagged like the other
  // actionable paths rather than left to whoever happens to read the thread.
  //
  // A release reply runs ~10 lines per game with no cap, so Slack collapses it
  // behind "Show more" from about ten games up. The verdict tally goes in the
  // first line so the ping is scannable without expanding the post; the
  // per-game detail below is unchanged.
  const head = `${mention()}🎰 *${checked.length} matched release${
    checked.length === 1 ? '' : 's'
  } checked*${formatVerdictTally(checked)}`;
  const sections = formatReleaseSections(checked).join('\n\n');
  return `${head}\n\n${sections}`;
}

// "— ❌ 1  ⚠️ 6  ✅ 15", in severity order, omitting verdicts that did not
// occur so a single-game reply does not read as a row of zeroes.
function formatVerdictTally(checked: CheckedReleaseGame[]): string {
  const order: Array<[GateVerdict['verdict'], string]> = [
    ['reject', '❌'],
    ['escalate', '⚠️'],
    ['proceed', '✅']
  ];
  const parts = order
    .map(([verdict, icon]) => {
      const n = checked.filter((c) => c.gate.verdict === verdict).length;
      return n > 0 ? `${icon} ${n}` : null;
    })
    .filter((x): x is string => x !== null);
  return parts.length > 0 ? ` — ${parts.join('  ')}` : '';
}

export async function dispatch(
  alert: ParsedAlert,
  sourceTs: string | null
): Promise<string | null> {
  switch (alert.type) {
    case 'released':
      return handleRelease(alert.games);
    case 'recall':
    case 'urgent':
      return handleRecallOrUrgent(
        alert.games,
        alert.type === 'urgent',
        sourceTs
      );
    case 'rtp_change':
      return handleRtpChange(alert);
    case 'enabled_back':
      return handleEnabledBack(alert);
    case 'maintenance':
      return handleMaintenance(alert);
    case null:
      return null;
  }
}

async function handleRelease(games: MatchedGame[]): Promise<string | null> {
  if (games.length === 0) return null;

  const checked = await mapWithLimit<MatchedGame, CheckedReleaseGame>(
    games,
    FANOUT_CONCURRENCY,
    async (m) => {
      const [shuffleR, stakeR, rainbetR, roobetR, diceyR] =
        await Promise.allSettled([
          searchShuffle(m.game),
          searchStake(m.game),
          searchRainbet(m.game),
          searchRoobet(m.game, m.provider ?? null),
          searchDicey(m.game)
        ]);
      const results: CompetitorResults = {
        shuffle: unwrap(shuffleR),
        stake: unwrap(stakeR),
        rainbet: unwrap(rainbetR),
        roobet: unwrap(roobetR)
      };
      const dicey = unwrap(diceyR) as DiceyResult;
      return { ...m, results, dicey, gate: computeGate(results, m.configs ?? []) };
    }
  );

  return formatReleaseReply(checked);
}

async function handleRecallOrUrgent(
  games: MatchedGame[],
  isUrgent: boolean,
  sourceTs: string | null
): Promise<string | null> {
  if (games.length === 0) return null;

  const checked = await mapWithLimit<MatchedGame, CheckedRecallGame>(
    games,
    FANOUT_CONCURRENCY,
    async (g) => {
      const settled = await Promise.allSettled([searchDicey(g.game)]);
      return { ...g, dicey: unwrap(settled[0]) as DiceyResult };
    }
  );

  const actionable = checked.filter(
    (c) => c.dicey?.found && c.dicey.isActive !== false
  );

  for (const g of actionable) {
    const provider = g.matchedProviders[0] || g.providerRaw || 'unknown';
    await recordRecall({
      provider,
      slug: g.dicey.slug!,
      name: g.dicey.name || g.game,
      reason: isUrgent ? 'urgent_disabled' : 'recalled',
      sourceTs
    });
  }

  return formatRecallReply(checked, actionable.length > 0, isUrgent);
}

async function handleRtpChange(
  alert: Extract<ParsedAlert, { type: 'rtp_change' }>
): Promise<string> {
  const dicey = await safeSearchDicey(alert.game);
  const onDicey = dicey.found && dicey.isActive !== false;
  return formatRtpChangeReply(alert, dicey, onDicey);
}

async function handleEnabledBack(
  alert: Extract<ParsedAlert, { type: 'enabled_back' }>
): Promise<string> {
  const provider = alert.matchedProvider;
  if (!provider) {
    return `ℹ️ *Provider enabled back:* ${alert.providerRaw} — not in our allowlist, no action.`;
  }
  const prior = await clearRecallsForProvider(provider);
  return formatEnabledBackReply(provider, prior);
}

async function handleMaintenance(
  alert: Extract<ParsedAlert, { type: 'maintenance' }>
): Promise<string> {
  const provider = alert.matchedProvider;
  if (!provider) {
    return `ℹ️ *Maintenance:* ${alert.providerRaw || 'unknown provider'} — not in our allowlist, no action.`;
  }
  let priorRecalls: RecallEntry[] = [];
  try {
    priorRecalls = await getRecallsForProvider(provider);
  } catch {
    /* ignore */
  }
  return formatMaintenanceReply(alert, provider, priorRecalls);
}

async function safeSearchDicey(game: string): Promise<DiceyResult> {
  try {
    return await searchDicey(game);
  } catch (err) {
    return { found: false, error: (err as Error).message };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────────────────────────────────

function mention(): string {
  return ALERT_USERGROUP_ID ? `<!subteam^${ALERT_USERGROUP_ID}> ` : '';
}

function canonicalNameOf(c: CheckedReleaseGame): string {
  const { game, results, dicey } = c;
  // Prefer a real title from a site that publishes one. Rainbet is excluded on
  // purpose: its "name" is derived from a sitemap slug, so it arrives
  // lowercased, punctuation-stripped and provider-prefixed ("playn go lawn n
  // complete disorder") and would replace the actual release title.
  return (
    (dicey.found && dicey.name) ||
    (results.shuffle?.found && results.shuffle.name) ||
    (results.stake?.found && results.stake.name) ||
    (results.roobet?.found && results.roobet.name) ||
    game
  );
}

function providerDisplayOf(c: CheckedReleaseGame): string {
  const { providerRaw, matchedProviders } = c;
  return providerRaw?.includes('/')
    ? providerRaw
    : matchedProviders[0] || providerRaw || 'unknown';
}

// Everything below the heading. Two games whose bodies are byte-identical are
// indistinguishable in the reply, which is what lets them share one block.
function formatReleaseBody(c: CheckedReleaseGame): string {
  const { providerRaw, matchedProviders, rtp, results, dicey, gate } = c;
  const lines: string[] = [];
  if (
    providerRaw?.includes('/') &&
    matchedProviders.length < providerRaw.split('/').length
  ) {
    lines.push(`  Matched: ${matchedProviders.join(', ')}`);
  }
  lines.push(formatDiceyLine(dicey));
  const configs = c.configs ?? [];
  if (configs.length > 1) {
    const detail = configs
      .map((cfg) =>
        cfg.rtp != null
          ? `${cfg.fee ?? 'config'} ${cfg.rtp.toFixed(2)}%`
          : (cfg.fee ?? 'config')
      )
      .join(' · ');
    // Providers reuse one fee label across builds (Playtech: 4× `gpas`), so say
    // how many there are rather than leaving a repeated label looking like a
    // copy-paste error.
    const labels = new Set(configs.map((c) => c.fee));
    lines.push(
      `  Configs (${configs.length}${
        labels.size < configs.length ? ', shared fee label' : ''
      }): ${detail}`
    );
  } else if (rtp != null) {
    lines.push(`  Source RTP: ${rtp.toFixed(2)}%`);
  }
  lines.push(formatSiteLine('Shuffle', results.shuffle, configs));
  lines.push(formatSiteLine('Stake', results.stake, configs));
  lines.push(formatSiteLine('Rainbet', results.rainbet, configs));
  lines.push(formatSiteLine('Roobet', results.roobet, configs));
  lines.push(`  ${gate.icon} *Gate 1:* ${gate.summary}`);
  return lines.join('\n');
}

// "Free Bet Blackjack 13" -> stem "Free Bet Blackjack", number "13".
function splitNumberedTitle(
  name: string
): { stem: string; number: string } | null {
  const m = name.match(/^(.*\S)\s+(\d+)$/);
  return m ? { stem: m[1]!, number: m[2]! } : null;
}

// Table games ship in near-identical numbered runs — Free Bet Blackjack
// 13/14/15/16, one provider, one fee group, one RTP and necessarily the same
// verdict. Repeating an identical nine-line block per game is the main driver
// of reply length, so such a run shares one block.
//
// Grouping is deliberately narrow: the games must be consecutive (message order
// survives), share a provider, share a title stem that differs only by a
// trailing number, and render a byte-identical body. Two different families
// whose bodies happen to coincide — Free Bet Blackjack and Classic Bet Stacker
// Blackjack both being 0/4 at 99.29% — stay apart, because merging them under
// one heading reads as though they were the same game. Numbers are listed, not
// ranged, so a gap (13, 14, 16) is visible.
function formatReleaseSections(checked: CheckedReleaseGame[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < checked.length) {
    const first = checked[i]!;
    const body = formatReleaseBody(first);
    const provider = providerDisplayOf(first);
    const parts = splitNumberedTitle(canonicalNameOf(first));

    let j = i + 1;
    if (parts) {
      while (j < checked.length) {
        const next = checked[j]!;
        const nextParts = splitNumberedTitle(canonicalNameOf(next));
        if (
          !nextParts ||
          nextParts.stem !== parts.stem ||
          providerDisplayOf(next) !== provider ||
          formatReleaseBody(next) !== body
        ) {
          break;
        }
        j++;
      }
    }

    const run = checked.slice(i, j);
    let heading: string;
    if (run.length === 1) {
      heading = `*${canonicalNameOf(first)}* (${provider})`;
    } else {
      const numbers = run
        .map((c) => splitNumberedTitle(canonicalNameOf(c))!.number)
        .join(', ');
      heading = `*${parts!.stem} ${numbers}* (${provider}) — ${run.length} games, identical results`;
    }
    out.push(`${heading}\n${body}`);
    i = j;
  }
  return out;
}

function formatRecallReply(
  checked: CheckedRecallGame[],
  hasActionable: boolean,
  isUrgent: boolean
): string {
  const header = isUrgent
    ? `🚨 *URGENT — ${checked.length} game${checked.length === 1 ? '' : 's'} disabled by SOFTSWISS*`
    : `🔔 *Recall — ${checked.length} game${checked.length === 1 ? '' : 's'} recalled*`;
  const sections = checked
    .map((g) => formatRecallSection(g, isUrgent))
    .join('\n\n');
  const prefix = hasActionable ? mention() : '';
  return `${prefix}${header}\n\n${sections}`;
}

function formatRecallSection(g: CheckedRecallGame, isUrgent: boolean): string {
  const providerDisplay = g.providerRaw?.includes('/')
    ? g.providerRaw
    : g.matchedProviders[0] || g.providerRaw || 'unknown';
  const lines = [`*${g.game}* (${providerDisplay})`];
  if (!g.dicey || g.dicey.error) {
    lines.push(
      `  ⚠️ Dicey check failed${g.dicey?.error ? `: ${g.dicey.error}` : ''}`
    );
    lines.push('  Action: manual check needed');
  } else if (!g.dicey.found) {
    lines.push('  ❌ Not on Dicey — no action needed');
  } else if (g.dicey.isActive === false) {
    lines.push(
      `  ⚠️ On Dicey but already inactive (slug: ${g.dicey.slug}) — no action needed`
    );
  } else {
    lines.push(`  ✅ Active on Dicey (slug: ${g.dicey.slug})`);
    if (isUrgent) {
      lines.push('  *Recommend: freeze withdrawals + deactivate now*');
    } else {
      lines.push('  *Recommend: deactivate now*');
    }
  }
  return lines.join('\n');
}

function formatRtpChangeReply(
  alert: Extract<ParsedAlert, { type: 'rtp_change' }>,
  dicey: DiceyResult,
  onDicey: boolean
): string {
  const providerDisplay = alert.providerRaw?.includes('/')
    ? alert.providerRaw
    : alert.matchedProviders[0] || alert.providerRaw;
  const delta = (alert.newRtp - alert.oldRtp).toFixed(2);
  const sign = alert.newRtp > alert.oldRtp ? '+' : '';
  const header = `⚠️ *RTP changed — ${alert.game}* (${providerDisplay})`;
  const change = `  ${alert.oldRtp.toFixed(2)}% → ${alert.newRtp.toFixed(2)}% (Δ ${sign}${delta} pp)`;

  if (dicey.error) {
    return `${header}\n${change}\n  ⚠️ Dicey check failed: ${dicey.error}`;
  }
  if (!dicey.found) {
    return `${header}\n${change}\n  ❌ Not on Dicey — no action needed`;
  }
  if (!onDicey) {
    return `${header}\n${change}\n  ⚠️ On Dicey but inactive (slug: ${dicey.slug}) — no action needed`;
  }
  return `${mention()}${header}\n${change}\n  ✅ Active on Dicey (slug: ${dicey.slug})\n  *Team: verify and update RTP config*`;
}

function formatEnabledBackReply(
  provider: string,
  prior: RecallEntry[]
): string {
  if (prior.length === 0) {
    return `ℹ️ *${provider} games enabled back* — no prior Dicey recalls tracked for this provider, no action.`;
  }
  const lines = [
    `${mention()}✅ *${provider} games enabled back — re-enable on Dicey*`,
    `Previously recalled (${prior.length}):`
  ];
  for (const r of prior) {
    const when = (r.recalledAt || '').slice(0, 10);
    lines.push(
      `  • *${r.name}* (slug: ${r.slug}) — ${r.reason}${when ? `, recalled ${when}` : ''}`
    );
  }
  return lines.join('\n');
}

function formatMaintenanceReply(
  alert: Extract<ParsedAlert, { type: 'maintenance' }>,
  provider: string,
  priorRecalls: RecallEntry[]
): string {
  const lines = [`${mention()}🛠️ *Maintenance — ${provider}*`];
  const w = alert.window;
  const winParts: string[] = [];
  if (w.releaseDate) winParts.push(`date ${w.releaseDate}`);
  if (w.startTime) winParts.push(`start ${w.startTime}`);
  if (w.duration) winParts.push(`duration ${w.duration}`);
  if (winParts.length > 0) lines.push(`  Window: ${winParts.join(' · ')}`);
  if (priorRecalls.length > 0) {
    lines.push(`  Active recalls on Dicey: ${priorRecalls.length}`);
  }
  lines.push('  *Team: queue downtime notification for affected customers*');
  return lines.join('\n');
}

function formatDiceyLine(dicey: DiceyResult): string {
  if (dicey.error) return `  ⚠️ Dicey — check failed: ${dicey.error}`;
  if (!dicey.found) return `  ❌ Not on Dicey yet`;
  if (dicey.isActive === false) {
    return `  ⚠️ On Dicey but inactive (slug: ${dicey.slug})`;
  }
  if (dicey.isGeoRestricted) {
    return `  ⚠️ On Dicey (geo-restricted) — slug: ${dicey.slug}`;
  }
  return `  ✅ Already on Dicey (slug: ${dicey.slug})`;
}

function formatSiteLine(
  site: string,
  result: SiteResult | undefined,
  configs: ReleaseConfig[] = []
): string {
  if (result?.error) return `  ⚠️ ${site} — error: ${result.error}`;
  if (!result?.found) return `  ❌ ${site} — not found`;
  if (result.rtp == null) return `  ✅ ${site} — listed (RTP not published)`;
  return `  ✅ ${site} — RTP ${result.rtp.toFixed(2)}%${configTag(
    result.rtp,
    configs
  )}`;
}

// Name the build a competitor is running, but only when the label actually
// tells them apart: Playtech ships four configs all called `gpas`, so "(=gpas)"
// would be true and useless. When the fee is ambiguous the RTP on the line is
// already the discriminator. An RTP matching no published build is the
// interesting case, so flag it.
function configTag(rtp: number, configs: ReleaseConfig[]): string {
  if (configs.length < 2) return '';
  const hit = matchConfig(rtp, configs);
  if (!hit) return ' ⚠️ no published config';
  if (!hit.fee) return '';
  const sameFee = configs.filter((c) => c.fee === hit.fee).length;
  return sameFee === 1 ? ` (=${hit.fee})` : '';
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!, idx);
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    worker
  );
  await Promise.all(workers);
  return out;
}

function unwrap<T extends SiteResult>(
  settled: PromiseSettledResult<T>
): T | SiteResult {
  if (settled.status === 'fulfilled') return settled.value;
  return {
    found: false,
    error:
      (settled.reason as { message?: string })?.message || 'unknown error'
  };
}

// Re-export for callers that just want the parser without importing extract directly.
export { _parseAlert as parseAlert };
