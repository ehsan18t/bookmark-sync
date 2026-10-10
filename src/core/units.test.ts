import { describe, expect, it } from 'vitest';
import { HlcClock, parseHlc } from './hlc.js';
import { ROOT_OTHER, ROOT_TOOLBAR } from './ids.js';
import { assignKeys } from './position.js';
import { reconcile, type LiveNode, type Mirror } from './reconcile.js';

describe('HLC', () => {
  it('orders ticks and survives a wall clock that steps back', () => {
    let now = 5_000;
    const c = new HlcClock('a', () => now);
    const t1 = c.tick();
    now = 1_000; // clock stepped back
    const t2 = c.tick();
    expect(t2 > t1).toBe(true);
    expect(parseHlc(t2).wall).toBe(5_000);
  });

  it('keeps every later tick above a reserved bound, even if the wall clock steps back', () => {
    let now = 10_000;
    const c = new HlcClock('a', () => now);
    const bound = c.reserveBound();
    now = 2_000;
    expect(c.tick() > bound).toBe(true);
  });

  it('observing a remote timestamp moves later ticks past it', () => {
    const c = new HlcClock('a', () => 1_000);
    const remote = new HlcClock('b', () => 9_000).tick();
    c.observe(remote);
    expect(c.tick() > remote).toBe(true);
  });
});

describe('position keys', () => {
  it('keeps the longest increasing run of existing keys and fills the rest in order', () => {
    const current = ['a2', null, 'a1', 'a3', null];
    const keys = assignKeys(current);
    // Two of the three existing keys can be kept (a2,a3 or a1,a3); either is a longest run.
    expect(keys.filter((k, i) => k === current[i]).length).toBe(2);
    expect(keys[3]).toBe('a3');
    expect([...keys].sort()).toEqual(keys); // strictly increasing in the given order
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('re-keys one of two equal keys so there is room between them', () => {
    const keys = assignKeys(['a1', null, 'a1']);
    expect(new Set(keys).size).toBe(3);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('reconcile', () => {
  const folder = (localId: string, title: string, children: LiveNode[] = []): LiveNode => ({ localId, kind: 'folder', title, url: '', children });
  const root = (children: LiveNode[]): LiveNode => folder('R', '', children);

  function run(mirror: Mirror, idmap: Map<string, string>, live: LiveNode) {
    let n = 0;
    return reconcile({
      roots: [{ groupRoot: ROOT_OTHER, live }],
      mirror,
      idmap,
      excluded: new Set(),
      newId: () => `new${++n}`,
    });
  }

  it('records nothing when the live tree equals the mirror (own changes are not re-recorded)', () => {
    const first = run({ roots: [ROOT_OTHER], nodes: new Map() }, new Map(), root([folder('l1', 'A', [folder('l2', 'B')])]));
    expect(first.drafts.map((d) => d.type)).toEqual(['create', 'create']);
    const again = run(first.mirror, first.idmap, root([folder('l1', 'A', [folder('l2', 'B')])]));
    expect(again.drafts).toEqual([]);
  });

  it('emits a parent-first move order when two folders swap nesting, so no move is a cycle', () => {
    const first = run({ roots: [ROOT_OTHER], nodes: new Map() }, new Map(), root([folder('l1', 'A', [folder('l2', 'B')])]));
    const swapped = run(first.mirror, first.idmap, root([folder('l2', 'B', [folder('l1', 'A')])]));
    const moves = swapped.drafts.filter((d) => d.type === 'move');
    expect(moves.map((m) => m.node)).toEqual(['new2', 'new1']); // B to the root first, then A into B
  });

  it('records one delete for a removed folder, not one per child', () => {
    const first = run({ roots: [ROOT_OTHER], nodes: new Map() }, new Map(), root([folder('l1', 'A', [folder('l2', 'B')])]));
    const removed = run(first.mirror, first.idmap, root([]));
    expect(removed.drafts.map((d) => [d.type, d.node])).toEqual([['delete', 'new1']]);
  });

  it('a child moved out of a removed folder becomes a move plus the folder delete', () => {
    const first = run({ roots: [ROOT_OTHER], nodes: new Map() }, new Map(), root([folder('l1', 'A', [folder('l2', 'B')])]));
    const out = run(first.mirror, first.idmap, root([folder('l2', 'B')]));
    expect(out.drafts.map((d) => [d.type, d.node])).toEqual([
      ['move', 'new2'],
      ['delete', 'new1'],
    ]);
    void ROOT_TOOLBAR;
  });
});
