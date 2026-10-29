import { canonical, type Tree } from '../../src/core/tree.js';
import type { RandomBytes } from '../../src/core/ids.js';
import {
  GroupEngine,
  type EnginePorts,
  type EngineSettings,
  type GroupConfig,
  type GroupLocal,
  type GroupStore,
  type JoinOptions,
  type NewTop,
} from '../../src/engine/group.js';
import { MemoryProvider, type MemoryFaults } from '../../src/storage/memory.js';
import { FAKE_ROOTS, FakeBookmarks, fakeRoots } from './fakeBookmarks.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MemoryStore implements GroupStore {
  data = new Map<string, GroupLocal>();
  /** While frozen, saves are dropped, like writes after the background worker was stopped. */
  frozen = false;
  async load(groupId: string) {
    const v = this.data.get(groupId);
    return v ? structuredClone(v) : null;
  }
  async save(local: GroupLocal) {
    if (!this.frozen) this.data.set(local.config.groupId, structuredClone(local));
  }
  async delete(groupId: string) {
    this.data.delete(groupId);
  }
}

export interface SimDevice {
  name: string;
  bookmarks: FakeBookmarks;
  store: MemoryStore;
  keys: Map<string, CryptoKey>;
  ports: EnginePorts;
  engine: GroupEngine;
  skew: number;
}

export interface SimOptions {
  devices: number;
  seed: number;
  faults?: boolean;
  maxSkew?: number;
  settings?: Partial<EngineSettings>;
  passphrase?: string;
  chromiumDevices?: number[];
  guardPolicy?: 'apply' | 'revert';
  visibilityDelayMs?: number;
}

export const GROUP_ID = 'g0';
export const SIM_SETTINGS: Partial<EngineSettings> = { consistentReadDelayMs: 1000, guardMin: 1_000_000 };

export class Simulator {
  time = 1_800_000_000_000;
  readonly rng: () => number;
  readonly provider: MemoryProvider;
  readonly devices: SimDevice[] = [];
  readonly errors: string[] = [];
  private faultsOn = false;
  loseNextUpload = false;

  constructor(readonly options: SimOptions) {
    this.rng = mulberry32(options.seed);
    const faults: MemoryFaults = {
      visibilityDelay: () => {
        if (!this.faultsOn) return 0;
        if (options.visibilityDelayMs) return options.visibilityDelayMs;
        return options.faults && this.rng() < 0.3 ? Math.floor(this.rng() * 20_000) : 0;
      },
      loseCreateResponse: () => {
        if (this.loseNextUpload) {
          this.loseNextUpload = false;
          return true;
        }
        return !!options.faults && this.faultsOn && this.rng() < 0.1;
      },
    };
    this.provider = new MemoryProvider(() => this.time, faults);
  }

  randomBytes: RandomBytes = (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(this.rng() * 256);
    return out;
  };

  makeDevice(name: string, bookmarks?: FakeBookmarks, store?: MemoryStore, keys?: Map<string, CryptoKey>): SimDevice {
    const chromium = this.options.chromiumDevices?.includes(this.devices.length) ?? false;
    const bm = bookmarks ?? new FakeBookmarks(`${name}_`, { separators: !chromium });
    const st = store ?? new MemoryStore();
    const ks = keys ?? new Map<string, CryptoKey>();
    const skew = this.options.maxSkew ? Math.floor((this.rng() * 2 - 1) * this.options.maxSkew) : 0;
    const device = { skew } as SimDevice;
    const ports: EnginePorts = {
      provider: this.provider.client(),
      bookmarks: bm,
      store: st,
      clock: { now: () => this.time + device.skew },
      random: this.randomBytes,
      settings: { ...SIM_SETTINGS, ...this.options.settings },
      sleep: async (ms) => this.advance(ms),
      keyFor: async (g) => ks.get(g) ?? null,
      place: async (hint, title) => {
        const parent = await fakeRoots(bm).resolve({ root: hint.root, path: hint.path.slice(0, -1) }, true);
        return bm.create({ parentId: parent, kind: 'folder', title: hint.path.at(-1) ?? title, url: '' });
      },
    };
    return Object.assign(device, { name, bookmarks: bm, store: st, keys: ks, ports, engine: undefined as unknown as GroupEngine });
  }

  config(d: SimDevice): GroupConfig {
    return {
      groupId: GROUP_ID,
      accountId: 'acct',
      deviceId: d.name,
      deviceName: d.name,
      browser: 'firefox',
      mode: 'everything',
      mapping: { 'root:toolbar': FAKE_ROOTS.toolbar, 'root:other': FAKE_ROOTS.other, 'root:menu': FAKE_ROOTS.menu },
      name: 'Test group',
      encrypted: !!this.options.passphrase,
    };
  }

  async setup(): Promise<void> {
    for (let i = 0; i < this.options.devices; i++) {
      const d = this.makeDevice(`dev${String.fromCharCode(97 + i)}`);
      if (i === 0) {
        const { encrypted: _e, ...config } = this.config(d);
        const res = await GroupEngine.create(d.ports, config, { passphrase: this.options.passphrase, iterations: 1000 });
        d.engine = res.engine;
        if (res.key) d.keys.set(GROUP_ID, res.key);
      } else {
        if (this.options.passphrase) d.keys.set(GROUP_ID, this.devices[0]!.keys.get(GROUP_ID)!);
        d.engine = await GroupEngine.join(d.ports, this.config(d), { mode: 'merge', ignoreDefaults: false }, d.keys.get(GROUP_ID) ?? null);
      }
      this.devices.push(d);
    }
    this.faultsOn = true;
  }

