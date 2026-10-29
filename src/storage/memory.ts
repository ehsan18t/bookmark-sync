
import { bytesEqual } from '../core/codec.js';
import type { CreateOnceResult, StorageProvider } from '../engine/ports.js';

export interface MemoryFaults {
  visibilityDelay?: () => number;
  loseCreateResponse?: () => boolean;
}

interface StoredFile {
  versions: { data: Uint8Array; visibleAt: number }[];
}

export class LostResponseError extends Error {}

export class MemoryProvider {
  private readonly files = new Map<string, StoredFile>();
  readonly createLog = new Map<string, Uint8Array[]>();

  constructor(
    private readonly now: () => number,
    private readonly faults: MemoryFaults = {},
  ) {}

  client(): StorageProvider {
    return {
      listGroups: async () => this.listGroups(),
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

  overwrittenPaths(): string[] {
    return [...this.createLog].filter(([, versions]) => versions.length > 1).map(([p]) => p);
  }

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

  private listGroups(): string[] {
    const out = new Set<string>();
    for (const [path, f] of this.files) {
      const m = /^groups\/([^/]+)\/group\.json$/.exec(path);
      if (m && this.visible(f)) out.add(m[1]!);
    }
    return [...out].sort();
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
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
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
