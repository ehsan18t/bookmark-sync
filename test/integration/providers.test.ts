import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StorageProvider } from '../../src/engine/ports.js';
import { DriveProvider } from '../../src/storage/gdrive.js';
import { MemoryProvider } from '../../src/storage/memory.js';
import { ProviderAuthError, parseMultistatus, WebDavProvider } from '../../src/storage/webdav.js';
import { FakeDrive } from '../sim/fakeDrive.js';

const require = createRequire(import.meta.url);
const { v2: webdav } = require('webdav-server');

let server: Server;
let port = 0;

beforeAll(async () => {
  const users = new webdav.SimpleUserManager();
  const user = users.addUser('test', 'secret', false);
  const privileges = new webdav.SimplePathPrivilegeManager();
  privileges.setRights(user, '/', ['all']);
  const dav = new webdav.WebDAVServer({
    httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'test'),
    privilegeManager: privileges,
  });
  port = 18000 + Math.floor(Math.random() * 2000);
  server = await new Promise((resolve) => dav.start(port, resolve));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

function contract(name: string, make: () => StorageProvider) {
  describe(`${name} provider contract`, () => {
    it('reads, creates once, and reports what exists', async () => {
      const p = make();
      expect(await p.get('groups/g/devices/d/batches/1.json')).toBeNull();
      expect(await p.createOnce('groups/g/devices/d/batches/1.json', bytes('one'))).toEqual({ status: 'created' });
      expect(text(await p.get('groups/g/devices/d/batches/1.json'))).toBe('one');
      const again = await p.createOnce('groups/g/devices/d/batches/1.json', bytes('two'));
      expect(again.status).toBe('exists');
      expect(again.status === 'exists' && text(again.existing[0]!)).toBe('one');
      expect(text(await p.get('groups/g/devices/d/batches/1.json'))).toBe('one');
    });

    it('overwrites, lists groups, devices and files, and deletes', async () => {
      const p = make();
      await p.createOnce('groups/g2/group.json', bytes('h'));
      await p.overwrite('groups/g2/devices/a/device.json', bytes('v1'));
      await p.overwrite('groups/g2/devices/a/device.json', bytes('v2'));
      await p.overwrite('groups/g2/devices/b/device.json', bytes('b'));
      await p.createOnce('groups/g2/devices/b/batches/000000000001.json', bytes('b1'));
      await p.createOnce('groups/g2/devices/b/batches/000000000002.json', bytes('b2'));
      expect(text(await p.get('groups/g2/devices/a/device.json'))).toBe('v2');
      expect(await p.listGroups()).toContain('g2');
      expect((await p.listDevices('g2')).sort()).toEqual(['a', 'b']);
      expect((await p.listFiles('groups/g2/devices/b/batches')).sort()).toEqual(['groups/g2/devices/b/batches/000000000001.json', 'groups/g2/devices/b/batches/000000000002.json']);
      await p.delete('groups/g2/devices/b/batches/000000000001.json');
      await p.delete('groups/g2/devices/b/batches/000000000009.json');
      expect(await p.listFiles('groups/g2/devices/b/batches')).toEqual(['groups/g2/devices/b/batches/000000000002.json']);
      expect(await p.listFiles('groups/missing/devices/x/batches')).toEqual([]);
    });

    it('reports a server time close to now', async () => {
      const p = make();
      await p.get('groups/none/group.json');
      expect(Math.abs(p.serverDate() - Date.now())).toBeLessThan(120_000);
    });
  });
}

contract('memory', () => {
  const m = new MemoryProvider(() => Date.now());
  return m.client();
});
contract('webdav', () => new WebDavProvider({ url: `http://127.0.0.1:${port}/bsync-${Math.random().toString(36).slice(2)}/`, username: 'test', password: 'secret' }));

contract('google drive (fake API)', () => {
  const drive = new FakeDrive();
  return new DriveProvider({ token: async () => 'good', refresh: async () => 'good' }, drive.fetch);
});

describe('google drive specifics', () => {
  it('refreshes an expired token once and retries', async () => {
    const drive = new FakeDrive();
    let refreshed = 0;
    let token = 'expired';
    const p = new DriveProvider(
      {
        token: async () => token,
        refresh: async () => {
          refreshed++;
          token = 'good';
          return token;
        },
      },
      drive.fetch,
    );
    await p.overwrite('groups/g/devices/d/device.json', bytes('x'));
    await p.overwrite('groups/g/devices/d/device.json', bytes('x'));
    expect(refreshed).toBe(1);
  });

  it('reports duplicate files for one path, which is how profile copies show up on Drive', async () => {
    const { DuplicateFileError } = await import('../../src/engine/ports.js');
    const drive = new FakeDrive();
    const auth = { token: async () => 'good', refresh: async () => 'good' };
    const one = new DriveProvider(auth, drive.fetch);
    const two = new DriveProvider(auth, drive.fetch);
    const path = 'groups/g/devices/d/batches/000000000001.json';
    await Promise.all([one.createOnce(path, bytes('a')), two.createOnce(path, bytes('b'))]);
    await expect(one.get(path)).rejects.toBeInstanceOf(DuplicateFileError);
  });
});

describe('google drive batched reads', () => {
  it('reads several files with one listing per folder and reports copies that differ', async () => {
    const { DuplicateFileError } = await import('../../src/engine/ports.js');
    const drive = new FakeDrive();
    const auth = { token: async () => 'good', refresh: async () => 'good' };
    const one = new DriveProvider(auth, drive.fetch);
    const two = new DriveProvider(auth, drive.fetch);
    const dir = 'groups/g/devices/d/batches';
    await one.createOnce(`${dir}/1.json`, bytes('a'));
    await Promise.all([one.createOnce(`${dir}/2.json`, bytes('b')), two.createOnce(`${dir}/2.json`, bytes('c'))]);
    await one.createOnce('groups/g/devices/d/device.json', bytes('info'));
    let listings = 0;
    const counted = new DriveProvider(auth, async (input, init) => {
      if (String(input).includes('/drive/v3/files?')) listings++;
      return drive.fetch(input, init);
    });
    const res = await counted.getMany([`${dir}/1.json`, `${dir}/2.json`, `${dir}/3.json`, 'groups/g/devices/d/device.json']);
    expect(listings).toBe(2);
    expect(res[0]).toEqual({ status: 'fulfilled', value: bytes('a') });
    expect(res[1]!.status === 'rejected' && res[1]!.reason).toBeInstanceOf(DuplicateFileError);
    expect(res[2]).toEqual({ status: 'fulfilled', value: null });
    expect(text((res[3] as PromiseFulfilledResult<Uint8Array>).value)).toBe('info');
    expect(await counted.copiedPaths(dir)).toEqual([`${dir}/2.json`]);
  });
});

describe('google drive batched deletes', () => {
  it('deletes several files, copies included, with one listing per folder', async () => {
    const drive = new FakeDrive();
    const auth = { token: async () => 'good', refresh: async () => 'good' };
    const one = new DriveProvider(auth, drive.fetch);
    const two = new DriveProvider(auth, drive.fetch);
    const dir = 'groups/g/devices/d/batches';
    await one.createOnce(`${dir}/1.json`, bytes('a'));
    await Promise.all([one.createOnce(`${dir}/2.json`, bytes('b')), two.createOnce(`${dir}/2.json`, bytes('c'))]);
    await one.createOnce(`${dir}/3.json`, bytes('keep'));
    await one.createOnce('groups/g/devices/d/snapshots/s.json', bytes('s'));
    let listings = 0;
    const counted = new DriveProvider(auth, async (input, init) => {
      if (String(input).includes('/drive/v3/files?')) listings++;
      return drive.fetch(input, init);
    });
    await counted.deleteMany([`${dir}/1.json`, `${dir}/2.json`, 'groups/g/devices/d/snapshots/s.json']);
    expect(listings).toBe(2);
    expect([...drive.files.values()].map((f) => f.appProperties.p)).toEqual([`${dir}/3.json`]);
  });
});

describe('google drive lookups', () => {
  it('reads and overwrites files it just listed without looking them up again', async () => {
    const drive = new FakeDrive();
    const auth = { token: async () => 'good', refresh: async () => 'good' };
    await new DriveProvider(auth, drive.fetch).createOnce('groups/g/devices/d/device.json', bytes('one'));
    const calls: string[] = [];
    const p = new DriveProvider(auth, async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return drive.fetch(input, init);
    });
    expect(await p.listDevices('g')).toEqual(['d']);
    const [read] = await p.getMany(['groups/g/devices/d/device.json']);
    expect(text((read as PromiseFulfilledResult<Uint8Array>).value)).toBe('one');
    await p.overwrite('groups/g/devices/d/device.json', bytes('two'));
    expect(calls.filter((c) => c === 'GET /drive/v3/files')).toHaveLength(1);
    expect(text(await new DriveProvider(auth, drive.fetch).get('groups/g/devices/d/device.json'))).toBe('two');
  });

  it('reads a listed file that another browser removed as missing', async () => {
    const drive = new FakeDrive();
    const auth = { token: async () => 'good', refresh: async () => 'good' };
    const other = new DriveProvider(auth, drive.fetch);
    const dir = 'groups/g/devices/d/batches';
    await other.createOnce(`${dir}/1.json`, bytes('a'));
    const p = new DriveProvider(auth, drive.fetch);
    await p.listFiles(dir);
    await other.delete(`${dir}/1.json`);
    expect(await p.get(`${dir}/1.json`)).toBeNull();
    expect(await p.getMany([`${dir}/1.json`])).toEqual([{ status: 'fulfilled', value: null }]);
  });

  it('looks a listed file up again when another browser removed it', async () => {
    const drive = new FakeDrive();
    const auth = { token: async () => 'good', refresh: async () => 'good' };
    const other = new DriveProvider(auth, drive.fetch);
    await other.createOnce('groups/g/devices/d/device.json', bytes('one'));
    const p = new DriveProvider(auth, drive.fetch);
    await p.listDevices('g');
    await other.delete('groups/g/devices/d/device.json');
    await p.overwrite('groups/g/devices/d/device.json', bytes('two'));
    expect(text(await other.get('groups/g/devices/d/device.json'))).toBe('two');
  });
});

