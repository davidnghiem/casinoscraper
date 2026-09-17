import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Recall state for the bot. Tracks games we've recommended deactivating on
// Dicey, so that when SOFTSWISS later announces 'X games enabled back' we can
// replay the list to the team.

export interface RecallEntry {
  slug: string;
  name: string;
  reason: string;
  recalledAt: string;
  sourceTs: string | null;
}

export type RecallState = Record<string, RecallEntry[]>;

const STATE_PATH = resolve(
  process.cwd(),
  process.env.STATE_PATH || 'state/recalls.json'
);

let cache: RecallState | null = null;

async function load(): Promise<RecallState> {
  if (cache) return cache;
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    cache = JSON.parse(raw) as RecallState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    cache = {};
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, STATE_PATH);
}

export interface RecordRecallInput {
  provider: string;
  slug: string;
  name?: string | null;
  reason: string;
  sourceTs?: string | null;
}

export async function recordRecall(input: RecordRecallInput): Promise<void> {
  const { provider, slug, name, reason, sourceTs } = input;
  if (!provider || !slug) return;
  const state = await load();
  const list = state[provider] || (state[provider] = []);
  const existing = list.find((e) => e.slug === slug);
  const now = new Date().toISOString();
  if (existing) {
    existing.reason = reason;
    existing.recalledAt = now;
    existing.sourceTs = sourceTs ?? existing.sourceTs;
    existing.name = name ?? existing.name;
  } else {
    list.push({
      slug,
      name: name || slug,
      reason,
      recalledAt: now,
      sourceTs: sourceTs ?? null
    });
  }
  await persist();
}

export async function clearRecallsForProvider(
  provider: string
): Promise<RecallEntry[]> {
  const state = await load();
  const removed = state[provider] || [];
  delete state[provider];
  await persist();
  return removed;
}

export async function getRecallsForProvider(
  provider: string
): Promise<RecallEntry[]> {
  const state = await load();
  return state[provider] || [];
}