  /** Add a device whose bookmarks are filled in first, then create or join the group. */
  async addDevice(
    name: string,
    fill: (bm: FakeBookmarks) => Promise<void>,
    how: { create: true; ignoreDefaults?: boolean; tops?: NewTop[] } | { create?: false; join: JoinOptions },
    browser: GroupConfig['browser'] = 'firefox',
    override: Partial<GroupConfig> & { bookmarks?: FakeBookmarks } = {},
  ): Promise<SimDevice> {
    const { bookmarks, ...configOverride } = override;
    const d = this.makeDevice(name, bookmarks);
    await fill(d.bookmarks);
    const config = { ...this.config(d), browser, ...configOverride };
    if (how.create) {
      const { encrypted: _e, ...rest } = config;
      const res = await GroupEngine.create(d.ports, rest, { passphrase: this.options.passphrase, iterations: 1000, ignoreDefaults: how.ignoreDefaults ?? false, tops: how.tops });
      d.engine = res.engine;
      if (res.key) d.keys.set(config.groupId, res.key);
    } else {
      if (this.options.passphrase) d.keys.set(config.groupId, this.devices[0]!.keys.get(config.groupId)!);
      d.engine = await GroupEngine.join(d.ports, config, how.join, d.keys.get(config.groupId) ?? null);
    }
    this.devices.push(d);
    return d;
  }

  async preview(name: string, fill: (bm: FakeBookmarks) => Promise<void>, opts: JoinOptions) {
    const d = this.makeDevice(name);
    await fill(d.bookmarks);
    return GroupEngine.preview(d.ports, this.config(d), opts, this.devices[0]?.keys.get(GROUP_ID) ?? null);
  }

  enableFaults(on = true): void {
    this.faultsOn = on;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  async sync(d: SimDevice): Promise<void> {
    try {
      await d.engine.cycle();
      const st = d.engine.status;
      if (st.state === 'paused' && (st.reason === 'large-remote-change' || st.reason === 'large-local-change') && this.options.guardPolicy) {
        await d.engine.resolveGuard(this.options.guardPolicy);
      }
    } catch (e) {
      if (!(e as Error).message.startsWith('lost response')) throw e;
      this.errors.push((e as Error).message);
    }
  }

  async restart(d: SimDevice): Promise<void> {
    d.engine = await GroupEngine.open(d.ports, d.engine.groupId);
  }

  async cloneDevice(d: SimDevice, name: string): Promise<SimDevice> {
    const store = new MemoryStore();
    store.data = new Map([...d.store.data].map(([k, v]) => [k, structuredClone(v)]));
    const copy = this.makeDevice(name, d.bookmarks.clone(`${name}_`), store, new Map(d.keys));
    copy.engine = await GroupEngine.open(copy.ports, d.engine.groupId);
    this.devices.push(copy);
    return copy;
  }

  async quiet(maxRounds = 40): Promise<void> {
    this.provider.flushVisibility();
    let previous = '';
    let stable = 0;
    for (let round = 0; round < maxRounds; round++) {
      for (const d of this.devices) await this.sync(d);
      this.advance(1000);
      this.provider.flushVisibility();
      const fingerprint = JSON.stringify(this.devices.map((d) => [this.canonicalMirror(d), d.engine.state.ops.length, d.engine.groupId]));
      const idle = this.devices.every((d) => d.engine.state.outbox.length === 0 && !d.engine.state.pendingBatch);
      if (idle && fingerprint === previous) {
        if (++stable >= 2) return;
      } else stable = 0;
      previous = fingerprint;
    }
    throw new Error(`simulation did not settle: ${JSON.stringify(this.devices.map((d) => d.engine.status))}`);
  }

  mirrorTree(d: SimDevice): Tree {
    const m = d.engine.mirror();
    return { roots: m.roots, nodes: m.nodes };
  }

  canonicalMirror(d: SimDevice): unknown {
    return canonical(this.mirrorTree(d));
  }

  canonicalLocalMirror(d: SimDevice): unknown {
    const m = d.engine.mirror();
    return canonical({ roots: m.roots, nodes: new Map([...m.nodes].filter(([, n]) => n.localId !== '')) });
  }

  async canonicalLive(d: SimDevice): Promise<unknown> {
    const idmap = new Map(d.engine.state.idmap);
    const excluded = new Set(d.engine.state.excluded.map(([l]) => l));
    const out = [];
    for (const groupRoot of d.engine.roots) {
      const n = await d.bookmarks.getSubTree(d.engine.state.config.mapping[groupRoot]!);
      const walk = (x: typeof n): unknown[] =>
        (x.children ?? []).filter((c) => !excluded.has(c.localId)).map((c) => [idmap.get(c.localId) ?? `?${c.localId}`, c.kind, c.title, c.url, walk(c)]);
      out.push([groupRoot, walk(n)]);
    }
    return out;
  }

}
