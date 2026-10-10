import { describe, expect, it } from 'vitest';
import { encode } from '../../src/core/codec.js';
import { deviceInfoPath } from '../../src/storage/layout.js';
import { FAKE_ROOTS } from '../sim/fakeBookmarks.js';
import { GROUP_ID, Simulator, type SimDevice } from '../sim/simulator.js';

const titles = (d: SimDevice) => [...d.engine.mirror().nodes.values()].map((n) => n.title).sort();

describe('device identity and clocks', () => {
  it('a copied profile becomes a separate device, with no batch overwritten and no edit lost (checklist 24)', async () => {
    const sim = new Simulator({ devices: 2, seed: 21 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'before copy', url: 'https://x.example/' });
    await sim.quiet();
    const copy = await sim.cloneDevice(b, 'devcopy');
    await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'original', url: 'https://o.example/' });
    await copy.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'copy', url: 'https://c.example/' });
    await sim.sync(b);
    await sim.sync(copy);
    await sim.quiet();
    expect(copy.engine.deviceId).not.toBe(b.engine.deviceId);
    expect(sim.provider.overwrittenPaths()).toEqual([]);
    for (const d of [a, b, copy]) expect(titles(d)).toEqual(['before copy', 'copy', 'original']);
    expect(sim.canonicalMirror(a)).toEqual(sim.canonicalMirror(copy));
  });

  it('restoring an old backup of a profile does not overwrite newer batches', async () => {
    const sim = new Simulator({ devices: 2, seed: 22 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    const backup = await sim.cloneDevice(b, 'devbackup');
    sim.devices.pop();
    for (let i = 0; i < 3; i++) {
      await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: `b${i}`, url: `https://b${i}.example/` });
      await sim.quiet();
    }
    sim.devices.push(backup);
    await backup.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: 'from backup', url: 'https://bk.example/' });
    await sim.quiet();
    expect(sim.provider.overwrittenPaths()).toEqual([]);
    for (const d of [a, b, backup]) expect(titles(d)).toEqual(['b0', 'b1', 'b2', 'from backup']);
  });

  it('a device whose clock is more than 2 minutes off pauses and writes nothing (checklist 25)', async () => {
    const sim = new Simulator({ devices: 2, seed: 23 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await sim.quiet();
    b.skew = 5 * 60_000;
    const before = [...sim.provider.createLog.keys()].filter((p) => p.includes('/devb/')).length;
    await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'skewed', url: 'https://s.example/' });
    await sim.sync(b);
    expect(b.engine.status).toMatchObject({ state: 'paused', reason: 'clock-skew' });
    expect([...sim.provider.createLog.keys()].filter((p) => p.includes('/devb/')).length).toBe(before);
    b.skew = 0;
    await sim.quiet();
    expect(b.engine.status.state).toBe('active');
    expect(titles(a)).toEqual(['skewed']);
  });

  it('a file with a newer format version pauses the group with a clear reason (checklist 23)', async () => {
    const sim = new Simulator({ devices: 2, seed: 24 });
    await sim.setup();
    const [a] = sim.devices as [SimDevice, SimDevice];
    const bytes = await encode('device', { deviceId: 'future' });
    const env = JSON.parse(new TextDecoder().decode(bytes));
    env.v = 2;
    await sim.provider.client().overwrite(deviceInfoPath(GROUP_ID, 'future'), new TextEncoder().encode(JSON.stringify(env)));
    await sim.sync(a);
    expect(a.engine.status).toMatchObject({ state: 'paused', reason: 'format-too-new' });
  });
});
