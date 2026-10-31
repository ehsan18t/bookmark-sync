// Captures real extension screens for the promo video: two Chromium profiles syncing through a local WebDAV server.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { v2: webdav } = require('webdav-server');
const EXTENSION = resolve('.output-e2e/chrome-mv3');
const OUT = resolve('promo/shots');
mkdirSync(OUT, { recursive: true });

const users = new webdav.SimpleUserManager();
const user = users.addUser('me', 'pw', false);
const privileges = new webdav.SimplePathPrivilegeManager();
privileges.setRights(user, '/', ['all']);
const dav = new webdav.WebDAVServer({ httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'promo'), privilegeManager: privileges });
const port = 8080;
const server = await new Promise((r) => dav.start(port, r));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bsync-promo-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 720 },
    deviceScaleFactor: 3,
    colorScheme: 'light',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`chrome-extension://${id}/options.html`);
  return { context, page, id };
}

const command = async (p, cmd) => {
  const reply = await p.page.evaluate((c) => chrome.runtime.sendMessage(c), cmd);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
};
const create = (p, d) => p.page.evaluate((x) => chrome.bookmarks.create(x).then((n) => n.id), { parentId: '1', ...d });
// Boxes are in CSS pixels of the page, so the video can point the cursor at them.
const boxes = {};
const shot = async (p, name, { targets = {}, fullPage = false } = {}) => {
  await wait(700);
  await p.page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  for (const [key, locator] of Object.entries(targets)) boxes[`${name}/${key}`] = await locator.first().boundingBox();
  console.log('shot', name);
};

async function seed(p, tree, parentId = '1') {
  for (const n of tree) {
    if (n.children) await seed(p, n.children, await create(p, { parentId, title: n.title }));
    else await create(p, { parentId, title: n.title, url: n.url });
  }
}

const a = await launch();
const b = await launch();
try {
  await seed(a, [
    { title: 'Work', children: [
      { title: 'Team handbook', url: 'https://handbook.example.com/' },
      { title: 'Sprint board', url: 'https://board.example.com/sprint' },
      { title: 'Design system', url: 'https://design.example.com/' },
    ] },
    { title: 'Reading list', children: [
      { title: 'How CRDTs work', url: 'https://blog.example.com/crdts' },
      { title: 'Hybrid logical clocks', url: 'https://papers.example.com/hlc' },
    ] },
    { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
    { title: 'GitHub', url: 'https://github.com/' },
  ]);
  await seed(a, [{ title: 'Recipes', children: [{ title: 'Pasta al limone', url: 'https://food.example.com/pasta' }] }], '2');

  await a.page.goto(`chrome-extension://${a.id}/options.html#setup`);
  await shot(a, 'setup-1-storage', { targets: { server: a.page.locator('.choice').nth(1) } });
  await a.page.getByText('Your own server').click();
  await a.page.getByLabel('Server address').fill('http://127.0.0.1:8080/');
  await a.page.getByLabel('Username').fill('me');
  await a.page.getByLabel('Password', { exact: true }).fill('pw');
  await shot(a, 'setup-2-connect');
  await a.page.getByRole('button', { name: 'Connect' }).click();
  await a.page.getByLabel('Name the new sync').waitFor();
  await shot(a, 'setup-3-name');
  await a.page.getByRole('button', { name: 'Continue' }).click();
  await shot(a, 'setup-4-what', { targets: { folders: a.page.locator('.choice').nth(1), start: a.page.getByRole('button', { name: 'Start syncing' }) } });
  await a.page.getByRole('button', { name: 'Start syncing' }).click();
  await a.page.getByText('Your bookmarks are syncing').waitFor();
  await shot(a, 'setup-5-done');

  await seed(b, [
    { title: 'Travel', children: [
      { title: 'Lisbon guide', url: 'https://travel.example.com/lisbon' },
      { title: 'Train times', url: 'https://rail.example.com/' },
    ] },
    { title: 'GitHub', url: 'https://github.com/' },
    { title: 'Weather', url: 'https://weather.example.com/' },
  ]);
  await b.page.goto(`chrome-extension://${b.id}/options.html#setup`);
  await b.page.getByText('Your own server').click();
  await b.page.getByLabel('Server address').fill('http://127.0.0.1:8080/');
  await b.page.getByLabel('Username').fill('me');
  await b.page.getByLabel('Password', { exact: true }).fill('pw');
  await b.page.getByRole('button', { name: 'Connect' }).click();
  await b.page.getByText('Join or start a sync').waitFor();
  await shot(b, 'join-1-found');
  await b.page.locator('.choice').first().click();
  await b.page.getByRole('button', { name: 'Continue' }).click();
  await b.page.locator('.banner.info').waitFor();
  await shot(b, 'join-2-preview', { fullPage: true, targets: { join: b.page.getByRole('button', { name: 'Join and sync' }), combine: b.page.getByText('Combine') } });
  await b.page.getByRole('button', { name: 'Join and sync' }).click();
  await b.page.getByText('Your bookmarks are syncing').waitFor();
  await command(a, { t: 'syncNow' });

  const [weather] = await a.page.evaluate(() => chrome.bookmarks.search({ title: 'Weather' }));
  await a.page.evaluate((id) => chrome.bookmarks.update(id, { title: 'Weather radar' }), weather.id);
  await create(a, { title: 'Hacker News', url: 'https://news.ycombinator.com/' });
  await wait(600);
  await command(a, { t: 'syncNow' });
  await command(b, { t: 'syncNow' });

  for (const tab of ['overview', 'history', 'browsers', 'duplicates']) {
    await a.page.goto(`chrome-extension://${a.id}/options.html#${tab}`);
    await a.page.getByRole('tab', { name: 'Overview' }).waitFor();
    await shot(a, `dash-${tab}`, tab === 'history' ? { targets: { undo: a.page.getByRole('button', { name: 'Undo from here' }), view: a.page.getByRole('button', { name: 'View changes' }) } } : {});
    if (tab !== 'history') continue;
    await a.page.getByRole('button', { name: 'View changes' }).first().click();
    await a.page.locator('.changes-dialog').waitFor();
    await shot(a, 'dash-history-changes', { targets: { dialog: a.page.locator('.changes-dialog') } });
  }

  await a.page.setViewportSize({ width: 380, height: 520 });
  await a.page.goto(`chrome-extension://${a.id}/popup.html`);
  await shot(a, 'popup');

} finally {
  await a.context.close();
  await b.context.close();
  server.close();
  writeFileSync(join(OUT, 'boxes.json'), JSON.stringify(boxes, null, 2));
}
