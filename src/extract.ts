import * as fuzz from 'fuzzball';

// Tighter than upstream's 80 because we don't pre-gate on an alert keyword:
// 80 starts confusing 'PoggiPlay' (a real provider we don't track) with our
// 'Popiplay' (ratio=82). Realistic typos still score ≥93.
const FUZZY_THRESHOLD = 88;

// Provider allowlist mirrors ALLOWED_PROVIDERS in
// magiceden-vibes/tg-slack-softswiss-alerts.
export const PROVIDERS = [
  'Pragmatic Play',
  'Hacksaw Gaming',
  'Evolution',
  'Nolimit City',
  'BGaming',
  "Play'n GO",
  'Penguin King',
  'Booming Games',
  'Endorphina',
  'PG Soft',
  'Peter & Sons',
  'Belatra',
  'Slotmill',
  'AvatarUX',
  'OneTouch',
  'Thunderkick',
  'Red Tiger',
  'Spinomenal',
  'NetEnt',
  'VoltEnt',
  'Big Time Gaming',
  'Gamomat',
  'Quickspin',
  'Blueprint',
  'Popiplay',
  'Truelab',
  'GameArt',
  'Skywind',
  'Fantasma Games',
  'Betsoft',
  'Habanero',
  'Evoplay',
  'Onlyplay',
  'Gaming Corps',
  'Amigo Gaming',
  '1Spin4Win',
  'Netgame',
  'Yggdrasil',
  'Playtech',
  'Spribe',
  'Platipus',
  'Barbara Bang',
  'Winfinity',
  'iNOUT',
  '1X2 Gaming',
  'Rogue',
  'EGT Digital',
  '1ZMIN'
] as const;

