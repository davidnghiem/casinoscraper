import 'dotenv/config';
import bolt from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock, Block } from '@slack/types';
import { parseAlert } from './extract.js';
import { dispatch } from './handlers.js';
import { shutdownBrowser } from './browser.js';
import { logger as log } from './logger.js';

const { App, LogLevel } = bolt;

const WATCH_CHANNEL_ID = process.env.SLACK_WATCH_CHANNEL_ID;
if (!WATCH_CHANNEL_ID) {
  throw new Error('SLACK_WATCH_CHANNEL_ID is not set');
}

// Restrict to SOFTSWISS Alerts bot posts. Exact match if SOFTSWISS_BOT_ID is
// set; otherwise name heuristic on bot_profile.name / username.
const SOFTSWISS_BOT_ID = process.env.SOFTSWISS_BOT_ID || null;
const SOFTSWISS_NAME_RE = /softswiss/i;

// Separate channel for bot-error notifications. Empty = log only.
const ERRORS_CHANNEL_ID = process.env.SLACK_ERRORS_CHANNEL_ID || null;

// Footer appended to every reply so the OG poster knows the acknowledgement
// protocol.
const REPLY_FOOTER =
  '_React to OG post w/ ✅ or ❌ once actioned or dismissed_';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO
});

let selfBotId: string | null = null;

// Slack types don't surface bot_profile cleanly on the union; narrow ad-hoc.
interface SoftswissBotMessage {
  channel?: string;
  subtype?: string;
  bot_id?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  username?: string;
  bot_profile?: { name?: string };
  blocks?: Array<KnownBlock | Block>;
  attachments?: Array<{
    pretext?: string;
    title?: string;
    text?: string;
    fallback?: string;
    blocks?: Array<KnownBlock | Block>;
  }>;
}

app.message(async ({ message, client }) => {
  const m = message as SoftswissBotMessage;
  if (m.channel !== WATCH_CHANNEL_ID) return;
  if (m.subtype !== 'bot_message') return;
  if (selfBotId && m.bot_id === selfBotId) return;
  if (!isSoftswissMessage(m)) return;

  const text = composeText(m);
  if (!text) return;

  const alert = parseAlert(text);
  if (!alert.type) return;

  log.info({ type: alert.type, ts: m.ts }, 'alert detected');

  let reply: string | null;
  try {
    reply = await dispatch(alert, m.ts ?? null);
  } catch (err) {
    const e = err as Error;
    log.error(
      { type: alert.type, ts: m.ts, err: e.message, stack: e.stack },
      'handler error'
    );
    await postErrorToSlack(
      client,
      `:rotating_light: *casinoscraper* — handler crashed on \`${alert.type}\` alert (ts: ${m.ts}): \`${e.message}\``
    );
    return;
  }

  if (!reply) return;

  try {
    await client.chat.postMessage({
      channel: m.channel!,
      thread_ts: m.thread_ts || m.ts,
      text: `${reply}\n\n${REPLY_FOOTER}`,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false
    });
  } catch (err) {
    const e = err as Error;
    log.error(
      { type: alert.type, ts: m.ts, err: e.message },
      'reply post failed'
    );
    await postErrorToSlack(
      client,
      `:rotating_light: *casinoscraper* — reply post failed for \`${alert.type}\` (ts: ${m.ts}): \`${e.message}\``
    );
  }
});

// Best-effort post to the errors channel; never throws, never crashes the bot.
async function postErrorToSlack(
  client: WebClient,
  text: string
): Promise<void> {
  if (!ERRORS_CHANNEL_ID) return;
  try {
    await client.chat.postMessage({
      channel: ERRORS_CHANNEL_ID,
      text,
      mrkdwn: true,
      unfurl_links: false
    });
  } catch (err) {
    log.error(
      { err: (err as Error).message },
      'failed to post to errors channel'
    );
  }
}

function isSoftswissMessage(message: SoftswissBotMessage): boolean {
  if (SOFTSWISS_BOT_ID) return message.bot_id === SOFTSWISS_BOT_ID;
  const name = message.bot_profile?.name || message.username || '';
  return SOFTSWISS_NAME_RE.test(name);
}

function composeText(message: SoftswissBotMessage): string {
  const parts: string[] = [];
  if (message.text) parts.push(message.text);
  for (const block of message.blocks || []) {
    collectBlockText(block as unknown as Record<string, unknown>, parts);
  }
  for (const att of message.attachments || []) {
    if (att.pretext) parts.push(att.pretext);
    if (att.title) parts.push(att.title);
    if (att.text) parts.push(att.text);
    if (att.fallback) parts.push(att.fallback);
    for (const block of att.blocks || []) {
      collectBlockText(block as unknown as Record<string, unknown>, parts);
    }
  }
  return parts.join('\n');
}

function collectBlockText(
  block: Record<string, unknown>,
  parts: string[]
): void {
  const textObj = block.text as { text?: string } | undefined;
  if (textObj?.text) parts.push(textObj.text);
  const fields = block.fields as Array<{ text?: string }> | undefined;
  for (const f of fields || []) {
    if (f.text) parts.push(f.text);
  }
  const elements = block.elements as
    | Array<Record<string, unknown>>
    | undefined;
  for (const el of elements || []) {
    const elText = el.text;
    if (elText && typeof elText === 'object' && 'text' in elText) {
      const t = (elText as { text?: string }).text;
      if (t) parts.push(t);
    }
    if (typeof elText === 'string') parts.push(elText);
    const subs = el.elements as Array<Record<string, unknown>> | undefined;
    for (const sub of subs || []) {
      const subText = sub.text;
      if (typeof subText === 'string') parts.push(subText);
      else if (subText && typeof subText === 'object' && 'text' in subText) {
        const t = (subText as { text?: string }).text;
        if (t) parts.push(t);
      }
    }
  }
}

const shutdown = async (): Promise<void> => {
  await shutdownBrowser();
  await app.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.start();

try {
  const me = (await app.client.auth.test()) as { bot_id?: string };
  selfBotId = me.bot_id || null;
  log.info(
    {
      channel: WATCH_CHANNEL_ID,
      botId: selfBotId,
      errorsChannel: ERRORS_CHANNEL_ID
    },
    'casinoscraper running'
  );
} catch (err) {
  log.warn(
    {
      channel: WATCH_CHANNEL_ID,
      err: (err as Error).message
    },
    'casinoscraper running, but auth.test failed'
  );
}

process.on('unhandledRejection', (reason) => {
  log.fatal({ reason: String(reason) }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  log.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
});
