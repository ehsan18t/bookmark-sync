import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Kind } from '../../src/core/ops.js';
import { type Action, FOLDER_HEAVY_KINDS, performEdit } from '../sim/actions.js';
import { FAKE_ROOTS } from '../sim/fakeBookmarks.js';
import { type SimDevice, Simulator } from '../sim/simulator.js';

interface ONode {
  kind: Kind;
  title: string;
  url: string;
  parent: string;
  children: string[];
}

const ROOT_OF_LOCAL: Record<string, string> = {
  [FAKE_ROOTS.toolbar]: 'root:toolbar',
  [FAKE_ROOTS.other]: 'root:other',
  [FAKE_ROOTS.menu]: 'root:menu',
};

class Oracle {
  roots = new Map<string, string[]>([
    ['root:toolbar', []],
    ['root:other', []],
    ['root:menu', []],
  ]);
  nodes = new Map<string, ONode>();

  clone(): Oracle {
    const o = new Oracle();
    o.roots = new Map([...this.roots].map(([k, v]) => [k, [...v]]));
    o.nodes = new Map([...this.nodes].map(([k, v]) => [k, { ...v, children: [...v.children] }]));
    return o;
  }

  private kids(parent: string): string[] {
    return this.roots.get(parent) ?? this.nodes.get(parent)!.children;
  }

  insert(id: string, node: Omit<ONode, 'children'>, index: number): void {
    this.nodes.set(id, { ...node, children: [] });
    const kids = this.kids(node.parent);
    kids.splice(Math.min(index, kids.length), 0, id);
  }

  move(id: string, parent: string, index: number): void {
    const n = this.nodes.get(id)!;
    const old = this.kids(n.parent);
    old.splice(old.indexOf(id), 1);
    const kids = this.kids(parent);
    kids.splice(Math.min(index, kids.length), 0, id);
    n.parent = parent;
  }

  remove(id: string): void {
    const n = this.nodes.get(id)!;
    const kids = this.kids(n.parent);
    kids.splice(kids.indexOf(id), 1);
    const drop = (x: string) => {
      for (const c of this.nodes.get(x)!.children) drop(c);
      this.nodes.delete(x);
    };
    drop(id);
  }

  canonical(): unknown {
    const render = (ids: string[]): unknown[] =>
      ids.map((id) => {
        const n = this.nodes.get(id)!;
        return [id, n.kind, n.title, n.url, render(n.children)];
      });
    return [...this.roots].map(([r, kids]) => [r, render(kids)]);
  }
}

const TRACE = !!process.env.ORACLE_TRACE;

async function runSequential(seed: number, devices: number, actions: Action[]) {
  const sim = new Simulator({ devices, seed, faults: false });
  await sim.setup();
  let oracle = new Oracle();
  const checkpoints: { t: string; oracle: Oracle }[] = [];
  const sidOf = (map: Map<string, string>, local: string) => ROOT_OF_LOCAL[local] ?? map.get(local)!;

  for (const act of actions) {
    const d: SimDevice = sim.devices[act.a % sim.devices.length]!;
    if (act.k < 60) {
      const before = new Map(d.engine.state.idmap);
      const edit = await performEdit(sim, d, act, FOLDER_HEAVY_KINDS);
      if (!edit) continue;
      if (TRACE) console.log('edit', edit.kind, edit.node, edit.parent, edit.index, edit.title);
      await sim.quiet();
      const after = new Map(d.engine.state.idmap);
      switch (edit.kind) {
        case 'addBookmark':
        case 'addFolder':
          oracle.insert(
            after.get(edit.node!)!,
            {
              kind: edit.kind === 'addFolder' ? 'folder' : 'bookmark',
              title: edit.title!,
              url: edit.url!,
              parent: sidOf(before, edit.parent!),
            },
            edit.index!,
          );
          break;
        case 'rename':
          oracle.nodes.get(sidOf(before, edit.node!))!.title = edit.title!;
          break;
        case 'setUrl':
          oracle.nodes.get(sidOf(before, edit.node!))!.url = edit.url!;
          break;
        case 'move':
          oracle.move(sidOf(before, edit.node!), sidOf(before, edit.parent!), edit.index!);
          break;
        case 'remove':
          oracle.remove(sidOf(before, edit.node!));
          break;
      }
    } else if (act.k < 75) {
      checkpoints.push({ t: d.engine.restorePoint(), oracle: oracle.clone() });
      sim.advance(1000);
    } else if (act.k < 95) {
      const cp = checkpoints[act.b % Math.max(checkpoints.length, 1)];
      if (!cp) continue;
      if (TRACE) console.log('restore to checkpoint', checkpoints.indexOf(cp));
      await d.engine.restoreTo(cp.t);
      await sim.quiet();
      oracle = cp.oracle.clone();
    } else {
      await sim.restart(d);
    }
    sim.advance(1000);
    if (TRACE) console.log(JSON.stringify(act), JSON.stringify(sim.canonicalMirror(sim.devices[0]!)));
    for (const dev of sim.devices) expect(sim.canonicalMirror(dev)).toEqual(oracle.canonical());
  }
  for (const dev of sim.devices) expect(await sim.canonicalLive(dev)).toEqual(oracle.canonical());
}

