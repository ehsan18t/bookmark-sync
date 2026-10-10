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

describe('interrupted apply', () => {
  it('a worker stopped halfway through applying remote changes does not duplicate bookmarks', async () => {
    const sim = new Simulator({ devices: 2, seed: 25 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    for (let i = 0; i < 12; i++) await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: `item${i}`, url: `https://i${i}.example/` });
    await sim.sync(a);
    b.bookmarks.crashAfter = 5;
    await expect(b.engine.cycle()).rejects.toThrow('worker stopped');
    await sim.restart(b);
    await sim.quiet();
    expect(titles(a)).toHaveLength(12);
    expect(titles(b)).toHaveLength(12);
    expect(((await b.bookmarks.getSubTree(FAKE_ROOTS.other)).children ?? []).length).toBe(12);
    expect(b.engine.state.ops.filter((op) => op.device === b.engine.deviceId)).toEqual([]);
    for (const d of [a, b]) expect(d.engine.status.state).toBe('active');
  });
});

describe('leaving a group', () => {
  it('edits uploaded while leaving reach the other browsers', async () => {
    const sim = new Simulator({ devices: 2, seed: 26, visibilityDelayMs: 60_000 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    sim.enableFaults(false);
    await sim.quiet();
    sim.enableFaults(true);
    await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'last edit', url: 'https://last.example/' });
    await b.engine.recordLocalChanges();
    await b.engine.leave();
    sim.devices.splice(1, 1);
    sim.enableFaults(false);
    sim.advance(120_000);
    await sim.quiet();
    expect(titles(a)).toEqual(['last edit']);
    expect(a.engine.devices().find((d) => d.deviceId === 'devb')?.left).toBe(true);
  });
});

describe('clock far ahead', () => {
  it('edits made while the clock is days ahead are stamped with the corrected time and pause nobody else', async () => {
    const sim = new Simulator({ devices: 2, seed: 27 });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await sim.quiet();
    a.skew = 3 * 24 * 60 * 60_000;
    await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'edited with a wrong clock', url: 'https://w.example/' });
    await sim.sync(a);
    expect(a.engine.status).toMatchObject({ state: 'paused', reason: 'clock-skew' });
    expect(a.engine.state.outbox).toEqual([]);
    a.skew = 0;
    await sim.quiet();
    expect(b.engine.status.state).toBe('active');
    expect(titles(b)).toEqual(['edited with a wrong clock']);
    const op = b.engine.state.ops.find((o) => o.device === 'deva')!;
    expect(Number(op.hlc.slice(0, 15))).toBeLessThan(sim.time + 60_000);
  });
});
