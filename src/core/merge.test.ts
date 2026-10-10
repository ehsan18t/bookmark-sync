import { describe, expect, it } from 'vitest';
import { formatHlc } from './hlc.js';
import { ROOT_OTHER, ROOT_TOOLBAR, EVERYTHING_ROOTS } from './ids.js';
import type { Op } from './ops.js';
import { emptyState, replay } from './replay.js';
import { canonical, visibleTree } from './tree.js';

// A tiny op builder. Each device numbers its own ops; `t` is the wall time of the HLC.
class Dev {
  seq = 0;
  constructor(readonly id: string) {}
  private base(t: number, node: string) {
    return { device: this.id, opSeq: ++this.seq, hlc: formatHlc(1000 + t, 0, this.id), node };
  }
  folder(t: number, node: string, parent = ROOT_OTHER, pos = 'a0', title = node): Op {
    return { ...this.base(t, node), type: 'create', kind: 'folder', parent, pos, fields: { title } };
  }
  bookmark(t: number, node: string, parent: string, pos = 'a0', url = `https://${node}.example`): Op {
    return { ...this.base(t, node), type: 'create', kind: 'bookmark', parent, pos, fields: { title: node, url } };
  }
  rename(t: number, node: string, title: string): Op {
    return { ...this.base(t, node), type: 'update', fields: { title }, before: {} };
  }
  setUrl(t: number, node: string, url: string): Op {
    return { ...this.base(t, node), type: 'update', fields: { url }, before: {} };
  }
  move(t: number, node: string, parent: string, pos = 'a0'): Op {
    return { ...this.base(t, node), type: 'move', parent, pos, before: { parent: '', pos: '' } };
  }
  /** `seen` lists what this device had applied from each device, its own ops included automatically. */
  del(t: number, node: string, seen: Record<string, number> = {}): Op {
    const b = this.base(t, node);
    return {
      ...b,
      type: 'delete',
      seen: { ...seen, [this.id]: b.opSeq - 1 },
      before: { id: node, kind: 'folder', title: '', url: '', children: [] },
    };
  }
  undelete(t: number, node: string, parent: string, kind: 'folder' | 'bookmark' = 'folder', pos = 'a0'): Op {
    return { ...this.base(t, node), type: 'undelete', kind, parent, pos, fields: { title: node } };
  }
}

