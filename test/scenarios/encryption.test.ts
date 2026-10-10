import { describe, expect, it } from 'vitest';
import { decode, LockedError } from '../../src/core/codec.js';
import { FAKE_ROOTS } from '../sim/fakeBookmarks.js';
import { GROUP_ID, Simulator, type SimDevice } from '../sim/simulator.js';

const titles = (d: SimDevice) => [...d.engine.mirror().nodes.values()].map((n) => n.title).sort();

async function filesOf(sim: Simulator, group: string) {
  return [...sim.provider.createLog.entries()].filter(([p]) => p.startsWith(`groups/${group}/`) && p.includes('/batches/'));
}

async function migrate(sim: Simulator, initiator: SimDevice, passphrase: string | null) {
  const { newGroupId, key } = await initiator.engine.startMigration(passphrase, 1000);
  if (key) for (const d of sim.devices) d.keys.set(newGroupId, key);
  return newGroupId;
}

describe('encryption', () => {
  it('an encrypted group syncs, and its files cannot be read without the key (checklist 19)', async () => {
    const sim = new Simulator({ devices: 2, seed: 51, passphrase: 'correct horse' });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'secret', url: 'https://s.example/' });
    await sim.quiet();
    expect(titles(b)).toEqual(['secret']);
    const [, versions] = (await filesOf(sim, GROUP_ID))[0]!;
    await expect(decode(versions[0]!, 'batch', { key: null, path: 'x', required: true })).rejects.toBeInstanceOf(LockedError);
    expect(new TextDecoder().decode(versions[0]!)).not.toContain('secret');
  });

  it('a browser without the passphrase stays locked until it is entered', async () => {
    const sim = new Simulator({ devices: 2, seed: 52, passphrase: 'pw' });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    const key = b.keys.get(GROUP_ID)!;
    b.keys.delete(GROUP_ID);
    await sim.restart(b);
    await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'x', url: 'https://x.example/' });
    await sim.sync(a);
    await sim.sync(b);
    expect(b.engine.status).toMatchObject({ state: 'paused', reason: 'locked' });
    b.engine.setKey(key);
    await sim.quiet();
    expect(titles(b)).toEqual(['x']);
  });
});

describe('encryption migration', () => {
  it('turning encryption on moves every browser to the new group without losing edits made during it', async () => {
    const sim = new Simulator({ devices: 3, seed: 53 });
    await sim.setup();
    const [a, b, c] = sim.devices as [SimDevice, SimDevice, SimDevice];
    await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'before', url: 'https://before.example/' });
    await sim.quiet();
    const g2 = await migrate(sim, a, 'new secret');
    await b.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'during b', url: 'https://db.example/' });
    await sim.sync(b);
    await c.bookmarks.userCreate({ parentId: FAKE_ROOTS.other, kind: 'bookmark', title: 'during c', url: 'https://dc.example/' });
    await sim.sync(c);
    await sim.quiet();
    for (const d of [a, b, c]) {
      expect(d.engine.groupId).toBe(g2);
      expect(d.engine.status.state).toBe('active');
      expect(titles(d)).toEqual(['before', 'during b', 'during c']);
    }
    expect(sim.canonicalMirror(a)).toEqual(sim.canonicalMirror(c));
    for (const [, versions] of await filesOf(sim, g2)) expect(new TextDecoder().decode(versions[0]!)).not.toContain('during');
    expect((await sim.provider.client().listFiles(`groups/${GROUP_ID}/devices/devb/batches`)).length).toBe(0);
  });

  it('turning encryption off works the same way, and later edits keep syncing', async () => {
    const sim = new Simulator({ devices: 2, seed: 54, passphrase: 'pw' });
    await sim.setup();
    const [a, b] = sim.devices as [SimDevice, SimDevice];
    await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'one', url: 'https://1.example/' });
    await sim.quiet();
    const g2 = await migrate(sim, b, null);
    await sim.quiet();
    expect(a.engine.groupId).toBe(g2);
    expect(a.engine.state.config.encrypted).toBe(false);
    await a.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'two', url: 'https://2.example/' });
    await sim.quiet();
    expect(titles(b)).toEqual(['one', 'two']);
    const [, versions] = (await filesOf(sim, g2)).at(-1)!;
    expect(new TextDecoder().decode(versions[0]!)).toContain('two');
  });

  it('can continue without an offline browser, which moves over with its edits when it returns', async () => {
    const sim = new Simulator({ devices: 3, seed: 55 });
    await sim.setup();
    const [a, b, c] = sim.devices as [SimDevice, SimDevice, SimDevice];
    await sim.quiet();
    await c.bookmarks.userCreate({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'offline', url: 'https://off.example/' });
    const g2 = await migrate(sim, a, 'pw2');
    for (let i = 0; i < 3; i++) {
      await sim.sync(a);
      await sim.sync(b);
    }
    expect(a.engine.migrationProgress()?.waitingFor).toEqual(['devc']);
    await a.engine.continueMigrationWithout(['devc']);
    for (let i = 0; i < 3; i++) {
      await sim.sync(a);
      await sim.sync(b);
    }
    expect(a.engine.groupId).toBe(g2);
    await sim.quiet();
    for (const d of [a, b, c]) {
      expect(d.engine.groupId).toBe(g2);
      expect(titles(d)).toEqual(['offline']);
    }
  });
});
