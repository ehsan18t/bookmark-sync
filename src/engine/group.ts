// Per-group sync engine (IMPLEMENTATION.md 9.1). One instance per group per device. Every public
// method is meant to run as one task of the global queue, so they never interleave.

import {
  bytesEqual,
  decode,
  encode,
  hashBytes,
  type Batch,
  type DeviceInfo,
  type GroupHeader,
} from '../core/codec.js';
import { HlcClock, HLC_ZERO_STATE, type Hlc, type HlcState } from '../core/hlc.js';
import { cryptoRandomBytes, EVERYTHING_ROOTS, FOLDER_ROOTS, randomId, type RandomBytes } from '../core/ids.js';
import { opKey, type Op, type OpDraft } from '../core/ops.js';
import { reconcile, type Mirror, type MirrorNode } from '../core/reconcile.js';
import { planRestoreExact } from '../core/restore.js';
import { deserializeState, emptyState, replay, serializeState, type SerializedState } from '../core/replay.js';
import { visibleTree, type Tree } from '../core/tree.js';
import { batchPath, deviceInfoPath, groupHeaderPath } from '../storage/layout.js';
import { applyMerged } from './apply.js';
import type { BookmarksPort, Clock, StorageProvider } from './ports.js';

export interface GroupConfig {
  groupId: string;
  deviceId: string;
  deviceName: string;
  browser: string;
  mode: 'everything' | 'folder';
  /** Group root ID -> local folder ID. */
  mapping: Record<string, string>;
}

interface Cursor {
  batchNo: number;
  hash: string;
  opSeq: number;
}

interface PendingBatch {
  batchNo: number;
  bytes: Uint8Array;
  hash: string;
  ops: Op[];
}

/** Everything a device keeps locally for one group. The IndexedDB store (M2) persists this shape. */
export interface GroupLocal {
  config: GroupConfig;
  hlc: HlcState;
  opSeq: number;
  lastBatchNo: number;
  lastBatchHash: string;
  lastPublishedOpSeq: number;
  base: SerializedState;
  ops: Op[];
  outbox: Op[];
  pendingBatch: PendingBatch | null;
  cursors: Record<string, Cursor>;
  /** Highest opSeq per device whose effects are in the mirror and the browser. Used for `seen`. */
  appliedSeq: Record<string, number>;
  mirror: MirrorNode[];
  idmap: [string, string][];
  excluded: string[];
}

export interface Store {
  load(groupId: string): Promise<GroupLocal | null>;
  save(local: GroupLocal): Promise<void>;
}

export interface EnginePorts {
  provider: StorageProvider;
  bookmarks: BookmarksPort;
  store: Store;
  clock: Clock;
  random?: RandomBytes;
}

export class ForkError extends Error {}

export class GroupEngine {
  private readonly clock: HlcClock;
  private readonly random: RandomBytes;

  private constructor(
    private readonly ports: EnginePorts,
    private local: GroupLocal,
  ) {
    this.clock = new HlcClock(local.config.deviceId, () => ports.clock.now(), local.hlc);
    this.random = ports.random ?? cryptoRandomBytes;
  }

  static async open(ports: EnginePorts, groupId: string): Promise<GroupEngine> {
    const local = await ports.store.load(groupId);
    if (!local) throw new Error(`no local state for group ${groupId}`);
    return new GroupEngine(ports, local);
  }

  /** Create a new group whose first batch is the mapped folders' current contents. */
  static async createGroup(ports: EnginePorts, config: GroupConfig, name: string): Promise<GroupEngine> {
    const header: GroupHeader = {
      groupId: config.groupId,
      name,
      mode: config.mode,
      createdBy: config.deviceId,
      createdAt: new Date(ports.clock.now()).toISOString(),
      encryption: null,
    };
    const res = await ports.provider.createOnce(groupHeaderPath(config.groupId), encode('group', header));
    if (res.status !== 'created') throw new Error('group ID already exists');
    const engine = await GroupEngine.attach(ports, config);
    await engine.cycle();
    return engine;
  }

  /**
   * Start syncing an existing group from this device. Milestone M1 supports only mapped folders that
   * are empty or whose contents should be added as new items; the full join flow comes in M4.
   */
  static async attach(ports: EnginePorts, config: GroupConfig): Promise<GroupEngine> {
    const local: GroupLocal = {
      config,
      hlc: HLC_ZERO_STATE,
      opSeq: 0,
      lastBatchNo: 0,
      lastBatchHash: '',
      lastPublishedOpSeq: 0,
      base: serializeState(emptyState()),
      ops: [],
      outbox: [],
      pendingBatch: null,
      cursors: {},
      appliedSeq: {},
      mirror: [],
      idmap: [],
      excluded: [],
    };
    const engine = new GroupEngine(ports, local);
    engine.clock.observe(formatServerFloor(ports.provider.serverDate()));
    await engine.publish(true);
    await engine.persist();
    return engine;
  }

