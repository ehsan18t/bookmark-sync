import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StorageProvider } from '../../src/engine/ports.js';
import { MemoryProvider } from '../../src/storage/memory.js';
import { parseMultistatus, ProviderAuthError, WebDavProvider } from '../../src/storage/webdav.js';

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
      await p.createOnce('groups/g2/devices/b/batches/000000000001.json', bytes('b1'));
      await p.createOnce('groups/g2/devices/b/batches/000000000002.json', bytes('b2'));
      expect(text(await p.get('groups/g2/devices/a/device.json'))).toBe('v2');
      expect(await p.listGroups()).toContain('g2');
      expect((await p.listDevices('g2')).sort()).toEqual(['a', 'b']);
      expect((await p.listFiles('groups/g2/devices/b/batches')).sort()).toEqual([
        'groups/g2/devices/b/batches/000000000001.json',
        'groups/g2/devices/b/batches/000000000002.json',
      ]);
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
