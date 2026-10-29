import { unlockKey } from '../core/crypto.js';
import { UserError } from '../core/errors.js';
import { findDuplicates, type DedupeItem, type DuplicateGroup } from '../core/dedupe.js';
import type { BrowserFamily } from '../core/defaults.js';
import { DAY } from '../core/frontier.js';
import { EVERYTHING_ROOTS, randomId, ROOT_GROUP, type PlaceHint, type RandomBytes, type RootType } from '../core/ids.js';
import type { Kind } from '../core/ops.js';
import type { Excluded, LiveNode } from '../core/reconcile.js';
import { ProviderAuthError } from '../storage/webdav.js';
import {
  GroupEngine,
  type EnginePorts,
  type GroupConfig,
  type GroupFolder,
  type GroupStatus,
  type NewTop,
  type Notice,
  type GroupStore,
  type JoinOptions,
  type JoinPreview,
  type PauseReason,
  type RestorePoint,
  type TimelineEntry,
} from './group.js';
import { PermissionMissingError, type BookmarksPort, type Clock, type StorageProvider } from './ports.js';

export type Account =
  | { id: string; type: 'webdav'; name: string; url: string; username: string; password: string }
  | { id: string; type: 'gdrive'; name: string; refreshToken: string; accessToken?: string; expiresAt?: number };

export type NewAccount = Account extends infer A ? (A extends Account ? Omit<A, 'id'> : never) : never;

export interface Settings {
  historyDays: number;
  guardPercent: number;
  guardMin: number;
  pullMinutes: number;
}

export const DEFAULT_APP_SETTINGS: Settings = { historyDays: 7, guardPercent: 20, guardMin: 10, pullMinutes: 5 };

interface UndoEntry {
  id: string;
  at: number;
  label: string;
  removed: { parentId: string; index: number; node: LiveNode }[];
  moved: { localId: string; parentId: string; index: number }[];
}

export interface AppMeta {
  deviceName: string;
  settings: Settings;
  accounts: Account[];
  groups: string[];
  localUndo: UndoEntry[];
}

export interface AppStore extends GroupStore {
  loadMeta(): Promise<AppMeta | null>;
  saveMeta(meta: AppMeta): Promise<void>;
  getKey(groupId: string): Promise<CryptoKey | null>;
  setKey(groupId: string, key: CryptoKey, persistent: boolean): Promise<void>;
  deleteKey(groupId: string): Promise<void>;
}

/** A group folder this browser holds, and the local folder for it. Without `folderId`, it goes at `hint`. */
export interface PartChoice {
  part: string;
  folderId?: string;
  hint?: PlaceHint;
}

/**
 * Where a group lives in this browser. `folders` starts a folder group with those local folders as its
 * tops; `parts` holds chosen group folders, and `followTops` also places tops other browsers add later.
 */
export type Target =
  | { kind: 'whole' }
  | { kind: 'everything-into'; folderId: string }
  | { kind: 'folders'; folderIds: string[] }
  | { kind: 'parts'; parts: PartChoice[]; followTops?: boolean };

/** Folder IDs a preview uses for helper folders that do not exist yet; they read as empty. */
export const PENDING_PREFIX = 'pending:';

/** A folder still to be made below `existing`; overlap checks test `existing` in its place. */
export const pendingAt = (existing: string, rest: string[]) => `${PENDING_PREFIX}${existing}:${rest.join('/')}`;

function pendingAnchor(id: string): string | null {
  const end = id.indexOf(':', PENDING_PREFIX.length);
  return id.startsWith(PENDING_PREFIX) && end > 0 ? id.slice(PENDING_PREFIX.length, end) : null;
}

export interface LocalFolder {
  id: string;
  parentId: string | null;
  title: string;
  path: string;
  /** Set on the browser's own top-level folders. */
  root?: RootType;
}

export interface RootsPort {
  /** Whole-tree mapping. With `create`, makes (or reuses) the Bookmarks Menu helper folder on Chromium. */
  wholeTree(create: boolean): Promise<{ mapping: Record<string, string>; excluded: [string, Excluded][] }>;
  /** Mapping for an `everything` group kept inside one folder, as three helper subfolders. */
  everythingInto(folderId: string, create: boolean): Promise<{ mapping: Record<string, string>; excluded: [string, Excluded][] }>;
  /** The browser's top-level folders, for scanning every bookmark. */
  topLevel(): Promise<string[]>;
  folders(): Promise<LocalFolder[]>;
  pathOf(localId: string): Promise<string>;
  /** Where a local folder sits, as a hint other browsers can follow. Null outside the synced root folders. */
  describe(localId: string): Promise<{ title: string; hint: PlaceHint | null }>;
  /** The folder at `hint`. Missing folders are created with `create`, or read as a pending ID without it. */
  resolve(hint: PlaceHint, create: boolean): Promise<string>;
}

