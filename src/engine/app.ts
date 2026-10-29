import { unlockKey } from '../core/crypto.js';
import { type DedupeItem, type DuplicateGroup, findDuplicates } from '../core/dedupe.js';
import type { BrowserFamily } from '../core/defaults.js';
import { BridgeTakenError, UserError } from '../core/errors.js';
import { DAY } from '../core/frontier.js';
import { EVERYTHING_ROOTS, type PlaceHint, type RandomBytes, ROOT_GROUP, type RootType, randomId } from '../core/ids.js';
import { sameNameKey } from '../core/names.js';
import type { Excluded, LiveNode } from '../core/reconcile.js';
import { ProviderAuthError } from '../storage/webdav.js';
import { recreate, removeEach } from './apply.js';
import {
  type EnginePorts,
  type GroupConfig,
  GroupEngine,
  type GroupFolder,
  type GroupLocal,
  type GroupStatus,
  type GroupStore,
  type JoinOptions,
  type JoinPreview,
  type NewTop,
  type Notice,
  type PauseReason,
  type PullCache,
  type RestorePoint,
  type TimelineEntry,
} from './group.js';
import { type BookmarksPort, type Clock, PermissionMissingError, type StorageProvider } from './ports.js';

const PULL_CACHE_MS = 5 * 60_000;

export type Account =
  | { id: string; type: 'webdav'; name: string; url: string; username: string; password: string }
  | { id: string; type: 'gdrive'; name: string; email?: string; refreshToken: string; accessToken?: string; expiresAt?: number };

export type FoundGroup = { groupId: string; name: string; mode: 'everything' | 'folder'; encrypted: boolean; joined: boolean; browsers: string[] | null };

export type NewAccount = Account extends infer A ? (A extends Account ? Omit<A, 'id'> : never) : never;

export interface Settings {
  historyDays: number;
  guardPercent: number;
  guardMin: number;
  activeCheckSeconds: number;
  awayCheckSeconds: number;
}

export const DEFAULT_APP_SETTINGS: Settings = { historyDays: 7, guardPercent: 20, guardMin: 10, activeCheckSeconds: 30, awayCheckSeconds: 300 };

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
export type Target = { kind: 'whole' } | { kind: 'everything-into'; folderId: string } | { kind: 'folders'; folderIds: string[] } | { kind: 'parts'; parts: PartChoice[]; followTops?: boolean };

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
  /** Each folder's path, or null for one that no longer exists. */
  pathsOf(localIds: string[]): Promise<(string | null)[]>;
  /** Where each local folder sits, as a hint other browsers can follow. Null outside the synced root folders. */
  describe(localIds: string[]): Promise<{ title: string; hint: PlaceHint | null }[]>;
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
  /** Syncs this one shares a folder with: linked on this browser (`via` null) or through another browser. */
  links: { name: string; via: string | null }[];
}

type Inside = (inner: string, outer: string) => boolean;

