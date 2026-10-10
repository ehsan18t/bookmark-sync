import {
  bytesEqual,
  CorruptFileError,
  decode,
  encode,
  FormatTooNewError,
  hashBytes,
  LockedError,
  type Batch,
  type Crypt,
  type DeviceInfo,
  type GroupDeletedMarker,
  type GroupHeader,
  type MigratedMarker,
  type MigrationMarker,
  type RemovedMarker,
  type Snapshot,
} from '../core/codec.js';
import { newKeyParams, type KeyParams } from '../core/crypto.js';
import { findDefaultBookmarks, type BrowserFamily } from '../core/defaults.js';
import { compactionPoint, DAY, isStale, snapshotComplete, stableFrontier } from '../core/frontier.js';
import { formatHlc, hlcFloor, hlcWall, HlcClock, HLC_ZERO_STATE, type Hlc, type HlcState } from '../core/hlc.js';
import { cryptoRandomBytes, EVERYTHING_ROOTS, FOLDER_ROOTS, randomId, type RandomBytes } from '../core/ids.js';
import { planJoin } from '../core/join.js';
import { findDuplicatePairs, type RecentCreate } from '../core/nativeSync.js';
import { compareOps, opKey, type CreateOp, type Op, type OpDraft } from '../core/ops.js';
import { keyBetween } from '../core/position.js';
import { reconcile, type Excluded, type LiveNode, type Mirror, type MirrorNode } from '../core/reconcile.js';
import {
  compact,
  coveredBy,
  deserializeState,
  emptyState,
  replay,
  seedState,
  serializeState,
  type GroupState,
  type SerializedState,
} from '../core/replay.js';
import { planRestoreExact } from '../core/restore.js';
import { childrenIndex, diffTrees, disturbedIds, preorder, visibleTree, type Tree } from '../core/tree.js';
import { visibleSet } from '../core/visibility.js';
import {
  batchPath,
  batchesDir,
  deviceInfoPath,
  groupHeaderPath,
  markerPath,
  snapshotPath,
  snapshotsDir,
  type MarkerName,
} from '../storage/layout.js';
import { applyMerged } from './apply.js';
import { DuplicateFileError, type BookmarksPort, type Clock, type StorageProvider } from './ports.js';

export type PauseReason =
  | 'clock-skew'
  | 'format-too-new'
  | 'corrupt'
  | 'auth'
  | 'permission'
  | 'provider'
  | 'locked'
  | 'root-changed'
  | 'mapped-folder-missing'
  | 'mapping-overlap'
  | 'large-remote-change'
  | 'large-local-change'
  | 'native-sync'
  | 'migration'
  | 'needs-join'
  | 'group-deleted';

export type GroupStatus = { state: 'active' } | { state: 'paused'; reason: PauseReason; detail?: string };

const SELF_CLEARING: ReadonlySet<PauseReason> = new Set(['clock-skew', 'provider', 'locked', 'migration']);

export interface EngineSettings {
  historyMs: number;
  guardPercent: number;
  guardMin: number;
  staleMs: number;
  compactMinOps: number;
  compactIntervalMs: number;
  maxSkewMs: number;
  restampAfterMs: number;
  nativeSyncWindowMs: number;
  nativeSyncPauseCount: number;
  publishIntervalMs: number;
  consistentReadDelayMs: number;
}

export const DEFAULT_SETTINGS: EngineSettings = {
  historyMs: 7 * DAY,
  guardPercent: 20,
  guardMin: 10,
  staleMs: 90 * DAY,
  compactMinOps: 500,
  compactIntervalMs: DAY,
  maxSkewMs: 2 * 60_000,
  restampAfterMs: 12 * 60 * 60_000,
  nativeSyncWindowMs: 10 * 60_000,
  nativeSyncPauseCount: 3,
  publishIntervalMs: DAY,
  consistentReadDelayMs: 5_000,
};

export interface GroupConfig {
  groupId: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  browser: BrowserFamily;
  mode: 'everything' | 'folder';
  mapping: Record<string, string>;
  name: string;
  encrypted: boolean;
}

interface Cursor {
  batchNo: number;
  /** null after loading a snapshot: the next batch's chain is accepted as is. */
  hash: string | null;
  opSeq: number;
  info?: DeviceInfo;
  markers: Record<string, number>;
  migration?: MigrationMarker;
  migrated?: MigratedMarker;
  removed?: string[];
  deleted?: boolean;
}

interface PendingBatch {
  batchNo: number;
  bytes: Uint8Array;
  hash: string;
  ops: Op[];
  confirmed: boolean;
  frozenAt: number;
}

interface GuardPause {
  kind: 'remote' | 'local';
  count: number;
  total: number;
  firstHlc: Hlc;
  touched: string[];
  keys: string[];
}

export interface RestorePoint {
  hlc: Hlc;
  label: string;
  at: number;
}

interface JoinRecord {
  created: boolean;
  restorePoint: Hlc;
  nodes: string[];
  local: { groupRoot: string; live: LiveNode }[];
}

interface ForkOf {
  device: string;
  fromOpSeq: number;
  dropOld: boolean;
}

export interface GroupLocal {
  config: GroupConfig;
  status: GroupStatus;
  hlc: HlcState;
  opSeq: number;
  lastBatchNo: number;
  lastBatchHash: string;
  lastPublishedOpSeq: number;
  ownBatches: { batchNo: number; firstOpSeq: number; lastOpSeq: number }[];
  base: SerializedState;
  baseFrontier: Hlc;
  ops: Op[];
  confirmed: string[];
  outbox: Op[];
  pendingBatch: PendingBatch | null;
  cursors: Record<string, Cursor>;
  appliedSeq: Record<string, number>;
  mirror: MirrorNode[];
  idmap: [string, string][];
  excluded: [string, Excluded][];
  recentCreates: (RecentCreate & { at: number })[];
  restorePoints: RestorePoint[];
  join: JoinRecord | null;
  removed: string[];
  forked: Record<string, number>;
  forkOf: ForkOf[];
  markers: Partial<Record<MarkerName, { version: number; body: unknown }>>;
  migration: { id: string; frozen: boolean } | null;
  guard: GuardPause | null;
  lastPublished: string;
  lastPublishAt: number;
  lastCompactAt: number;
  /** Set while applying to the browser; after a crash, local items the apply created are adopted, not recorded as new. */
  applyInProgress: boolean;
}

export interface GroupStore {
  load(groupId: string): Promise<GroupLocal | null>;
  save(local: GroupLocal): Promise<void>;
  delete(groupId: string): Promise<void>;
}

export interface EnginePorts {
  provider: StorageProvider;
  bookmarks: BookmarksPort;
  store: GroupStore;
  clock: Clock;
  random?: RandomBytes;
  settings?: Partial<EngineSettings>;
  sleep?: (ms: number) => Promise<void>;
  keyFor?: (groupId: string) => Promise<CryptoKey | null>;
}

export class ForkError extends Error {}

export interface JoinOptions {
  mode: 'merge' | 'replace';
  ignoreDefaults: boolean;
  creating?: boolean;
  excluded?: [string, Excluded][];
}

export interface JoinPreview {
  added: number;
  matched: number;
  removedLocal: number;
  groupItems: number;
  ignoredDefaults: number;
}

export interface CycleResult {
  pulled: number;
  pushed: number;
  applied: boolean;
  migratedTo?: string;
}

export interface TimelineEntry {
  device: string;
  from: Hlc;
  to: Hlc;
  count: number;
  kinds: Record<string, number>;
}

const EMPTY_FRONTIER = hlcFloor(0);

function freshLocal(config: GroupConfig): GroupLocal {
  return {
    config,
    status: { state: 'active' },
    hlc: HLC_ZERO_STATE,
    opSeq: 0,
    lastBatchNo: 0,
    lastBatchHash: '',
    lastPublishedOpSeq: 0,
    ownBatches: [],
    base: serializeState(emptyState()),
    baseFrontier: EMPTY_FRONTIER,
    ops: [],
    confirmed: [],
    outbox: [],
    pendingBatch: null,
    cursors: {},
    appliedSeq: {},
    mirror: [],
    idmap: [],
    excluded: [],
    recentCreates: [],
    restorePoints: [],
    join: null,
    removed: [],
    forked: {},
    forkOf: [],
    markers: {},
    migration: null,
    guard: null,
    lastPublished: '',
    lastPublishAt: 0,
    lastCompactAt: 0,
    applyInProgress: false,
  };
}