  get state(): Readonly<GroupLocal> {
    return this.local;
  }

  get roots(): readonly string[] {
    return this.local.config.mode === 'everything' ? EVERYTHING_ROOTS : FOLDER_ROOTS;
  }

  /** One full sync cycle: record local changes, pull, apply, push, publish. */
  async cycle(): Promise<void> {
    await this.recordLocalChanges();
    await this.pull();
    await this.applyMergedState();
    await this.push();
    await this.publish(false);
  }

  /** Reconcile the live mapped folders against the mirror and record the differences. */
  async recordLocalChanges(): Promise<number> {
    const live = await Promise.all(
      this.roots.map(async (r) => ({ groupRoot: r, live: await this.ports.bookmarks.getSubTree(this.localRoot(r)) })),
    );
    const result = reconcile({
      roots: live,
      mirror: this.mirror(),
      idmap: new Map(this.local.idmap),
      excluded: new Set(this.local.excluded),
      newId: () => randomId(this.random),
    });
    this.recordDrafts(result.drafts);
    this.local.mirror = [...result.mirror.nodes.values()];
    this.local.idmap = [...result.idmap];
    await this.persist();
    return result.drafts.length;
  }

  /** Restore the group to its merged state at time T (an HLC), by recording new changes. */
  async restoreTo(t: Hlc): Promise<number> {
    await this.recordLocalChanges();
    const now = this.mergedTree();
    const then = visibleTree(
      replay(deserializeState(this.local.base), this.local.ops.filter((op) => op.hlc <= t)),
      this.roots,
    );
    const base = deserializeState(this.local.base);
    const drafts = planRestoreExact(now, then, (trial) =>
      visibleTree(replay(base, [...this.local.ops, ...this.stampDrafts(trial, true)]), this.roots),
    );
    this.recordDrafts(drafts);
    await this.persist();
    await this.applyMergedState();
    return drafts.length;
  }

  /** A fresh HLC after everything this device has seen, usable as a restore point. */
  restorePoint(): Hlc {
    return this.clock.tick();
  }

  async pull(): Promise<number> {
    const { provider } = this.ports;
    const { groupId, deviceId } = this.local.config;
    const known = new Set(this.local.ops.map(opKey));
    let added = 0;
    for (const d of await provider.listDevices(groupId)) {
      if (d === deviceId) continue;
      const infoBytes = await provider.get(deviceInfoPath(groupId, d));
      if (!infoBytes) continue;
      const info = decode<DeviceInfo>(infoBytes, 'device');
      const cursor = this.local.cursors[d] ?? { batchNo: 0, hash: '', opSeq: 0 };
      for (let b = cursor.batchNo + 1; b <= info.lastBatchNo; b++) {
        const bytes = await provider.get(batchPath(groupId, d, b));
        if (!bytes) break; // not visible yet: retry next cycle, never skip
        const batch = decode<Batch>(bytes, 'batch');
        if (batch.prevHash !== cursor.hash) throw new ForkError(`batch chain of ${d} broken at ${b}`);
        for (const op of batch.ops) {
          this.clock.observe(op.hlc);
          if (known.has(opKey(op))) continue;
          known.add(opKey(op));
          this.local.ops.push(op);
          added++;
        }
        cursor.batchNo = b;
        cursor.hash = await hashBytes(bytes);
        cursor.opSeq = batch.ops.length ? batch.ops[batch.ops.length - 1]!.opSeq : cursor.opSeq;
        this.local.cursors[d] = { ...cursor };
      }
    }
    this.clock.observe(formatServerFloor(provider.serverDate()));
    await this.persist();
    return added;
  }

  /** Replay everything known and make the browser match the merged visible tree. */
  async applyMergedState(): Promise<boolean> {
    const merged = this.mergedTree();
    const result = await applyMerged(
      this.ports.bookmarks,
      Object.fromEntries(this.roots.map((r) => [r, this.localRoot(r)])),
      this.mirror(),
      merged,
      new Set(this.local.excluded),
    );
    this.local.mirror = [...result.mirror.nodes.values()];
    this.local.idmap = [...result.idmap];
    for (const [d, c] of Object.entries(this.local.cursors)) this.local.appliedSeq[d] = c.opSeq;
    await this.persist();
    return result.changed;
  }

