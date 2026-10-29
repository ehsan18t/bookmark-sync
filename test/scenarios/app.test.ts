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
    expect(found).toEqual([{ groupId, name: 'Main', mode: 'everything', encrypted: false, joined: false, browsers: ['chrome'] }]);
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

  it('hides a group deleted from another browser and frees its name', async () => {
    const { a, b, accA, accB } = await pair();
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Main', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    await a.app.deleteEverywhere(groupId);
    expect(await b.app.discoverGroups(accB)).toEqual([]);
    await expect(b.app.createGroup({ accountId: accB, name: 'Main', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false })).resolves.toBeTruthy();
  });

  it('refuses a name already used on the storage, ignoring case and spaces', async () => {
    const { a, b, accA, accB } = await pair();
    await a.app.createGroup({ accountId: accA, name: 'Bookmarks New', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    for (const name of ['bookmarks new', '  BOOKMARKS   NEW ', 'BookmarksNew'])
      await expect(b.app.createGroup({ accountId: accB, name, mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false })).rejects.toThrow(/already on this storage/);
  });

  it('renames a group for every browser and for discovery, refusing a taken name', async () => {
    const { provider, a, b, accA, accB } = await pair();
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Main', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    const c = browser('edge', provider);
    await c.app.init();
    const accC = await c.app.addAccount({ type: 'webdav', name: 'Server', url: 'mem://', username: 'u', password: 'p' });
    await c.app.createGroup({ accountId: accC, name: 'Work', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    await b.app.joinGroup({ accountId: accB, groupId, target: { kind: 'whole' }, mode: 'merge', ignoreDefaults: false });
    await expect(a.app.renameGroup(groupId, ' work ')).rejects.toThrow(/already on this storage/);
    await a.app.renameGroup(groupId, 'Home');
    expect((await a.app.status()).find((g) => g.groupId === groupId)?.name).toBe('Home');
    expect((await b.app.discoverGroups(accB)).find((g) => g.groupId === groupId)?.name).toBe('Home');
    await b.app.syncAll();
    expect((await b.app.status())[0]?.name).toBe('Home');
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

  it('lets syncs share folders, including folders inside each other', async () => {
    const { a, accA } = await pair();
    const work = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Work', url: '' });
    const inner = await a.bookmarks.create({ parentId: work, kind: 'folder', title: 'Inner', url: '' });
    await a.app.createGroup({ accountId: accA, name: 'Work', mode: 'folder', target: { kind: 'folders', folderIds: [work] }, ignoreDefaults: false });
    await a.app.createGroup({ accountId: accA, name: 'Inner', mode: 'folder', target: { kind: 'folders', folderIds: [inner] }, ignoreDefaults: false });
    await a.app.createGroup({ accountId: accA, name: 'All', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: false });
    await a.app.syncAll();
    expect((await a.app.status()).map((s) => [s.name, s.status.state])).toEqual([
      ['Work', 'active'],
      ['Inner', 'active'],
      ['All', 'active'],
    ]);
  });

  /** a holds the inner sync, b links it with the outer one, c holds the outer one; `order` is which b joins first. */
  async function nested(order: 'inner first' | 'outer first') {
    const { provider, a, b, accA, accB } = await pair();
    const c = browser('edge', provider);
    await c.app.init();
    const accC = await c.app.addAccount({ type: 'webdav', name: 'Server', url: 'mem://', username: 'u', password: 'p' });
    const games = await b.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Games', url: '' });
    await b.bookmarks.create({ parentId: games, kind: 'bookmark', title: 'Y', url: 'https://y.example/' });
    await b.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: 'Z', url: 'https://z.example/' });
    const make = (which: 'inner' | 'outer') =>
      which === 'inner'
        ? b.app.createGroup({ accountId: accB, name: 'Games', mode: 'folder', target: { kind: 'folders', folderIds: [games] }, ignoreDefaults: false })
        : b.app.createGroup({ accountId: accB, name: 'Other', mode: 'folder', target: { kind: 'folders', folderIds: [FAKE_ROOTS.other] }, ignoreDefaults: false });
    const first = await make(order === 'inner first' ? 'inner' : 'outer');
    const second = await make(order === 'inner first' ? 'outer' : 'inner');
    const [inner, outer] = order === 'inner first' ? [first, second] : [second, first];
    const boxA = await a.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'Box', url: '' });
    const boxC = await c.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'Box', url: '' });
    const join = async (x: typeof a, acc: string, groupId: string, box: string) => {
      const [top] = (await x.app.groupFolders({ accountId: acc, groupId })).folders;
      await x.app.joinGroup({ accountId: acc, groupId, mode: 'merge', ignoreDefaults: false, target: { kind: 'parts', parts: [{ part: top!.id, folderId: box }] } });
    };
    await join(a, accA, inner, boxA);
    await join(c, accC, outer, boxC);
    const settle = async () => {
      for (let i = 0; i < 3; i++) for (const x of [a, b, c]) await x.app.syncAll();
    };
    await settle();
    return { a, b, c, games, boxA, boxC, settle };
  }

  for (const order of ['inner first', 'outer first'] as const) {
    it(`keeps bookmarks moved across a nested shared folder (${order})`, async () => {
      const { a, b, c, games, boxA, boxC, settle } = await nested(order);
      const gamesC = (await c.bookmarks.getSubTree(boxC)).children!.find((n) => n.title === 'Games')!.localId;
      expect(await titles(a.bookmarks, boxA)).toEqual(['Y']);
      expect((await titles(c.bookmarks, boxC)).sort()).toEqual(['Games', 'Z']);

      const yC = (await c.bookmarks.getSubTree(gamesC)).children![0]!.localId;
      await c.bookmarks.move(yC, { parentId: boxC });
      await settle();
      expect((await titles(b.bookmarks, FAKE_ROOTS.other)).sort()).toEqual(['Games', 'Y', 'Z']);
      expect(await titles(a.bookmarks, boxA)).toEqual([]);

      const zC = (await c.bookmarks.getSubTree(boxC)).children!.find((n) => n.title === 'Z')!.localId;
      await c.bookmarks.move(zC, { parentId: gamesC });
      await settle();
      expect(await titles(b.bookmarks, games)).toEqual(['Z']);
      expect(await titles(a.bookmarks, boxA)).toEqual(['Z']);
      expect((await titles(c.bookmarks, boxC)).sort()).toEqual(['Games', 'Y']);
      expect(await titles(c.bookmarks, gamesC)).toEqual(['Z']);
    });
  }

  it('refuses a second link between two syncs unless it takes over, and the old link lets go', async () => {
    const { a, b, c } = await nested('outer first');
    const [outer, inner] = (await b.app.status()).map((s) => s.groupId);
    const status = async (x: typeof a, id: string) => (await x.app.status()).find((s) => s.groupId === id)!;
    expect((await status(b, outer!)).links).toEqual([{ name: 'Games', via: null }]);
    expect((await status(c, outer!)).links).toEqual([{ name: 'Games', via: 'firefox' }]);

    const accC = (await c.app.accounts())[0]!.id;
    const gamesC = (await c.bookmarks.getSubTree((await c.bookmarks.getSubTree(FAKE_ROOTS.toolbar)).children![0]!.localId)).children!.find((n) => n.title === 'Games')!.localId;
    const [top] = (await c.app.groupFolders({ accountId: accC, groupId: inner! })).folders;
    const input = { accountId: accC, groupId: inner!, mode: 'merge' as const, ignoreDefaults: false, target: { kind: 'parts' as const, parts: [{ part: top!.id, folderId: gamesC }] } };
    await expect(c.app.joinGroup(input)).rejects.toThrow(/firefox already links this sync with “Other”/);
    await c.app.joinGroup({ ...input, takeover: true });
    for (let i = 0; i < 2; i++) for (const x of [c, b, a]) await x.app.syncAll();

    const innerB = await status(b, inner!);
    expect(innerB.parts).toEqual([]);
    expect(innerB.notices.map((n) => n.text)).toEqual([expect.stringContaining('edge now links “Other” and “Games”')]);
    expect((await status(b, outer!)).links).toEqual([{ name: 'Games', via: 'edge' }]);
    expect((await status(c, outer!)).links).toEqual([{ name: 'Games', via: null }]);
  });

  it('carries changes between two syncs through a folder they share', async () => {
    const { provider, a, b, accA, accB } = await pair();
    const c = browser('edge', provider);
    await c.app.init();
    const accC = await c.app.addAccount({ type: 'webdav', name: 'Server', url: 'mem://', username: 'u', password: 'p' });
    const shared = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Shared', url: '' });
    const work = await a.app.createGroup({ accountId: accA, name: 'Work', mode: 'folder', target: { kind: 'folders', folderIds: [shared] }, ignoreDefaults: false });
    const home = await b.app.createGroup({ accountId: accB, name: 'Home', mode: 'folder', target: { kind: 'folders', folderIds: [FAKE_ROOTS.other] }, ignoreDefaults: false });
    const [top] = (await b.app.groupFolders({ accountId: accB, groupId: work })).folders;
    await b.app.joinGroup({ accountId: accB, groupId: work, mode: 'merge', ignoreDefaults: false, target: { kind: 'parts', parts: [{ part: top!.id, hint: top!.hint! }] } });
    const box = await c.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'Home', url: '' });
    const [homeTop] = (await c.app.groupFolders({ accountId: accC, groupId: home })).folders;
    await c.app.joinGroup({ accountId: accC, groupId: home, mode: 'merge', ignoreDefaults: false, target: { kind: 'parts', parts: [{ part: homeTop!.id, folderId: box }] } });

    for (let i = 0; i < 12; i++) await a.bookmarks.create({ parentId: shared, kind: 'bookmark', title: `b${i}`, url: `https://b${i}.example/` });
    await a.app.syncAll();
    await b.app.syncAll();
    await b.app.syncAll();
    await c.app.syncAll();
    expect((await b.app.status()).map((s) => s.status.state)).toEqual(['active', 'active']);
    const sharedC = (await c.bookmarks.getSubTree(box)).children!.find((f) => f.title === 'Shared')!;
    expect((sharedC.children ?? []).map((n) => n.title)).toHaveLength(12);

    for (const n of (await a.bookmarks.getSubTree(shared)).children ?? []) await a.bookmarks.removeTree(n.localId);
    await a.app.syncAll();
    await a.app.resolvePause(work, 'apply');
    await b.app.syncAll();
    await b.app.syncAll();
    expect((await b.app.status()).map((s) => s.status.state)).toEqual(['active', 'active']);
    await c.app.syncAll();
    expect((await c.app.status())[0]!.status.state).toBe('active');
    expect(await titles(c.bookmarks, sharedC.localId)).toEqual([]);
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

  it('still asks about a big change of its own while a shared folder brings changes in', async () => {
    const { a, b, accA, accB } = await pair();
    const shared = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Shared', url: '' });
    const work = await a.app.createGroup({ accountId: accA, name: 'Work', mode: 'folder', target: { kind: 'folders', folderIds: [shared] }, ignoreDefaults: false });
    const own = await b.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Own', url: '' });
    for (let i = 0; i < 12; i++) await b.bookmarks.create({ parentId: own, kind: 'bookmark', title: `o${i}`, url: `https://o${i}.example/` });
    const home = await b.app.createGroup({ accountId: accB, name: 'Home', mode: 'folder', target: { kind: 'folders', folderIds: [FAKE_ROOTS.other] }, ignoreDefaults: false });
    const [top] = (await b.app.groupFolders({ accountId: accB, groupId: work })).folders;
    await b.app.joinGroup({ accountId: accB, groupId: work, mode: 'merge', ignoreDefaults: false, target: { kind: 'parts', parts: [{ part: top!.id, hint: top!.hint! }] } });
    await b.app.syncAll();

    for (const n of (await b.bookmarks.getSubTree(own)).children ?? []) await b.bookmarks.removeTree(n.localId);
    await a.bookmarks.create({ parentId: shared, kind: 'bookmark', title: 'new', url: 'https://new.example/' });
    await a.app.syncAll();
    await b.app.syncGroup(work);
    await b.app.syncGroup(home);
    expect((await b.app.status()).find((s) => s.groupId === home)!.status).toMatchObject({ state: 'paused', reason: 'large-local-change' });
  });

  it('places a joined folder inside a folder of another sync, but never a followed one', async () => {
    const { a, b, accA, accB } = await pair();
    const java = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Java', url: '' });
    const groupId = await a.app.createGroup({ accountId: accA, name: 'Picked', mode: 'folder', target: { kind: 'folders', folderIds: [java] }, ignoreDefaults: false });
    await b.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: 'private', url: 'https://private.example/' });
    await b.app.createGroup({ accountId: accB, name: 'Mine', mode: 'folder', target: { kind: 'folders', folderIds: [FAKE_ROOTS.other] }, ignoreDefaults: false });

    const [top] = (await b.app.groupFolders({ accountId: accB, groupId })).folders;
    await b.app.joinGroup({ accountId: accB, groupId, mode: 'merge', ignoreDefaults: false, target: { kind: 'parts', parts: [{ part: top!.id, hint: top!.hint! }], followTops: true } });
    const recipes = await a.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Recipes', url: '' });
    await a.app.addTops(groupId, [recipes]);
    await b.app.syncAll();
    const picked = (await b.app.status()).find((s) => s.name === 'Picked')!;
    expect(picked.parts.map((p) => p.path)).toEqual(['unfiled_____ / Java']);
    expect(picked.notices.map((n) => n.text)).toEqual([expect.stringContaining('already synced by another folder')]);
    expect((await titles(b.bookmarks, FAKE_ROOTS.other)).sort()).toEqual(['Java', 'private']);
    await a.app.syncAll();
    expect(await titles(a.bookmarks, FAKE_ROOTS.other)).toEqual(['Java', 'Recipes']);
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