describe('google drive retries', () => {
  it('treats byte-identical copies of a file as one file and removes the extras', async () => {
    const drive = new FakeDrive();
    const p = new DriveProvider({ token: async () => 'good', refresh: async () => 'good' }, drive.fetch);
    const path = 'groups/g/devices/d/batches/000000000001.json';
    await p.createOnce(path, bytes('same'));
    const again = new DriveProvider({ token: async () => 'good', refresh: async () => 'good' }, async (input, init) => {
      if (init?.method === 'GET' && String(input).includes('/drive/v3/files?')) return new Response(JSON.stringify({ files: [] }), { status: 200 });
      return drive.fetch(input, init);
    });
    await again.createOnce(path, bytes('same'));
    expect([...drive.files.values()].filter((f) => f.appProperties.p === path)).toHaveLength(2);
    expect(text(await p.get(path))).toBe('same');
    expect([...drive.files.values()].filter((f) => f.appProperties.p === path)).toHaveLength(1);
  });
});

describe('webdav specifics', () => {
  it('rejects bad credentials with an auth error', async () => {
    const p = new WebDavProvider({ url: `http://127.0.0.1:${port}/x/`, username: 'test', password: 'wrong' });
    await expect(p.overwrite('a/b.json', bytes('x'))).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('parses multistatus responses from different servers', () => {
    const nextcloud = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/me/bsync/groups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/remote.php/dav/files/me/bsync/groups/My%20Group/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/remote.php/dav/files/me/bsync/groups/a.json</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`;
    expect(parseMultistatus(nextcloud, '/remote.php/dav/files/me/bsync/groups/')).toEqual([
      { name: 'My Group', collection: true },
      { name: 'a.json', collection: false },
    ]);
    const apache = `<D:multistatus xmlns:D="DAV:"><D:response xmlns:lp1="DAV:"><D:href>https://h/dav/x/</D:href><D:propstat><D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype></D:prop></D:propstat></D:response><D:response><D:href>https://h/dav/x/f.json</D:href><D:propstat><D:prop><lp1:resourcetype/></D:prop></D:propstat></D:response></D:multistatus>`;
    expect(parseMultistatus(apache, '/dav/x/')).toEqual([{ name: 'f.json', collection: false }]);
  });
});

describe('engine over WebDAV', () => {
  it('two browsers sync an encrypted group through a real WebDAV server', async () => {
    const { GroupEngine } = await import('../../src/engine/group.js');
    const { FakeBookmarks, FAKE_ROOTS } = await import('../sim/fakeBookmarks.js');
    const { MemoryStore } = await import('../sim/simulator.js');
    const url = `http://127.0.0.1:${port}/e2e-${Math.random().toString(36).slice(2)}/`;
    const keys = new Map<string, CryptoKey>();
    const device = (name: string) => {
      const bookmarks = new FakeBookmarks(`${name}_`);
      return {
        bookmarks,
        ports: {
          provider: new WebDavProvider({ url, username: 'test', password: 'secret' }),
          bookmarks,
          store: new MemoryStore(),
          clock: { now: () => Date.now() },
          settings: { consistentReadDelayMs: 20 },
          keyFor: async (g: string) => keys.get(g) ?? null,
        },
      };
    };
    const config = (name: string) => ({
      groupId: 'wd',
      accountId: 'a',
      deviceId: name,
      deviceName: name,
      browser: 'firefox' as const,
      mode: 'everything' as const,
      mapping: { 'root:toolbar': FAKE_ROOTS.toolbar, 'root:other': FAKE_ROOTS.other, 'root:menu': FAKE_ROOTS.menu },
      name: 'WebDAV group',
    });
    const a = device('deva');
    await a.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'over http', url: 'https://h.example/' });
    const { engine: ea, key } = await GroupEngine.create(a.ports, config('deva'), { passphrase: 'pw', iterations: 1000 });
    keys.set('wd', key!);
    const b = device('devb');
    const eb = await GroupEngine.join(b.ports, { ...config('devb'), encrypted: true }, { mode: 'merge', ignoreDefaults: false }, key);
    await b.bookmarks.create({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: 'from b', url: 'https://b.example/' });
    await eb.cycle();
    await ea.cycle();
    const titles = async (bm: InstanceType<typeof FakeBookmarks>) =>
      (await Promise.all(Object.values(FAKE_ROOTS).map((r) => bm.getSubTree(r)))).flatMap((n) => (n.children ?? []).map((c) => c.title)).sort();
    expect(await titles(a.bookmarks)).toEqual(['from b', 'over http']);
    expect(await titles(b.bookmarks)).toEqual(['from b', 'over http']);
    expect(ea.status.state).toBe('active');
  });
});

