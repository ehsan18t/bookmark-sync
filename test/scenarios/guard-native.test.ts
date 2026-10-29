import { describe, expect, it } from 'vitest';
import { GroupEngine } from '../../src/engine/group.js';
import { FAKE_ROOTS, type FakeBookmarks } from '../sim/fakeBookmarks.js';
import { type SimDevice, Simulator } from '../sim/simulator.js';

const GUARD = { guardMin: 10, guardPercent: 20 };
const titles = (d: SimDevice) => [...d.engine.mirror().nodes.values()].map((n) => n.title).sort();
const urls = async (d: SimDevice) => {
  const out: string[] = [];
  const walk = (n: Awaited<ReturnType<FakeBookmarks['getSubTree']>>) => {
    for (const c of n.children ?? []) {
      if (c.kind === 'bookmark') out.push(c.url);
      walk(c);
    }
  };
  for (const r of Object.values(FAKE_ROOTS)) walk(await d.bookmarks.getSubTree(r));
  return out.sort();
};

async function twentyBookmarks(sim: Simulator, d: SimDevice) {
  for (let i = 0; i < 20; i++) await d.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: `item${i}`, url: `https://i${i}.example/` });
  await sim.quiet();
}

/** A sender whose own guard is off, so its large change reaches others unconfirmed. */
async function withoutGuard(d: SimDevice) {
  d.ports = { ...d.ports, settings: { ...d.ports.settings, guardMin: 1_000_000 } };
  d.engine = await GroupEngine.open(d.ports, d.engine.groupId);
}

async function deleteMost(d: SimDevice) {
  const kids = (await d.bookmarks.getSubTree(FAKE_ROOTS.other)).children!;
  for (const c of kids.slice(0, 15)) await d.bookmarks.removeTree(c.localId);
}

describe('large change guard (checklist 18)', () => {
  it('an approved large local change is uploaded and does not pause other browsers', async () => {
    const sim = new Simulator({ devices: 2, seed: 30, settings: GUARD });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await twentyBookmarks(sim, a);
    await deleteMost(a);
    await a.engine.cycle();
    expect(a.engine.status).toMatchObject({ state: 'paused', reason: 'large-local-change' });
    await a.engine.resolveGuard('apply');
    await sim.quiet();
    expect(b.engine.status.state).toBe('active');
    expect(titles(b).length).toBe(5);
  });

  it('pauses on a large remote change and applies it when the user accepts', async () => {
    const sim = new Simulator({ devices: 2, seed: 31, settings: GUARD });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await twentyBookmarks(sim, a);
    await withoutGuard(a);
    await deleteMost(a);
    await a.engine.cycle();
    await b.engine.cycle();
    expect(b.engine.status).toMatchObject({ state: 'paused', reason: 'large-remote-change' });
    expect(titles(b).length).toBe(20);
    await b.engine.resolveGuard('apply');
    await sim.quiet();
    expect(titles(a).length).toBe(5);
    expect(sim.canonicalMirror(a)).toEqual(sim.canonicalMirror(b));
  });

  it('reverting a large remote change brings the items back on every browser', async () => {
    const sim = new Simulator({ devices: 2, seed: 32, settings: GUARD });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await twentyBookmarks(sim, a);
    await withoutGuard(a);
    await deleteMost(a);
    await a.engine.cycle();
    await b.engine.cycle();
    expect(b.engine.status).toMatchObject({ state: 'paused', reason: 'large-remote-change' });
    await b.engine.resolveGuard('revert');
    await sim.quiet();
    expect(titles(a).length).toBe(20);
    expect(sim.canonicalMirror(a)).toEqual(sim.canonicalMirror(b));
    expect(await urls(a)).toEqual(await urls(b));
  });

  it('reverting a large local change restores this browser before anything is uploaded', async () => {
    const sim = new Simulator({ devices: 2, seed: 33, settings: GUARD });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await twentyBookmarks(sim, a);
    await deleteMost(a);
    await a.engine.cycle();
    await a.engine.resolveGuard('revert');
    await sim.quiet();
    expect((await urls(a)).length).toBe(20);
    expect(sim.canonicalMirror(a)).toEqual(sim.canonicalMirror(b));
  });

  it('a join that adds many items does not trigger the guard elsewhere', async () => {
    const sim = new Simulator({ devices: 1, seed: 34, settings: GUARD });
    await sim.setup();
    await sim.addDevice(
      'devb',
      async (bm) => {
        for (let i = 0; i < 30; i++) await bm.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: `j${i}`, url: `https://j${i}.example/` });
      },
      { join: { mode: 'merge', ignoreDefaults: false } },
    );
    await sim.quiet();
    for (const d of sim.devices) expect(d.engine.status.state).toBe('active');
    expect(titles(sim.devices[0]!).length).toBe(30);
  });
});

/** Copy every user-created item on `from` to `to` at the same folder path, like native browser sync would. */
function linkByNativeSync(from: SimDevice, to: SimDevice) {
  from.bookmarks.onChange = (_kind, id) => {
    const n = from.bookmarks.node(id);
    const path = from.bookmarks.pathTitles(id);
    let parent: string = Object.values(FAKE_ROOTS).find((r) => r === path[0]) ?? FAKE_ROOTS.other;
    void (async () => {
      for (const title of path.slice(1)) {
        const kids = (await to.bookmarks.getSubTree(parent)).children ?? [];
        parent = kids.find((k) => k.kind === 'folder' && k.title === title)?.localId ?? parent;
      }
      await to.bookmarks.create({ parentId: parent, kind: n.kind, title: n.title, url: n.url });
    })();
  };
}

describe('native sync detection', () => {
  it('two installs linked by native sync: duplicates are repaired and the device pauses (checklist 16)', async () => {
    const sim = new Simulator({ devices: 3, seed: 41 });
    await sim.setup();
    const [a, b, c] = sim.devices as [SimDevice, SimDevice, SimDevice];
    await sim.quiet();
    linkByNativeSync(b, c);
    for (let i = 0; i < 4; i++) await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: `n${i}`, url: `https://n${i}.example/` });
    await sim.sync(b);
    await sim.sync(c);
    await sim.quiet();
    expect([b, c].some((d) => d.engine.status.state === 'paused' && d.engine.status.reason === 'native-sync')).toBe(true);
    for (const d of [b, c].filter((d) => d.engine.status.state === 'paused')) await d.engine.resume();
    await sim.quiet();
    expect(titles(a)).toEqual(['n0', 'n1', 'n2', 'n3']);
    for (const d of [a, b, c]) expect((await urls(d)).length).toBe(4);
  });

  it('the same bookmark added on two browsers within minutes ends as one copy, without a pause (checklist 17, 29)', async () => {
    const sim = new Simulator({ devices: 2, seed: 42 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await sim.quiet();
    await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'Same', url: 'https://same.example/' });
    sim.advance(30_000);
    await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'Same', url: 'https://same.example/' });
    await sim.sync(a);
    await sim.sync(b);
    await sim.quiet();
    expect(titles(a)).toEqual(['Same']);
    expect(await urls(b)).toEqual(['https://same.example/']);
    for (const d of [a, b]) expect(d.engine.status.state).toBe('active');
  });
});
