import { describe, expect, it } from 'vitest';
import { FAKE_ROOTS, type FakeBookmarks } from '../sim/fakeBookmarks.js';
import { type SimDevice, Simulator } from '../sim/simulator.js';

type Spec = { f: string; c: Spec[] } | { b: string; u: string };

async function fill(bm: FakeBookmarks, parent: string, items: Spec[]): Promise<void> {
  for (const it of items) {
    if ('f' in it) {
      const id = await bm.create({ parentId: parent, kind: 'folder', title: it.f, url: '' });
      await fill(bm, id, it.c);
    } else await bm.create({ parentId: parent, kind: 'bookmark', title: it.b, url: it.u });
  }
}

async function render(d: SimDevice, local: string = FAKE_ROOTS.toolbar): Promise<unknown[]> {
  const n = await d.bookmarks.getSubTree(local);
  const walk = (x: typeof n): unknown[] => (x.children ?? []).map((c) => (c.kind === 'folder' ? [c.title, walk(c)] : `${c.title}|${c.url}`));
  return walk(n);
}

const groupA: Spec[] = [
  { b: 'News', u: 'https://news.example/' },
  { f: 'Work', c: [{ b: 'Doc', u: 'https://doc.example/' }] },
];
const localB: Spec[] = [
  { b: 'News site', u: 'https://news.example/' },
  {
    f: 'Work',
    c: [
      { b: 'Doc', u: 'https://doc.example/' },
      { b: 'Other', u: 'https://other.example/' },
    ],
  },
  { b: 'Music', u: 'https://music.example/' },
];