describe('profile copies on Google Drive', () => {
  it('two copies uploading the same batch number at once both rotate and no edit is lost', async () => {
    const { GroupEngine } = await import('../../src/engine/group.js');
    const { FakeBookmarks, FAKE_ROOTS } = await import('../sim/fakeBookmarks.js');
    const { MemoryStore } = await import('../sim/simulator.js');
    const drive = new FakeDrive();
    let racing = false;
    let waiting: (() => void)[] = [];
    const racyFetch: typeof fetch = async (input, init) => {
      if (racing && init?.method === 'POST' && String(input).includes('/upload/')) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) {
            for (const r of waiting) r();
            waiting = [];
          }
          setTimeout(resolve, 500);
        });
      }
      return drive.fetch(input, init);
    };
    const auth = { token: async () => 'good', refresh: async () => 'good' };
    const config = (name: string) => ({
      groupId: 'gd',
      accountId: 'a',
      deviceId: name,
      deviceName: name,
      browser: 'firefox' as const,
      mode: 'everything' as const,
      mapping: { 'root:toolbar': FAKE_ROOTS.toolbar, 'root:other': FAKE_ROOTS.other, 'root:menu': FAKE_ROOTS.menu },
      name: 'Drive group',
      encrypted: false,
    });
    const ports = (bookmarks: InstanceType<typeof FakeBookmarks>, store: InstanceType<typeof MemoryStore>) => ({
      provider: new DriveProvider(auth, racyFetch),
      bookmarks,
      store,
      clock: { now: () => Date.now() },
      settings: { consistentReadDelayMs: 10 },
    });
    const bmA = new FakeBookmarks('a_');
    const { engine: a } = await GroupEngine.create(ports(bmA, new MemoryStore()), config('deva'));
    const bmB = new FakeBookmarks('b_');
    const storeB = new MemoryStore();
    const b = await GroupEngine.join(ports(bmB, storeB), config('devb'), { mode: 'merge', ignoreDefaults: false }, null);
    await bmB.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'shared', url: 'https://s.example/' });
    await b.cycle();

    const storeCopy = new MemoryStore();
    storeCopy.data = new Map([...storeB.data].map(([k, v]) => [k, structuredClone(v)]));
    const bmCopy = bmB.clone('copy_');
    const copy = await GroupEngine.open(ports(bmCopy, storeCopy), 'gd');
    await bmB.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'original', url: 'https://o.example/' });
    await bmCopy.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'copy', url: 'https://c.example/' });
    racing = true;
    await Promise.all([b.cycle(), copy.cycle()]);
    racing = false;
    const batchPaths = [...drive.files.values()].map((f) => f.appProperties.p).filter((p) => p?.includes('/devb/batches/'));
    expect(new Set(batchPaths).size).toBeLessThan(batchPaths.length);

    for (let round = 0; round < 4; round++) for (const e of [a, b, copy]) await e.cycle();
    const titles = async (bm: InstanceType<typeof FakeBookmarks>) => ((await bm.getSubTree(FAKE_ROOTS.toolbar)).children ?? []).map((c) => c.title).sort();
    for (const bm of [bmA, bmB, bmCopy]) expect(await titles(bm)).toEqual(['copy', 'original', 'shared']);
    await bmB.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'later', url: 'https://l.example/' });
    for (let round = 0; round < 3; round++) for (const e of [b, a, copy]) await e.cycle();
    for (const bm of [bmA, bmB, bmCopy]) expect(await titles(bm)).toEqual(['copy', 'later', 'original', 'shared']);
    expect(b.deviceId).not.toBe('devb');
    expect(copy.deviceId).not.toBe('devb');
  });
});