function normalize(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const NORMALIZED = PROVIDERS.map((canonical) => ({
  canonical,
  norm: normalize(canonical)
}));

// Match a raw provider token to a canonical name. Three-stage strategy:
//   1. exact normalized match (handles casing/punctuation: 'Pragmaticplay')
//   2. bidirectional substring containment (handles suffix presence/absence:
//      'Hacksaw' → 'Hacksaw Gaming')
//   3. fuzzball fuzz.ratio ≥ FUZZY_THRESHOLD (handles typos: 'Pragmatik Play')
export function matchProvider(rawProvider: string | null | undefined): string | null {
  const raw = normalize(rawProvider);
  if (!raw) return null;

  for (const { canonical, norm } of NORMALIZED) {
    if (norm === raw) return canonical;
  }
  for (const { canonical, norm } of NORMALIZED) {
    if (norm.includes(raw) || raw.includes(norm)) return canonical;
  }

  const results = fuzz.extract(rawProvider as string, PROVIDERS as unknown as string[], {
    scorer: fuzz.ratio,
    cutoff: FUZZY_THRESHOLD
  }) as Array<[string, number, number]>;
  if (results.length > 0) return results[0]![0];
  return null;
}

function matchProvidersForRaw(providerRaw: string | null | undefined): string[] {
  if (!providerRaw) return [];
  const out: string[] = [];
  for (const p of providerRaw
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const c = matchProvider(p);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────────────────────────────────

// One `Fee: … | RTP: … | Certs: …` line. SOFTSWISS ships many games in several
// fee/RTP configurations at once (e.g. hacksaw_basic 96.27 / hacksaw_rtp94
// 94.29 / hacksaw_rtp 92.23), one line each under a single game heading.
export interface ReleaseConfig {
  fee: string | null;
  rtp: number | null;
  certs: string | null;
}

export interface MatchedGame {
  game: string;
  providerRaw: string | null;
  matchedProviders: string[];
  provider?: string;
  location?: string | null;
  // First config, kept flat for the single-config case and back-compat.
  rtp?: number | null;
  fee?: string | null;
  certs?: string | null;
  // Every published config, in message order. Length >1 for multi-RTP games.
  configs?: ReleaseConfig[];
  reason?: string;
}

export interface MaintenanceWindow {
  releaseDate: string | null;
  startTime: string | null;
  duration: string | null;
}

export type AlertType =
  | 'released'
  | 'recall'
  | 'urgent'
  | 'rtp_change'
  | 'enabled_back'
  | 'maintenance';

export type ParsedAlert =
  | { type: 'released'; games: MatchedGame[] }
  | { type: 'recall'; games: MatchedGame[] }
  | { type: 'urgent'; games: MatchedGame[] }
  | {
      type: 'rtp_change';
      game: string;
      providerRaw: string;
      matchedProviders: string[];
      oldRtp: number;
      newRtp: number;
    }
  | {
      type: 'enabled_back';
      providerRaw: string;
      matchedProvider: string | null;
    }
  | {
      type: 'maintenance';
      providerRaw: string | null;
      matchedProvider: string | null;
      window: MaintenanceWindow;
    }
  | { type: null };

// ──────────────────────────────────────────────────────────────────────────
// Release-message parser (multi-game)
// ──────────────────────────────────────────────────────────────────────────

// Two release dialects are in circulation and both must parse:
//
//   A. SOFTSWISS GA bot        B. the prose "Dear team!" mail
//      New Games Released         The following games are released today:
//      Curacao+Malta              Curacao+Malta:
//      Red Rascal (Hacksaw)       Toothrot Tilly (Hacksaw/PineapplePlay):
//      Fee: x | RTP: 92.26 | …      - fee group: x ; RTP - 96.34
//                                   - Certifications: CA-ON CW EE
//
// B puts a colon after the game heading, writes "fee group" instead of "Fee",
// separates the RTP with a dash, spells out "Certifications", bullets each
// line, and hangs the certs on their own line covering the configs above them.
const RELEASE_HEADER_RE =
  /new\s+games\s+released|following\s+games\s+(?:are\s+|were\s+)?released|released\s+today/i;
const GAME_LINE_RE = /^(.+?)\s*\(([^)]+)\)\s*:?\s*$/;
const RTP_RE = /\brtp\s*[:\-]\s*([\d.,]+)/i;
const FEE_RE = /\bfee(?:\s+group)?\s*:\s*([^|;]+?)(?:\s*[|;]|$)/i;
const CERTS_RE = /\b(?:certifications?|certs?)\s*:\s*(.+?)$/i;
const META_LINE_RE = /^(source|time)\s*:/i;
const DETAIL_LINE_RE =
  /^[-•*]?\s*(?:fee(?:\s+group)?|rtp|certifications?|certs?)\s*[:\-]/i;
// Salutations and sign-offs in dialect B are not location headers.
const PROSE_LINE_RE =
  /^(?:dear\b|hi\b|hello\b|the\s+following\b|please\s+note\b)/i;
// A "game heading" that still carries detail-line syntax, or runs absurdly
// long, means the message reached us without its line breaks (a paste or a
// mangled forward). Looking those titles up yields nothing but noise, so the
// game is skipped rather than fanned out to five sites under a junk name.
const ARTIFACT_TITLE_RE =
  /\b(?:fee|rtp|certifications?|certs?)\s*[:\-]|\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/i;
const MAX_TITLE_LEN = 80;

export function parseReleaseMessage(text: string): MatchedGame[] {
  if (!text) return [];
  const lines = text.split('\n').map((l) => l.trim());
  if (!lines.some((l) => RELEASE_HEADER_RE.test(l))) return [];

  const games: MatchedGame[] = [];
  let location: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    if (RELEASE_HEADER_RE.test(line)) continue;
    if (META_LINE_RE.test(line)) continue;

    const gameMatch = line.match(GAME_LINE_RE);
    if (gameMatch) {
      const game = gameMatch[1]!.trim();
      const providerRaw = gameMatch[2]!.trim();

      // A game heading is followed by one or more consecutive detail lines,
      // one per published fee/RTP configuration. Tolerate blank lines before
      // the first; stop at the blank line (or heading) that starts the next
      // game.
      const configs: ReleaseConfig[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j];
        if (!candidate) {
          if (configs.length > 0) break;
          continue;
        }
        if (!DETAIL_LINE_RE.test(candidate)) break;
        const rtpM = candidate.match(RTP_RE);
        const feeM = candidate.match(FEE_RE);
        const certsM = candidate.match(CERTS_RE);

        if (rtpM || feeM) {
          configs.push({
            fee: feeM ? feeM[1]!.trim() : null,
            rtp: rtpM ? toFloat(rtpM[1]!) : null,
            certs: certsM ? certsM[1]!.trim() : null
          });
        } else if (certsM) {
          // Dialect B hangs "Certifications:" on its own line. It covers every
          // config above it that hasn't been given certs yet — which handles
          // both one shared trailing line and one line interleaved per config.
          const certs = certsM[1]!.trim();
          for (const c of configs) if (c.certs == null) c.certs = certs;
        }
      }

      if (ARTIFACT_TITLE_RE.test(game) || game.length > MAX_TITLE_LEN) continue;

      const matchedProviders = matchProvidersForRaw(providerRaw);

      if (matchedProviders.length > 0) {
        const first = configs[0];
        games.push({
          game,
          providerRaw,
          matchedProviders,
          provider: matchedProviders[0],
          location,
          rtp: first ? first.rtp : null,
          fee: first ? first.fee : null,
          certs: first ? first.certs : null,
          configs
        });
      }
      continue;
    }

    if (DETAIL_LINE_RE.test(line)) continue;
    if (PROSE_LINE_RE.test(line)) continue;
    if (line.length <= 60 && !line.includes('|')) {
      location = line.replace(/\s*:\s*$/, '');
    }
  }

  return games;
}

