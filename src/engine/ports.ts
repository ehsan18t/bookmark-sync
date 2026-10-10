import type { Kind } from '../core/ops.js';
import type { LiveNode } from '../core/reconcile.js';

export type CreateOnceResult = { status: 'created' } | { status: 'exists'; existing: Uint8Array[] };

export class DuplicateFileError extends Error {}

export interface StorageProvider {
  listGroups(): Promise<string[]>;
  listDevices(group: string): Promise<string[]>;
  get(path: string): Promise<Uint8Array | null>;
  createOnce(path: string, data: Uint8Array): Promise<CreateOnceResult>;
  overwrite(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  serverDate(): number;
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
