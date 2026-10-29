import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonical, type Tree } from '../../src/core/tree.js';
import { type Action, performEdit } from '../sim/actions.js';
import { FAKE_ROOTS, FakeBookmarks } from '../sim/fakeBookmarks.js';
import { Simulator } from '../sim/simulator.js';

const action = fc.record({ k: fc.nat(99), a: fc.nat(1000), b: fc.nat(1000), c: fc.nat(1000) });

async function runConcurrent(seed: number, devices: number, actions: Action[], faults: boolean) {
  const sim = new Simulator({ devices, seed, faults, maxSkew: 60_000 });
  await sim.setup();
  const restorePoints: string[] = [];
  for (const act of actions) {
    const d = sim.devices[act.a % sim.devices.length]!;
    const k = act.k;
    if (k < 55) await performEdit(sim, d, act);
    else if (k < 80) await sim.sync(d);
    else if (k < 88) sim.advance((act.b % 120) * 1000);
    else if (k < 92) await sim.restart(d);
    else if (k < 96) restorePoints.push(d.engine.restorePoint());
    else {
      const t = restorePoints[act.b % Math.max(restorePoints.length, 1)];
      if (t) await d.engine.restoreTo(t);
    }
  }
  await sim.quiet();
  return sim;
}

async function checkConverged(sim: Simulator) {
  const reference = sim.canonicalMirror(sim.devices[0]!);
  for (const d of sim.devices) {
    expect(sim.canonicalMirror(d)).toEqual(reference);
    expect(await sim.canonicalLive(d)).toEqual(sim.canonicalLocalMirror(d));
    const merged = d.engine.mergedTree();
    for (const n of merged.nodes.values()) {
      expect(merged.nodes.has(n.parent) || merged.roots.includes(n.parent)).toBe(true);
    }
    expect(canonical(merged)).toEqual(sim.canonicalMirror(d));
  }
  expect(sim.provider.overwrittenPaths()).toEqual([]);
}

function subtree(t: Tree, root: string): Tree {
  const under = (id: string) => {
    for (let cur = t.nodes.get(id); cur; cur = t.nodes.get(cur.parent)) if (cur.parent === root) return true;
    return false;
  };
  return { roots: [root], nodes: new Map([...t.nodes].filter(([id]) => under(id))) };
}

/** Two full browsers plus one that holds only the folder "Shared" of the group, in a folder of its own. */
async function runWithPartialHolder(seed: number, actions: Action[]) {
  const sim = new Simulator({ devices: 2, seed, faults: true, maxSkew: 60_000 });
  await sim.setup();
  const a = sim.devices[0]!;
  const shared = await a.bookmarks.create({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'Shared', url: '' });
  await a.bookmarks.create({ parentId: shared, kind: 'bookmark', title: 'seed', url: 'https://seed.example/' });
  await sim.quiet();
  const part = new Map(a.engine.state.idmap).get(shared)!;
  const bm = new FakeBookmarks('p_');
  const mine = await bm.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Mine', url: '' });
  await bm.create({ parentId: mine, kind: 'bookmark', title: 'own', url: 'https://own.example/' });
  sim.enableFaults(false);
  const p = await sim.addDevice('devp', async () => {}, { join: { mode: 'merge', ignoreDefaults: false } }, 'firefox', { bookmarks: bm, mapping: { [part]: mine } });
  sim.enableFaults(true);
  for (const act of actions) {
    const d = sim.devices[act.a % sim.devices.length]!;
    if (act.k < 55) await performEdit(sim, d, act);
    else if (act.k < 80) await sim.sync(d);
    else if (act.k < 90) sim.advance((act.b % 120) * 1000);
    else await sim.restart(d);
  }
  await sim.quiet();
  return { sim, p, part };
}

describe('convergence (properties 1, 2, 5)', () => {
  it('a browser holding one folder of the group matches that folder in the full browsers', async () => {
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1e9 }), fc.array(action, { maxLength: 60 }), async (seed, actions) => {
        const { sim, p, part } = await runWithPartialHolder(seed, actions);
        const full = sim.devices.filter((d) => d !== p);
        const reference = sim.canonicalMirror(full[0]!);
        for (const d of full) {
          expect(sim.canonicalMirror(d)).toEqual(reference);
          expect(await sim.canonicalLive(d)).toEqual(sim.canonicalLocalMirror(d));
        }
        if (p.engine.status.state !== 'active' || !(part in p.engine.state.config.mapping)) return;
        checked++;
        expect(sim.canonicalMirror(p)).toEqual(canonical(subtree(sim.mirrorTree(full[0]!), part)));
        expect(await sim.canonicalLive(p)).toEqual(sim.canonicalLocalMirror(p));
      }),
      {
        numRuns: 40,
        // The partial holder renames inside its folder while another browser deletes the folder.
        examples: [
          [
            432759527,
            [
              { k: 55, a: 0, b: 0, c: 0 },
              { k: 0, a: 136, b: 0, c: 0 },
              { k: 55, a: 511, b: 0, c: 0 },
              { k: 0, a: 227, b: 46, c: 0 },
              { k: 0, a: 615, b: 0, c: 0 },
            ],
          ],
        ],
      },
    );
    expect(checked).toBeGreaterThan(10);
  });

  it('long fixed runs build real trees and still converge', async () => {
    let total = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const rnd = (n: number) => Math.floor(((Math.sin(seed * 9973 + n) + 1) / 2) * 1000);
      const actions: Action[] = Array.from({ length: 400 }, (_, i) => ({ k: rnd(i) % 100, a: rnd(i + 1e4), b: rnd(i + 2e4), c: rnd(i + 3e4) }));
      const sim = await runConcurrent(seed, 4, actions, true);
      await checkConverged(sim);
      total += sim.mirrorTree(sim.devices[0]!).nodes.size;
      expect(sim.devices.some((d) => d.engine.state.ops.some((op) => op.type === 'delete'))).toBe(true);
      expect(sim.devices.some((d) => d.engine.state.ops.some((op) => op.type === 'undelete' || op.type === 'move'))).toBe(true);
    }
    expect(total).toBeGreaterThan(20);
  });

  it('converges with 3 devices, no faults', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1e9 }), fc.array(action, { maxLength: 60 }), async (seed, actions) => {
        await checkConverged(await runConcurrent(seed, 3, actions, false));
      }),
      { numRuns: 60 },
    );
  });

  it('converges with 2 to 5 devices and provider faults (lost responses, delayed visibility)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 2, max: 5 }), fc.array(action, { maxLength: 80 }), async (seed, devices, actions) => {
        await checkConverged(await runConcurrent(seed, devices, actions, true));
      }),
      { numRuns: 60 },
    );
  });
});