export interface GroupPart {
  part: string;
  path: string;
  /** A top of a folder group, which can be removed for every browser. */
  top: boolean;
}

export interface AppDeps {
  store: AppStore;
  bookmarks: BookmarksPort;
  roots: RootsPort;
  providerFor: (account: Account, onTokens: (a: Account) => Promise<void>) => StorageProvider;
  clock: Clock;
  browser: BrowserFamily;
  defaultDeviceName: string;
  notify?: (groupId: string, status: GroupStatus) => void;
  describeError?: (e: unknown) => string;
  random?: RandomBytes;
  sleep?: (ms: number) => Promise<void>;
}

export interface GroupSummary {
  groupId: string;
  name: string;
  accountId: string;
  mode: 'everything' | 'folder';
  location: string;
  parts: GroupPart[];
  /** Local folders this group holds here. */
  held: string[];
  notices: Notice[];
  encrypted: boolean;
  bookmarks: number;
  status: GroupStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  pendingChanges: number;
  guard: { kind: 'remote' | 'local'; count: number; total: number } | null;
  migration: { waitingFor: string[]; initiator: boolean } | null;
  restorePoints: RestorePoint[];
  oldestRestorable: string;
  canUndoJoin: boolean;
}

export class SyncApp {
  private meta!: AppMeta;
  private readonly engines = new Map<string, GroupEngine>();
  private readonly lastSyncAt = new Map<string, number>();
  private readonly lastError = new Map<string, string>();
  private readonly rawError = new Map<string, string>();
  private readonly backoffUntil = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private importing = false;

  constructor(private readonly deps: AppDeps) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async init(): Promise<void> {
    await this.run(async () => {
      this.meta = (await this.deps.store.loadMeta()) ?? {
        deviceName: this.deps.defaultDeviceName,
        settings: { ...DEFAULT_APP_SETTINGS },
        accounts: [],
        groups: [],
        localUndo: [],
      };
      for (const g of [...this.meta.groups]) {
        try {
          this.engines.set(g, await GroupEngine.open(this.ports(await this.accountOfGroup(g)), g));
        } catch {
          this.meta.groups = this.meta.groups.filter((x) => x !== g);
        }
      }
      await this.saveMeta();
    });
  }

  // Accounts

  accounts(): Omit<Account, 'password' | 'refreshToken' | 'accessToken'>[] {
    return this.meta.accounts.map((a) => ({ id: a.id, type: a.type, name: a.name, ...(a.type === 'webdav' ? { url: a.url, username: a.username } : {}) }) as Account);
  }

  addAccount(account: NewAccount): Promise<string> {
    return this.run(async () => {
      const id = randomId(this.deps.random, 8);
      const full = { ...account, id } as Account;
      await this.deps.providerFor(full, async () => {}).listGroups();
      this.meta.accounts.push(full);
      await this.saveMeta();
      return id;
    });
  }

  removeAccount(id: string): Promise<void> {
    return this.run(async () => {
      if ([...this.engines.values()].some((e) => e.state.config.accountId === id)) throw new UserError('Stop the syncs that use this storage before removing it.');
      this.meta.accounts = this.meta.accounts.filter((a) => a.id !== id);
      await this.saveMeta();
    });
  }

  discoverGroups(accountId: string): Promise<{ groupId: string; name: string; mode: string; encrypted: boolean; joined: boolean }[]> {
    return this.run(async () => {
      const provider = this.providerOf(this.account(accountId));
      const out = [];
      for (const g of await provider.listGroups()) {
        const h = await GroupEngine.readHeader(provider, g);
        if (h) out.push({ groupId: g, name: h.name, mode: h.mode, encrypted: !!h.encryption, joined: this.engines.has(g) });
      }
      return out;
    });
  }

  // Groups