export class GroupEngine {
  private clock: HlcClock;
  private readonly random: RandomBytes;
  private readonly settings: EngineSettings;
  private dryRun = false;
  private guardBypass = false;
  importing = false;

  private constructor(
    private readonly ports: EnginePorts,
    private local: GroupLocal,
    private key: CryptoKey | null,
  ) {
    this.clock = new HlcClock(local.config.deviceId, () => ports.clock.now(), local.hlc);
    this.random = ports.random ?? cryptoRandomBytes;
    this.settings = { ...DEFAULT_SETTINGS, ...ports.settings };
  }

  static async open(ports: EnginePorts, groupId: string): Promise<GroupEngine> {
    const local = await ports.store.load(groupId);
    if (!local) throw new Error(`no local state for group ${groupId}`);
    const key = local.config.encrypted ? ((await ports.keyFor?.(groupId)) ?? null) : null;
    return new GroupEngine(ports, local, key);
  }

  static async create(
    ports: EnginePorts,
    config: Omit<GroupConfig, 'encrypted'>,
    opts: { passphrase?: string; iterations?: number; ignoreDefaults?: boolean; excluded?: [string, Excluded][] } = {},
  ): Promise<{ engine: GroupEngine; key: CryptoKey | null }> {
    let encryption: KeyParams | null = null;
    let key: CryptoKey | null = null;
    if (opts.passphrase) ({ params: encryption, key } = await newKeyParams(opts.passphrase, opts.iterations));
    const header: GroupHeader = {
      groupId: config.groupId,
      name: config.name,
      mode: config.mode,
      createdBy: config.deviceId,
      createdAt: new Date(ports.clock.now()).toISOString(),
      encryption,
    };
    const res = await ports.provider.createOnce(groupHeaderPath(config.groupId), await encode('group', header));
    if (res.status !== 'created') throw new Error('a group with this ID already exists');
    const engine = new GroupEngine(ports, freshLocal({ ...config, encrypted: !!encryption }), key);
    await engine.performJoin({ mode: 'merge', ignoreDefaults: opts.ignoreDefaults ?? false, excluded: opts.excluded ?? [], creating: true });
    return { engine, key };
  }

  static async readHeader(provider: StorageProvider, groupId: string): Promise<GroupHeader | null> {
    const bytes = await provider.get(groupHeaderPath(groupId));
    return bytes ? decode<GroupHeader>(bytes, 'group') : null;
  }

  static async preview(ports: EnginePorts, config: GroupConfig, opts: JoinOptions, key: CryptoKey | null): Promise<JoinPreview> {
    const scratch: GroupStore = { load: async () => null, save: async () => {}, delete: async () => {} };
    const engine = new GroupEngine({ ...ports, store: scratch }, freshLocal(config), key);
    engine.dryRun = true;
    return engine.performJoin(opts);
  }

  static async join(ports: EnginePorts, config: GroupConfig, opts: JoinOptions, key: CryptoKey | null): Promise<GroupEngine> {
    const engine = new GroupEngine(ports, freshLocal(config), key);
    await engine.performJoin(opts);
    return engine;
  }

  get state(): Readonly<GroupLocal> {
    return this.local;
  }

  get groupId(): string {
    return this.local.config.groupId;
  }

  get deviceId(): string {
    return this.local.config.deviceId;
  }

  get roots(): readonly string[] {
    return this.local.config.mode === 'everything' ? EVERYTHING_ROOTS : FOLDER_ROOTS;
  }

  get status(): GroupStatus {
    return this.local.status;
  }

  setKey(key: CryptoKey | null): void {
    this.key = key;
    if (this.local.status.state === 'paused' && this.local.status.reason === 'locked') this.local.status = { state: 'active' };
  }

  async cycle(): Promise<CycleResult> {
    const result: CycleResult = { pulled: 0, pushed: 0, applied: false };
    const st = this.local.status;
    if (st.state === 'paused' && !SELF_CLEARING.has(st.reason)) return result;
    if (this.local.config.encrypted && !this.key) {
      await this.pause('locked');
      return result;
    }
    if (st.state === 'paused') this.local.status = { state: 'active' };
    try {
      if (!(await this.checkMapping())) return result;
      const listed = await this.ports.provider.listDevices(this.groupId);
      if (!(await this.checkClock())) return result;
      await this.recordLocalChanges();
      result.pulled = await this.pull(listed);
      if (this.paused) return result;
      const migratedTo = await this.migrationStep();
      if (migratedTo) return { ...result, migratedTo };
      if (this.paused && !this.inMigration) return result;
      result.applied = await this.applyMergedState();
      if (this.paused && !this.inMigration) return result;
      result.pushed = await this.push();
      await this.publish(false);
      await this.maybeCompact();
      if (this.pendingNativeSyncPause) {
        this.pendingNativeSyncPause = false;
        await this.pause('native-sync');
      }
    } catch (e) {
      if (e instanceof LockedError) await this.pause('locked');
      else if (e instanceof FormatTooNewError) await this.pause('format-too-new', e.message);
      else if (e instanceof CorruptFileError) await this.pause('corrupt', e.message);
      else throw e;
    } finally {
      await this.persist();
    }
    return result;
  }

  private pendingNativeSyncPause = false;
  private leaving = false;

  private get paused(): boolean {
    return this.local.status.state === 'paused';
  }

  private get inMigration(): boolean {
    return this.local.status.state === 'paused' && this.local.status.reason === 'migration';
  }

  async pause(reason: PauseReason, detail?: string): Promise<void> {
    this.local.status = detail === undefined ? { state: 'paused', reason } : { state: 'paused', reason, detail };
    await this.persist();
  }

  async resume(): Promise<void> {
    this.local.status = { state: 'active' };
    await this.persist();
  }

  private async checkMapping(): Promise<boolean> {
    for (const r of this.roots) {
      const local = this.local.config.mapping[r];
      if (!local || !(await this.ports.bookmarks.exists(local))) {
        await this.pause(this.local.config.mode === 'folder' ? 'mapped-folder-missing' : 'root-changed', r);
        return false;
      }
    }
    return true;
  }

  private async liveRoots(): Promise<{ groupRoot: string; live: LiveNode }[]> {
    return Promise.all(
      this.roots.map(async (r) => {
        const local = this.localRoot(r);
        if (this.dryRun && !(await this.ports.bookmarks.exists(local))) {
          return { groupRoot: r, live: { localId: local, kind: 'folder' as const, title: '', url: '', children: [] } };
        }
        return { groupRoot: r, live: await this.ports.bookmarks.getSubTree(local) };
      }),
    );
  }

  async recordLocalChanges(opts: { confirmed?: boolean } = {}): Promise<number> {
    if (this.importing) return 0;
    if (this.local.applyInProgress) await this.adoptInterruptedApply();
    if (!(await this.rebuildIdMapIfLost())) return 0;
    const result = reconcile({
      roots: await this.liveRoots(),
      mirror: this.mirror(),
      idmap: new Map(this.local.idmap),
      excluded: new Map(this.local.excluded),
      newId: () => randomId(this.random),
    });
    const ops = this.recordDrafts(result.drafts, opts.confirmed ?? false);
    const now = this.ports.clock.now();
    for (const op of ops) if (op.type === 'create') this.local.recentCreates.push({ node: op.node, hlc: op.hlc, device: op.device, at: now });
    this.local.recentCreates = this.local.recentCreates.filter((r) => now - r.at <= this.settings.nativeSyncWindowMs);
    this.local.mirror = [...result.mirror.nodes.values()];
    this.local.idmap = [...result.idmap];
    if (result.released.length) this.local.excluded = this.local.excluded.filter(([l]) => !result.released.includes(l));
    await this.persist();
    return result.drafts.length;
  }

