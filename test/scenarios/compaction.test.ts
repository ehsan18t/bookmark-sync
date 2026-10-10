import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decode, type Batch } from '../../src/core/codec.js';
import { DAY } from '../../src/core/frontier.js';
import { EVERYTHING_ROOTS } from '../../src/core/ids.js';
import type { Op } from '../../src/core/ops.js';
import { emptyState, replay } from '../../src/core/replay.js';
import { canonical, visibleTree } from '../../src/core/tree.js';
import { performEdit, type Action } from '../sim/actions.js';
import { FAKE_ROOTS } from '../sim/fakeBookmarks.js';
import { GROUP_ID, Simulator, type SimDevice } from '../sim/simulator.js';

const COMPACTING = { compactIntervalMs: 0, compactMinOps: 1, historyMs: 60 * 60_000 };

async function oracleTree(sim: Simulator) {
  const ops: Op[] = [];
  for (const [path, versions] of sim.provider.createLog) {
    if (!path.includes(`groups/${GROUP_ID}/`) || !path.includes('/batches/')) continue;
    ops.push(...(await decode<Batch>(versions[0]!, 'batch')).ops);
  }
  return canonical(visibleTree(replay(emptyState(), ops), EVERYTHING_ROOTS));
}

async function expectConverged(sim: Simulator, devices: SimDevice[] = sim.devices) {
  const ref = sim.canonicalMirror(devices[0]!);
  for (const d of devices) {
    expect(sim.canonicalMirror(d)).toEqual(ref);
    expect(await sim.canonicalLive(d)).toEqual(sim.canonicalLocalMirror(d));
  }
  expect(sim.provider.overwrittenPaths()).toEqual([]);
}

const batchFiles = (sim: Simulator, device: string) =>
  [...sim.provider.createLog.keys()].filter((p) => p.includes(`/devices/${device}/batches/`)).length;

describe('compaction and snapshots', () => {
  it('replaying the full log from scratch equals every device after compaction (property 4)', async () => {
    const action = fc.record({ k: fc.nat(99), a: fc.nat(1000), b: fc.nat(1000), c: fc.nat(1000) });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1e9 }), fc.array(action, { minLength: 10, maxLength: 60 }), async (seed, actions: Action[]) => {
        const sim = new Simulator({ devices: 3, seed, settings: COMPACTING });
        await sim.setup();
        for (const act of actions) {
          const d = sim.devices[act.a % sim.devices.length]!;
          if (act.k < 60) await performEdit(sim, d, act);
          else if (act.k < 85) await sim.sync(d);
          else sim.advance((act.b % 3) * DAY + 1000);
        }
        await sim.quiet();
        sim.advance(2 * DAY);
        await sim.quiet();
        await expectConverged(sim);
        expect(sim.canonicalMirror(sim.devices[0]!)).toEqual(await oracleTree(sim));
      }),
      { numRuns: 25 },
    );
  });

  it('compacts, deletes covered batches, and a device that fell behind catches up from the snapshot (checklist 14)', async () => {
    const sim = new Simulator({ devices: 3, seed: 11, settings: COMPACTING });
    await sim.setup();
    const [a, b, c] = sim.devices as [SimDevice, SimDevice, SimDevice];
    await c.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'from c', url: 'https://c.example/' });
    await sim.quiet();

    for (let day = 0; day < 4; day++) {
      await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: `a${day}`, url: `https://a${day}.example/` });
      await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: `b${day}`, url: `https://b${day}.example/` });
      await sim.sync(a);
      await sim.sync(b);
      await sim.sync(c);
      sim.advance(DAY + 1000);
    }
    await sim.sync(a);
    await sim.sync(b);
    expect(a.engine.state.baseFrontier > '0').toBe(true);

    for (let day = 0; day < 3; day++) {
      await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.menu, kind: 'bookmark', title: `late${day}`, url: `https://late${day}.example/` });
      await sim.sync(a);
      await sim.sync(b);
      sim.advance(DAY + 1000);
    }
    await sim.sync(a);
    await sim.sync(b);
    const aBatches = (await sim.provider.client().listFiles(`groups/${GROUP_ID}/devices/deva/batches`)).length;
    expect(aBatches).toBeLessThan(batchFiles(sim, 'deva'));

    await sim.quiet();
    await expectConverged(sim);
    expect(sim.canonicalMirror(c)).toEqual(await oracleTree(sim));
  });

  it('a device away longer than the stale limit returns and keeps its unsynced edits', async () => {
    const sim = new Simulator({ devices: 3, seed: 12, settings: { ...COMPACTING, staleMs: 10 * DAY } });
    await sim.setup();
    const [a, b, c] = sim.devices as [SimDevice, SimDevice, SimDevice];
    await sim.quiet();
    await c.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'offline edit', url: 'https://offline.example/' });
    await c.engine.recordLocalChanges();

    for (let day = 0; day < 15; day++) {
      await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: `a${day}`, url: `https://a${day}.example/` });
      await sim.sync(a);
      await sim.sync(b);
      sim.advance(DAY + 1000);
    }
    expect(a.engine.state.baseFrontier > c.engine.state.outbox[0]!.hlc).toBe(true);
    await sim.quiet();
    await expectConverged(sim);
    const titles = [...a.engine.mirror().nodes.values()].map((n) => n.title);
    expect(titles).toContain('offline edit');
    expect(titles.filter((t) => t.startsWith('a')).length).toBe(15);
  });

  it('a new browser can join after old batches were compacted away', async () => {
    const sim = new Simulator({ devices: 2, seed: 13, settings: COMPACTING });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    for (let day = 0; day < 5; day++) {
      await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: `a${day}`, url: `https://a${day}.example/` });
      await sim.sync(a);
      await sim.sync(b);
      sim.advance(DAY + 1000);
    }
    await sim.quiet();
    expect((await sim.provider.client().listFiles(`groups/${GROUP_ID}/devices/deva/batches`)).length).toBeLessThan(batchFiles(sim, 'deva'));
    const c = await sim.addDevice('devc', async () => {}, { join: { mode: 'merge', ignoreDefaults: false } });
    await sim.quiet();
    await expectConverged(sim);
    expect([...c.engine.mirror().nodes.values()].length).toBe(5);
  });
});
