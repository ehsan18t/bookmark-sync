import { batch, signal } from '@preact/signals';
import { browser } from 'wxt/browser';
import type { FoundGroup, GroupSummary, LocalFolder } from '../../engine/app.js';
import { SNAPSHOT_KEY, type Capabilities, type PublicAccount, type Snapshot } from '../../messages.js';
import { send } from '../../ui/util.js';

export type { Capabilities, PublicAccount };
export type Folder = LocalFolder;
export type FoundSync = FoundGroup;

export const groups = signal<GroupSummary[]>([]);
export const accounts = signal<PublicAccount[]>([]);
export const folders = signal<Folder[]>([]);
export const caps = signal<Capabilities>({ google: false, googleBlocked: false, browser: 'this browser' });
export const devices = signal<Snapshot['devices']>({});

let shownAt = 0;

function apply(s: Snapshot) {
  if (s.at < shownAt) return;
  shownAt = s.at;
  batch(() => {
    groups.value = s.groups;
    accounts.value = s.accounts;
    folders.value = s.folders;
    caps.value = s.caps;
    devices.value = s.devices;
  });
}

/** Shows the snapshot the background saved, and every later one. False when none is saved yet. */
export async function follow(): Promise<boolean> {
  browser.storage.onChanged.addListener((changes, area) => {
    const next = changes[SNAPSHOT_KEY]?.newValue as Snapshot | undefined;
    if (area === 'local' && next) apply(next);
  });
  const saved = (await browser.storage.local.get(SNAPSHOT_KEY))[SNAPSHOT_KEY] as Snapshot | undefined;
  if (saved) apply(saved);
  return !!saved;
}

/** Asks the background for a fresh snapshot; it waits behind a running sync. */
export async function load() {
  apply(await send<Snapshot>({ t: 'snapshot' }));
}

/** Ticks so relative times like "2 min ago" stay current. */
export const now = signal(Date.now());
setInterval(() => (now.value = Date.now()), 30_000);

export const storageLabel = (a: PublicAccount | undefined) => (!a ? 'Unknown storage' : a.type === 'gdrive' ? 'Google Drive' : a.name);

/** The storage with the account signed in to it, for telling two connections apart. */
export const storageWithAccount = (a: PublicAccount | undefined) => {
  const who = a?.type === 'gdrive' ? a.email : a?.username;
  return who ? `${storageLabel(a)} · ${who}` : storageLabel(a);
};

export const REASON_TEXT: Record<string, string> = {
  'large-remote-change': 'Another browser made a big change to these bookmarks. Check it before it’s applied here.',
  'large-local-change': 'Many bookmarks changed here at once. Check it before it’s sent to your other browsers.',
  'native-sync':
    'Two browsers in this sync also use the browser’s own bookmark sync, which creates duplicates. Turn off bookmark syncing in the browser’s settings (Chrome and Edge: Settings, Sync, Bookmarks; Firefox: Settings, Sync, Bookmarks), then resume.',
  locked: 'This sync is encrypted. Enter its passphrase to keep syncing.',
  'clock-skew': 'This computer’s clock is off by more than two minutes. Set the clock to the right time; syncing resumes by itself.',
  auth: 'The storage stopped accepting the sign-in. Remove the storage in Settings and connect it again.',
  permission: 'The extension no longer has permission to reach the storage server.',
  'mapped-folder-missing': 'A folder this sync uses here was deleted. Put it back and resume, pick another folder for it, or stop syncing it here.',
  'nothing-held': 'This browser no longer syncs any folder of this sync. Add a folder under More options, or stop syncing here.',
  'root-changed': 'The browser’s main bookmark folders changed. Stop syncing here, then set it up again.',
  'mapping-overlap': 'Two synced folders now overlap. Move one of them, then resume.',
  'group-deleted': 'This sync was deleted from another browser. Stop syncing here; your bookmarks stay as they are.',
  'format-too-new': 'Another browser uses a newer version of the extension. Update the extension here.',
  corrupt: 'A file in this sync couldn’t be read. Resume to try again, or export diagnostics from Settings.',
  migration: 'Encryption is being switched for this sync. Every browser moves over in the background.',
  'needs-join': 'This browser needs to set up this sync again.',
};

export const SHORT_REASON: Record<string, string> = {
  'large-remote-change': 'Big change to review',
  'large-local-change': 'Big change to review',
  'native-sync': 'Browser sync conflict',
  locked: 'Needs passphrase',
  'clock-skew': 'Clock is off',
  auth: 'Sign in again',
  permission: 'Needs permission',
  'mapped-folder-missing': 'Folder missing',
  'nothing-held': 'No folders here',
  'group-deleted': 'Deleted elsewhere',
  'format-too-new': 'Update needed',
  migration: 'Switching encryption',
};