describe('joining a group', () => {
  it('merge links exact matches, adds the rest, and matches the preview (checklist 9)', async () => {
    const sim = new Simulator({ devices: 0, seed: 1 });
    const a = await sim.addDevice('deva', (bm) => fill(bm, FAKE_ROOTS.toolbar, groupA), { create: true });
    const preview = await sim.preview('devb', (bm) => fill(bm, FAKE_ROOTS.toolbar, localB), { mode: 'merge', ignoreDefaults: false });
    expect(preview).toMatchObject({ matched: 3, added: 2, removedLocal: 0 });
    const b = await sim.addDevice('devb', (bm) => fill(bm, FAKE_ROOTS.toolbar, localB), { join: { mode: 'merge', ignoreDefaults: false } });
    await sim.quiet();
    const expected = ['News|https://news.example/', ['Work', ['Doc|https://doc.example/', 'Other|https://other.example/']], 'Music|https://music.example/'];
    expect(await render(a)).toEqual(expected);
    expect(await render(b)).toEqual(expected);
  });

  it('ignores the browser default bookmarks, which stay local only (checklist 9)', async () => {
    const sim = new Simulator({ devices: 0, seed: 2 });
    const a = await sim.addDevice('deva', (bm) => fill(bm, FAKE_ROOTS.toolbar, groupA), { create: true });
    const firefoxDefaults: Spec[] = [
      {
        f: 'Mozilla Firefox',
        c: [
          { b: 'Get Help', u: 'https://support.mozilla.org/products/firefox' },
          { b: 'About Us', u: 'https://www.mozilla.org/en-US/about/' },
        ],
      },
    ];
    const b = await sim.addDevice('devb', (bm) => fill(bm, FAKE_ROOTS.menu, firefoxDefaults), { join: { mode: 'merge', ignoreDefaults: true } });
    await sim.quiet();
    expect(await render(a, FAKE_ROOTS.menu)).toEqual([]);
    expect(await render(b, FAKE_ROOTS.menu)).toEqual([['Mozilla Firefox', ['Get Help|https://support.mozilla.org/products/firefox', 'About Us|https://www.mozilla.org/en-US/about/']]]);
    const c = await sim.addDevice('devc', (bm) => fill(bm, FAKE_ROOTS.menu, firefoxDefaults), { join: { mode: 'merge', ignoreDefaults: true } });
    await sim.quiet();
    expect(await render(a, FAKE_ROOTS.menu)).toEqual([]);
    expect((await render(c, FAKE_ROOTS.menu)).length).toBe(1);

    const folder = (await b.bookmarks.getSubTree(FAKE_ROOTS.menu)).children![0]!.localId;
    await b.bookmarks.move(folder, { parentId: FAKE_ROOTS.toolbar });
    await sim.quiet();
    expect((await render(a)).some((x) => Array.isArray(x) && x[0] === 'Mozilla Firefox')).toBe(true);
  });

  it('two browsers joining at the same time with the same bookmarks end with one copy (checklist 10)', async () => {
    const sim = new Simulator({ devices: 0, seed: 3, visibilityDelayMs: 600_000 });
    await sim.addDevice('deva', async () => {}, { create: true });
    sim.enableFaults(true);
    const b = await sim.addDevice('devb', (bm) => fill(bm, FAKE_ROOTS.toolbar, localB), { join: { mode: 'merge', ignoreDefaults: false } });
    const c = await sim.addDevice('devc', (bm) => fill(bm, FAKE_ROOTS.toolbar, localB), { join: { mode: 'merge', ignoreDefaults: false } });
    sim.enableFaults(false);
    await sim.quiet();
    expect(await render(b)).toEqual(await render(c));
    expect(await render(sim.devices[0]!)).toEqual(await render(b));
    expect((await render(b)).length).toBe(3);
  });

  it('replace mode makes the browser match the group, and undo brings its bookmarks back (checklist 11, 12)', async () => {
    const sim = new Simulator({ devices: 0, seed: 4 });
    const a = await sim.addDevice('deva', (bm) => fill(bm, FAKE_ROOTS.toolbar, groupA), { create: true });
    const b = await sim.addDevice('devb', (bm) => fill(bm, FAKE_ROOTS.toolbar, localB), { join: { mode: 'replace', ignoreDefaults: false } });
    await sim.quiet();
    expect(await render(b)).toEqual(await render(a));
    await b.engine.undoJoin();
    await b.engine.leave();
    sim.devices.splice(sim.devices.indexOf(b), 1);
    await sim.quiet();
    expect(await render(b)).toEqual(['News site|https://news.example/', ['Work', ['Doc|https://doc.example/', 'Other|https://other.example/']], 'Music|https://music.example/']);
    expect(await render(a)).toEqual(['News|https://news.example/', ['Work', ['Doc|https://doc.example/']]]);
  });

  it('undoing a merge join removes what it added and restores the browser exactly (checklist 30)', async () => {
    const sim = new Simulator({ devices: 0, seed: 5 });
    const a = await sim.addDevice('deva', (bm) => fill(bm, FAKE_ROOTS.toolbar, groupA), { create: true });
    const b = await sim.addDevice('devb', (bm) => fill(bm, FAKE_ROOTS.toolbar, localB), { join: { mode: 'merge', ignoreDefaults: false } });
    await sim.quiet();
    expect((await render(a)).length).toBe(3);
    await b.engine.undoJoin();
    await b.engine.leave();
    sim.devices.splice(sim.devices.indexOf(b), 1);
    await sim.quiet();
    expect(await render(a)).toEqual(['News|https://news.example/', ['Work', ['Doc|https://doc.example/']]]);
    expect(await render(b)).toEqual(['News site|https://news.example/', ['Work', ['Doc|https://doc.example/', 'Other|https://other.example/']], 'Music|https://music.example/']);
  });
});

describe('a failed join', () => {
  it('leaves no device behind in the group', async () => {
    const sim = new Simulator({ devices: 1, seed: 6 });
    await sim.setup();
    const d = sim.makeDevice('devlate');
    d.skew = 10 * 60_000;
    const { GroupEngine } = await import('../../src/engine/group.js');
    await expect(GroupEngine.join(d.ports, sim.config(d), { mode: 'merge', ignoreDefaults: false }, null)).rejects.toThrow(/can’t be joined/);
    expect(await sim.provider.client().listDevices('g0')).toEqual(['deva']);
  });
});
