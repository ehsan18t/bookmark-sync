import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { recreate } from '../../src/engine/apply.js';
import { type Action, performEdit, WITH_SEPARATORS } from '../sim/actions.js';
import { FAKE_ROOTS, FakeBookmarks } from '../sim/fakeBookmarks.js';
import { type SimDevice, Simulator } from '../sim/simulator.js';

const folderGroup = (groupId: string, local: string) => ({ groupId, mode: 'folder' as const, mapping: { 'root:group': local } });

async function folderIn(bm: FakeBookmarks, parent: string, title: string): Promise<string> {
  return bm.create({ parentId: parent, kind: 'folder', title, url: '' });
}

const titlesIn = async (bm: FakeBookmarks, folder: string) => ((await bm.getSubTree(folder)).children ?? []).map((c) => c.title);

describe('folder mappings', () => {
  it('maps one group to different folders on different browsers (checklist 20)', async () => {
    const sim = new Simulator({ devices: 0, seed: 61 });
    const bmA = new FakeBookmarks('a_');
    const workA = await folderIn(bmA, FAKE_ROOTS.other, 'Work');
    await bmA.create({ parentId: workA, kind: 'bookmark', title: 'x', url: 'https://x.example/' });
    const bmB = new FakeBookmarks('b_');
    const workB = await folderIn(bmB, FAKE_ROOTS.toolbar, 'Work');
    const a = await sim.addDevice('deva', async () => {}, { create: true }, 'firefox', { ...folderGroup('gw', workA), bookmarks: bmA });
    const b = await sim.addDevice('devb', async () => {}, { join: { mode: 'merge', ignoreDefaults: false } }, 'chrome', { ...folderGroup('gw', workB), bookmarks: bmB });
    await sim.quiet();
    expect(await titlesIn(bmB, workB)).toEqual(['x']);
    expect(await titlesIn(bmB, FAKE_ROOTS.toolbar)).toEqual(['Work']);

    const x = (await bmB.getSubTree(workB)).children![0]!.localId;
    await bmB.move(x, { parentId: FAKE_ROOTS.toolbar });
    await sim.quiet();
    expect(await titlesIn(bmA, workA)).toEqual([]);
    expect(await titlesIn(bmB, FAKE_ROOTS.toolbar)).toEqual(['Work', 'x']);
    expect(sim.canonicalMirror(a)).toEqual(sim.canonicalMirror(b));
  });

  it('moving an item between two groups removes it from one and adds it to the other', async () => {
    const sim = new Simulator({ devices: 0, seed: 62 });
    const bmA = new FakeBookmarks('a_');
    const work = await folderIn(bmA, FAKE_ROOTS.other, 'Work');
    const home = await folderIn(bmA, FAKE_ROOTS.other, 'Home');
    const item = await bmA.create({ parentId: work, kind: 'bookmark', title: 'moving', url: 'https://m.example/' });
    const bmB = new FakeBookmarks('b_');
    const workB = await folderIn(bmB, FAKE_ROOTS.other, 'Work');
    const bmC = new FakeBookmarks('c_');
    const homeC = await folderIn(bmC, FAKE_ROOTS.other, 'Home');

    await sim.addDevice('aw', async () => {}, { create: true }, 'firefox', { ...folderGroup('gw', work), bookmarks: bmA });
    await sim.addDevice('ah', async () => {}, { create: true }, 'firefox', { ...folderGroup('gh', home), bookmarks: bmA });
    await sim.addDevice('bw', async () => {}, { join: { mode: 'merge', ignoreDefaults: false } }, 'firefox', { ...folderGroup('gw', workB), bookmarks: bmB });
    await sim.addDevice('ch', async () => {}, { join: { mode: 'merge', ignoreDefaults: false } }, 'firefox', { ...folderGroup('gh', homeC), bookmarks: bmC });
    await sim.quiet();
    expect(await titlesIn(bmB, workB)).toEqual(['moving']);
    expect(await titlesIn(bmC, homeC)).toEqual([]);

    await bmA.move(item, { parentId: home });
    await sim.quiet();
    expect(await titlesIn(bmB, workB)).toEqual([]);
    expect(await titlesIn(bmC, homeC)).toEqual(['moving']);
    expect(await titlesIn(bmA, home)).toEqual(['moving']);
  });

  it('deleting a mapped folder pauses that browser and leaves the group intact elsewhere (checklist 21)', async () => {
    const sim = new Simulator({ devices: 0, seed: 63 });
    const bmA = new FakeBookmarks('a_');
    const workA = await folderIn(bmA, FAKE_ROOTS.other, 'Work');
    await bmA.create({ parentId: workA, kind: 'bookmark', title: 'keep', url: 'https://k.example/' });
    const bmB = new FakeBookmarks('b_');
    const workB = await folderIn(bmB, FAKE_ROOTS.other, 'Work');
    const a = await sim.addDevice('deva', async () => {}, { create: true }, 'firefox', { ...folderGroup('gw', workA), bookmarks: bmA });
    const b = await sim.addDevice('devb', async () => {}, { join: { mode: 'merge', ignoreDefaults: false } }, 'firefox', { ...folderGroup('gw', workB), bookmarks: bmB });
    await sim.quiet();
    await bmA.removeTree(workA);
    await sim.sync(a);
    await sim.quiet();
    expect(a.engine.status).toMatchObject({ state: 'paused', reason: 'mapped-folder-missing' });
    expect(await titlesIn(bmB, workB)).toEqual(['keep']);
    expect(b.engine.status.state).toBe('active');
  });
});

