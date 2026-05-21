const PROVIDERS = [
  { canonical: 'Pragmatic Play', patterns: [/\bpragmatic(?:\s+play)?\b/i] },
  { canonical: 'Hacksaw Gaming', patterns: [/\bhacksaw(?:\s+gaming)?\b/i] },
  { canonical: 'Nolimit City', patterns: [/\bno\s*limit\s*city\b/i, /\bnlc\b/i] },
  { canonical: 'Push Gaming', patterns: [/\bpush\s+gaming\b/i] },
  { canonical: 'Relax Gaming', patterns: [/\brelax\s+gaming\b/i] },
  {
    canonical: "Play'n GO",
    patterns: [/\bplay['’]?n\s*go\b/i, /\bplayngo\b/i]
  },
  { canonical: 'ELK Studios', patterns: [/\belk(?:\s+studios)?\b/i] },
  { canonical: 'Print Studios', patterns: [/\bprint\s+studios\b/i] },
  {
    canonical: 'Big Time Gaming',
    patterns: [/\bbig\s+time\s+gaming\b/i, /\bbtg\b/i]
  }
];

const FILLER_TOKENS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'will', 'be',
  'just', 'now', 'live', 'out', 'today', 'tomorrow', 'tonight',
  'new', 'release', 'releases', 'releasing', 'released',
  'drop', 'drops', 'dropped', 'dropping',
  'launch', 'launches', 'launching', 'launched',
  'from', 'by', 'on', 'with', 'via', 'and',
  'game', 'games', 'slot', 'slots', 'title',
  'coming', 'soon', 'available', 'next', 'week',
  'fire', 'lit', 'hype', 'official', 'feature', 'incoming',
  'stake', 'shuffle', 'stakecom', 'shufflecom',
  'here', 'channel', 'everyone'
]);

const SLACK_MENTIONS = /<[@#!][^>]+>|@(?:here|channel|everyone)\b/gi;
const NOISE_CHARS = /[@\p{Emoji_Presentation}\p{Extended_Pictographic}!?.,:;—–\-\[\](){}<>"“”'`|/\\*~_]/gu;

const MAX_NAME_LENGTH = 60;

export function extractGameAnnouncement(messageText) {
  if (!messageText || messageText.length < 3) return null;

  let providerMatch = null;
  for (const p of PROVIDERS) {
    if (p.patterns.some((re) => re.test(messageText))) {
      providerMatch = p;
      break;
    }
  }
  if (!providerMatch) return null;

  let stripped = messageText.replace(SLACK_MENTIONS, ' ');
  for (const re of providerMatch.patterns) {
    stripped = stripped.replace(new RegExp(re.source, re.flags + 'g'), ' ');
  }
  stripped = stripped.replace(NOISE_CHARS, ' ');

  const tokens = stripped
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !FILLER_TOKENS.has(t.toLowerCase()));

  const cleaned = tokens.join(' ').trim();
  if (cleaned.length < 2 || cleaned.length > MAX_NAME_LENGTH) return null;

  return {
    provider: providerMatch.canonical,
    gameName: cleaned
  };
}