  createGroup(input: { accountId: string; name: string; mode: 'everything' | 'folder'; target: Target; passphrase?: string; ignoreDefaults: boolean; iterations?: number }): Promise<string> {
    return this.run(async () => {
      const account = this.account(input.accountId);
      const groupId = randomId(this.deps.random);
      let resolved: { mapping: Record<string, string>; excluded: [string, Excluded][]; tops?: NewTop[] };
      if (input.mode === 'folder') {
        if (input.target.kind !== 'folders' || !input.target.folderIds.length) throw new UserError('Pick at least one folder to sync.');
        const tops: NewTop[] = [];
        for (const folderId of input.target.folderIds) {
          const { title, hint } = await this.deps.roots.describe(folderId);
          tops.push({ id: randomId(this.deps.random), title, hint: hint ?? { root: 'other', path: [title] } });
        }
        resolved = { mapping: Object.fromEntries(tops.map((t, i) => [t.id, input.target.kind === 'folders' ? input.target.folderIds[i]! : ''])), excluded: [], tops };
      } else {
        resolved = await this.resolveTarget(input.mode, input.target, true);
      }
      await this.checkOverlap(resolved.mapping, input.mode === 'folder');
      const { encrypted: _e, ...config } = this.config(groupId, account.id, input.name, input.mode, resolved.mapping, false);
      const { engine, key } = await GroupEngine.create(this.ports(account), { ...config, ...(input.mode === 'folder' ? { followTops: true } : {}) }, {
        passphrase: input.passphrase,
        iterations: input.iterations,
        ignoreDefaults: input.ignoreDefaults,
        excluded: resolved.excluded,
        tops: resolved.tops,
      });
      if (key) await this.deps.store.setKey(groupId, key, false);
      this.engines.set(groupId, engine);
      this.meta.groups.push(groupId);
      await this.saveMeta();
      return groupId;
    });
  }

  previewJoin(input: JoinInput): Promise<JoinPreview> {
    return this.run(async () => {
      const { ports, config, opts, key } = await this.prepareJoin(input, true);
      return GroupEngine.preview(ports, config, opts, key);
    });
  }

  joinGroup(input: JoinInput): Promise<void> {
    return this.run(async () => {
      const { ports, config, opts, key, newKey } = await this.prepareJoin(input, false);
      const engine = await GroupEngine.join(ports, config, opts, key);
      if (key && newKey) await this.deps.store.setKey(config.groupId, key, input.rememberKey ?? false);
      this.engines.set(config.groupId, engine);
      this.meta.groups.push(config.groupId);
      await this.saveMeta();
    });
  }

  leaveGroup(groupId: string): Promise<void> {
    return this.run(async () => {
      await this.engine(groupId).leave();
      await this.forget(groupId);
    });
  }