export class SyncApp {
  private meta!: AppMeta;
  private readonly engines = new Map<string, GroupEngine>();
  private readonly lastSyncAt = new Map<string, number>();
  private readonly lastError = new Map<string, string>();
  private readonly rawError = new Map<string, string>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly emailTried = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private importing = false;
  /** What the join page read of groups not joined here, so joining fetches only what is new. */
  private readonly pulled = new Map<string, { at: number; local: GroupLocal }>();

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
      const { pullMinutes, ...saved } = this.meta.settings as Settings & { pullMinutes?: number };
      this.meta.settings = { ...DEFAULT_APP_SETTINGS, ...(pullMinutes ? { awayCheckSeconds: pullMinutes * 60 } : {}), ...saved };
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
    return this.meta.accounts.map((a) => ({ id: a.id, type: a.type, name: a.name, ...(a.type === 'webdav' ? { url: a.url, username: a.username } : { email: a.email }) }) as Account);
  }

  addAccount(account: NewAccount): Promise<string> {
    return this.run(async () => {
      const id = randomId(this.deps.random, 8);
      const full = { ...account, id } as Account;
      const provider = this.deps.providerFor(full, async () => {});
      await provider.listGroups();
      if (full.type === 'gdrive') full.email = (await provider.whoAmI?.().catch(() => null)) ?? undefined;
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

  /** Groups on the storage that aren't deleted. */
  discoverGroups(accountId: string): Promise<FoundGroup[]> {
    return this.run(() => this.liveGroups(this.providerOf(this.account(accountId))));
  }

  private async liveGroups(provider: StorageProvider): Promise<FoundGroup[]> {
    const out: FoundGroup[] = [];
    for (const g of await provider.listGroups()) {
      const h = await GroupEngine.readHeader(provider, g);
      if (!h) continue;
      const { deleted, browsers } = await GroupEngine.readMembers(provider, g, !!h.encryption);
      if (!deleted) out.push({ groupId: g, name: h.name, mode: h.mode, encrypted: !!h.encryption, joined: this.engines.has(g), browsers });
    }
    return out;
  }

  // Groups

  createGroup(input: { accountId: string; name: string; mode: 'everything' | 'folder'; target: Target; passphrase?: string; ignoreDefaults: boolean; iterations?: number }): Promise<string> {
    return this.run(async () => {
      const account = this.account(input.accountId);
      const nameKey = sameNameKey(input.name);
      if (!nameKey) throw new UserError('Give this sync a name.');
      const taken = (await this.liveGroups(this.providerOf(account))).find((g) => sameNameKey(g.name) === nameKey);
      if (taken) throw new UserError(`A sync called “${taken.name}” is already on this storage. Join it, or pick another name.`);
      const groupId = randomId(this.deps.random);
      let resolved: { mapping: Record<string, string>; excluded: [string, Excluded][]; tops?: NewTop[] };
      if (input.mode === 'folder') {
        if (input.target.kind !== 'folders' || !input.target.folderIds.length) throw new UserError('Pick at least one folder to sync.');
        const tops: NewTop[] = (await this.deps.roots.describe(input.target.folderIds)).map(({ title, hint }) => ({
          id: randomId(this.deps.random),
          title,
          hint: hint ?? { root: 'other', path: [title] },
        }));
        resolved = { mapping: Object.fromEntries(tops.map((t, i) => [t.id, input.target.kind === 'folders' ? input.target.folderIds[i]! : ''])), excluded: [], tops };
      } else {
        resolved = await this.resolveTarget(input.mode, input.target, true);
      }
      if (input.mode === 'folder') await this.checkNesting(resolved.mapping);
      const { encrypted: _e, ...config } = this.config(groupId, account.id, input.name, input.mode, resolved.mapping, false);
      const { engine, key } = await GroupEngine.create(
        this.ports(account),
        { ...config, ...(input.mode === 'folder' ? { followTops: true } : {}) },
        {
          passphrase: input.passphrase,
          iterations: input.iterations,
          ignoreDefaults: input.ignoreDefaults,
          excluded: resolved.excluded,
          tops: resolved.tops,
        },
      );
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
      return GroupEngine.preview(ports, config, opts, key, this.pullCache(input.accountId, input.groupId));
    });
  }

  joinGroup(input: JoinInput): Promise<void> {
    return this.run(async () => {
      const { ports, config, opts, key, newKey } = await this.prepareJoin(input, false);
      await this.checkBridge(config.groupId, config.mapping, input.takeover);
      const engine = await GroupEngine.join(ports, config, opts, key, this.pullCache(input.accountId, input.groupId));
      this.pulled.clear();
      if (key && newKey) await this.deps.store.setKey(config.groupId, key, input.rememberKey ?? false);
      this.engines.set(config.groupId, engine);
      this.meta.groups.push(config.groupId);
      await this.saveMeta();
      if (input.takeover) await this.settleBridges(engine, true);
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

  renameGroup(groupId: string, name: string): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const trimmed = name.trim();
      if (!sameNameKey(trimmed)) throw new UserError('Give this sync a name.');
      const taken = (await this.liveGroups(this.providerOf(this.account(e.state.config.accountId)))).find((g) => g.groupId !== groupId && sameNameKey(g.name) === sameNameKey(trimmed));
      if (taken) throw new UserError(`A sync called “${taken.name}” is already on this storage. Pick another name.`);
      await e.rename(trimmed);
    });
  }

  deleteEverywhere(groupId: string): Promise<void> {
    return this.run(async () => {
      await this.engine(groupId).deleteEverywhere();
      await this.forget(groupId);
    });
  }

  async devices(groupId: string) {
    return this.engine(groupId).devices();
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
      return { mode: header.mode, folders: await GroupEngine.readFolders(this.ports(account), config, key, this.pullCache(account.id, input.groupId)) };
    });
  }

  addParts(groupId: string, parts: PartChoice[], takeover?: boolean): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const mapping = await this.resolveParts(parts, false);
      await this.checkNesting({ ...e.state.config.mapping, ...mapping });
      await this.checkBridge(groupId, mapping, takeover);
      await e.addParts(Object.entries(await this.resolveParts(parts, true)).map(([part, localId]) => ({ part, localId })));
      if (takeover) await this.settleBridges(e, true);
    });
  }

  /** Adds local folders to a folder group as new top folders, for every browser. */
  addTops(groupId: string, folderIds: string[], takeover?: boolean): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const tops: (NewTop & { localId: string })[] = (await this.deps.roots.describe(folderIds)).map(({ title, hint }, i) => ({
        id: randomId(this.deps.random),
        title,
        hint: hint ?? { root: 'other', path: [title] },
        localId: folderIds[i]!,
      }));
      await this.checkNesting({ ...e.state.config.mapping, ...Object.fromEntries(tops.map((t) => [t.id, t.localId])) });
      await this.checkBridge(groupId, Object.fromEntries(tops.map((t) => [t.id, t.localId])), takeover);
      await e.addTops(tops);
      if (takeover) await this.settleBridges(e, true);
    });
  }

  removePart(groupId: string, part: string, everywhere: boolean): Promise<void> {
    return this.run(() => this.engine(groupId).removePart(part, everywhere));
  }

  /** Points a part at another local folder, for example after its folder was deleted. */
  movePart(groupId: string, part: string, folderId: string, takeover?: boolean): Promise<void> {
    return this.run(async () => {
      const e = this.engine(groupId);
      const { [part]: _old, ...others } = e.state.config.mapping;
      await this.checkNesting({ ...others, [part]: folderId });
      await this.checkBridge(groupId, { [part]: folderId }, takeover);
      await e.movePart(part, folderId);
      if (takeover) await this.settleBridges(e, true);
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

  async timeline(groupId: string): Promise<TimelineEntry[]> {
    return this.engine(groupId).timeline();
  }

  async previewRestore(groupId: string, hlc: string) {
    return this.engine(groupId).previewRestore(hlc);
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
      await this.fillEmails();
      await this.checkMappingOverlaps();
      for (const e of [...this.engines.values()]) await this.syncOne(e);
      await this.syncBridged();
    });
  }

  /** Google accounts connected before the email was recorded; tried once per run of the extension. */
  private async fillEmails(): Promise<void> {
    let changed = false;
    for (const a of this.meta.accounts) {
      if (a.type !== 'gdrive' || a.email || this.emailTried.has(a.id)) continue;
      this.emailTried.add(a.id);
      const email = await this.providerOf(a)
        .whoAmI?.()
        .catch(() => null);
      if (email) {
        a.email = email;
        changed = true;
      }
    }
    if (changed) await this.saveMeta();
  }

  syncGroup(groupId: string): Promise<void> {
    return this.run(async () => {
      await this.syncOne(this.engine(groupId));
      await this.syncBridged();
    });
  }

  /**
   * Reads what the engines hold without waiting for a running sync; the snapshot after it shows its result.
   * Keyed by `engines`, not the engine's own ID, which a migration changes before the app moves it.
   */
  async status(): Promise<GroupSummary[]> {
    const engines = [...this.engines].map(([groupId, e]) => ({ groupId, e, mapping: { ...e.state.config.mapping } }));
    const locals = engines.flatMap((x) => Object.values(x.mapping));
    const found = await this.deps.roots.pathsOf(locals);
    const pathOf = new Map(locals.map((l, i) => [l, found[i] ?? 'A deleted folder']));
    return engines.map(({ groupId, e, mapping }) => {
      const c = e.state.config;
      const g = e.state.guard;
      const m = e.migrationProgress();
      const tops = new Set(
        c.mode === 'folder'
          ? e
              .folders()
              .filter((f) => f.parent === ROOT_GROUP)
              .map((f) => f.id)
          : [],
      );
      const parts: GroupPart[] = Object.entries(mapping).map(([part, local]) => ({ part, path: pathOf.get(local)!, top: tops.has(part) }));
      const whole = c.mode === 'everything' && EVERYTHING_ROOTS.every((r) => mapping[r] !== undefined);
      const paths = parts.map((p) => p.path);
      return {
        groupId,
        name: c.name,
        accountId: c.accountId,
        mode: c.mode,
        location: whole ? 'All bookmarks' : paths.length > 2 ? `${paths.slice(0, 2).join(', ')} and ${paths.length - 2} more` : paths.join(', ') || 'No folders',
        parts: whole ? [] : parts,
        held: Object.values(mapping),
        notices: [...e.notices],
        encrypted: c.encrypted,
        bookmarks: [...e.mirror().nodes.values()].filter((n) => n.kind === 'bookmark').length,
        status: e.status,
        lastSyncAt: this.lastSyncAt.get(groupId) ?? null,
        lastError: this.lastError.get(groupId) ?? null,
        pendingChanges: e.state.outbox.length + (e.state.pendingBatch?.ops.length ?? 0),
        guard: g ? { kind: g.kind, count: g.count, total: g.total } : null,
        migration: m ? { waitingFor: m.waitingFor, initiator: m.initiator } : null,
        restorePoints: e.state.restorePoints,
        oldestRestorable: e.oldestRestorable,
        canUndoJoin: !!e.state.join && !e.state.join.created,
        links: [...Object.values(e.ownLinks()).map((l) => ({ name: l.name, via: null })), ...e.otherLinks().map((l) => ({ name: l.name, via: l.device }))],
      };
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

  /**
   * Remove `remove`, or move `move` into `folderId`. Synced items go through the change log; others get a local undo entry.
   * Resolves once the bookmarks changed here; the upload follows in the queue.
   */
  applyDedupe(action: { remove: string[] } | { move: string[]; folderId: string }): Promise<void> {
    const done = this.run(async () => {
      for (const e of this.engines.values()) await e.recordLocalChanges();
      const entry: UndoEntry = { id: randomId(this.deps.random, 8), at: this.deps.clock.now(), label: '', removed: [], moved: [] };
      const syncedIds = new Set([...this.engines.values()].flatMap((e) => e.state.idmap.map(([l]) => l)));
      const synced = (id: string) => syncedIds.has(id);
      const at = await this.deps.bookmarks.positions();
      const index = (id: string) => at.get(id) ?? { parentId: '', index: -1 };
      let refused: PromiseRejectedResult | undefined;
      if ('remove' in action) {
        entry.label = `Removed ${action.remove.length} ${action.remove.length === 1 ? 'duplicate' : 'duplicates'}`;
        const unsynced = new Set(action.remove.filter((id) => !synced(id)));
        const nodes = await Promise.all(action.remove.map((id) => (unsynced.has(id) ? this.deps.bookmarks.getSubTree(id).catch(() => null) : null)));
        const results = await removeEach(this.deps.bookmarks, action.remove);
        // Whatever was removed keeps its undo entry and is recorded below; the first refusal is reported after that.
        refused = results.find((r) => r.status === 'rejected');
        for (const [i, id] of action.remove.entries()) {
          const node = nodes[i];
          if (node && results[i]!.status === 'fulfilled') entry.removed.push({ ...index(id), node });
        }
      } else {
        entry.label = `Moved ${action.move.length} ${action.move.length === 1 ? 'duplicate' : 'duplicates'}`;
        for (const id of action.move) {
          if (!synced(id)) entry.moved.push({ localId: id, ...index(id) });
          await this.deps.bookmarks.move(id, { parentId: action.folderId });
        }
      }
      if (entry.removed.length || entry.moved.length) {
        this.meta.localUndo = [entry, ...this.meta.localUndo].slice(0, 20);
        await this.saveMeta();
      }
      for (const e of this.engines.values()) await e.recordLocalChanges({ confirmed: true });
      if (refused) throw refused.reason;
    });
    // Uploads what was recorded even when one removal was refused.
    const upload = () =>
      this.run(async () => {
        for (const e of [...this.engines.values()]) await this.syncOne(e);
      });
    void done.then(upload, upload);
    return done;
  }

  localUndo(): { id: string; at: number; label: string }[] {
    return this.meta.localUndo.map(({ id, at, label }) => ({ id, at, label }));
  }

  undoLocal(id: string): Promise<void> {
    return this.run(async () => {
      const entry = this.meta.localUndo.find((u) => u.id === id);
      if (!entry) return;
      for (const m of entry.moved) if (await this.deps.bookmarks.exists(m.localId)) await this.deps.bookmarks.move(m.localId, { parentId: m.parentId, index: m.index });
      for (const r of entry.removed) if (await this.deps.bookmarks.exists(r.parentId)) await recreate(this.deps.bookmarks, r.parentId, [r.node], undefined, r.index);
      this.meta.localUndo = this.meta.localUndo.filter((u) => u.id !== id);
      await this.saveMeta();
    });
  }

  folders() {
    return this.deps.roots.folders();
  }

  async diagnostics(): Promise<unknown> {
    return {
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
    };
  }

  // Internals

  private async syncOne(e: GroupEngine): Promise<void> {
    const g = e.groupId;
    if ((this.backoffUntil.get(g) ?? 0) > this.deps.clock.now()) return;
    const before = JSON.stringify(e.status);
    try {
      await this.markBridges();
      if (e.bridged || Object.keys(e.ownLinks()).length) await this.settleBridges(e);
      const bridged = await this.recordBeforeBridge(e);
      const res = await e.cycle();
      if (res.applied || res.migratedTo) await this.recordBridged(bridged);
      this.lastSyncAt.set(g, this.deps.clock.now());
      this.lastError.delete(g);
      this.rawError.delete(g);
      this.backoffUntil.delete(g);
      this.failures.delete(g);
      if (res.migratedTo) {
        this.engines.delete(g);
        this.engines.set(res.migratedTo, e);
        this.lastSyncAt.set(res.migratedTo, this.lastSyncAt.get(g)!);
        this.lastSyncAt.delete(g);
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

  /** Folders of one sync nested inside each other pause it; folders shared with other syncs are allowed. */
  private async checkMappingOverlaps(): Promise<void> {
    const inside = await this.insideCheck();
    for (const e of this.engines.values()) {
      if (this.wholeTreeMapping(e.state.config)) continue;
      const folders = Object.values(e.state.config.mapping).filter((local) => !local.startsWith(PENDING_PREFIX));
      for (const a of folders) {
        for (const b of folders) {
          if (a !== b && inside(a, b)) await e.pause('mapping-overlap' as PauseReason, e.state.config.name);
        }
      }
    }
  }

  /** Whether two syncs hold a folder in common, the same one or one inside the other. */
  private shareFolders(a: GroupEngine, b: GroupEngine, inside: Inside): boolean {
    const live = (e: GroupEngine) => Object.values(e.state.config.mapping).filter((l) => !l.startsWith(PENDING_PREFIX));
    for (const x of live(a)) {
      for (const y of live(b)) if (x === y || inside(x, y) || inside(y, x)) return true;
    }
    return false;
  }

  /** Marks syncs that share folders with another sync here. */
  private async markBridges(): Promise<void> {
    const all = [...this.engines.values()];
    const inside = all.length > 1 ? await this.insideCheck() : () => false;
    for (const e of all) e.bridged = all.some((o) => o !== e && this.shareFolders(e, o, inside));
  }

  /**
   * Other devices' claims to bridge `a` and `b`. A claim counts only when it is in both groups from the same device name with the same time:
   * someone who can write to just one of them can't make this device release.
   */
  private claimsFor(a: GroupEngine, b: GroupEngine) {
    // Device ids differ per group, so the device name and time identify the same claim in both.
    const inB = new Set(
      b
        .otherLinks()
        .filter((l) => l.group === a.groupId)
        .map((l) => `${l.device}|${l.at}`),
    );
    return a.otherLinks().filter((l) => l.group === b.groupId && inB.has(`${l.device}|${l.at}`));
  }

  /** The latest claim another device holds for bridging `groupId` with `partner`; using the pair then needs a takeover. */
  private takenBy(groupId: string, partner: GroupEngine): { device: string; at: number } | null {
    const others = partner.otherLinks().filter((l) => l.group === groupId);
    const mine = this.engines.get(groupId);
    if (mine) others.push(...mine.otherLinks().filter((l) => l.group === partner.groupId));
    return others.sort((x, y) => y.at - x.at)[0] ?? null;
  }

  /** This device claims the pairs it bridges, and releases a pair another device claimed later (docs/design/shared-folders.md, decisions 4 and 5). */
  private async settleBridges(e: GroupEngine, takeover = false): Promise<void> {
    const inside = await this.insideCheck();
    const partners = [...this.engines.values()].filter((p) => p !== e && this.shareFolders(e, p, inside));
    // Decide on fresh claims, so a release happens before this pass carries anything across.
    for (const x of [e, ...partners]) await x.refreshMarkers().catch(() => {});
    const links = { ...e.ownLinks() };
    for (const id of Object.keys(links)) {
      const p = this.engines.get(id);
      if (!p || !this.shareFolders(e, p, inside)) delete links[id];
    }
    for (const p of partners) {
      const mine = Math.max(links[p.groupId]?.at ?? 0, p.ownLinks()[e.groupId]?.at ?? 0);
      const self = this.meta.deviceName;
      // Equal times go to the later device name, so two claims made at once still settle on one bridge.
      const newer = takeover
        ? undefined
        : this.claimsFor(e, p)
            .filter((c) => c.at > mine || (c.at === mine && c.device > self))
            .sort((x, y) => y.at - x.at)[0];
      if (newer) {
        await this.release(e, p, newer.device, inside);
        delete links[p.groupId];
        await p.setLinks(Object.fromEntries(Object.entries(p.ownLinks()).filter(([k]) => k !== e.groupId))).catch(() => {});
      } else if (!links[p.groupId] || takeover) {
        const seen = [...e.otherLinks().filter((l) => l.group === p.groupId), ...p.otherLinks().filter((l) => l.group === e.groupId)];
        const at = Math.max(this.deps.clock.now(), ...seen.map((c) => c.at + 1));
        links[p.groupId] = { name: p.state.config.name, at };
        // The partner may live on other storage; its failure is retried on a later pass, not charged to this group.
        await p.setLinks({ ...p.ownLinks(), [e.groupId]: { name: e.state.config.name, at } }).catch(() => {});
      }
    }
    await e.setLinks(links);
  }

  /**
   * Stops sharing folders between `a` and `b` here after `device` took over linking them. A folder inside the other
   * sync's folder stops syncing in its own sync, so the outer sync keeps everything; the same folder stays in the sync
   * that held it first. Two syncs of all bookmarks can't drop anything, so the later one pauses.
   */
  private async release(a: GroupEngine, b: GroupEngine, device: string, inside: Inside): Promise<void> {
    const order = this.meta.groups;
    const [first, later] = order.indexOf(a.groupId) <= order.indexOf(b.groupId) ? [a, b] : [b, a];
    const live = (e: GroupEngine) => Object.entries(e.state.config.mapping).filter(([, l]) => !l.startsWith(PENDING_PREFIX));
    const drops: [GroupEngine, string, GroupEngine][] = [];
    for (const [drop, keep] of [
      [later, first],
      [first, later],
    ] as const) {
      if (this.wholeTreeMapping(drop.state.config)) continue;
      for (const [part, local] of live(drop)) {
        for (const [, held] of live(keep)) {
          const inner = inside(local, held);
          if (inner || (local === held && drop === later)) drops.push([drop, part, keep]);
        }
      }
    }
    if (!drops.length) {
      if (later.status.state === 'paused' && later.status.reason === 'bridge-moved') return;
      later.addNotice(
        `${device} now links “${first.state.config.name}” and “${later.state.config.name}”. Both sync all bookmarks here, so “${later.state.config.name}” is paused. Stop syncing one of them here.`,
      );
      await later.pause('bridge-moved', device);
      return;
    }
    for (const [drop, part, keep] of drops) {
      if (!drop.state.config.mapping[part]) continue;
      const path = (await this.deps.roots.pathsOf([drop.state.config.mapping[part]!]))[0] ?? '';
      await drop.removePart(part, false);
      drop.addNotice(
        `${device} now links “${keep.state.config.name}” and “${drop.state.config.name}”. “${path}” stays in “${keep.state.config.name}” here and no longer syncs in “${drop.state.config.name}”.`,
      );
    }
  }

  /** Syncs that received bridged changes after their own turn in this pass; one more turn uploads them now. */
  private readonly bridgedPending = new Set<GroupEngine>();

  private async syncBridged(): Promise<void> {
    const pending = [...this.bridgedPending];
    this.bridgedPending.clear();
    for (const e of pending) if ([...this.engines.values()].includes(e)) await this.syncOne(e);
    this.bridgedPending.clear();
  }

  /** Refuses folders of `groupId` that another sync here shares while another browser links the two, unless taking over. */
  private async checkBridge(groupId: string, mapping: Record<string, string>, takeover = false): Promise<void> {
    if (takeover) return;
    for (const e of this.engines.values()) await e.refreshMarkers().catch(() => {});
    const inside = await this.insideCheck();
    const mine = Object.values(mapping)
      .map((l) => pendingAnchor(l) ?? l)
      .filter((l) => !l.startsWith(PENDING_PREFIX));
    for (const p of this.engines.values()) {
      if (p.groupId === groupId) continue;
      const held = Object.values(p.state.config.mapping).filter((l) => !l.startsWith(PENDING_PREFIX));
      if (!mine.some((m) => held.some((h) => m === h || inside(m, h) || inside(h, m)))) continue;
      const taken = this.takenBy(groupId, p);
      const own = Math.max(p.ownLinks()[groupId]?.at ?? 0, this.engines.get(groupId)?.ownLinks()[p.groupId]?.at ?? 0);
      if (taken && taken.at > own) throw new BridgeTakenError(`${taken.device} already links this sync with “${p.state.config.name}” through a shared folder.`);
    }
  }

  /** Syncs sharing a folder with `source`, after recording their pending changes unconfirmed so the big-change guard still sees them. */
  private async recordBeforeBridge(source: GroupEngine): Promise<GroupEngine[]> {
    if (!source.bridged) return [];
    const inside = await this.insideCheck();
    const ready: GroupEngine[] = [];
    for (const e of this.engines.values()) {
      if (e === source || !this.shareFolders(source, e, inside)) continue;
      try {
        await e.recordLocalChanges();
        ready.push(e);
      } catch {
        // Not recorded first, so it must not confirm afterwards; its next pass records everything unconfirmed.
      }
    }
    return ready;
  }

  /**
   * After `source` applied changes here, `targets` record them as already checked: `source` reviewed them on the way in.
   * Only what changed during `source`'s pass is confirmed; anything before it was recorded by `recordBeforeBridge`.
   */
  private async recordBridged(targets: GroupEngine[]): Promise<void> {
    for (const e of targets) {
      try {
        if (await e.recordLocalChanges({ confirmed: true })) this.bridgedPending.add(e);
      } catch {
        // Recorded unconfirmed on that sync's next pass instead.
      }
    }
  }

  /** A whole-tree or into-one-folder mapping, whose Chromium menu helper sits inside the other bookmarks folder. */
  private wholeTreeMapping(c: GroupConfig): boolean {
    return c.mode === 'everything' && EVERYTHING_ROOTS.every((r) => c.mapping[r] !== undefined);
  }

  /** Reads the bookmark tree once and answers from it whether `inner` sits below `outer`. */
  private async insideCheck(): Promise<Inside> {
    const at = await this.deps.bookmarks.positions();
    return (inner, outer) => {
      for (let cur = at.get(inner)?.parentId; cur; cur = at.get(cur)?.parentId) if (cur === outer) return true;
      return false;
    };
  }

  /** Rejects folders of one sync that sit inside each other. Other syncs may share them. */
  private async checkNesting(mapping: Record<string, string>, inside?: Inside): Promise<void> {
    const mine = Object.values(mapping).filter((l) => !l.startsWith(PENDING_PREFIX) || pendingAnchor(l));
    if (mine.length < 2) return;
    const within = inside ?? (await this.insideCheck());
    // A folder still to be made is empty and sits below its anchor, so only the anchor being inside the other folder counts.
    const nested = (a: string, b: string): boolean => {
      if (a === b) return true;
      const anchorA = pendingAnchor(a);
      const anchorB = pendingAnchor(b);
      if (anchorA && anchorB) return false;
      if (anchorA) return anchorA === b || within(anchorA, b);
      if (anchorB) return anchorB === a || within(anchorB, a);
      return within(a, b) || within(b, a);
    };
    for (const [i, a] of mine.entries()) {
      for (const b of mine.slice(i + 1)) if (nested(a, b)) throw new UserError('Two of the folders are inside each other. Pick only the outer one.');
    }
  }

  /**
   * Where a top another browser added goes here, or null when that place overlaps a folder of this or another sync.
   * Always a new, empty folder: adopting an existing one would upload its contents without anyone choosing that here.
   */
  private async placeTop(hint: PlaceHint, title: string, groupId: string): Promise<string | null> {
    const parent = { root: hint.root, path: hint.path.slice(0, -1) };
    const name = hint.path.at(-1) ?? title;
    const own = this.engines.get(groupId)?.state.config.mapping ?? {};
    const at = await this.deps.roots.resolve(parent, false);
    const inside = await this.insideCheck();
    try {
      await this.checkNesting({ ...own, new: at.startsWith(PENDING_PREFIX) ? at : pendingAt(at, [name]) }, inside);
    } catch (e) {
      if (e instanceof UserError) return null;
      throw e;
    }
    // Sharing a folder with another sync bridges the two, so only the user may choose it, never an automatic placement.
    const anchor = pendingAnchor(at) ?? at;
    for (const e of this.engines.values()) {
      if (e.groupId === groupId) continue;
      for (const held of Object.values(e.state.config.mapping)) {
        if (!held.startsWith(PENDING_PREFIX) && (anchor === held || inside(anchor, held))) return null;
      }
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
    if (input.target.kind === 'parts') await this.checkNesting((await this.resolveTarget(header.mode, input.target, false)).mapping);
    const { mapping, excluded } = await this.resolveTarget(header.mode, input.target, !preview);
    const config = this.config(input.groupId, account.id, header.name, header.mode, mapping, !!header.encryption);
    if (input.target.kind === 'parts' && input.target.followTops && header.mode === 'folder') config.followTops = true;
    const opts: JoinOptions = { mode: input.mode, ignoreDefaults: input.ignoreDefaults, excluded };
    return { ports: this.ports(account), config, opts, key, newKey };
  }

  private pullCache(accountId: string, groupId: string): PullCache {
    const id = `${accountId}/${groupId}`;
    return {
      load: () => {
        const p = this.pulled.get(id);
        return p && this.deps.clock.now() - p.at < PULL_CACHE_MS ? structuredClone(p.local) : null;
      },
      save: (local) => this.pulled.set(id, { at: this.deps.clock.now(), local }),
    };
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
  /** Become the browser linking this sync with another that shares a folder, in place of the one that does. */
  takeover?: boolean;
}
