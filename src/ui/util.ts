import { browser } from 'wxt/browser';
import type { Command, Reply } from '../messages.js';

export class ReplyError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Runs `run`, and when another browser links the syncs it would share a folder between, offers to take that over. */
export async function withTakeover(run: (takeover: boolean) => Promise<unknown>): Promise<void> {
  try {
    await run(false);
  } catch (e) {
    if (!(e instanceof ReplyError) || e.code !== 'bridge-taken') throw e;
    if (!window.confirm(`${e.message}

Make this browser the link instead? The other browser then stops syncing the shared folder in one of the two syncs.`)) throw e;
    await run(true);
  }
}

export async function send<T>(cmd: Command): Promise<T> {
  const reply = (await browser.runtime.sendMessage(cmd)) as Reply<T> | undefined;
  if (!reply) throw new Error('The extension did not answer. Try again.');
  if (!reply.ok) throw new ReplyError(reply.error, reply.code);
  return reply.value;
}

export function relativeTime(ms: number | null, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function hlcTime(hlc: string): string {
  return new Date(Number(hlc.slice(0, 15))).toLocaleString();
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