const action = fc.record({ k: fc.nat(99), a: fc.nat(1000), b: fc.nat(1000), c: fc.nat(1000) });

describe('sequential oracle (property 3)', () => {
  it('a single device matches a plain tree model, including restores', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1e9 }), fc.array(action, { minLength: 20, maxLength: 80 }), async (seed, actions) => {
        await runSequential(seed, 1, actions);
      }),
      { numRuns: 300 },
    );
  });

  it('several fully synced devices match a plain tree model, including restores', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 2, max: 3 }), fc.array(action, { maxLength: 30 }), async (seed, devices, actions) => {
        await runSequential(seed, devices, actions);
      }),
      { numRuns: 40 },
    );
  });

  it('regression: shrunk case 1', async () => {
    const actions: Action[] = [
      { k: 0, a: 0, b: 0, c: 0 },
      { k: 0, a: 0, b: 0, c: 0 },
      { k: 75, a: 0, b: 0, c: 0 },
      { k: 0, a: 0, b: 0, c: 0 },
      { k: 0, a: 0, b: 0, c: 0 },
      { k: 0, a: 507, b: 0, c: 0 },
      { k: 0, a: 67, b: 0, c: 171 },
      { k: 60, a: 0, b: 0, c: 0 },
      { k: 0, a: 0, b: 0, c: 0 },
      { k: 0, a: 0, b: 0, c: 0 },
      { k: 60, a: 0, b: 0, c: 0 },
      { k: 0, a: 134, b: 0, c: 0 },
      { k: 0, a: 0, b: 603, c: 0 },
      { k: 60, a: 0, b: 0, c: 0 },
      { k: 0, a: 0, b: 746, c: 0 },
      { k: 0, a: 347, b: 482, c: 373 },
      { k: 75, a: 0, b: 0, c: 0 },
      { k: 75, a: 0, b: 719, c: 0 },
      { k: 0, a: 0, b: 0, c: 0 },
      { k: 0, a: 0, b: 0, c: 0 },
    ];
    await runSequential(1, 1, actions);
  });

  it('regression: moving a folder into a deleted-then-restored folder keeps its contents (checklist 28)', async () => {
    const sim = new Simulator({ devices: 1, seed: 7, faults: false });
    await sim.setup();
    const d = sim.devices[0]!;
    const bm = d.bookmarks;
    const a = await bm.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'A', url: '' });
    await bm.create({ parentId: a, kind: 'bookmark', title: 'x', url: 'https://x.example/' });
    const b = await bm.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'B', url: '' });
    await sim.quiet();
    const t = d.engine.restorePoint();
    sim.advance(1000);
    await bm.removeTree(b);
    await sim.quiet();
    await d.engine.restoreTo(t);
    await sim.quiet();
    const bAgain = d.engine.state.idmap.find(([, sid]) => sid === d.engine.mirror().nodes.get([...d.engine.mirror().nodes.values()].find((n) => n.title === 'B')!.id)!.id)![0];
    await bm.move(a, { parentId: bAgain });
    await sim.quiet();
    const titles = [...d.engine.mirror().nodes.values()].map((n) => n.title).sort();
    expect(titles).toEqual(['A', 'B', 'x']);
  });
});