  /**
   * Chromium can give every bookmark a new local ID (for example when native sync reloads its data).
   * Mirror entries whose local ID vanished are matched again by parent, kind, title and URL; if most
   * cannot be matched the group pauses instead of recording a mass delete and re-create.
   */
  private async rebuildIdMapIfLost(): Promise<boolean> {
    const live = new Map<string, LiveNode>();
    const index = (n: LiveNode) => {
      live.set(n.localId, n);
      for (const c of n.children ?? []) index(c);
    };
    for (const r of await this.liveRoots()) index(r.live);
    const real = this.local.mirror.filter((m) => m.localId);
    const lost = real.filter((m) => !live.has(m.localId));
    if (lost.length < 3 || lost.length < real.length * 0.3) return true;
    const known = new Set([...this.local.idmap.map(([l]) => l), ...this.local.excluded.map(([l]) => l), ...this.roots.map((r) => this.localRoot(r))]);
    const unmapped = [...live.keys()].filter((l) => !known.has(l)).length;
    if (unmapped < lost.length * 0.5) return true;

    const mirror = new Map(this.local.mirror.map((m) => [m.id, { ...m }]));
    const taken = new Set(real.filter((m) => live.has(m.localId)).map((m) => m.localId));
    const localOf = new Map<string, string>(this.roots.map((r) => [r, this.localRoot(r)]));
    for (const m of mirror.values()) if (m.localId && live.has(m.localId)) localOf.set(m.id, m.localId);
    let rematched = 0;
    for (const t of preorder({ roots: this.roots, nodes: mirror })) {
      const n = mirror.get(t.id)!;
      if (!n.localId || live.has(n.localId)) continue;
      const parent = localOf.get(n.parent);
      const c = parent && live.get(parent)?.children?.find((x) => !taken.has(x.localId) && x.kind === n.kind && x.title === n.title && (n.kind !== 'bookmark' || x.url === n.url));
      if (!c) continue;
      taken.add(c.localId);
      mirror.get(n.id)!.localId = c.localId;
      localOf.set(n.id, c.localId);
      rematched++;
    }
    if (rematched < lost.length * 0.5) {
      await this.pause('needs-join', `${lost.length - rematched} of ${real.length} items could not be matched`);
      return false;
    }
    this.local.mirror = [...mirror.values()];
    this.local.idmap = [...mirror.values()].filter((m) => m.localId).map((m) => [m.localId, m.id]);
    return true;
  }

  private async adoptInterruptedApply(): Promise<void> {
    const merged = this.mergedTree();
    const mirror = new Map(this.local.mirror.map((m) => [m.id, m]));
    const idmap = new Map(this.local.idmap);
    const localOf = new Map<string, string>(this.roots.map((r) => [r, this.localRoot(r)]));
    for (const m of mirror.values()) if (m.localId) localOf.set(m.id, m.localId);
    const live = new Map<string, LiveNode>();
    const index = (n: LiveNode) => {
      live.set(n.localId, n);
      for (const c of n.children ?? []) index(c);
    };
    for (const r of await this.liveRoots()) index(r.live);
    for (const n of preorder(merged)) {
      if (mirror.has(n.id)) continue;
      const parent = localOf.get(n.parent);
      const candidate = parent && live.get(parent)?.children?.find((c) => !idmap.has(c.localId) && c.kind === n.kind && c.title === n.title && (n.kind !== 'bookmark' || c.url === n.url));
      if (!candidate) continue;
      mirror.set(n.id, { ...n, localId: candidate.localId });
      idmap.set(candidate.localId, n.id);
      localOf.set(n.id, candidate.localId);
    }
    this.local.mirror = [...mirror.values()];
    this.local.idmap = [...idmap];
    this.local.applyInProgress = false;
  }

  async pull(prelisted?: string[]): Promise<number> {
    const { provider } = this.ports;
    const { groupId, deviceId } = this.local.config;
    const listed = prelisted ?? (await provider.listDevices(groupId));
    if (!prelisted && !(await this.checkClock())) return 0;
    const devices = [...new Set([...listed, ...Object.keys(this.local.cursors)])].filter((d) => d !== deviceId).sort();
    const known = new Set(this.local.ops.map(opKey));
    const base = this.baseState();
    let added = 0;
    let needSnapshot = false;

    for (const d of devices) {
      const infoBytes = await provider.get(deviceInfoPath(groupId, d));
      if (!infoBytes) continue;
      const info = await decode<DeviceInfo>(infoBytes, 'device', this.crypt(deviceInfoPath(groupId, d)));
      const cursor = (this.local.cursors[d] ??= { batchNo: 0, hash: '', opSeq: 0, markers: {} });
      cursor.info = info;
      await this.readMarkers(d, info, cursor);
      if (this.local.forked[d] !== undefined) continue;
      if (info.lastBatchNo > cursor.batchNo && (base.coverage[d] ?? 0) >= info.lastOpSeq) {
        cursor.batchNo = info.lastBatchNo;
        cursor.hash = info.lastBatchHash;
        cursor.opSeq = info.lastOpSeq;
        continue;
      }
      if (info.lastBatchNo > cursor.batchNo && info.firstRetainedOpSeq > cursor.opSeq + 1) {
        needSnapshot = true;
        continue;
      }
      const gone = info.left || this.removedSet().has(d);
      for (let b = cursor.batchNo + 1; b <= info.lastBatchNo; b++) {
        const path = batchPath(groupId, d, b);
        let bytes: Uint8Array | null;
        try {
          bytes = await provider.get(path);
        } catch (e) {
          if (!(e instanceof DuplicateFileError)) throw e;
          this.local.forked[d] = b;
          break;
        }
        if (!bytes) {
          // A device that left or was removed never updates its device.json, so a batch compacted away shows up only as missing.
          if (gone) needSnapshot = true;
          break;
        }
        const batch = await decode<Batch>(bytes, 'batch', this.crypt(path));
        if (cursor.hash !== null && batch.prevHash !== cursor.hash) {
          this.local.forked[d] = b;
          break;
        }
        const confirmed = new Set(this.local.confirmed);
        for (const op of batch.ops) {
          this.observe(op.hlc);
          const key = opKey(op);
          if (known.has(key) || coveredBy(base.coverage, op)) continue;
          known.add(key);
          this.local.ops.push(op);
          if (batch.confirmed) confirmed.add(key);
          added++;
        }
        this.local.confirmed = [...confirmed];
        cursor.batchNo = b;
        cursor.hash = await hashBytes(bytes);
        if (batch.ops.length) cursor.opSeq = batch.ops[batch.ops.length - 1]!.opSeq;
      }
    }
    this.applyForkNotices();
    this.observe(hlcFloor(provider.serverDate()));
    if (Object.values(this.local.cursors).some((c) => c.deleted)) await this.pause('group-deleted');
    else if (this.otherRemoved().includes(deviceId)) await this.rotateDevice(this.local.lastPublishedOpSeq + 1, false);
    if (needSnapshot && (await this.loadNewestSnapshot())) added += await this.pull();
    await this.persist();
    return added;
  }

  private async checkClock(): Promise<boolean> {
    const skew = Math.abs(this.ports.provider.serverDate() - this.ports.clock.now());
    if (skew > this.settings.maxSkewMs) {
      await this.pause('clock-skew', `${Math.round(skew / 1000)} s`);
      return false;
    }
    return true;
  }

  private observe(h: Hlc): void {
    if (hlcWall(h) > this.ports.provider.serverDate() + DAY) throw new CorruptFileError(`timestamp far in the future: ${h}`);
    this.clock.observe(h);
  }

