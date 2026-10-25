import { describe, expect, it } from 'vitest';
import { WrongPassphraseError } from '../../src/core/crypto.js';
import { SyncApp, type AppMeta, type AppStore } from '../../src/engine/app.js';
import type { StorageProvider } from '../../src/engine/ports.js';
import { MemoryProvider } from '../../src/storage/memory.js';
import { ProviderAuthError } from '../../src/storage/webdav.js';
import { FAKE_ROOTS, FakeBookmarks, fakeRoots } from '../sim/fakeBookmarks.js';
import { MemoryStore } from '../sim/simulator.js';

class MemoryAppStore extends MemoryStore implements AppStore {
  meta: AppMeta | null = null;
  keys = new Map<string, CryptoKey>();
  async loadMeta() {
    return this.meta && structuredClone(this.meta);
  }
  async saveMeta(m: AppMeta) {
    this.meta = structuredClone(m);
  }
  async getKey(g: string) {
    return this.keys.get(g) ?? null;
  }
  async setKey(g: string, k: CryptoKey) {
    this.keys.set(g, k);
  }
  async deleteKey(g: string) {
    this.keys.delete(g);
  }
}

let now = 1_800_000_000_000;
const clock = { now: () => now };

function browser(name: string, provider: MemoryProvider, fail?: { auth: boolean }) {
  const bookmarks = new FakeBookmarks(`${name}_`);
  const store = new MemoryAppStore();
  const app = new SyncApp({
    store,
    bookmarks,
    roots: fakeRoots(bookmarks),
    providerFor: () => {
      const p = provider.client();
      if (!fail) return p;
      return new Proxy(p, {
        get: (t, k: keyof StorageProvider) =>
          k === 'serverDate' ? t.serverDate : async (...args: unknown[]) => {
            if (fail.auth) throw new ProviderAuthError('401');
            return (t[k] as (...a: unknown[]) => unknown)(...args);
          },
      }) as StorageProvider;
    },
    clock,
    browser: 'firefox',
    defaultDeviceName: name,
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { app, bookmarks, store };
}

const titles = async (bm: FakeBookmarks, folder: string = FAKE_ROOTS.toolbar) => ((await bm.getSubTree(folder)).children ?? []).map((c) => c.title);

async function pair() {
  const provider = new MemoryProvider(() => now);
  const a = browser('chrome', provider);
  const b = browser('firefox', provider);
  await a.app.init();
  await b.app.init();
  const accA = await a.app.addAccount({ type: 'webdav', name: 'Server', url: 'mem://', username: 'u', password: 'p' });
  const accB = await b.app.addAccount({ type: 'webdav', name: 'Server', url: 'mem://', username: 'u', password: 'p' });
  return { provider, a, b, accA, accB };
}

describe('the app layer', () => {
  it('creates a group, lets another browser discover, preview and join it, and syncs', async () => {
    const { a, b, accA, accB } = await pair();
    await a.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'From Chrome', url: 'https://c.example/' });
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Main', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    const found = await b.app.discoverGroups(accB);
    expect(found).toEqual([{ groupId, name: 'Main', mode: 'everything', encrypted: false, joined: false }]);
    await b.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'From Firefox', url: 'https://f.example/' });
    const input = { accountId: accB, groupId, target: { kind: 'whole' as const }, mode: 'merge' as const, ignoreDefaults: true };
    expect(await b.app.previewJoin(input)).toMatchObject({ added: 1, matched: 0, groupItems: 1 });
    await b.app.joinGroup(input);
    await a.app.syncAll();
    expect(await titles(a.bookmarks)).toEqual(['From Chrome', 'From Firefox']);
    expect(await titles(b.bookmarks)).toEqual(['From Chrome', 'From Firefox']);
    const [status] = await a.app.status();
    expect(status).toMatchObject({ name: 'Main', status: { state: 'active' }, pendingChanges: 0 });
  });

  it('previewing a join into a folder creates nothing', async () => {
    const { a, b, accA, accB } = await pair();
    await a.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'x', url: 'https://x.example/' });
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Main', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    const box = await b.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Synced', url: '' });
    const input = { accountId: accB, groupId, target: { kind: 'everything-into' as const, folderId: box }, mode: 'merge' as const, ignoreDefaults: false };
    expect(await b.app.previewJoin(input)).toMatchObject({ added: 0, groupItems: 1 });
    expect(await titles(b.bookmarks, box)).toEqual([]);
    await b.app.joinGroup(input);
    expect(await titles(b.bookmarks, box)).toEqual(['Toolbar', 'Other', 'Menu']);
  });

  it('refuses mappings that overlap another group', async () => {
    const { a, accA } = await pair();
    const work = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Work', url: '' });
    const inner = await a.bookmarks.create({ parentId: work, kind: 'folder', title: 'Inner', url: '' });
    await a.app.createGroup({ accountId: accA, name: 'Work', mode: 'folder', target: { kind: 'folders', folderIds: [work] }, ignoreDefaults: false });
    await expect(a.app.createGroup({ accountId: accA, name: 'Inner', mode: 'folder', target: { kind: 'folders', folderIds: [inner] }, ignoreDefaults: false })).rejects.toThrow(/overlaps/);
    await expect(a.app.createGroup({ accountId: accA, name: 'All', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false })).rejects.toThrow(/overlaps/);
    const home = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Home', url: '' });
    await a.app.createGroup({ accountId: accA, name: 'Home', mode: 'folder', target: { kind: 'folders', folderIds: [home] }, ignoreDefaults: false });
    expect((await a.app.status()).map((s) => s.location).sort()).toEqual(['unfiled_____ / Home', 'unfiled_____ / Work']);
  });

  it('starts a group from several folders; another browser joins one by path, adds another, and re-points a lost one', async () => {
    const { a, b, accA, accB } = await pair();
    const games = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Games', url: '' });
    const inner = await a.bookmarks.create({ parentId: games, kind: 'folder', title: 'Inner', url: '' });
    const java = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Java', url: '' });
    await a.bookmarks.create({ parentId: java, kind: 'bookmark', title: 'jdk', url: 'https://jdk.example/' });
    const nested = { accountId: accA, name: 'Picked', mode: 'folder' as const, target: { kind: 'folders' as const, folderIds: [games, inner] }, ignoreDefaults: false };
    await expect(a.app.createGroup(nested)).rejects.toThrow(/inside each other/);
    const groupId = await a.app.createGroup({ ...nested, target: { kind: 'folders', folderIds: [games, java] } });

    const { mode, folders } = await b.app.groupFolders({ accountId: accB, groupId });
    expect(mode).toBe('folder');
    const tops = folders.filter((f) => f.parent === 'root:group');
    expect(tops.map((t) => [t.title, t.hint])).toEqual([
      ['Games', { root: 'other', path: ['Games'] }],
      ['Java', { root: 'other', path: ['Java'] }],
    ]);
    const [gamesTop, javaTop] = tops as [(typeof tops)[0], (typeof tops)[0]];
    await b.app.joinGroup({ accountId: accB, groupId, target: { kind: 'parts', parts: [{ part: javaTop.id, hint: javaTop.hint! }] }, mode: 'merge', ignoreDefaults: false });
    expect(await titles(b.bookmarks, FAKE_ROOTS.other)).toEqual(['Java']);
    expect((await b.app.status())[0]).toMatchObject({ location: 'unfiled_____ / Java', parts: [{ part: javaTop.id, top: true }] });

    await b.app.addParts(groupId, [{ part: gamesTop.id, hint: gamesTop.hint! }]);
    expect(await titles(b.bookmarks, FAKE_ROOTS.other)).toEqual(['Java', 'Games']);

    const javaB = (await b.bookmarks.getSubTree(FAKE_ROOTS.other)).children![0]!.localId;
    await b.bookmarks.removeTree(javaB);
    await b.app.syncAll();
    expect((await b.app.status())[0]!.status).toMatchObject({ state: 'paused', reason: 'mapped-folder-missing', detail: javaTop.id });
    const again = await b.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'Java again', url: '' });
    await b.app.movePart(groupId, javaTop.id, again);
    expect((await b.app.status())[0]!.status.state).toBe('active');
    expect(await titles(b.bookmarks, again)).toEqual(['jdk']);
    await a.app.syncAll();
    expect(await titles(a.bookmarks, java)).toEqual(['jdk']);
  });

  it('never places a folder inside a folder another sync holds, including folders still to be made', async () => {
    const { a, b, accA, accB } = await pair();
    const java = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Java', url: '' });
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Picked', mode: 'folder', target: { kind: 'folders', folderIds: [java] }, ignoreDefaults: false });
    await b.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: 'private', url: 'https://private.example/' });
    await b.app.createGroup({ accountId: accB, name: 'Mine', mode: 'folder', target: { kind: 'folders', folderIds: [FAKE_ROOTS.other] }, ignoreDefaults: false });

    const [top] = (await b.app.groupFolders({ accountId: accB, groupId })).folders;
    const join = { accountId: accB, groupId, mode: 'merge' as const, ignoreDefaults: false };
    await expect(b.app.joinGroup({ ...join, target: { kind: 'parts', parts: [{ part: top!.id, hint: top!.hint! }], followTops: true } })).rejects.toThrow(/overlaps with the sync “Mine”/);
    const javaB = await b.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'Java', url: '' });
    await b.app.joinGroup({ ...join, target: { kind: 'parts', parts: [{ part: top!.id, folderId: javaB }], followTops: true } });

    const recipes = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Recipes', url: '' });
    await a.app.addTops(groupId, [recipes]);
    await b.app.syncAll();
    const picked = (await b.app.status()).find((s) => s.name === 'Picked')!;
    expect(picked.parts.map((p) => p.path)).toEqual(['toolbar_____ / Java']);
    expect(picked.notices.map((n) => n.text)).toEqual([expect.stringContaining('already synced by another folder')]);
    expect(await titles(b.bookmarks, FAKE_ROOTS.other)).toEqual(['private']);
    await a.app.syncAll();
    expect(await titles(a.bookmarks, FAKE_ROOTS.other)).toEqual(['Java', 'Recipes']);
    expect(await titles(a.bookmarks, recipes)).toEqual([]);
  });

  it('joins an encrypted group only with the right passphrase, and unlocks after a restart', async () => {
    const { a, b, accA, accB } = await pair();
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Secret', mode: 'everything', target: { kind: 'whole' }, passphrase: 'pw', iterations: 1000, ignoreDefaults: false });
    const input = { accountId: accB, groupId, target: { kind: 'whole' as const }, mode: 'merge' as const, ignoreDefaults: false };
    await expect(b.app.joinGroup(input)).rejects.toThrow(/passphrase/);
    await expect(b.app.joinGroup({ ...input, passphrase: 'nope' })).rejects.toBeInstanceOf(WrongPassphraseError);
    await b.app.joinGroup({ ...input, passphrase: 'pw' });
    b.store.keys.clear();
    const restarted = new SyncApp({ ...(b.app as unknown as { deps: ConstructorParameters<typeof SyncApp>[0] }).deps });
    await restarted.init();
    await a.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'hidden', url: 'https://h.example/' });
    await a.app.syncAll();
    await restarted.syncAll();
    expect((await restarted.status())[0]!.status).toMatchObject({ state: 'paused', reason: 'locked' });
    await restarted.unlock(groupId, 'pw', false);
    expect(await titles(b.bookmarks)).toEqual(['hidden']);
  });

  it('cleans up duplicates: synced removals sync, unsynced ones can be undone locally', async () => {
    const { a, b, accA, accB } = await pair();
    const work = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Work', url: '' });
    await a.bookmarks.create({ parentId: work, kind: 'bookmark', title: 'Doc', url: 'https://doc.example/' });
    await a.bookmarks.create({ parentId: work, kind: 'bookmark', title: 'Doc again', url: 'https://doc.example' });
    const loose = await a.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'Doc loose', url: 'https://doc.example/#top' });
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Work', mode: 'folder', target: { kind: 'folders', folderIds: [work] }, ignoreDefaults: false });
    const workB = await b.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'Work', url: '' });
    const [top] = (await b.app.groupFolders({ accountId: accB, groupId })).folders;
    await b.app.joinGroup({ accountId: accB, groupId, target: { kind: 'parts', parts: [{ part: top!.id, folderId: workB }], followTops: true }, mode: 'merge', ignoreDefaults: false });

    const groups = await a.app.scanDuplicates();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.group).sort()).toEqual(['Work', 'Work', null].sort());
    const again = groups[0]!.items.find((i) => i.title === 'Doc again')!;
    await a.app.applyDedupe({ remove: [again.localId, loose] });
    await b.app.syncAll();
    expect(await titles(b.bookmarks, workB)).toEqual(['Doc']);
    expect(await titles(a.bookmarks)).toEqual([]);
    const [undo] = a.app.localUndo();
    await a.app.undoLocal(undo!.id);
    expect(await titles(a.bookmarks)).toEqual(['Doc loose']);
  });

  it('switches a group to encrypted and both browsers follow', async () => {
    const { a, b, accA, accB } = await pair();
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Main', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    await b.app.joinGroup({ accountId: accB, groupId, target: { kind: 'whole' }, mode: 'merge', ignoreDefaults: false });
    await a.app.setEncryption(groupId, 'pw', 1000);
    for (let i = 0; i < 3; i++) {
      await b.app.syncAll();
      await a.app.syncAll();
    }
    const [sa] = await a.app.status();
    expect(sa!.encrypted).toBe(true);
    expect(sa!.groupId).not.toBe(groupId);
    const [sb] = await b.app.status();
    expect(sb!.status).toMatchObject({ state: 'paused', reason: 'locked' });
    await b.app.unlock(groupId, 'pw', false);
    await b.app.syncAll();
    expect((await b.app.status())[0]!.groupId).toBe(sa!.groupId);
  });

  it('pauses a group when the storage rejects the credentials', async () => {
    const provider = new MemoryProvider(() => now);
    const fail = { auth: false };
    const a = browser('chrome', provider, fail);
    await a.app.init();
    const acc = await a.app.addAccount({ type: 'webdav', name: 'S', url: 'mem://', username: 'u', password: 'p' });
    await a.app.createGroup({ accountId: acc, name: 'Main', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    fail.auth = true;
    await a.app.syncAll();
    expect((await a.app.status())[0]!.status).toMatchObject({ state: 'paused', reason: 'auth' });
  });
});
