import type { FoundSync, PublicAccount } from '../../../ui/state/store.js';
import { accounts, load } from '../../../ui/state/store.js';

export type Step =
  | { id: 'storage' }
  | { id: 'google' }
  | { id: 'server' }
  | { id: 'choose'; account: PublicAccount }
  | { id: 'create'; account: PublicAccount; name: string }
  | { id: 'join'; account: PublicAccount; sync: FoundSync }
  | { id: 'done'; account: PublicAccount; groupId: string; joined: boolean };

export type Go = (step: Step) => void;

export const STEP_INDEX: Record<Step['id'], number> = { storage: 1, google: 2, server: 2, choose: 3, create: 4, join: 4, done: 5 };

/** Reloads the store and goes on with the account just added. */
export async function connected(go: Go, id: string) {
  await load();
  go({ id: 'choose', account: accounts.value.find((a) => a.id === id)! });
}