const tree = (ops: Op[]) => visibleTree(replay(emptyState(), ops), EVERYTHING_ROOTS);
const visible = (ops: Op[]) => [...tree(ops).nodes.keys()].sort();

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('conflict rules (spec rule 12, IMPLEMENTATION 4.3)', () => {
  it('a bookmark added to a folder deleted concurrently survives, alone (checklist 3)', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [a.folder(1, 'F'), a.bookmark(2, 'old', 'F')];
    // b has seen a's ops 1-2 and adds a bookmark; a deletes F without seeing b's add.
    ops.push(b.bookmark(3, 'pasta', 'F', 'a1'));
    ops.push(a.del(4, 'F'));
    expect(visible(ops)).toEqual(['F', 'pasta']);
  });

  it('a delete that saw an item removes it even if a nested delete did not (checklist 4)', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const c = new Dev('c');
    const ops = [a.folder(1, 'P'), a.folder(2, 'F', 'P')];
    ops.push(c.bookmark(3, 'x', 'F')); // c:1
    ops.push(a.del(4, 'P', { c: 1 })); // a saw x
    ops.push(b.del(5, 'F', { a: 2 })); // b did not see x
    expect(visible(ops)).toEqual([]);
  });

  it('moving a folder into a deleted-then-restored folder keeps its contents (checklist 28)', () => {
    const a = new Dev('a');
    const ops = [a.folder(1, 'A'), a.bookmark(2, 'x', 'A'), a.folder(3, 'B', ROOT_OTHER, 'a1')];
    ops.push(a.del(4, 'B'));
    ops.push(a.undelete(5, 'B', ROOT_OTHER));
    ops.push(a.move(6, 'A', 'B'));
    expect(visible(ops)).toEqual(['A', 'B', 'x']);
  });

  it('a folder moved into a folder deleted concurrently keeps its contents and revives it', () => {
    const d = new Dev('d');
    const e = new Dev('e');
    const ops = [d.folder(1, 'A'), d.bookmark(2, 'x', 'A'), d.folder(3, 'B', ROOT_OTHER, 'a1')];
    ops.push(e.move(4, 'A', 'B')); // e saw d:1-3
    ops.push(d.del(5, 'B')); // d did not see e's move
    expect(visible(ops)).toEqual(['A', 'B', 'x']);
  });

  it('an item moved out of a folder deleted concurrently survives at its new place', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [a.folder(1, 'P'), a.bookmark(2, 'x', 'P'), a.bookmark(3, 'y', 'P', 'a1')];
    ops.push(b.move(4, 'x', ROOT_TOOLBAR));
    ops.push(a.del(5, 'P'));
    expect(visible(ops)).toEqual(['x']);
    expect(tree(ops).nodes.get('x')!.parent).toBe(ROOT_TOOLBAR);
  });

  it('a delete beats a concurrent rename of the same item', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [a.bookmark(1, 'x', ROOT_OTHER), b.rename(2, 'x', 'renamed'), a.del(3, 'x')];
    expect(visible(ops)).toEqual([]);
  });

  it('a delete beats a concurrent move of the same item', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [a.bookmark(1, 'x', ROOT_OTHER), b.move(2, 'x', ROOT_TOOLBAR), a.del(3, 'x')];
    expect(visible(ops)).toEqual([]);
  });

  it('an undelete wins over the delete it has seen (checklist 13)', () => {
    const a = new Dev('a');
    const ops = [a.folder(1, 'F'), a.bookmark(2, 'x', 'F'), a.del(3, 'F')];
    ops.push(a.undelete(4, 'F', ROOT_OTHER), a.undelete(5, 'x', 'F', 'bookmark'));
    expect(visible(ops)).toEqual(['F', 'x']);
  });

  it('the later rename wins (checklist 5)', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [a.bookmark(1, 'x', ROOT_OTHER), b.rename(3, 'x', 'from b'), a.rename(2, 'x', 'from a')];
    expect(tree(ops).nodes.get('x')!.title).toBe('from b');
  });

  it('a rename and a URL change on different devices both apply (checklist 6)', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [a.bookmark(1, 'x', ROOT_OTHER), a.rename(2, 'x', 'new title'), b.setUrl(3, 'x', 'https://new.example')];
    const x = tree(ops).nodes.get('x')!;
    expect([x.title, x.url]).toEqual(['new title', 'https://new.example']);
  });

  it('concurrent moves that would form a cycle skip one move, the same way in any order (checklist 7)', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const base = [a.folder(1, 'F'), a.folder(2, 'G', ROOT_OTHER, 'a1')];
    const ops = [...base, a.move(3, 'F', 'G'), b.move(4, 'G', 'F')];
    const expected = canonical(tree(ops));
    for (let seed = 1; seed < 20; seed++) expect(canonical(tree(shuffled(ops, seed)))).toEqual(expected);
    const t = tree(ops);
    expect(t.nodes.get('F')!.parent).toBe('G'); // the later move (G into F) was skipped
    expect(t.nodes.get('G')!.parent).toBe(ROOT_OTHER);
  });

  it('a create on an existing node does not overwrite newer edits (derived join IDs)', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [a.folder(1, 'j1', ROOT_OTHER, 'a0', 'Work'), a.rename(2, 'j1', 'Job'), a.move(3, 'j1', ROOT_TOOLBAR)];
    ops.push(b.folder(4, 'j1', ROOT_OTHER, 'a0', 'Work'));
    const n = tree(ops).nodes.get('j1')!;
    expect([n.title, n.parent]).toEqual(['Job', ROOT_TOOLBAR]);
  });

  it('two identical joins merge into one node', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [a.folder(1, 'j1', ROOT_OTHER, 'a0', 'Work'), b.folder(1, 'j1', ROOT_OTHER, 'a0', 'Work')];
    expect(visible(ops)).toEqual(['j1']);
  });

  it('an op that arrives before its create is held on a stub and applied once the create arrives', () => {
    const a = new Dev('a');
    const create = a.bookmark(1, 'x', ROOT_OTHER);
    const rename = a.rename(2, 'x', 'renamed');
    expect(visible([rename])).toEqual([]);
    expect(tree([rename, create]).nodes.get('x')!.title).toBe('renamed');
  });

  it('replay does not depend on arrival order', () => {
    const a = new Dev('a');
    const b = new Dev('b');
    const ops = [
      a.folder(1, 'F'),
      a.bookmark(2, 'x', 'F'),
      a.folder(3, 'G', ROOT_OTHER, 'a1'),
      b.move(4, 'x', 'G'),
      a.del(5, 'G'),
      b.rename(6, 'x', 'renamed'),
      a.bookmark(7, 'y', 'F', 'a1'),
    ];
    const expected = canonical(tree(ops));
    for (let seed = 1; seed < 30; seed++) expect(canonical(tree(shuffled(ops, seed)))).toEqual(expected);
  });
});
