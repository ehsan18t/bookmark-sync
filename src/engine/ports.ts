import type { Kind } from '../core/ops.js';
import type { LiveNode } from '../core/reconcile.js';

export type CreateOnceResult = { status: 'created' } | { status: 'exists'; existing: Uint8Array[] };

export class DuplicateFileError extends Error {}

export class PermissionMissingError extends Error {}

export interface StorageProvider {
  listGroups(): Promise<string[]>;
  /** Devices that have published a device.json in this group. */
  listDevices(group: string): Promise<string[]>;
  get(path: string): Promise<Uint8Array | null>;
  /** Several files at once, in order; each entry is what `get` would return or throw. */
  getMany?(paths: string[]): Promise<PromiseSettledResult<Uint8Array | null>[]>;
  /** Paths in `dir` stored more than once. Only Drive allows that; other storage leaves this out. */
  copiedPaths?(dir: string): Promise<string[]>;
  createOnce(path: string, data: Uint8Array): Promise<CreateOnceResult>;
  overwrite(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  serverDate(): number;
  /** The signed-in account, such as an email address, when the storage can tell. */
  whoAmI?(): Promise<string | null>;
}

export interface BookmarksPort {
  readonly supportsSeparators: boolean;
  getSubTree(localId: string): Promise<LiveNode>;
  exists(localId: string): Promise<boolean>;
  parentOf(localId: string): Promise<string | null>;
  create(args: { parentId: string; index?: number; kind: Kind; title: string; url: string }): Promise<string>;
  update(localId: string, changes: { title?: string; url?: string }): Promise<void>;
  move(localId: string, dest: { parentId: string; index?: number }): Promise<void>;
  removeTree(localId: string): Promise<void>;
}

export interface Clock {
  now(): number;
}
