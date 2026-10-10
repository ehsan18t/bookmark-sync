// Interfaces the engine uses to reach the outside world (IMPLEMENTATION.md 1 and 7).
// The browser, the provider and the local database are all behind these, so the simulator can run
// the real engine against fakes.

import type { LiveNode } from '../core/reconcile.js';
import type { Kind } from '../core/ops.js';

export type CreateOnceResult = { status: 'created' } | { status: 'exists'; existing: Uint8Array[] };

export interface StorageProvider {
  /** Device IDs that have a folder in this group. */
  listDevices(group: string): Promise<string[]>;
  get(path: string): Promise<Uint8Array | null>;
  /** Write a file that must never be overwritten. Reports every file already at that path. */
  createOnce(path: string, data: Uint8Array): Promise<CreateOnceResult>;
  /** Replace a file only this device writes (device.json, its own markers). */
  overwrite(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  /** The provider's clock, from the Date header of the last response. */
  serverDate(): number;
}

/** The subset of browser.bookmarks the engine needs, with Firefox index semantics (final position). */
export interface BookmarksPort {
  /** The live tree under a local folder. */
  getSubTree(localId: string): Promise<LiveNode>;
  create(args: { parentId: string; index?: number; kind: Kind; title: string; url: string }): Promise<string>;
  update(localId: string, changes: { title?: string; url?: string }): Promise<void>;
  move(localId: string, dest: { parentId: string; index?: number }): Promise<void>;
  removeTree(localId: string): Promise<void>;
}

export interface Clock {
  now(): number;
}