  async push(): Promise<boolean> {
    const { provider } = this.ports;
    const { groupId, deviceId } = this.local.config;
    if (!this.local.pendingBatch) {
      if (this.local.outbox.length === 0) return false;
      const ops = this.local.outbox;
      const batch: Batch = {
        batchNo: this.local.lastBatchNo + 1,
        prevHash: this.local.lastBatchHash,
        firstOpSeq: ops[0]!.opSeq,
        confirmed: false,
        ops,
      };
      const bytes = encode('batch', batch);
      // Freeze the exact bytes before the first attempt, so a retry sends identical bytes.
      this.local.pendingBatch = { batchNo: batch.batchNo, bytes, hash: await hashBytes(bytes), ops };
      this.local.outbox = [];
      await this.persist();
    }
    const pending = this.local.pendingBatch!;
    const res = await provider.createOnce(batchPath(groupId, deviceId, pending.batchNo), pending.bytes);
    if (res.status === 'exists' && !(res.existing.length === 1 && bytesEqual(res.existing[0]!, pending.bytes))) {
      throw new ForkError(`batch ${pending.batchNo} of ${deviceId} was written by another copy of this profile`);
    }
    this.local.lastBatchNo = pending.batchNo;
    this.local.lastBatchHash = pending.hash;
    this.local.lastPublishedOpSeq = pending.ops[pending.ops.length - 1]!.opSeq;
    this.local.pendingBatch = null;
    await this.persist();
    return true;
  }

  async publish(force: boolean): Promise<void> {
    const { groupId, deviceId, deviceName, browser } = this.local.config;
    const pendingHlcs = [...(this.local.pendingBatch?.ops ?? []), ...this.local.outbox].map((op) => op.hlc);
    const reserved = this.clock.reserveBound();
    const bound = pendingHlcs.reduce((min, h) => (h < min ? h : min), reserved);
    const info: DeviceInfo = {
      deviceId,
      name: deviceName,
      browser,
      lastBatchNo: this.local.lastBatchNo,
      lastBatchHash: this.local.lastBatchHash,
      lastOpSeq: this.local.lastPublishedOpSeq,
      bound,
      firstRetainedOpSeq: 1,
      left: false,
      frozenFor: null,
      updatedAt: new Date(this.ports.clock.now()).toISOString(),
    };
    // The clock state behind `bound` must be durable before the bound is published.
    await this.persist();
    void force; // publishing only on change or daily is an M3 optimization
    await this.ports.provider.overwrite(deviceInfoPath(groupId, deviceId), encode('device', info));
  }

  mergedTree(): Tree {
    return visibleTree(replay(deserializeState(this.local.base), this.local.ops), this.roots);
  }

  mirror(): Mirror {
    return { roots: this.roots, nodes: new Map(this.local.mirror.map((m) => [m.id, m])) };
  }

  private localRoot(groupRoot: string): string {
    const l = this.local.config.mapping[groupRoot];
    if (!l) throw new Error(`group root ${groupRoot} is not mapped`);
    return l;
  }

  private recordDrafts(drafts: OpDraft[]): void {
    for (const op of this.stampDrafts(drafts, false)) {
      this.local.ops.push(op);
      this.local.outbox.push(op);
    }
  }

  /** Turn drafts into ops. With `dryRun`, counters and the clock are left untouched (for simulation). */
  private stampDrafts(drafts: OpDraft[], dryRun: boolean): Op[] {
    const { deviceId } = this.local.config;
    const clock = dryRun ? new HlcClock(deviceId, () => this.ports.clock.now(), this.clock.snapshot()) : this.clock;
    let seq = this.local.opSeq;
    const ops = drafts.map((draft) => {
      const opSeq = ++seq;
      const hlc = clock.tick();
      return (
        draft.type === 'delete'
          ? { ...draft, device: deviceId, opSeq, hlc, seen: { ...this.local.appliedSeq, [deviceId]: opSeq - 1 } }
          : { ...draft, device: deviceId, opSeq, hlc }
      ) as Op;
    });
    if (!dryRun) this.local.opSeq = seq;
    return ops;
  }

  private async persist(): Promise<void> {
    this.local.hlc = this.clock.snapshot();
    await this.ports.store.save(structuredClone(this.local));
  }
}

/** An HLC at the provider's current time, so this device never stamps ops behind the server clock. */
function formatServerFloor(serverMs: number): Hlc {
  return `${serverMs.toString().padStart(15, '0')}-${'0'.padStart(6, '0')}-`;
}
