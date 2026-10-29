import type { PublicAccount } from '../../messages.js';

export const storageLabel = (a: PublicAccount | undefined) => (!a ? 'Unknown storage' : a.type === 'gdrive' ? 'Google Drive' : a.name);

/** The storage with the account signed in to it, for telling two connections apart. */
export const storageWithAccount = (a: PublicAccount | undefined) => {
  const who = a?.type === 'gdrive' ? a.email : a?.username;
  return who ? `${storageLabel(a)} · ${who}` : storageLabel(a);
};