  undoJoin(groupId: string): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      await e.undoJoin();
      await e.leave();
      await this.forget(groupId);
    });
  }

  deleteEverywhere(groupId: string): Promise<void> {
    return this.run(async () => {
      await this.engine(groupId).deleteEverywhere();
      await this.forget(groupId);
    });
  }

  devices(groupId: string) {
    return this.run(async () => this.engine(groupId).devices());
  }

  // Parts this browser holds

  /** The folders of a group, joined or not, for choosing which of them this browser holds. */
  groupFolders(input: { accountId: string; groupId: string; passphrase?: string }): Promise<{ mode: 'everything' | 'folder'; folders: GroupFolder[] }> {
    return this.run(async () => {
      const joined = this.engines.get(input.groupId);
      if (joined) return { mode: joined.state.config.mode, folders: joined.folders() };
      const account = this.account(input.accountId);
      const header = await GroupEngine.readHeader(this.providerOf(account), input.groupId);
      if (!header) throw new UserError('That sync no longer exists on this storage.');
      const key = header.encryption ? await this.keyFor(input.groupId, header.encryption, input.passphrase) : null;
      const config = this.config(input.groupId, account.id, header.name, header.mode, {}, !!header.encryption);
      return { mode: header.mode, folders: await GroupEngine.readFolders(this.ports(account), config, key) };
    });
  }

  addParts(groupId: string, parts: PartChoice[]): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const mapping = await this.resolveParts(parts, false);
      await this.checkOverlap({ ...e.state.config.mapping, ...mapping }, true, groupId);
      await e.addParts(Object.entries(await this.resolveParts(parts, true)).map(([part, localId]) => ({ part, localId })));
    });
  }

  /** Adds local folders to a folder group as new top folders, for every browser. */
  addTops(groupId: string, folderIds: string[]): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const tops: (NewTop & { localId: string })[] = [];
      for (const localId of folderIds) {
        const { title, hint } = await this.deps.roots.describe(localId);
        tops.push({ id: randomId(this.deps.random), title, hint: hint ?? { root: 'other', path: [title] }, localId });
      }
      await this.checkOverlap({ ...e.state.config.mapping, ...Object.fromEntries(tops.map((t) => [t.id, t.localId])) }, true, groupId);
      await e.addTops(tops);
    });
  }

  removePart(groupId: string, part: string, everywhere: boolean): Promise<void> {
    return this.run(() => this.engine(groupId).removePart(part, everywhere));
  }

  /** Points a part at another local folder, for example after its folder was deleted. */
  movePart(groupId: string, part: string, folderId: string): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const { [part]: _old, ...others } = e.state.config.mapping;
      await this.checkOverlap({ ...others, [part]: folderId }, true, groupId);
      await e.movePart(part, folderId);
      await this.syncOne(e);
    });
  }

  dismissNotices(groupId: string): Promise<void> {
    return this.run(() => this.engine(groupId).dismissNotices());
  }

  removeDevice(groupId: string, deviceId: string): Promise<void> {
    return this.run(() => this.engine(groupId).removeDevice(deviceId));
  }

  // History

  timeline(groupId: string): Promise<TimelineEntry[]> {
    return this.run(async () => this.engine(groupId).timeline());
  }

  previewRestore(groupId: string, hlc: string) {
    return this.run(async () => this.engine(groupId).previewRestore(hlc));
  }

  restore(groupId: string, hlc: string): Promise<number> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const n = await e.restoreTo(hlc);
      await this.syncOne(e);
      return n;
    });
  }

  // Pauses, keys and encryption

  resolvePause(groupId: string, choice: 'apply' | 'revert' | 'resume'): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const st = e.status;
      if (st.state !== 'paused') return;
      if (st.reason === 'large-remote-change' || st.reason === 'large-local-change') await e.resolveGuard(choice === 'revert' ? 'revert' : 'apply');
      else await e.resume();
      await this.syncOne(e);
    });
  }

  unlock(groupId: string, passphrase: string, remember: boolean): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const st = e.status;
      const target = st.state === 'paused' && st.reason === 'locked' && st.detail ? st.detail : groupId;
      const header = await GroupEngine.readHeader(this.providerOf(this.account(e.state.config.accountId)), target);
      if (!header?.encryption) throw new UserError('This sync isn’t encrypted.');
      const key = await unlockKey(passphrase, header.encryption);
      await this.deps.store.setKey(target, key, remember);
      if (target === groupId) e.setKey(key);
      else await e.resume();
      await this.syncOne(e);
    });
  }

  setEncryption(groupId: string, passphrase: string | null, iterations?: number): Promise<void> {
    return this.run(async () => {
      const { newGroupId, key } = await this.engine(groupId).startMigration(passphrase, iterations);
      if (key) await this.deps.store.setKey(newGroupId, key, false);
      await this.syncOne(this.engine(groupId));
    });
  }

  continueMigrationWithout(groupId: string, deviceIds: string[]): Promise<void> {
    return this.run(async () => {
      await this.engine(groupId).continueMigrationWithout(deviceIds);
      await this.syncOne(this.engine(groupId));
    });
  }

  // Sync

  setImporting(on: boolean): void {
    this.importing = on;
    for (const e of this.engines.values()) e.importing = on;
    if (!on) void this.syncAll();
  }

  syncAll(): Promise<void> {
    return this.run(async () => {
      if (this.importing) return;
      await this.checkMappingOverlaps();
      for (const e of [...this.engines.values()]) await this.syncOne(e);
    });
  }

  syncGroup(groupId: string): Promise<void> {
    return this.run(() => this.syncOne(this.engine(groupId)));
  }

  status(): Promise<GroupSummary[]> {
    return this.run(async () => {
      const out: GroupSummary[] = [];
      for (const e of this.engines.values()) {
        const c = e.state.config;
        const g = e.state.guard;
        const m = e.migrationProgress();
        const tops = new Set(c.mode === 'folder' ? e.folders().filter((f) => f.parent === ROOT_GROUP).map((f) => f.id) : []);
        const parts: GroupPart[] = [];
        for (const [part, local] of Object.entries(c.mapping)) {
          const path = (await this.deps.bookmarks.exists(local)) ? await this.deps.roots.pathOf(local) : 'A deleted folder';
          parts.push({ part, path, top: tops.has(part) });
        }
        const whole = c.mode === 'everything' && EVERYTHING_ROOTS.every((r) => c.mapping[r] !== undefined);
        const paths = parts.map((p) => p.path);
        out.push({
          groupId: c.groupId,
          name: c.name,
          accountId: c.accountId,
          mode: c.mode,
          location: whole ? 'All bookmarks' : paths.length > 2 ? `${paths.slice(0, 2).join(', ')} and ${paths.length - 2} more` : paths.join(', ') || 'No folders',
          parts: whole ? [] : parts,
          held: Object.values(c.mapping),
          notices: [...e.notices],
          encrypted: c.encrypted,
          bookmarks: [...e.mirror().nodes.values()].filter((n) => n.kind === 'bookmark').length,
          status: e.status,
          lastSyncAt: this.lastSyncAt.get(c.groupId) ?? null,
          lastError: this.lastError.get(c.groupId) ?? null,
          pendingChanges: e.state.outbox.length + (e.state.pendingBatch?.ops.length ?? 0),
          guard: g ? { kind: g.kind, count: g.count, total: g.total } : null,
          migration: m ? { waitingFor: m.waitingFor, initiator: m.initiator } : null,
          restorePoints: e.state.restorePoints,
          oldestRestorable: e.oldestRestorable,
          canUndoJoin: !!e.state.join && !e.state.join.created,
        });
      }
      return out;
    });
  }

  // Settings

  settings(): Settings & { deviceName: string } {
    return { ...this.meta.settings, deviceName: this.meta.deviceName };
  }

  updateSettings(patch: Partial<Settings & { deviceName: string }>): Promise<void> {
    return this.run(async () => {
      const { deviceName, ...rest } = patch;
      if (deviceName) this.meta.deviceName = deviceName;
      this.meta.settings = { ...this.meta.settings, ...rest };
      await this.saveMeta();
      for (const g of [...this.engines.keys()]) this.engines.set(g, await GroupEngine.open(this.ports(await this.accountOfGroup(g)), g));
    });
  }

  // Duplicates

  scanDuplicates(): Promise<DuplicateGroup[]> {
    return this.run(async () => {
      const groupOf = new Map<string, string>();
      for (const e of this.engines.values()) for (const [local] of e.state.idmap) groupOf.set(local, e.state.config.name);
      const items: DedupeItem[] = [];
      const walk = (n: LiveNode, path: string[]) => {
        for (const c of n.children ?? []) {
          if (c.kind === 'bookmark') items.push({ localId: c.localId, title: c.title, url: c.url, path: path.join(' / '), group: groupOf.get(c.localId) ?? null });
          else if (c.kind === 'folder') walk(c, [...path, c.title]);
        }
      };
      for (const top of await this.deps.roots.topLevel()) {
        const n = await this.deps.bookmarks.getSubTree(top);
        walk(n, [n.title]);
      }
      return findDuplicates(items);
    });
  }

  /** Remove `remove`, or move `move` into `folderId`. Synced items go through the change log; others get a local undo entry. */
  applyDedupe(action: { remove: string[] } | { move: string[]; folderId: string }): Promise<void> {
    return this.run(async () => {
      for (const e of this.engines.values()) await e.recordLocalChanges();
      const entry: UndoEntry = { id: randomId(this.deps.random, 8), at: this.deps.clock.now(), label: '', removed: [], moved: [] };
      const synced = (id: string) => [...this.engines.values()].some((e) => e.state.idmap.some(([l]) => l === id));
      const index = async (id: string) => {
        const parent = await this.deps.bookmarks.parentOf(id);
        const kids = parent ? (await this.deps.bookmarks.getSubTree(parent)).children ?? [] : [];
        return { parentId: parent ?? '', index: kids.findIndex((k) => k.localId === id) };
      };
      if ('remove' in action) {
        entry.label = `Removed ${action.remove.length} duplicates`;
        for (const id of action.remove) {
          if (!synced(id)) entry.removed.push({ ...(await index(id)), node: await this.deps.bookmarks.getSubTree(id) });
          await this.deps.bookmarks.removeTree(id);
        }
      } else {
        entry.label = `Moved ${action.move.length} duplicates`;
        for (const id of action.move) {
          if (!synced(id)) entry.moved.push({ localId: id, ...(await index(id)) });
          await this.deps.bookmarks.move(id, { parentId: action.folderId });
        }
      }
      if (entry.removed.length || entry.moved.length) {
        this.meta.localUndo = [entry, ...this.meta.localUndo].slice(0, 20);
        await this.saveMeta();
      }
      for (const e of this.engines.values()) {
        await e.recordLocalChanges({ confirmed: true });
        await this.syncOne(e);
      }
    });
  }

  localUndo(): { id: string; at: number; label: string }[] {
    return this.meta.localUndo.map(({ id, at, label }) => ({ id, at, label }));
  }

  undoLocal(id: string): Promise<void> {
    return this.run(async () => {
      const entry = this.meta.localUndo.find((u) => u.id === id);
      if (!entry) return;
      for (const m of entry.moved) if (await this.deps.bookmarks.exists(m.localId)) await this.deps.bookmarks.move(m.localId, { parentId: m.parentId, index: m.index });
      const rebuild = async (parentId: string, n: LiveNode, index?: number) => {
        const created = await this.deps.bookmarks.create({ parentId, index, kind: n.kind as Kind, title: n.title, url: n.url });
        for (const c of n.children ?? []) await rebuild(created, c);
      };
      for (const r of entry.removed) if (await this.deps.bookmarks.exists(r.parentId)) await rebuild(r.parentId, r.node, r.index);
      this.meta.localUndo = this.meta.localUndo.filter((u) => u.id !== id);
      await this.saveMeta();
    });
  }

  folders() {
    return this.run(() => this.deps.roots.folders());
  }

  diagnostics(): Promise<unknown> {
    return this.run(async () => ({
      at: new Date(this.deps.clock.now()).toISOString(),
      browser: this.deps.browser,
      settings: this.meta.settings,
      accounts: this.meta.accounts.map((a) => ({ id: a.id, type: a.type })),
      groups: [...this.engines.values()].map((e) => ({
        groupId: e.groupId,
        deviceId: e.deviceId,
        status: e.status,
        ops: e.state.ops.length,
        outbox: e.state.outbox.length,
        lastBatchNo: e.state.lastBatchNo,
        devices: Object.keys(e.state.cursors).length,
        lastError: this.rawError.get(e.groupId) ?? null,
      })),
    }));
  }

  // Internals

  private async syncOne(e: GroupEngine): Promise<void> {
    const g = e.groupId;
    if ((this.backoffUntil.get(g) ?? 0) > this.deps.clock.now()) return;
    const before = JSON.stringify(e.status);
    try {
      const res = await e.cycle();
      this.lastSyncAt.set(g, this.deps.clock.now());
      this.lastError.delete(g);
      this.rawError.delete(g);
      this.backoffUntil.delete(g);
      if (res.migratedTo) {
        this.engines.delete(g);
        this.engines.set(res.migratedTo, e);
        this.meta.groups = [...this.meta.groups.filter((x) => x !== g), res.migratedTo];
        await this.deps.store.deleteKey(g);
        await this.saveMeta();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.rawError.set(g, message);
      this.lastError.set(g, this.deps.describeError?.(err) ?? message);
      if (err instanceof ProviderAuthError) await e.pause('auth', message);
      else if (err instanceof PermissionMissingError) await e.pause('permission', message);
      else {
        const failures = (this.failures.get(g) ?? 0) + 1;
        this.failures.set(g, failures);
        this.backoffUntil.set(g, this.deps.clock.now() + [60_000, 300_000, 900_000][Math.min(failures - 1, 2)]!);
      }
    }
    if (JSON.stringify(e.status) !== before) this.deps.notify?.(e.groupId, e.status);
  }

  private readonly failures = new Map<string, number>();

  private async checkMappingOverlaps(): Promise<void> {
    const folders = [...this.engines.values()].flatMap((e) =>
      Object.entries(e.state.config.mapping)
        .filter(([, local]) => !local.startsWith(PENDING_PREFIX))
        .map(([part, folder]) => ({ e, part, folder })),
    );
    for (const a of folders) {
      for (const b of folders) {
        if (a === b || (a.e === b.e && this.wholeTreeMapping(a.e.state.config))) continue;
        if (a.folder === b.folder || (await this.isInside(a.folder, b.folder))) {
          await a.e.pause('mapping-overlap' as PauseReason, b.e.state.config.name);
          await b.e.pause('mapping-overlap' as PauseReason, a.e.state.config.name);
        }
      }
    }
  }

  /** A whole-tree or into-one-folder mapping, whose Chromium menu helper sits inside the other bookmarks folder. */
  private wholeTreeMapping(c: GroupConfig): boolean {
    return c.mode === 'everything' && EVERYTHING_ROOTS.every((r) => c.mapping[r] !== undefined);
  }

  private async isInside(inner: string, outer: string): Promise<boolean> {
    for (let cur: string | null = await this.deps.bookmarks.parentOf(inner); cur; cur = await this.deps.bookmarks.parentOf(cur)) {
      if (cur === outer) return true;
    }
    return false;
  }

  /** `ownPairs` also rejects folders of this mapping that sit inside each other; `except` skips that group's current mapping. */
  private async checkOverlap(mapping: Record<string, string>, ownPairs: boolean, except?: string): Promise<void> {
    const mine = Object.values(mapping).filter((l) => !l.startsWith(PENDING_PREFIX) || pendingAnchor(l));
    // A folder still to be made is empty and sits below its anchor, so only the anchor being inside the other folder counts.
    const nested = async (a: string, b: string): Promise<boolean> => {
      if (a === b) return true;
      const anchorA = pendingAnchor(a);
      const anchorB = pendingAnchor(b);
      if (anchorA && anchorB) return false;
      if (anchorA) return anchorA === b || (await this.isInside(anchorA, b));
      if (anchorB) return anchorB === a || (await this.isInside(anchorB, a));
      return (await this.isInside(a, b)) || (await this.isInside(b, a));
    };
    if (ownPairs) {
      for (const [i, a] of mine.entries()) {
        for (const b of mine.slice(i + 1)) if (await nested(a, b)) throw new UserError('Two of the folders are inside each other. Pick only the outer one.');
      }
    }
    for (const e of this.engines.values()) {
      if (e.groupId === except) continue;
      const name = e.state.config.name;
      for (const m of mine) {
        for (const t of Object.values(e.state.config.mapping)) {
          if (!t.startsWith(PENDING_PREFIX) && (await nested(m, t))) throw new UserError(`That overlaps with the sync “${name}”. Pick a folder outside it.`);
        }
      }
    }
  }

  /** Where a top another browser added goes here, or null when that place overlaps a folder already synced. */
  /**
   * A new, empty folder at the hinted path, never an existing folder or a browser root: adopting one would upload
   * its contents without anyone choosing that on this browser.
   */
  private async placeTop(hint: PlaceHint, title: string, groupId: string): Promise<string | null> {
    const parent = { root: hint.root, path: hint.path.slice(0, -1) };
    const name = hint.path.at(-1) ?? title;
    const own = this.engines.get(groupId)?.state.config.mapping ?? {};
    const at = await this.deps.roots.resolve(parent, false);
    try {
      await this.checkOverlap({ ...own, new: at.startsWith(PENDING_PREFIX) ? at : pendingAt(at, [name]) }, true, groupId);
    } catch (e) {
      if (e instanceof UserError) return null;
      throw e;
    }
    return this.deps.bookmarks.create({ parentId: await this.deps.roots.resolve(parent, true), kind: 'folder', title: name, url: '' });
  }

  private async resolveTarget(mode: 'everything' | 'folder', target: Target, create: boolean): Promise<{ mapping: Record<string, string>; excluded: [string, Excluded][] }> {
    if (target.kind === 'parts') return { mapping: await this.resolveParts(target.parts, create), excluded: [] };
    if (mode === 'folder') throw new Error('a folder group maps chosen parts');
    if (target.kind === 'whole') return this.deps.roots.wholeTree(create);
    if (target.kind === 'everything-into') return this.deps.roots.everythingInto(target.folderId, create);
    throw new Error('an everything group maps to the whole tree, into one folder, or chosen parts');
  }

  private async resolveParts(parts: PartChoice[], create: boolean): Promise<Record<string, string>> {
    if (!parts.length) throw new UserError('Pick at least one folder to sync.');
    const mapping: Record<string, string> = {};
    for (const p of parts) {
      if (p.folderId) mapping[p.part] = p.folderId;
      else if (p.hint) mapping[p.part] = await this.deps.roots.resolve(p.hint, create);
      else throw new Error('a part needs a folder or a hint');
    }
    return mapping;
  }

  private async keyFor(groupId: string, params: Parameters<typeof unlockKey>[1], passphrase?: string): Promise<CryptoKey> {
    const stored = await this.deps.store.getKey(groupId);
    if (stored) return stored;
    if (!passphrase) throw new UserError('This sync is encrypted. Enter its passphrase.');
    return unlockKey(passphrase, params);
  }

  private async prepareJoin(input: JoinInput, preview: boolean) {
    const account = this.account(input.accountId);
    if (!preview && this.engines.has(input.groupId)) throw new UserError('This browser is already part of that sync.');
    const provider = this.providerOf(account);
    const header = await GroupEngine.readHeader(provider, input.groupId);
    if (!header) throw new UserError('That sync no longer exists on this storage.');
    let key: CryptoKey | null = null;
    let newKey = false;
    if (header.encryption) {
      key = await this.deps.store.getKey(input.groupId);
      if (!key && input.passphrase) {
        key = await unlockKey(input.passphrase, header.encryption);
        newKey = true;
      }
      if (!key) throw new UserError('This sync is encrypted. Enter its passphrase.');
    }
    await this.checkOverlap((await this.resolveTarget(header.mode, input.target, false)).mapping, input.target.kind === 'parts');
    const { mapping, excluded } = await this.resolveTarget(header.mode, input.target, !preview);
    const config = this.config(input.groupId, account.id, header.name, header.mode, mapping, !!header.encryption);
    if (input.target.kind === 'parts' && input.target.followTops && header.mode === 'folder') config.followTops = true;
    const opts: JoinOptions = { mode: input.mode, ignoreDefaults: input.ignoreDefaults, excluded };
    return { ports: this.ports(account), config, opts, key, newKey };
  }

  private config(groupId: string, accountId: string, name: string, mode: 'everything' | 'folder', mapping: Record<string, string>, encrypted: boolean): GroupConfig {
    return {
      groupId,
      accountId,
      deviceId: randomId(this.deps.random),
      deviceName: this.meta.deviceName,
      browser: this.deps.browser,
      mode,
      mapping,
      name,
      encrypted,
    };
  }

  private ports(account: Account): EnginePorts {
    const s = this.meta.settings;
    return {
      provider: this.providerOf(account),
      bookmarks: this.deps.bookmarks,
      store: this.deps.store,
      clock: this.deps.clock,
      random: this.deps.random,
      sleep: this.deps.sleep,
      keyFor: (g) => this.deps.store.getKey(g),
      place: (hint, title, groupId) => this.placeTop(hint, title, groupId),
      settings: { historyMs: s.historyDays * DAY, guardPercent: s.guardPercent, guardMin: s.guardMin },
    };
  }

  private readonly providers = new Map<string, StorageProvider>();

  private providerOf(account: Account): StorageProvider {
    let p = this.providers.get(account.id);
    if (!p) {
      p = this.deps.providerFor(account, async (updated) => {
        this.meta.accounts = this.meta.accounts.map((a) => (a.id === updated.id ? updated : a));
        await this.saveMeta();
      });
      this.providers.set(account.id, p);
    }
    return p;
  }

  private account(id: string): Account {
    const a = this.meta.accounts.find((x) => x.id === id);
    if (!a) throw new Error('unknown account');
    return a;
  }

  private async accountOfGroup(groupId: string): Promise<Account> {
    const local = await this.deps.store.load(groupId);
    if (!local) throw new Error(`no local state for ${groupId}`);
    return this.account(local.config.accountId);
  }

  private engine(groupId: string): GroupEngine {
    const e = this.engines.get(groupId);
    if (!e) throw new Error('unknown group');
    return e;
  }

  private async forget(groupId: string): Promise<void> {
    this.engines.delete(groupId);
    this.meta.groups = this.meta.groups.filter((g) => g !== groupId);
    await this.deps.store.delete(groupId);
    await this.deps.store.deleteKey(groupId);
    await this.saveMeta();
  }

  private async saveMeta(): Promise<void> {
    await this.deps.store.saveMeta(structuredClone(this.meta));
  }
}

export interface JoinInput {
  accountId: string;
  groupId: string;
  target: Target;
  mode: 'merge' | 'replace';
  ignoreDefaults: boolean;
  passphrase?: string;
  rememberKey?: boolean;
}
