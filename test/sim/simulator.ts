// Multi-device simulator (IMPLEMENTATION.md 15.2): runs the real engine for several devices against
// one shared memory provider, with a fake bookmarks API per device and a shared, controllable clock.

import { canonical, type Tree } from '../../src/core/tree.js';
import type { RandomBytes } from '../../src/core/ids.js';
import { GroupEngine, type EnginePorts, type GroupConfig, type GroupLocal, type Store } from '../../src/engine/group.js';
import { MemoryProvider, type MemoryFaults } from '../../src/storage/memory.js';
import { FAKE_ROOTS, FakeBookmarks } from './fakeBookmarks.js';

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

class MemoryStore implements Store {
  private readonly data = new Map<string, GroupLocal>();
  async load(groupId: string) {
    const v = this.data.get(groupId);
    return v ? structuredClone(v) : null;
  }
  async save(local: GroupLocal) {
    this.data.set(local.config.groupId, structuredClone(local));
  }
}

export interface SimDevice {
  name: string;
  bookmarks: FakeBookmarks;
  ports: EnginePorts;
  engine: GroupEngine;
  skew: number;
}

export interface SimOptions {
  devices: number;
  seed: number;
  faults?: boolean;
  /** Maximum absolute clock skew per device in ms (kept within the 2-minute clock check). */
  maxSkew?: number;
}

export const GROUP_ID = 'g0';

export class Simulator {
  time = 1_800_000_000_000;
  readonly rng: () => number;
  readonly provider: MemoryProvider;
  readonly devices: SimDevice[] = [];
  readonly errors: string[] = [];
  /** Faults start after setup, so group creation itself is not under test here. */
  private faultsOn = false;

  constructor(readonly options: SimOptions) {
    this.rng = mulberry32(options.seed);
    const faults: MemoryFaults = options.faults
      ? {
          visibilityDelay: () => (this.faultsOn && this.rng() < 0.3 ? Math.floor(this.rng() * 20_000) : 0),
          loseCreateResponse: () => this.faultsOn && this.rng() < 0.1,
        }
      : {};
    this.provider = new MemoryProvider(() => this.time, faults);
  }

  randomBytes: RandomBytes = (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(this.rng() * 256);
    return out;
  };

  pick<T>(items: readonly T[]): T | undefined {
    return items.length ? items[Math.floor(this.rng() * items.length)] : undefined;
  }

  async setup(): Promise<void> {
    for (let i = 0; i < this.options.devices; i++) {
      const name = `dev${String.fromCharCode(97 + i)}`;
      const bookmarks = new FakeBookmarks(`${name}_`);
      const skew = this.options.maxSkew ? Math.floor((this.rng() * 2 - 1) * this.options.maxSkew) : 0;
      const ports: EnginePorts = {
        provider: this.provider.client(),
        bookmarks,
        store: new MemoryStore(),
        clock: { now: () => this.time + skew },
        random: this.randomBytes,
      };
      const config: GroupConfig = {
        groupId: GROUP_ID,
        deviceId: name,
        deviceName: name,
        browser: 'firefox',
        mode: 'everything',
        mapping: { 'root:toolbar': FAKE_ROOTS.toolbar, 'root:other': FAKE_ROOTS.other, 'root:menu': FAKE_ROOTS.menu },
      };
      const engine =
        i === 0 ? await GroupEngine.createGroup(ports, config, 'Test group') : await GroupEngine.attach(ports, config);
      this.devices.push({ name, bookmarks, ports, engine, skew });
    }
    this.faultsOn = true;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  /** One sync cycle on a device. Provider faults surface as errors and are retried next cycle. */
  async sync(d: SimDevice): Promise<void> {
    try {
      await d.engine.cycle();
    } catch (e) {
      const msg = (e as Error).message;
      if ((e as Error).name !== 'LostResponseError' && !msg.startsWith('lost response')) throw e;
      this.errors.push(msg);
    }
  }

  /** Simulate the background worker restarting: rebuild the engine from the persisted local state. */
  async restart(d: SimDevice): Promise<void> {
    d.engine = await GroupEngine.open(d.ports, GROUP_ID);
  }

  /** Make every file visible and sync every device until nothing changes. Throws if it never settles. */
  async quiet(maxRounds = 30): Promise<void> {
    this.provider.flushVisibility();
    let previous = '';
    let stableRounds = 0;
    for (let round = 0; round < maxRounds; round++) {
      for (const d of this.devices) await this.sync(d);
      this.advance(1000);
      this.provider.flushVisibility();
      const fingerprint = JSON.stringify(this.devices.map((d) => this.fingerprint(d)));
      const idle = this.devices.every((d) => d.engine.state.outbox.length === 0 && !d.engine.state.pendingBatch);
      if (idle && fingerprint === previous) {
        if (++stableRounds >= 2) return;
      } else stableRounds = 0;
      previous = fingerprint;
    }
    throw new Error('simulation did not settle');
  }

  /** The device's mirror as a canonical tree with stable IDs. */
  mirrorTree(d: SimDevice): Tree {
    const m = d.engine.mirror();
    return { roots: m.roots, nodes: m.nodes };
  }

  canonicalMirror(d: SimDevice): unknown {
    return canonical(this.mirrorTree(d));
  }

  /** The device's live fake tree rendered with stable IDs (through its ID map), for comparing with the mirror. */
  canonicalLive(d: SimDevice): unknown {
    const idmap = new Map(d.engine.state.idmap);
    const roots = [
      ['root:toolbar', FAKE_ROOTS.toolbar],
      ['root:other', FAKE_ROOTS.other],
      ['root:menu', FAKE_ROOTS.menu],
    ] as const;
    const render = async (localId: string) => {
      const n = await d.bookmarks.getSubTree(localId);
      const walk = (x: typeof n): unknown[] =>
        (x.children ?? []).map((c) => [idmap.get(c.localId) ?? `?${c.localId}`, c.kind, c.title, c.url, walk(c)]);
      return walk(n);
    };
    return Promise.all(roots.map(async ([groupRoot, local]) => [groupRoot, await render(local)]));
  }

  private fingerprint(d: SimDevice): unknown {
    return [this.canonicalMirror(d), d.engine.state.ops.length];
  }
}
