import type { JoinInput, NewAccount, PartChoice, Settings, Target } from './engine/app.js';

export type Command =
  | { t: 'status' }
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
  | { t: 'groupFolders'; accountId: string; groupId: string; passphrase?: string }
  | { t: 'addParts'; groupId: string; parts: PartChoice[] }
  | { t: 'addTops'; groupId: string; folderIds: string[] }
  | { t: 'removePart'; groupId: string; part: string; everywhere: boolean }
  | { t: 'movePart'; groupId: string; part: string; folderId: string }
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

export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