  private async readMarkers(d: string, info: DeviceInfo, cursor: Cursor): Promise<void> {
    const { groupId } = this.local.config;
    for (const [name, version] of Object.entries(info.markers ?? {})) {
      if (cursor.markers[name] === version) continue;
      const path = markerPath(groupId, d, name as MarkerName);
      const bytes = await this.ports.provider.get(path);
      if (!bytes) continue;
      const body = await decode<unknown>(bytes, 'marker', this.crypt(path));
      if (name === 'removed') cursor.removed = (body as RemovedMarker).devices;
      else if (name === 'group-deleted') cursor.deleted = !!(body as GroupDeletedMarker).hlc;
      else if (name === 'migration') cursor.migration = body as MigrationMarker;
      else if (name === 'migrated') cursor.migrated = body as MigratedMarker;
      cursor.markers[name] = version;
    }
  }

  private otherRemoved(): string[] {
    return Object.values(this.local.cursors).flatMap((c) => c.removed ?? []);
  }

  private removedSet(): Set<string> {
    return new Set([...this.otherRemoved(), ...this.local.removed]);
  }

  private applyForkNotices(): void {
    for (const c of Object.values(this.local.cursors)) {
      for (const f of (c.info as (DeviceInfo & { forkOf?: ForkOf[] }) | undefined)?.forkOf ?? []) {
        if (!f.dropOld || f.device === this.deviceId || this.local.forked[f.device] === -f.fromOpSeq) continue;
        this.local.forked[f.device] = -f.fromOpSeq;
        this.local.ops = this.local.ops.filter((op) => !(op.device === f.device && op.opSeq >= f.fromOpSeq));
      }
    }
  }

  private async loadNewestSnapshot(): Promise<boolean> {
    const { groupId } = this.local.config;
    const infos = this.infos();
    let best: Snapshot | null = null;
    for (const d of [...new Set([...infos.keys(), this.deviceId])]) {
      for (const path of await this.ports.provider.listFiles(snapshotsDir(groupId, d))) {
        const bytes = await this.ports.provider.get(path);
        if (!bytes) continue;
        const snap = await decode<Snapshot>(bytes, 'snapshot', this.crypt(path));
        if (snapshotComplete(snap, infos) && (!best || snap.frontier > best.frontier)) best = snap;
      }
    }
    if (!best || best.frontier <= this.local.baseFrontier) return false;
    this.observe(best.frontier);
    this.local.base = best.state;
    this.local.baseFrontier = best.frontier;
    const coverage = best.state.coverage;
    this.local.ops = this.local.ops.filter((op) => !coveredBy(coverage, op));
    for (const [d, info] of infos) {
      const c = this.local.cursors[d]!;
      if ((coverage[d] ?? 0) >= info.lastOpSeq && c.batchNo < info.lastBatchNo) {
        c.batchNo = info.lastBatchNo;
        c.hash = info.lastBatchHash;
        c.opSeq = info.lastOpSeq;
      } else if (c.batchNo < info.firstRetainedBatchNo - 1) {
        c.batchNo = info.firstRetainedBatchNo - 1;
        c.hash = null;
        c.opSeq = Math.max(c.opSeq, coverage[d] ?? 0);
      }
    }
    this.restampBelow(best.frontier);
    await this.persist();
    return true;
  }

  async applyMergedState(): Promise<boolean> {
    const self = this.deviceId;
    const newRemote = this.local.ops.filter((op) => op.device !== self && op.opSeq > (this.local.appliedSeq[op.device] ?? 0));
    let merged = this.mergedTree();

    if (!this.importing && newRemote.length) {
      const now = this.ports.clock.now();
      const recent = this.local.recentCreates.filter((r) => now - r.at <= this.settings.nativeSyncWindowMs);
      const pairs = findDuplicatePairs(merged, newRemote.filter((op): op is CreateOp => op.type === 'create'), recent);
      if (pairs.length) {
        this.repairDuplicates(merged, pairs.filter((p) => p.ownIsLater).map((p) => [p.own.node, p.remote.node] as const));
        if (pairs.length >= this.settings.nativeSyncPauseCount) this.pendingNativeSyncPause = true;
        merged = this.mergedTree();
      }
    }

    if (!this.guardBypass) {
      const confirmed = new Set(this.local.confirmed);
      const unconfirmed = newRemote.filter((op) => !confirmed.has(opKey(op)));
      if (unconfirmed.length) {
        const drop = new Set(unconfirmed.map(opKey));
        const without = visibleTree(replay(this.baseState(), this.local.ops.filter((op) => !drop.has(opKey(op)))), this.roots);
        const touched = disturbedIds(diffTrees(without, merged));
        const total = Math.max(without.nodes.size, 1);
        if (touched.size >= this.settings.guardMin && touched.size > (this.settings.guardPercent / 100) * total) {
          this.local.guard = {
            kind: 'remote',
            count: touched.size,
            total,
            firstHlc: [...unconfirmed].sort(compareOps)[0]!.hlc,
            touched: [...touched],
            keys: [...drop],
          };
          await this.pause('large-remote-change', `${touched.size} of ${total} items`);
          return false;
        }
      }
    }

    this.local.applyInProgress = true;
    await this.persist();
    const result = await applyMerged(
      this.ports.bookmarks,
      Object.fromEntries(this.roots.map((r) => [r, this.localRoot(r)])),
      this.mirror(),
      merged,
      new Set(this.local.excluded.map(([l]) => l)),
    );
    this.local.applyInProgress = false;
    this.local.mirror = [...result.mirror.nodes.values()];
    this.local.idmap = [...result.idmap];
    for (const [d, c] of Object.entries(this.local.cursors)) this.local.appliedSeq[d] = c.opSeq;
    await this.persist();
    return result.changed;
  }

  private repairDuplicates(merged: Tree, pairs: readonly (readonly [string, string])[]): void {
    if (!pairs.length) return;
    const idx = childrenIndex(merged);
    const ownIds = new Set(pairs.map(([own]) => own));
    const drafts: OpDraft[] = [];
    const mirror = new Map(this.local.mirror.map((m) => [m.id, m]));
    for (const [own, remote] of pairs) {
      let last = (idx.get(remote) ?? []).at(-1)?.pos ?? null;
      for (const child of idx.get(own) ?? []) {
        if (ownIds.has(child.id)) continue;
        const pos = keyBetween(last, null);
        last = pos;
        drafts.push({ type: 'move', node: child.id, parent: remote, pos, before: { parent: own, pos: child.pos } });
      }
      const ownNode = merged.nodes.get(own)!;
      drafts.push({ type: 'delete', node: own, before: { id: own, kind: ownNode.kind, title: ownNode.title, url: ownNode.url, children: [] } });
      const m = mirror.get(own);
      const r = merged.nodes.get(remote);
      if (m && r) {
        mirror.delete(own);
        mirror.set(remote, { ...r, localId: m.localId });
        for (const x of mirror.values()) if (x.parent === own) mirror.set(x.id, { ...x, parent: remote });
      }
    }
    this.recordDrafts(drafts, true);
    this.local.mirror = [...mirror.values()];
    this.local.idmap = [...mirror.values()].filter((m) => m.localId).map((m) => [m.localId, m.id]);
    const repaired = new Set(pairs.map(([own]) => own));
    this.local.recentCreates = this.local.recentCreates.filter((r) => !repaired.has(r.node));
  }

  async resolveGuard(choice: 'apply' | 'revert'): Promise<void> {
    const g = this.local.guard;
    if (!g) return;
    this.local.guard = null;
    this.local.status = { state: 'active' };
    this.local.confirmed = [...new Set([...this.local.confirmed, ...g.keys])];
    if (choice === 'revert') {
      const keys = new Set(g.keys);
      const then = visibleTree(replay(this.baseState(), this.local.ops.filter((op) => !keys.has(opKey(op)))), this.roots);
      this.recordRestore(then, new Set(g.touched));
    }
    await this.persist();
  }

