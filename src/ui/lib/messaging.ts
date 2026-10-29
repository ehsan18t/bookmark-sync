import { browser } from 'wxt/browser';
import type { Command, Reply } from '../../messages.js';

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
    if (
      !window.confirm(`${e.message}

Make this browser the link instead? The other browser then stops syncing the shared folder in one of the two syncs.`)
    )
      throw e;
    await run(true);
  }
}

export async function send<T>(cmd: Command): Promise<T> {
  const reply = (await browser.runtime.sendMessage(cmd)) as Reply<T> | undefined;
  if (!reply) throw new Error('The extension did not answer. Try again.');
  if (!reply.ok) throw new ReplyError(reply.error, reply.code);
  return reply.value;
}
