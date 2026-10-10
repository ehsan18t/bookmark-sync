import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

declare const chrome: any;

const require = createRequire(import.meta.url);
const { v2: webdav } = require('webdav-server');
const EXTENSION = resolve('.output-e2e/chrome-mv3');

let server: Server;
let port = 0;

interface Profile {
  context: BrowserContext;
  page: Page;
}

async function launch(): Promise<Profile> {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bsync-e2e-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  return { context, page };
}

async function command<T>(p: Profile, cmd: unknown): Promise<T> {
  const reply = (await p.page.evaluate((c) => chrome.runtime.sendMessage(c), cmd)) as { ok: boolean; value: T; error: string };
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

type Tree = { title: string; url?: string; children?: Tree[] };

async function bar(p: Profile): Promise<unknown[]> {
  const tree = (await p.page.evaluate(() => chrome.bookmarks.getSubTree('1'))) as Tree[];
  const walk = (n: Tree): unknown[] => (n.children ?? []).map((c) => (c.url ? c.title : [c.title, walk(c)]));
  return walk(tree[0]!);
}

const create = (p: Profile, details: { parentId?: string; title: string; url?: string; index?: number }) =>
  p.page.evaluate((d) => chrome.bookmarks.create(d).then((n: { id: string }) => n.id), { parentId: '1', ...details });

beforeAll(async () => {
  const users = new webdav.SimpleUserManager();
  const user = users.addUser('e2e', 'pw', false);
  const privileges = new webdav.SimplePathPrivilegeManager();
  privileges.setRights(user, '/', ['all']);
  const dav = new webdav.WebDAVServer({ httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'e2e'), privilegeManager: privileges });
  port = 20000 + Math.floor(Math.random() * 2000);
  server = await new Promise((r) => dav.start(port, r));
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('the extension in two Chromium profiles', () => {
  it('syncs bookmarks, edits, moves and order between profiles through WebDAV (checklist 1, 2, 26)', async () => {
    const a = await launch();
    const b = await launch();
    try {
      const account = { type: 'webdav', name: 'Local', url: `http://127.0.0.1:${port}/bsync/`, username: 'e2e', password: 'pw' };
      const accA = await command<string>(a, { t: 'addAccount', account });
      const accB = await command<string>(b, { t: 'addAccount', account });

      await create(a, { title: 'Alpha', url: 'https://alpha.example/' });
      const folder = await create(a, { title: 'Work' });
      await create(a, { parentId: folder, title: 'Doc', url: 'https://doc.example/' });
      const groupId = await command<string>(a, { t: 'create', input: { accountId: accA, name: 'Main', mode: 'everything', target: { kind: 'whole' }, ignoreDefaults: true } });

      await create(b, { title: 'Beta', url: 'https://beta.example/' });
      const groups = await command<{ groupId: string }[]>(b, { t: 'discover', accountId: accB });
      expect(groups.map((g) => g.groupId)).toEqual([groupId]);
      await command(b, { t: 'join', input: { accountId: accB, groupId, target: { kind: 'whole' }, mode: 'merge', ignoreDefaults: true } });
      await command(a, { t: 'syncNow' });

      expect(await bar(a)).toEqual(['Alpha', ['Work', ['Doc']], 'Beta']);
      expect(await bar(b)).toEqual(await bar(a));

      const [alpha] = (await b.page.evaluate(() => chrome.bookmarks.search({ title: 'Alpha' }))) as { id: string }[];
      await b.page.evaluate((id) => chrome.bookmarks.update(id, { title: 'Alpha renamed' }), alpha!.id);
      await b.page.evaluate((id) => chrome.bookmarks.move(id, { parentId: '1', index: 3 }), alpha!.id);
      await new Promise((r) => setTimeout(r, 500));
      await command(b, { t: 'syncNow' });
      await command(a, { t: 'syncNow' });
      expect(await bar(a)).toEqual([['Work', ['Doc']], 'Beta', 'Alpha renamed']);

      const [work] = (await a.page.evaluate(() => chrome.bookmarks.search({ title: 'Work' }))) as { id: string }[];
      await a.page.evaluate((id) => chrome.bookmarks.removeTree(id), work!.id);
      await command(a, { t: 'syncNow' });
      await command(b, { t: 'syncNow' });
      expect(await bar(b)).toEqual(['Beta', 'Alpha renamed']);

      const status = await command<{ status: { state: string } }[]>(b, { t: 'status' });
      expect(status[0]!.status.state).toBe('active');
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  it('restores a deleted folder from history in an encrypted group (checklist 13, 19)', async () => {
    const a = await launch();
    const b = await launch();
    try {
      const account = { type: 'webdav', name: 'Local', url: `http://127.0.0.1:${port}/bsync-enc/`, username: 'e2e', password: 'pw' };
      const accA = await command<string>(a, { t: 'addAccount', account });
      const accB = await command<string>(b, { t: 'addAccount', account });
      const folder = await create(a, { title: 'Recipes' });
      await create(a, { parentId: folder, title: 'Pasta', url: 'https://pasta.example/' });
      const groupId = await command<string>(a, { t: 'create', input: { accountId: accA, name: 'Secret', mode: 'everything', target: { kind: 'whole' }, passphrase: 'long passphrase', ignoreDefaults: true } });
      await command(b, { t: 'join', input: { accountId: accB, groupId, target: { kind: 'whole' }, mode: 'merge', ignoreDefaults: true, passphrase: 'long passphrase' } });
      expect(await bar(b)).toEqual([['Recipes', ['Pasta']]]);

      await b.page.evaluate((id) => chrome.bookmarks.removeTree(id), (await b.page.evaluate(() => chrome.bookmarks.search({ title: 'Recipes' })))[0].id);
      await command(b, { t: 'syncNow' });
      await command(a, { t: 'syncNow' });
      expect(await bar(a)).toEqual([]);

      const timeline = await command<{ to: string }[]>(a, { t: 'timeline', groupId });
      await command(a, { t: 'restore', groupId, hlc: timeline[1]!.to });
      await command(b, { t: 'syncNow' });
      expect(await bar(a)).toEqual([['Recipes', ['Pasta']]]);
      expect(await bar(b)).toEqual([['Recipes', ['Pasta']]]);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});