  async push(): Promise<number> {
    if (this.local.migration?.frozen) return 0;
    const { provider } = this.ports;
    const { groupId } = this.local.config;
    await this.settleOldPending();
    this.restampBelow(hlcFloor(provider.serverDate() - this.settings.restampAfterMs));
    if (this.local.ownBatches.length) await this.checkOwnDuplicates();
    let pushed = 0;
    for (let guard = 0; guard < 100; guard++) {
      if (!this.local.pendingBatch) {
        if (this.local.outbox.length === 0) break;
        if (!this.guardBypass && !(await this.localGuardAllows())) return pushed;
        await this.freezeBatch();
      }
      const pending = this.local.pendingBatch!;
      const res = await provider.createOnce(batchPath(groupId, this.deviceId, pending.batchNo), pending.bytes);
      if (res.status === 'exists' && !(res.existing.length > 0 && res.existing.every((e) => bytesEqual(e, pending.bytes)))) {
        await this.rotateDevice(pending.ops[0]!.opSeq, false);
        continue;
      }
      await this.commitPending(pending);
      pushed++;
    }
    return pushed;
  }

  /**
   * On Drive two copies of a profile can upload the same batch number at once without either seeing
   * the other. Both find the duplicate here and rotate, republishing from the first duplicated batch.
   */
  private async checkOwnDuplicates(): Promise<void> {
    let earliest: { batchNo: number; firstOpSeq: number } | null = null;
    for (const b of this.local.ownBatches.slice(-20).reverse()) {
      try {
        await this.ports.provider.get(batchPath(this.groupId, this.deviceId, b.batchNo));
        if (earliest) break;
      } catch (e) {
        if (!(e instanceof DuplicateFileError)) throw e;
        earliest = b;
      }
    }
    if (earliest) await this.rotateDevice(earliest.firstOpSeq, true);
  }

  private async commitPending(pending: PendingBatch): Promise<void> {
    this.local.lastBatchNo = pending.batchNo;
    this.local.lastBatchHash = pending.hash;
    this.local.lastPublishedOpSeq = pending.ops.at(-1)!.opSeq;
    this.local.ownBatches.push({ batchNo: pending.batchNo, firstOpSeq: pending.ops[0]!.opSeq, lastOpSeq: pending.ops.at(-1)!.opSeq });
    this.local.pendingBatch = null;
    await this.persist();
  }

  /** A pending batch frozen long ago may already have landed (only the response was lost); then it is simply recorded as published. */
  private async settleOldPending(): Promise<void> {
    const pending = this.local.pendingBatch;
    if (!pending || this.ports.clock.now() - pending.frozenAt <= this.settings.restampAfterMs) return;
    const existing = await this.ports.provider.get(batchPath(this.groupId, this.deviceId, pending.batchNo));
    if (existing && bytesEqual(existing, pending.bytes)) await this.commitPending(pending);
    else if (existing) pending.frozenAt = Number.POSITIVE_INFINITY;
  }

  private async freezeBatch(): Promise<void> {
    const confirmed = new Set(this.local.confirmed);
    const first = confirmed.has(opKey(this.local.outbox[0]!));
    let n = 0;
    while (n < this.local.outbox.length && confirmed.has(opKey(this.local.outbox[n]!)) === first) n++;
    const ops = this.local.outbox.slice(0, n);
    const batch: Batch = { batchNo: this.local.lastBatchNo + 1, prevHash: this.local.lastBatchHash, firstOpSeq: ops[0]!.opSeq, confirmed: first, ops };
    const path = batchPath(this.groupId, this.deviceId, batch.batchNo);
    const bytes = await encode('batch', batch, this.crypt(path));
    this.local.pendingBatch = { batchNo: batch.batchNo, bytes, hash: await hashBytes(bytes), ops, confirmed: first, frozenAt: this.ports.clock.now() };
    this.local.outbox = this.local.outbox.slice(n);
    await this.persist();
  }

  private async localGuardAllows(): Promise<boolean> {
    const confirmed = new Set(this.local.confirmed);
    const unconfirmed = this.local.outbox.filter((op) => !confirmed.has(opKey(op)));
    if (unconfirmed.length < this.settings.guardMin) return true;
    const drop = new Set(unconfirmed.map(opKey));
    const without = visibleTree(replay(this.baseState(), this.local.ops.filter((op) => !drop.has(opKey(op)))), this.roots);
    const touched = disturbedIds(diffTrees(without, this.mergedTree()));
    const total = Math.max(without.nodes.size, 1);
    if (touched.size < this.settings.guardMin || touched.size <= (this.settings.guardPercent / 100) * total) return true;
    this.local.guard = { kind: 'local', count: touched.size, total, firstHlc: unconfirmed[0]!.hlc, touched: [...touched], keys: [...drop] };
    await this.pause('large-local-change', `${touched.size} of ${total} items`);
    return false;
  }

  /** Give unpublished ops older than `cut` fresh timestamps, in order, so they never land behind a compacted point. */
  private restampBelow(cut: Hlc): void {
    const pending = this.local.pendingBatch;
    if (pending && pending.ops[0]!.hlc < cut && Number.isFinite(pending.frozenAt) && this.ports.clock.now() - pending.frozenAt > this.settings.restampAfterMs) {
      this.local.outbox = [...pending.ops, ...this.local.outbox];
      this.local.pendingBatch = null;
    }
    if (this.local.pendingBatch || !this.local.outbox.some((op) => op.hlc < cut)) return;
    const fresh = new Map<string, Op>();
    this.local.outbox = this.local.outbox.map((op) => {
      const next = { ...op, hlc: this.clock.tick() } as Op;
      fresh.set(opKey(op), next);
      return next;
    });
    this.local.ops = this.local.ops.map((op) => fresh.get(opKey(op)) ?? op);
  }

  /**
   * Continue under a new device ID. Ops from `fromOpSeq` on are republished under the new ID; with
   * `dropOld`, other devices also drop the old ID's ops from there (both profile copies wrote them).
   */
  private async rotateDevice(fromOpSeq: number, dropOld: boolean): Promise<void> {
    const oldId = this.deviceId;
    const newId = randomId(this.random);
    const own = [
      ...this.local.ops.filter((op) => op.device === oldId && op.opSeq >= fromOpSeq && op.opSeq <= this.local.lastPublishedOpSeq),
      ...(this.local.pendingBatch?.ops ?? []),
      ...this.local.outbox,
    ].filter((op) => op.opSeq >= fromOpSeq);
    const unique = [...new Map(own.map((op) => [opKey(op), op])).values()].sort((a, b) => a.opSeq - b.opSeq);
    const dropped = new Set(unique.map(opKey));
    this.local.ops = this.local.ops.filter((op) => !dropped.has(opKey(op)));

    this.clock = new HlcClock(newId, () => this.ports.clock.now(), this.clock.snapshot());
    this.local.config = { ...this.local.config, deviceId: newId };
    const map = new Map<number, number>();
    let seq = 0;
    const confirmed = new Set(this.local.confirmed);
    const republished = unique.map((op) => {
      const opSeq = ++seq;
      map.set(op.opSeq, opSeq);
      const next = { ...op, device: newId, opSeq, hlc: this.clock.tick() } as Op;
      if (next.type === 'delete') {
        const seen: Record<string, number> = { ...next.seen, [newId]: opSeq - 1 };
        seen[oldId] = Math.min(seen[oldId] ?? 0, fromOpSeq - 1);
        next.seen = seen;
      }
      if (confirmed.has(opKey(op))) confirmed.add(opKey(next));
      return next;
    });
    this.local.confirmed = [...confirmed];
    this.local.ops.push(...republished);
    this.local.outbox = republished;
    this.local.pendingBatch = null;
    this.local.opSeq = seq;
    this.local.lastBatchNo = 0;
    this.local.lastBatchHash = '';
    this.local.lastPublishedOpSeq = 0;
    this.local.ownBatches = [];
    this.local.markers = {};
    this.local.forkOf = [...this.local.forkOf, { device: oldId, fromOpSeq, dropOld }];
    if (!dropOld && fromOpSeq > 1) {
      this.local.cursors[oldId] = { batchNo: 0, hash: '', opSeq: 0, markers: {} };
      this.local.appliedSeq[oldId] = fromOpSeq - 1;
    }
    this.local.recentCreates = [];
    await this.publish(true);
  }

