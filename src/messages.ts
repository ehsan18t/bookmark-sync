import type { Account, GroupSummary, JoinInput, LocalFolder, NewAccount, PartChoice, Settings, Target } from './engine/app.js';

export type Command =
  | { t: 'status' }
  | { t: 'snapshot' }
  | { t: 'capabilities' }
  | { t: 'accounts' }
  | { t: 'addAccount'; account: NewAccount }
  | { t: 'addGoogle'; name: string }
  | { t: 'removeAccount'; id: string }
  | { t: 'discover'; accountId: string }
  | { t: 'folders' }
  | { t: 'create'; input: { accountId: string; name: string; mode: 'everything' | 'folder'; target: Target; passphrase?: string; ignoreDefaults: boolean } }
  | { t: 'previewJoin'; input: JoinInput }
  | { t: 'join'; input: JoinInput }
  | { t: 'leave' | 'undoJoin' | 'deleteEverywhere' | 'devices' | 'timeline' | 'syncGroup'; groupId: string }
  | { t: 'removeDevice'; groupId: string; deviceId: string }
  | { t: 'rename'; groupId: string; name: string }
  | { t: 'groupFolders'; accountId: string; groupId: string; passphrase?: string }
  | { t: 'addParts'; groupId: string; parts: PartChoice[]; takeover?: boolean }
  | { t: 'addTops'; groupId: string; folderIds: string[]; takeover?: boolean }
  | { t: 'removePart'; groupId: string; part: string; everywhere: boolean }
  | { t: 'movePart'; groupId: string; part: string; folderId: string; takeover?: boolean }
  | { t: 'dismissNotices'; groupId: string }
  | { t: 'previewRestore' | 'restore'; groupId: string; hlc: string }
  | { t: 'resolve'; groupId: string; choice: 'apply' | 'revert' | 'resume' }
  | { t: 'unlock'; groupId: string; passphrase: string; remember: boolean }
  | { t: 'setEncryption'; groupId: string; passphrase: string | null }
  | { t: 'continueMigration'; groupId: string; deviceIds: string[] }
  | { t: 'syncNow' }
  | { t: 'settings' }
  | { t: 'updateSettings'; patch: Partial<Settings & { deviceName: string }> }
  | { t: 'scanDuplicates' }
  | { t: 'applyDedupe'; action: { remove: string[] } | { move: string[]; folderId: string } }
  | { t: 'localUndo' }
  | { t: 'undoLocal'; id: string }
  | { t: 'diagnostics' };

export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export type PublicAccount = Pick<Account, 'id' | 'type' | 'name'> & { url?: string; username?: string; email?: string };
export type Capabilities = { google: boolean; googleBlocked: boolean; browser: string };
export type Device = { deviceId: string; name: string; browser: string; lastSeen: number; left: boolean; removed: boolean; self: boolean };

/** What the pages show, saved by the background script so they can draw it before it answers. */
export interface Snapshot {
  groups: GroupSummary[];
  accounts: PublicAccount[];
  folders: LocalFolder[];
  caps: Capabilities;
  devices: Record<string, Device[]>;
  /** Increases with every saved snapshot, so a page never replaces a newer one with an older one. */
  at: number;
}

export const SNAPSHOT_KEY = 'snapshot';