// ──────────────────────────────────────────────────────────────────────────
// Alert-type detection
// ──────────────────────────────────────────────────────────────────────────

const ALERT_PATTERNS: Record<AlertType, RegExp[]> = {
  urgent: [/#urgent\b/i, /temporarily\s+disabled/i, /freeze\s+withdrawals/i],
  recall: [/\brecall(?:ed)?\b/i],
  rtp_change: [/rtp[^.!?\n]*changed\s+from/i],
  enabled_back: [
    /\benabled\s+back\b/i,
    /\bavailable\s+again\b/i,
    /games?\s+(?:are|is)\s+available\s+again/i
  ],
  maintenance: [/\bmaintenance\b/i, /\bscheduled\s+downtime\b/i],
  released: [/new\s+games\s+released/i, /released\s+today/i]
};

const ALERT_ORDER: AlertType[] = [
  'urgent',
  'recall',
  'rtp_change',
  'enabled_back',
  'maintenance',
  'released'
];

export function detectAlertType(text: string): AlertType | null {
  if (!text) return null;
  for (const type of ALERT_ORDER) {
    for (const re of ALERT_PATTERNS[type]) {
      if (re.test(text)) return type;
    }
  }
  return null;
}

// "Detected Game:" preamble that the upstream bot prepends to single-game
// alerts. Captures the line after the colon (same-line or next-line).
function extractDetectedGame(text: string): MatchedGame | null {
  const m = text.match(/Detected Game:\s*([^\n]+)/i);
  if (!m) return null;
  const line = m[1]!.trim();
  const gm = line.match(GAME_LINE_RE);
  if (!gm) {
    return { game: line, providerRaw: null, matchedProviders: [] };
  }
  const game = gm[1]!.trim();
  const providerRaw = gm[2]!.trim();
  return {
    game,
    providerRaw,
    matchedProviders: matchProvidersForRaw(providerRaw)
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Recall (single + multi-game)
// ──────────────────────────────────────────────────────────────────────────

const RECALL_SINGLE_RE =
  /the\s+game\s+(.+?)\s*\(([^)]+)\)\s+has\s+been\s+recalled/i;
const RECALL_HEADER_RE =
  /the\s+following\s+(.+?)\s+games?\s+have\s+been\s+recalled\s*:?/i;
const RECALL_STOP_RE =
  /^(best\s+regards|thanks?\b|sincerely|kind\s+regards|please\s+let\s+us\s+know)/i;

export function parseRecall(text: string): { games: MatchedGame[] } {
  const games: MatchedGame[] = [];
  const detected = extractDetectedGame(text);
  if (detected && (detected.providerRaw || detected.game)) {
    games.push(detected);
    return { games };
  }

  const single = text.match(RECALL_SINGLE_RE);
  if (single) {
    const providerRaw = single[2]!.trim();
    games.push({
      game: single[1]!.trim(),
      providerRaw,
      matchedProviders: matchProvidersForRaw(providerRaw)
    });
    return { games };
  }

  const header = text.match(RECALL_HEADER_RE);
  if (header && header.index != null) {
    const providerRaw = header[1]!.trim();
    const matched = matchProvidersForRaw(providerRaw);
    const after = text.slice(header.index + header[0].length);
    for (const rawLine of after.split('\n')) {
      const line = rawLine.replace(/^[•\-*]\s*/, '').trim();
      if (!line) continue;
      if (RECALL_STOP_RE.test(line)) break;
      if (line.length > 80) break;
      const inline = line.match(GAME_LINE_RE);
      if (inline) {
        const provRaw = inline[2]!.trim();
        games.push({
          game: inline[1]!.trim(),
          providerRaw: provRaw,
          matchedProviders: matchProvidersForRaw(provRaw)
        });
      } else {
        games.push({ game: line, providerRaw, matchedProviders: matched });
      }
    }
  }

  return { games };
}

// ──────────────────────────────────────────────────────────────────────────
// URGENT
// ──────────────────────────────────────────────────────────────────────────

const URGENT_BODY_RE =
  /the\s+following\s+(.+?)\s+provider\s+games?\s+(?:has|have)\s+been\s+temporarily\s+disabled[^:\n]*:?\s*\n+\s*([^\n]+)/i;

export function parseUrgent(text: string): { games: MatchedGame[] } {
  const detected = extractDetectedGame(text);
  if (detected && detected.game) {
    return {
      games: [{ ...detected, reason: 'temporarily disabled by SOFTSWISS' }]
    };
  }
  const m = text.match(URGENT_BODY_RE);
  if (m) {
    const providerRaw = m[1]!.trim();
    return {
      games: [
        {
          game: m[2]!.trim(),
          providerRaw,
          matchedProviders: matchProvidersForRaw(providerRaw),
          reason: 'temporarily disabled by SOFTSWISS'
        }
      ]
    };
  }
  return { games: [] };
}

// ──────────────────────────────────────────────────────────────────────────
// RTP change
// ──────────────────────────────────────────────────────────────────────────

const RTP_CHANGE_RE =
  /value\s+of\s+rtp\s+in\s+the\s+game\s+(.+?)\s*\(([^)]+)\)\s+has\s+been\s+changed\s+from\s+["']?([\d.,]+)["']?\s+to\s+["']?([\d.,]+)["']?/i;

function toFloat(s: string): number {
  return parseFloat(String(s).replace(',', '.'));
}

export interface RtpChange {
  game: string;
  providerRaw: string;
  matchedProviders: string[];
  oldRtp: number;
  newRtp: number;
}

export function parseRtpChange(text: string): RtpChange | null {
  const m = text.match(RTP_CHANGE_RE);
  if (!m) return null;
  const providerRaw = m[2]!.trim();
  return {
    game: m[1]!.trim(),
    providerRaw,
    matchedProviders: matchProvidersForRaw(providerRaw),
    oldRtp: toFloat(m[3]!),
    newRtp: toFloat(m[4]!)
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Enabled back (provider-wide)
// ──────────────────────────────────────────────────────────────────────────

const ENABLED_BACK_PATTERNS = [
  /([\w][\w\s&'.\-]+?)\s+games?\s+(?:have\s+been|are)\s+enabled\s+back/i,
  /([\w][\w\s&'.\-]+?)\s+games?\s+(?:are|is)\s+available\s+again/i,
  /games?\s+(?:of|by)\s+([\w][\w\s&'.\-]+?)\s+(?:are|is)\s+available\s+again/i
];

export interface EnabledBack {
  providerRaw: string;
  matchedProvider: string | null;
}

export function parseEnabledBack(text: string): EnabledBack | null {
  for (const re of ENABLED_BACK_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const providerRaw = m[1]!.trim();
      return { providerRaw, matchedProvider: matchProvider(providerRaw) };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Maintenance
// ──────────────────────────────────────────────────────────────────────────

const MAINTENANCE_PROVIDER_PATTERNS = [
  /maintenance\s+related\s+to\s+the\s+(.+?)\s+integration/i,
  /game\s+provider\s+(.+?)\s+will\s+be/i,
  /\bprovider\s+(.+?)\s+(?:will\s+be|is\s+undergoing)/i
];

export interface MaintenanceInfo {
  providerRaw: string | null;
  matchedProvider: string | null;
  window: MaintenanceWindow;
}

export function parseMaintenance(text: string): MaintenanceInfo {
  let providerRaw: string | null = null;
  for (const re of MAINTENANCE_PROVIDER_PATTERNS) {
    const m = text.match(re);
    if (m) {
      providerRaw = m[1]!.trim();
      break;
    }
  }
  const dateM = text.match(/release\s+date\s*:\s*([^\n]+)/i);
  const timeM = text.match(/start\s+time\s*:\s*([^\n]+)/i);
  const durM = text.match(/duration\s*:\s*([^\n]+)/i);
  return {
    providerRaw,
    matchedProvider: providerRaw ? matchProvider(providerRaw) : null,
    window: {
      releaseDate: dateM ? dateM[1]!.trim() : null,
      startTime: timeM ? timeM[1]!.trim() : null,
      duration: durM ? durM[1]!.trim() : null
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────

export function parseAlert(text: string): ParsedAlert {
  const type = detectAlertType(text);
  switch (type) {
    case 'released':
      return { type, games: parseReleaseMessage(text) };
    case 'recall':
      return { type, ...parseRecall(text) };
    case 'urgent':
      return { type, ...parseUrgent(text) };
    case 'rtp_change': {
      const r = parseRtpChange(text);
      return r ? { type, ...r } : { type: null };
    }
    case 'enabled_back': {
      const r = parseEnabledBack(text);
      return r ? { type, ...r } : { type: null };
    }
    case 'maintenance':
      return { type, ...parseMaintenance(text) };
    default:
      return { type: null };
  }
}