  async publish(force: boolean): Promise<void> {
    if (this.dryRun) return;
    const { groupId, deviceId, deviceName, browser } = this.local.config;
    const pendingHlcs = [...(this.local.pendingBatch?.ops ?? []), ...this.local.outbox].map((op) => op.hlc);
    const bound = pendingHlcs.reduce((min, h) => (h < min ? h : min), this.clock.reserveBound());
    const first = this.local.ownBatches[0];
    const info: DeviceInfo & { forkOf: ForkOf[] } = {
      deviceId,
      name: deviceName,
      browser,
      lastBatchNo: this.local.lastBatchNo,
      lastBatchHash: this.local.lastBatchHash,
      lastOpSeq: this.local.lastPublishedOpSeq,
      bound,
      frontier: this.local.baseFrontier,
      firstRetainedBatchNo: first?.batchNo ?? this.local.lastBatchNo + 1,
      firstRetainedOpSeq: first?.firstOpSeq ?? this.local.lastPublishedOpSeq + 1,
      left: this.leaving,
      frozenFor: this.local.migration?.frozen ? this.local.migration.id : null,
      markers: Object.fromEntries(Object.entries(this.local.markers).map(([k, v]) => [k, v!.version])),
      updatedAt: this.ports.provider.serverDate(),
      forkOf: this.local.forkOf,
    };
    const { bound: _b, updatedAt: _u, ...stable } = info;
    const fingerprint = JSON.stringify(stable);
    const now = this.ports.clock.now();
    if (!force && fingerprint === this.local.lastPublished && now - this.local.lastPublishAt < this.settings.publishIntervalMs) return;
    await this.persist();
    const path = deviceInfoPath(groupId, deviceId);
    await this.ports.provider.overwrite(path, await encode('device', info, this.crypt(path)));
    this.local.lastPublished = fingerprint;
    this.local.lastPublishAt = now;
  }

  private async writeMarker(name: MarkerName, body: unknown): Promise<void> {
    const path = markerPath(this.groupId, this.deviceId, name);
    await this.ports.provider.overwrite(path, await encode('marker', body, this.crypt(path)));
    this.local.markers[name] = { version: (this.local.markers[name]?.version ?? 0) + 1, body };
    await this.publish(true);
  }

  private infos(): Map<string, DeviceInfo> {
    const m = new Map<string, DeviceInfo>();
    for (const [d, c] of Object.entries(this.local.cursors)) if (c.info) m.set(d, c.info);
    return m;
  }

  async maybeCompact(force = false): Promise<boolean> {
    const now = this.ports.clock.now();
    if (!force && now - this.local.lastCompactAt < this.settings.compactIntervalMs) return false;
    const serverNow = this.ports.provider.serverDate();
    const infos = this.infos();
    const removed = this.removedSet();
    const known = new Set([...infos.keys()].filter((d) => !removed.has(d) && !infos.get(d)!.left && this.local.forked[d] === undefined));
    for (const d of Object.keys(this.local.cursors)) if (!removed.has(d) && this.local.forked[d] === undefined && !infos.has(d)) known.add(d);
    const pendingHlcs = [...(this.local.pendingBatch?.ops ?? []), ...this.local.outbox].map((op) => op.hlc);
    const ownBound = pendingHlcs.reduce((min, h) => (h < min ? h : min), this.clock.reserveBound());
    const f = stableFrontier({ infos, known, ownBound, serverNow, staleAfterMs: this.settings.staleMs });
    if (f === null) return false;
    for (const [d, info] of infos) if ((this.local.cursors[d]?.batchNo ?? 0) < info.lastBatchNo && this.local.forked[d] === undefined) return false;
    const c = compactionPoint(f, serverNow, this.settings.historyMs);
    if (c <= this.local.baseFrontier) return false;
    const below = this.local.ops.filter((op) => op.hlc < c);
    if (!force && below.length < this.settings.compactMinOps) return false;
    this.local.lastCompactAt = now;

    const snap = compact(this.baseState(), below);
    const id = randomId(this.random, 5);
    const path = snapshotPath(this.groupId, this.deviceId, id);
    const body: Snapshot = { frontier: c, state: serializeState(snap) };
    await this.ports.provider.createOnce(path, await encode('snapshot', body, this.crypt(path)));

    const ownCoverage = snap.coverage[this.deviceId] ?? 0;
    const keep = this.local.ownBatches.filter((b) => b.lastOpSeq > ownCoverage);
    const drop = this.local.ownBatches.filter((b) => b.lastOpSeq <= ownCoverage);
    this.local.ownBatches = keep;
    this.local.base = serializeState(snap);
    this.local.baseFrontier = c;
    this.local.ops = this.local.ops.filter((op) => op.hlc >= c);
    const covered = (k: string) => {
      const i = k.lastIndexOf(':');
      return coveredBy(snap.coverage, { device: k.slice(0, i), opSeq: Number(k.slice(i + 1)) });
    };
    this.local.confirmed = this.local.confirmed.filter((k) => !covered(k));
    this.local.restorePoints = this.local.restorePoints.filter((r) => r.hlc >= c);
    await this.publish(true);
    for (const b of drop) await this.ports.provider.delete(batchPath(this.groupId, this.deviceId, b.batchNo));
    const mine = (await this.ports.provider.listFiles(snapshotsDir(this.groupId, this.deviceId))).filter((p) => p !== path);
    const others: { path: string; frontier: Hlc }[] = [];
    for (const p of mine) {
      const bytes = await this.ports.provider.get(p);
      if (bytes) others.push({ path: p, frontier: (await decode<Snapshot>(bytes, 'snapshot', this.crypt(p))).frontier });
    }
    others.sort((a, b) => (a.frontier < b.frontier ? 1 : -1));
    for (const o of others.slice(1)) await this.ports.provider.delete(o.path);
    for (const [d, info] of infos) {
      if ((info.left || removed.has(d)) && info.lastOpSeq <= (snap.coverage[d] ?? 0)) {
        for (const p of await this.ports.provider.listFiles(batchesDir(this.groupId, d))) await this.ports.provider.delete(p);
      }
    }
    await this.persist();
    return true;
  }

  private async performJoin(opts: JoinOptions): Promise<JoinPreview> {
    const header = await GroupEngine.readHeader(this.ports.provider, this.groupId);
    if (!header) throw new Error('group not found');
    if (header.encryption && !this.key) throw new LockedError();
    if (!(await this.waitForConsistentView())) throw new Error('the group is changing too fast to join; try again');
    this.observe(hlcFloor(this.ports.provider.serverDate()));
    await this.publish(true);
    await this.pull();
    if (await this.loadNewestSnapshot()) await this.pull();
    if (this.paused) throw new Error(`cannot join: ${(this.local.status as { reason: string }).reason}`);

    const roots = await this.liveRoots();
    const defaults = opts.ignoreDefaults ? findDefaultBookmarks(roots.map((r) => r.live), this.local.config.browser) : [];
    const excluded = new Map([...this.local.excluded, ...(opts.excluded ?? [])]);
    const parentOf = new Map<string, string>();
    const index = (n: LiveNode) => (n.children ?? []).forEach((c) => (parentOf.set(c.localId, n.localId), index(c)));
    roots.forEach((r) => index(r.live));
    for (const l of defaults) excluded.set(l, { parent: parentOf.get(l)!, sticky: false });

    const merged = this.mergedTree();
    const plan =
      opts.mode === 'merge'
        ? await planJoin(merged, roots, this.groupId, excluded)
        : { drafts: [], mirror: new Map<string, MirrorNode>(), idmap: new Map<string, string>(), added: 0, matched: 0 };
    const removable = opts.mode === 'replace' ? roots.flatMap((r) => (r.live.children ?? []).filter((c) => !excluded.has(c.localId))) : [];
    const preview: JoinPreview = {
      added: plan.added,
      matched: plan.matched,
      removedLocal: removable.length,
      groupItems: merged.nodes.size,
      ignoredDefaults: defaults.length,
    };
    if (this.dryRun) return preview;

    this.local.excluded = [...excluded];
    const restorePoint = this.clock.tick();
    this.local.join = { created: !!opts.creating, restorePoint, nodes: plan.drafts.map((d) => d.node), local: roots };
    this.local.restorePoints.push({ hlc: restorePoint, label: opts.creating ? 'Before creating the group' : 'Before joining', at: this.ports.clock.now() });
    for (const n of removable) await this.ports.bookmarks.removeTree(n.localId);
    this.recordDrafts(plan.drafts, true);
    this.local.mirror = [...plan.mirror.values()];
    this.local.idmap = [...plan.idmap];
    this.guardBypass = true;
    try {
      await this.applyMergedState();
      await this.push();
    } finally {
      this.guardBypass = false;
    }
    await this.publish(true);
    await this.persist();
    return preview;
  }

