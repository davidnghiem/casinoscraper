import 'dotenv/config';
import bolt from '@slack/bolt';
import { extractGameAnnouncement } from './extract.js';
import { searchShuffle } from './shuffle.js';
import { searchStake } from './stake.js';
import { searchRoobet } from './roobet.js';
import { searchRainbet } from './rainbet.js';
import { computeGate } from './gate.js';
import { shutdownBrowser } from './browser.js';

const { App, LogLevel } = bolt;

const WATCH_CHANNEL_ID = process.env.SLACK_WATCH_CHANNEL_ID;
if (!WATCH_CHANNEL_ID) {
  throw new Error('SLACK_WATCH_CHANNEL_ID is not set');
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO
});

app.message(async ({ message, client, logger }) => {
  if (message.channel !== WATCH_CHANNEL_ID) return;
  if (message.subtype) return;

  const text = message.text || '';
  const extracted = extractGameAnnouncement(text);
  if (!extracted) return;

  logger.info(`detected release: ${extracted.provider} / ${extracted.gameName}`);

  const settled = await Promise.allSettled([
    searchShuffle(extracted.gameName),
    searchStake(extracted.gameName),
    searchRainbet(extracted.gameName),
    searchRoobet(extracted.gameName)
  ]);

  const results = {
    shuffle: unwrap(settled[0]),
    stake: unwrap(settled[1]),
    rainbet: unwrap(settled[2]),
    roobet: unwrap(settled[3])
  };

  const gate = computeGate(results);
  const reply = formatReply(extracted, results, gate);

  await client.chat.postMessage({
    channel: message.channel,
    thread_ts: message.thread_ts || message.ts,
    text: reply,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false
  });
});

function unwrap(settled) {
  if (settled.status === 'fulfilled') return settled.value;
  return { found: false, error: settled.reason?.message || 'unknown error' };
}

function formatReply(extracted, results, gate) {
  const canonicalName =
    (results.shuffle?.found && results.shuffle.name) ||
    (results.stake?.found && results.stake.name) ||
    (results.rainbet?.found && results.rainbet.name) ||
    extracted.gameName;

  return [
    `🎰 *${canonicalName}* (${extracted.provider})`,
    formatSiteLine('Shuffle', results.shuffle),
    formatSiteLine('Stake', results.stake),
    formatSiteLine('Rainbet', results.rainbet),
    formatSiteLine('Roobet', results.roobet),
    '',
    `${gate.icon} *Gate 1:* ${gate.summary}`
  ].join('\n');
}

function formatSiteLine(site, result) {
  if (result?.error) return `  ⚠️ ${site} — error: ${result.error}`;
  if (!result?.found) return `  ❌ ${site} — not found`;
  if (result.rtp == null) {
    return `  ✅ ${site} — listed (RTP not published)`;
  }
  return `  ✅ ${site} — RTP ${result.rtp.toFixed(2)}%`;
}

const shutdown = async () => {
  await shutdownBrowser();
  await app.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.start();
console.log(`casinoscraper running — watching channel ${WATCH_CHANNEL_ID}`);
