import type { Account, GroupSummary, LocalFolder } from '../../engine/app.js';
import { send } from '../../ui/dom.js';

export type PublicAccount = Pick<Account, 'id' | 'type' | 'name'> & { url?: string; username?: string };
export type Folder = LocalFolder;
export type Capabilities = { google: boolean; googleBlocked: boolean; browser: string };
export type FoundSync = { groupId: string; name: string; mode: 'everything' | 'folder'; encrypted: boolean; joined: boolean };

export const state: { accounts: PublicAccount[]; groups: GroupSummary[]; folders: Folder[]; caps: Capabilities } = {
  accounts: [],
  groups: [],
  folders: [],
  caps: { google: false, googleBlocked: false, browser: 'this browser' },
};

export async function load() {
  [state.groups, state.accounts, state.folders, state.caps] = await Promise.all([
    send<GroupSummary[]>({ t: 'status' }),
    send<PublicAccount[]>({ t: 'accounts' }),
    send<Folder[]>({ t: 'folders' }),
    send<Capabilities>({ t: 'capabilities' }),
  ]);
}

export const storageLabel = (a: PublicAccount | undefined) => (!a ? 'Unknown storage' : a.type === 'gdrive' ? 'Google Drive' : a.name);

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
