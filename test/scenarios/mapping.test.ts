import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { performEdit, WITH_SEPARATORS, type Action } from '../sim/actions.js';
import { FAKE_ROOTS, FakeBookmarks } from '../sim/fakeBookmarks.js';
import { Simulator, type SimDevice } from '../sim/simulator.js';

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
