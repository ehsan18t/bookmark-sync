// In-memory storage provider for tests and the simulator (IMPLEMENTATION.md 15.2).
// It can delay when new files become visible, lose the response of a write that succeeded, and it
// keeps an oracle record of every write so tests can check that no batch was ever overwritten.

import { bytesEqual } from '../core/codec.js';
import type { CreateOnceResult, StorageProvider } from '../engine/ports.js';

export interface MemoryFaults {
  /** Milliseconds (of the shared clock) before a newly created file shows up in reads and listings. */
  visibilityDelay?: () => number;
  /** Return true to throw after a createOnce has written, as if the response was lost. */
  loseCreateResponse?: () => boolean;
}

interface StoredFile {
  /** Oldest first. Readers see the newest version that is already visible, like eventual consistency. */
  versions: { data: Uint8Array; visibleAt: number }[];
}

export class LostResponseError extends Error {}

export class MemoryProvider {
  private readonly files = new Map<string, StoredFile>();
  /** Every distinct content ever written to a createOnce path. */
  readonly createLog = new Map<string, Uint8Array[]>();

  constructor(
    private readonly now: () => number,
    private readonly faults: MemoryFaults = {},
  ) {}

  /** A view of this provider for one device. Each device sees the same files. */
  client(): StorageProvider {
    return {
      listDevices: async (group) => this.listDevices(group),
      get: async (path) => this.get(path),
      createOnce: async (path, data) => this.createOnce(path, data),
      overwrite: async (path, data) => this.overwrite(path, data),
      delete: async (path) => {
        this.files.delete(path);
      },
      listFiles: async (dir) => this.listFiles(dir),
      serverDate: () => this.now(),
    };
  }

  /** Every createOnce path that ever held two different contents. */
  overwrittenPaths(): string[] {
    return [...this.createLog].filter(([, versions]) => versions.length > 1).map(([p]) => p);
  }

  /** Make every file visible immediately, for the quiet phase of a simulation. */
  flushVisibility(): void {
    for (const f of this.files.values()) for (const v of f.versions) v.visibleAt = Math.min(v.visibleAt, this.now());
  }

  private current(f: StoredFile | undefined): Uint8Array | null {
    if (!f) return null;
    for (let i = f.versions.length - 1; i >= 0; i--) if (f.versions[i]!.visibleAt <= this.now()) return f.versions[i]!.data;
    return null;
  }

  private visible(f: StoredFile | undefined): f is StoredFile {
    return this.current(f) !== null;
  }

  private listDevices(group: string): string[] {
    const prefix = `groups/${group}/devices/`;
    const out = new Set<string>();
    for (const [path, f] of this.files) {
      if (path.startsWith(prefix) && this.visible(f)) out.add(path.slice(prefix.length).split('/')[0]!);
    }
    return [...out].sort();
  }

  private listFiles(dir: string): string[] {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    return [...this.files]
      .filter(([p, f]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && this.visible(f))
      .map(([p]) => p)
      .sort();
  }

  private get(path: string): Uint8Array | null {
    return this.current(this.files.get(path))?.slice() ?? null;
  }

  private createOnce(path: string, data: Uint8Array): CreateOnceResult {
    const existing = this.files.get(path);
    if (existing) return { status: 'exists', existing: [existing.versions[existing.versions.length - 1]!.data.slice()] };
    this.files.set(path, { versions: [{ data: data.slice(), visibleAt: this.now() + (this.faults.visibilityDelay?.() ?? 0) }] });
    const log = this.createLog.get(path) ?? [];
    if (!log.some((v) => bytesEqual(v, data))) log.push(data.slice());
    this.createLog.set(path, log);
    if (this.faults.loseCreateResponse?.()) throw new LostResponseError(`lost response for ${path}`);
    return { status: 'created' };
  }

  private overwrite(path: string, data: Uint8Array): void {
    const f = this.files.get(path) ?? { versions: [] };
    f.versions.push({ data: data.slice(), visibleAt: this.now() + (this.faults.visibilityDelay?.() ?? 0) });
    if (f.versions.length > 4) f.versions.splice(0, f.versions.length - 4);
    this.files.set(path, f);
  }
}