describe('separators across Firefox and Chromium', () => {
  it('Firefox separators survive syncing through a Chromium browser that cannot show them', async () => {
    const sim = new Simulator({ devices: 2, seed: 64, chromiumDevices: [1] });
    await sim.setup();
    const [ff, ch] = sim.devices as [SimDevice, SimDevice];
    await ff.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'one', url: 'https://1.example/' });
    await ff.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'separator', title: '', url: '' });
    await ff.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'two', url: 'https://2.example/' });
    await sim.quiet();
    expect(await titlesIn(ch.bookmarks, FAKE_ROOTS.toolbar)).toEqual(['one', 'two']);
    const two = (await ch.bookmarks.getSubTree(FAKE_ROOTS.toolbar)).children![1]!.localId;
    await ch.bookmarks.update(two, { title: 'two renamed' });
    await ch.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'three', url: 'https://3.example/' });
    await sim.quiet();
    const kinds = ((await ff.bookmarks.getSubTree(FAKE_ROOTS.toolbar)).children ?? []).map((c) => c.kind);
    expect(kinds).toEqual(['bookmark', 'separator', 'bookmark', 'bookmark']);
    expect(await titlesIn(ff.bookmarks, FAKE_ROOTS.toolbar)).toEqual(['one', '', 'two renamed', 'three']);
  });

  it('random edits with separators on Firefox and Chromium devices converge', async () => {
    const action = fc.record({ k: fc.nat(99), a: fc.nat(1000), b: fc.nat(1000), c: fc.nat(1000) });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1e9 }), fc.array(action, { maxLength: 60 }), async (seed, actions: Action[]) => {
        const sim = new Simulator({ devices: 3, seed, chromiumDevices: [1], faults: true });
        await sim.setup();
        for (const act of actions) {
          const d = sim.devices[act.a % sim.devices.length]!;
          if (act.k < 60) await performEdit(sim, d, act, WITH_SEPARATORS);
          else if (act.k < 90) await sim.sync(d);
          else sim.advance(30_000);
        }
        await sim.quiet();
        const ref = sim.canonicalMirror(sim.devices[0]!);
        for (const d of sim.devices) {
          expect(sim.canonicalMirror(d)).toEqual(ref);
          expect(await sim.canonicalLive(d)).toEqual(sim.canonicalLocalMirror(d));
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('items a browser refuses', () => {
  it('a bookmark Firefox refuses stays in the group without stopping that browser', async () => {
    const sim = new Simulator({ devices: 2, seed: 65 });
    await sim.setup();
    const [chrome, firefox] = sim.devices as [SimDevice, SimDevice];
    firefox.bookmarks.rejectUrl = (u) => u.startsWith('javascript:');
    await chrome.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'bookmarklet', url: 'javascript:alert(1)' });
    await chrome.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'normal', url: 'https://n.example/' });
    await sim.quiet();
    expect(firefox.engine.status.state).toBe('active');
    expect(await titlesIn(firefox.bookmarks, FAKE_ROOTS.toolbar)).toEqual(['normal']);
    expect(sim.canonicalMirror(chrome)).toEqual(sim.canonicalMirror(firefox));
    const normal = (await chrome.bookmarks.getSubTree(FAKE_ROOTS.toolbar)).children![1]!.localId;
    await chrome.bookmarks.update(normal, { url: 'javascript:void(0)' });
    await sim.quiet();
    expect(firefox.engine.status.state).toBe('active');
    expect(await titlesIn(chrome.bookmarks, FAKE_ROOTS.toolbar)).toEqual(['bookmarklet', 'normal']);
    const op = [...chrome.engine.mirror().nodes.values()].find((n) => n.title === 'normal')!;
    expect(op.url).toBe('javascript:void(0)');
  });
});