  private async waitForConsistentView(): Promise<boolean> {
    const read = async () => {
      const out: Record<string, number> = {};
      for (const d of await this.ports.provider.listDevices(this.groupId)) {
        const path = deviceInfoPath(this.groupId, d);
        const bytes = await this.ports.provider.get(path);
        if (bytes) out[d] = (await decode<DeviceInfo>(bytes, 'device', this.crypt(path))).lastBatchNo;
      }
      return JSON.stringify(out);
    };
    let prev = await read();
    for (let i = 0; i < 12; i++) {
      await (this.ports.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(this.settings.consistentReadDelayMs);
      const next = await read();
      if (next === prev) return true;
      prev = next;
    }
    return false;
  }

  async undoJoin(): Promise<void> {
    const j = this.local.join;
    if (!j || j.created) throw new Error('this group was not joined from this browser');
    await this.recordLocalChanges();
    const then = visibleTree(replay(this.baseState(), this.local.ops.filter((op) => op.hlc <= j.restorePoint)), this.roots);
    this.recordRestore(then, new Set(j.nodes));
    this.guardBypass = true;
    try {
      await this.pull();
      await this.push();
    } finally {
      this.guardBypass = false;
    }
    await this.publish(true);
    for (const r of j.local) {
      const folder = this.localRoot(r.groupRoot);
      const live = await this.ports.bookmarks.getSubTree(folder);
      for (const c of live.children ?? []) {
        if (!this.local.excluded.some(([l, e]) => l === c.localId && e.sticky)) await this.ports.bookmarks.removeTree(c.localId);
      }
      const rebuild = async (parent: string, kids: LiveNode[]) => {
        for (const k of kids) {
          if (this.local.excluded.some(([l, e]) => l === k.localId && e.sticky)) continue;
          const id = await this.ports.bookmarks.create({ parentId: parent, kind: k.kind, title: k.title, url: k.url });
          if (k.kind === 'folder') await rebuild(id, k.children ?? []);
        }
      };
      await rebuild(folder, (r.live.children ?? []).filter((c) => !this.local.excluded.some(([l, e]) => l === c.localId && e.sticky)));
    }
  }

  restorePoint(label?: string): Hlc {
    const hlc = this.clock.tick();
    if (label) this.local.restorePoints.push({ hlc, label, at: this.ports.clock.now() });
    return hlc;
  }

  async restoreTo(t: Hlc): Promise<number> {
    if (t < this.local.baseFrontier) throw new Error('that point is older than the kept history');
    await this.recordLocalChanges();
    const then = visibleTree(replay(this.baseState(), this.local.ops.filter((op) => op.hlc <= t)), this.roots);
    const n = this.recordRestore(then);
    await this.persist();
    this.guardBypass = true;
    try {
      await this.applyMergedState();
    } finally {
      this.guardBypass = false;
    }
    return n;
  }

  previewRestore(t: Hlc): { restored: number; removed: number; changed: number } {
    const then = visibleTree(replay(this.baseState(), this.local.ops.filter((op) => op.hlc <= t)), this.roots);
    const d = diffTrees(this.mergedTree(), then);
    return { restored: d.creates.length, removed: d.deletes.length, changed: new Set([...d.moves, ...d.updates].map((n) => n.id)).size };
  }

  get oldestRestorable(): Hlc {
    return this.local.baseFrontier;
  }

  private recordRestore(then: Tree, only?: ReadonlySet<string>): number {
    const now = this.mergedTree();
    const base = this.baseState();
    const drafts = planRestoreExact(
      now,
      then,
      (trial) => visibleTree(replay(base, [...this.local.ops, ...this.stampDrafts(trial, true)]), this.roots),
      only,
    );
    this.recordDrafts(drafts, true);
    return drafts.length;
  }

  timeline(limit = 200): TimelineEntry[] {
    const sorted = [...this.local.ops].sort(compareOps).reverse();
    const out: TimelineEntry[] = [];
    for (const op of sorted) {
      const last = out.at(-1);
      if (last && last.device === op.device && hlcWall(last.from) - hlcWall(op.hlc) < 60_000) {
        last.from = op.hlc;
        last.count++;
        last.kinds[op.type] = (last.kinds[op.type] ?? 0) + 1;
      } else {
        if (out.length >= limit) break;
        out.push({ device: op.device, from: op.hlc, to: op.hlc, count: 1, kinds: { [op.type]: 1 } });
      }
    }
    return out;
  }

  async leave(): Promise<void> {
    try {
      await this.push();
    } catch {
      /* best effort: the group must still be left */
    }
    this.leaving = true;
    await this.publish(true);
    await this.ports.store.delete(this.groupId);
  }

  async removeDevice(deviceId: string): Promise<void> {
    this.local.removed = [...new Set([...this.local.removed, deviceId])];
    await this.writeMarker('removed', { devices: this.local.removed } satisfies RemovedMarker);
    await this.persist();
  }

  devices(): { deviceId: string; name: string; browser: string; lastSeen: number; left: boolean; removed: boolean; self: boolean }[] {
    const removed = this.removedSet();
    const out = Object.entries(this.local.cursors)
      .filter(([, c]) => c.info)
      .map(([d, c]) => ({ deviceId: d, name: c.info!.name, browser: c.info!.browser, lastSeen: c.info!.updatedAt, left: c.info!.left, removed: removed.has(d), self: false }));
    out.push({ deviceId: this.deviceId, name: this.local.config.deviceName, browser: this.local.config.browser, lastSeen: this.ports.provider.serverDate(), left: false, removed: false, self: true });
    return out;
  }

  async deleteEverywhere(): Promise<void> {
    await this.writeMarker('group-deleted', { hlc: this.clock.tick() } satisfies GroupDeletedMarker);
    const { provider } = this.ports;
    for (const d of await provider.listDevices(this.groupId)) {
      for (const p of await provider.listFiles(batchesDir(this.groupId, d))) await provider.delete(p);
      for (const p of await provider.listFiles(snapshotsDir(this.groupId, d))) await provider.delete(p);
    }
    await this.ports.store.delete(this.groupId);
  }

  async startMigration(passphrase: string | null, iterations?: number): Promise<{ newGroupId: string; key: CryptoKey | null }> {
    const newGroupId = randomId(this.random);
    let encryption: KeyParams | null = null;
    let key: CryptoKey | null = null;
    if (passphrase) ({ params: encryption, key } = await newKeyParams(passphrase, iterations));
    const marker: MigrationMarker & { newGroupId: string } = {
      migrationId: newGroupId,
      newGroupId,
      hlc: this.clock.tick(),
      encryption,
      excluded: [],
    };
    await this.writeMarker('migration', marker);
    await this.persist();
    return { newGroupId, key };
  }

  async continueMigrationWithout(deviceIds: string[]): Promise<void> {
    const m = this.local.markers.migration?.body as (MigrationMarker & { newGroupId: string }) | undefined;
    if (!m) return;
    await this.writeMarker('migration', { ...m, excluded: [...new Set([...m.excluded, ...deviceIds])] });
  }

  migrationProgress(): { id: string; waitingFor: string[]; initiator: boolean } | null {
    const winner = this.migrationWinner();
    if (!winner) return null;
    return { id: winner.marker.migrationId, waitingFor: this.unfrozen(winner.marker), initiator: winner.device === this.deviceId };
  }

  private migrationWinner(): { device: string; marker: MigrationMarker & { newGroupId: string } } | null {
    const all: { device: string; marker: MigrationMarker & { newGroupId: string } }[] = [];
    for (const [d, c] of Object.entries(this.local.cursors)) if (c.migration) all.push({ device: d, marker: c.migration as MigrationMarker & { newGroupId: string } });
    const own = this.local.markers.migration?.body as (MigrationMarker & { newGroupId: string }) | undefined;
    if (own) all.push({ device: this.deviceId, marker: own });
    all.sort((a, b) => (a.marker.hlc < b.marker.hlc ? -1 : 1));
    return all[0] ?? null;
  }

  private unfrozen(marker: MigrationMarker): string[] {
    const removed = this.removedSet();
    const serverNow = this.ports.provider.serverDate();
    return [...this.infos()]
      .filter(([d, info]) => !removed.has(d) && !info.left && !marker.excluded.includes(d) && this.local.forked[d] === undefined)
      .filter(([, info]) => !isStale(info, serverNow, this.settings.staleMs))
      .filter(([, info]) => info.frozenFor !== marker.migrationId)
      .map(([d]) => d);
  }

  private async migrationStep(): Promise<string | undefined> {
    const winner = this.migrationWinner();
    if (!winner) return undefined;
    const done = [...Object.entries(this.local.cursors).map(([d, c]) => ({ device: d, m: c.migrated })), { device: this.deviceId, m: this.local.markers.migrated?.body as MigratedMarker | undefined }]
      .find((x) => x.m?.migrationId === winner.marker.migrationId);
    if (done?.m) return this.moveToNewGroup(done.m, winner.device, winner.marker);

    if (!this.local.migration || this.local.migration.id !== winner.marker.migrationId) {
      this.local.migration = { id: winner.marker.migrationId, frozen: false };
      await this.applyMergedState();
      await this.push();
      this.local.migration = { id: winner.marker.migrationId, frozen: true };
      await this.publish(true);
    }
    if (this.local.status.state === 'active') this.local.status = { state: 'paused', reason: 'migration' };
    if (winner.device !== this.deviceId) return undefined;

    if (this.unfrozen(winner.marker).length) return undefined;
    for (const [d, info] of this.infos()) if ((this.local.cursors[d]?.batchNo ?? 0) < info.lastBatchNo && this.local.forked[d] === undefined) return undefined;
    const newKey = winner.marker.encryption ? ((await this.ports.keyFor?.(winner.marker.newGroupId)) ?? null) : null;
    if (winner.marker.encryption && !newKey) {
      await this.pause('locked', winner.marker.newGroupId);
      return undefined;
    }
    const g2 = winner.marker.newGroupId;
    const header: GroupHeader = {
      groupId: g2,
      name: this.local.config.name,
      mode: this.local.config.mode,
      createdBy: this.deviceId,
      createdAt: new Date(this.ports.clock.now()).toISOString(),
      encryption: winner.marker.encryption,
    };
    await this.ports.provider.createOnce(groupHeaderPath(g2), await encode('group', header));
    const state = replay(this.baseState(), this.local.ops);
    const seed = seedState(state, visibleSet(state));
    const seedPath = snapshotPath(g2, this.deviceId, 'seed');
    const snap: Snapshot = { frontier: this.clock.tick(), state: serializeState(seed) };
    await this.ports.provider.createOnce(seedPath, await encode('snapshot', snap, { key: newKey, path: seedPath }));
    const coverage: Record<string, number> = { [this.deviceId]: this.local.lastPublishedOpSeq };
    for (const [d, c] of Object.entries(this.local.cursors)) coverage[d] = c.opSeq;
    const migrated: MigratedMarker = { migrationId: winner.marker.migrationId, newGroupId: g2, coverage };
    await this.writeMarker('migrated', migrated);
    return this.moveToNewGroup(migrated, this.deviceId, winner.marker);
  }

  private async moveToNewGroup(m: MigratedMarker, initiator: string, marker: MigrationMarker): Promise<string | undefined> {
    const g2 = m.newGroupId;
    const newKey = marker.encryption ? ((await this.ports.keyFor?.(g2)) ?? null) : null;
    if (marker.encryption && !newKey) {
      await this.pause('locked', g2);
      return undefined;
    }
    const seedPath = snapshotPath(g2, initiator, 'seed');
    const bytes = await this.ports.provider.get(seedPath);
    if (!bytes) return undefined;
    const seed = await decode<Snapshot>(bytes, 'snapshot', { key: newKey, path: seedPath, required: !!marker.encryption });
    const self = this.deviceId;
    const covered = m.coverage[self] ?? 0;
    const held = [
      ...this.local.ops.filter((op) => op.device === self && op.opSeq > covered && op.opSeq <= this.local.lastPublishedOpSeq),
      ...(this.local.pendingBatch?.ops ?? []),
      ...this.local.outbox,
    ];
    const unique = [...new Map(held.map((op) => [opKey(op), op])).values()].sort((a, b) => a.opSeq - b.opSeq);

    const old = this.local;
    const g1 = old.config.groupId;
    const next = freshLocal({ ...old.config, groupId: g2, encrypted: !!marker.encryption });
    next.hlc = this.clock.snapshot();
    next.base = seed.state;
    next.baseFrontier = seed.frontier;
    next.mirror = old.mirror;
    next.idmap = old.idmap;
    next.excluded = old.excluded;
    this.local = next;
    this.key = newKey;
    this.observe(seed.frontier);
    let seq = 0;
    const confirmed = new Set(old.confirmed);
    const restamped = unique.map((op) => {
      const opSeq = ++seq;
      const out = { ...op, opSeq, hlc: this.clock.tick() } as Op;
      if (out.type === 'delete') out.seen = { [self]: opSeq - 1 };
      if (confirmed.has(opKey(op))) next.confirmed.push(opKey(out));
      return out;
    });
    next.opSeq = seq;
    next.ops = restamped;
    next.outbox = [...restamped];
    await this.publish(true);
    await this.push();
    await this.publish(true);
    await this.persist();

    for (const p of await this.ports.provider.listFiles(batchesDir(g1, self))) await this.ports.provider.delete(p);
    for (const p of await this.ports.provider.listFiles(snapshotsDir(g1, self))) await this.ports.provider.delete(p);
    await this.ports.store.delete(g1);
    return g2;
  }

  mergedTree(): Tree {
    return visibleTree(replay(this.baseState(), this.local.ops), this.roots);
  }

  mirror(): Mirror {
    return { roots: this.roots, nodes: new Map(this.local.mirror.map((m) => [m.id, m])) };
  }

  private baseState(): GroupState {
    return deserializeState(this.local.base);
  }

  private crypt(path: string): Crypt {
    return { key: this.key, path, required: this.local.config.encrypted };
  }

  private localRoot(groupRoot: string): string {
    const l = this.local.config.mapping[groupRoot];
    if (!l) throw new Error(`group root ${groupRoot} is not mapped`);
    return l;
  }

  private recordDrafts(drafts: OpDraft[], confirmed: boolean): Op[] {
    const ops = this.stampDrafts(drafts, false);
    for (const op of ops) {
      this.local.ops.push(op);
      this.local.outbox.push(op);
    }
    if (confirmed) this.local.confirmed.push(...ops.map(opKey));
    return ops;
  }

  private stampDrafts(drafts: OpDraft[], dryRun: boolean): Op[] {
    const self = this.deviceId;
    const clock = dryRun ? new HlcClock(self, () => this.ports.clock.now(), this.clock.snapshot()) : this.clock;
    let seq = this.local.opSeq;
    const ops = drafts.map((draft) => {
      const opSeq = ++seq;
      const hlc = clock.tick();
      return (
        draft.type === 'delete'
          ? { ...draft, device: self, opSeq, hlc, seen: { ...this.local.appliedSeq, [self]: opSeq - 1 } }
          : { ...draft, device: self, opSeq, hlc }
      ) as Op;
    });
    if (!dryRun) this.local.opSeq = seq;
    return ops;
  }

  private async persist(): Promise<void> {
    if (this.dryRun) return;
    this.local.hlc = this.clock.snapshot();
    await this.ports.store.save(structuredClone(this.local));
  }
}

export { formatHlc };
