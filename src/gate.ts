import type { SiteResult } from './types.js';
import type { ReleaseConfig } from './extract.js';

const RTP_TOLERANCE_PP = 0.5;
// How close a competitor's scraped RTP must sit to a published config to count
// as "that operator integrated this build". 0.5pp is the ceiling, but real
// alerts ship configs far closer than that — NetEnt has run two `netent_basic`
// builds 0.13pp apart and two `netent_basic_rtp94` builds 0.04pp apart — so a
// fixed 0.5pp window would swallow several distinct builds at once. Narrow it
// to half the smallest gap between published RTPs, with a floor that still
// absorbs 2dp rounding.
const CONFIG_MATCH_TOLERANCE_PP = 0.5;
const CONFIG_MATCH_FLOOR_PP = 0.05;

function toleranceFor(configs: ReleaseConfig[]): number {
  const rtps = [
    ...new Set(
      configs
        .map((c) => c.rtp)
        .filter((n): n is number => typeof n === 'number')
    )
  ].sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < rtps.length; i++) {
    minGap = Math.min(minGap, rtps[i]! - rtps[i - 1]!);
  }
  if (!Number.isFinite(minGap)) return CONFIG_MATCH_TOLERANCE_PP;
  return Math.max(
    CONFIG_MATCH_FLOOR_PP,
    Math.min(CONFIG_MATCH_TOLERANCE_PP, minGap / 2)
  );
}
const SITE_ORDER = ['shuffle', 'stake', 'rainbet', 'roobet'] as const;
export type CompetitorSite = (typeof SITE_ORDER)[number];

export type CompetitorResults = Partial<Record<CompetitorSite, SiteResult>>;

export type GateVerdict = {
  verdict: 'proceed' | 'reject' | 'escalate';
  icon: string;
  summary: string;
};

// The published config whose RTP is closest to `rtp`, or null if none is within
// tolerance. SOFTSWISS ships many games in several fee/RTP builds at once, so a
// competitor sitting on a different build than another is normal, not a red
// flag — this is what tells the two cases apart.
export function matchConfig(
  rtp: number,
  configs: ReleaseConfig[]
): ReleaseConfig | null {
  const tolerance = toleranceFor(configs);
  let best: ReleaseConfig | null = null;
  let bestDelta = Infinity;
  for (const c of configs) {
    if (typeof c.rtp !== 'number') continue;
    const delta = Math.abs(c.rtp - rtp);
    if (delta <= tolerance && delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best;
}

export function computeGate(
  results: CompetitorResults,
  configs: ReleaseConfig[] = []
): GateVerdict {
  const listed = SITE_ORDER.filter((s) => results[s]?.found);
  const rtps = SITE_ORDER
    .filter((s) => results[s]?.found && typeof results[s]?.rtp === 'number')
    .map((s) => ({ site: s, rtp: results[s]!.rtp as number }));

  if (listed.length === 0) {
    return {
      verdict: 'escalate',
      icon: '⚠️',
      summary:
        'Not offered by any competitor → Escalate to Enhanced Due Diligence'
    };
  }

  // A spread only counts against the game if it is not already accounted for by
  // the configs SOFTSWISS published. With no config data (empty `configs`) no
  // RTP can match, so this reduces to the original hard reject.
  const publishedRtps = configs.filter((c) => typeof c.rtp === 'number');
  let configExplained = false;

  if (rtps.length >= 2) {
    const max = Math.max(...rtps.map((x) => x.rtp));
    const min = Math.min(...rtps.map((x) => x.rtp));
    const variance = max - min;
    if (variance > RTP_TOLERANCE_PP) {
      const unexplained = rtps.filter(
        (x) => matchConfig(x.rtp, publishedRtps) === null
      );
      if (unexplained.length > 0) {
        const detail = rtps
          .map((x) => `${x.site}=${x.rtp.toFixed(2)}%`)
          .join(', ');
        const suffix = publishedRtps.length
          ? ` — ${unexplained.map((x) => x.site).join(', ')} match${
              unexplained.length === 1 ? 'es' : ''
            } no published config`
          : '';
        return {
          verdict: 'reject',
          icon: '❌',
          summary: `RTP mismatch (Δ ${variance.toFixed(
            2
          )}pp — ${detail}${suffix}) → Do NOT proceed`
        };
      }
      configExplained = true;
    }
  }

  if (listed.length >= 3) {
    return {
      verdict: 'proceed',
      icon: '✅',
      summary: configExplained
        ? `Widely offered; RTP spread explained by ${publishedRtps.length} published configs → Proceed to Phase 2`
        : 'Widely offered + RTPs aligned → Proceed to Phase 2'
    };
  }

  return {
    verdict: 'escalate',
    icon: '⚠️',
    summary: `Only ${listed.length}/${SITE_ORDER.length} competitors list this game → Escalate to Enhanced Due Diligence`
  };
}