describe('items that failed once', () => {
  it('a bookmark the browser refused once is created on a later sync', async () => {
    const sim = new Simulator({ devices: 2, seed: 66 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    let refuse = true;
    b.bookmarks.rejectUrl = () => refuse;
    await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'later', url: 'https://later.example/' });
    await sim.quiet();
    expect(await titlesIn(b.bookmarks, FAKE_ROOTS.toolbar)).toEqual([]);
    refuse = false;
    await sim.quiet();
    expect(await titlesIn(b.bookmarks, FAKE_ROOTS.toolbar)).toEqual(['later']);
  });
});

describe('refused folders, edits and deletes', () => {
  it('a folder refused once does not delete its children anywhere, and is created later', async () => {
    const sim = new Simulator({ devices: 2, seed: 67 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    let refuse = true;
    b.bookmarks.refuseCreate = (args) => refuse && args.kind === 'folder';
    const f = await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'F', url: '' });
    await a.bookmarks.userCreate({ parentId: f, kind: 'bookmark', title: 'c1', url: 'https://c1.example/' });
    await a.bookmarks.userCreate({ parentId: f, kind: 'bookmark', title: 'c2', url: 'https://c2.example/' });
    await sim.quiet();
    expect(await titlesIn(a.bookmarks, f)).toEqual(['c1', 'c2']);
    expect(b.engine.state.ops.filter((o) => o.device === 'devb')).toEqual([]);
    refuse = false;
    await sim.quiet();
    const fb = (await b.bookmarks.getSubTree(FAKE_ROOTS.toolbar)).children![0]!;
    expect(fb.children!.map((c) => c.title)).toEqual(['c1', 'c2']);
  });

  it('a move that works while its edit is refused records no move of its own', async () => {
    const sim = new Simulator({ devices: 2, seed: 68 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    const g = await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'G', url: '' });
    const x = await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'x', url: 'https://x.example/' });
    await sim.quiet();
    b.bookmarks.rejectUrl = (u) => u.startsWith('javascript:');
    await a.bookmarks.move(x, { parentId: g });
    await a.bookmarks.update(x, { url: 'javascript:void(0)' });
    await sim.quiet();
    expect(b.engine.state.ops.filter((o) => o.device === 'devb')).toEqual([]);
    const gb = (await b.bookmarks.getSubTree(FAKE_ROOTS.toolbar)).children![0]!;
    expect(gb.children!.map((c) => c.title)).toEqual(['x']);
  });

  it('a delete refused once is retried instead of bringing the item back', async () => {
    const sim = new Simulator({ devices: 2, seed: 69 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    const x = await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'x', url: 'https://x.example/' });
    await sim.quiet();
    let refuse = true;
    b.bookmarks.refuseRemove = () => refuse;
    await a.bookmarks.removeTree(x);
    await sim.quiet();
    expect(b.engine.state.ops.filter((o) => o.device === 'devb')).toEqual([]);
    expect(await titlesIn(a.bookmarks, FAKE_ROOTS.toolbar)).toEqual([]);
    refuse = false;
    await sim.quiet();
    expect(await titlesIn(b.bookmarks, FAKE_ROOTS.toolbar)).toEqual([]);
  });
});

describe('recreating saved items', () => {
  it('makes everything it can, in order, and reports the first refusal afterwards', async () => {
    const bm = new FakeBookmarks('b');
    bm.refuseCreate = (args) => args.title === 'Refused';
    const link = (title: string) => ({ localId: '', kind: 'bookmark' as const, title, url: `https://${title}.example/` });
    const tree = [
      { localId: '', kind: 'folder' as const, title: 'A', url: '', children: [link('a1'), link('Refused'), link('a2')] },
      link('Refused'),
      { localId: '', kind: 'folder' as const, title: 'B', url: '', children: [link('b1')] },
    ];
    await expect(recreate(bm, FAKE_ROOTS.toolbar, tree)).rejects.toThrow('refused create');
    const top = (await bm.getSubTree(FAKE_ROOTS.toolbar)).children ?? [];
    expect(top.map((c) => [c.title, (c.children ?? []).map((k) => k.title)])).toEqual([
      ['A', ['a1', 'a2']],
      ['B', ['b1']],
    ]);
  });
});
