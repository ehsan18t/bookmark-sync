import { describe, expect, it } from 'vitest';
import { FAKE_ROOTS, FakeBookmarks } from '../../test/sim/fakeBookmarks.js';
import type { Tree } from '../core/tree.js';
import { applyMerged } from './apply.js';

const ROOT = 'root:group';

async function setup(url: string) {
  const port = new FakeBookmarks('x_');
  const box = await port.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Box', url: '' });
  const twin = await port.create({ parentId: FAKE_ROOTS.toolbar, kind: 'bookmark', title: 'Mine', url: 'https://mine.example/' });
  const merged: Tree = { roots: [ROOT], nodes: new Map([['n1', { id: 'n1', kind: 'bookmark', parent: ROOT, pos: 'a0', title: 'Theirs', url }]]) };
  const result = await applyMerged(port, { [ROOT]: box }, { roots: [ROOT], nodes: new Map() }, merged, new Set(), {
    adopt: () => twin,
    release: () => false,
  });
  return { port, box, twin, result };
}

describe('applyMerged with another group holding a twin', () => {
  it('moves an identical twin into place instead of copying it, without editing it', async () => {
    const { port, box, twin, result } = await setup('https://mine.example/');
    expect(result.idmap.get(twin)).toBe('n1');
    expect((await port.getSubTree(box)).children!.map((c) => [c.localId, c.title])).toEqual([[twin, 'Mine']]);
  });

  it('never takes over a folder twin that has contents', async () => {
    const port = new FakeBookmarks('x_');
    const box = await port.create({ parentId: FAKE_ROOTS.other, kind: 'folder', title: 'Box', url: '' });
    const twin = await port.create({ parentId: FAKE_ROOTS.toolbar, kind: 'folder', title: 'Games', url: '' });
    await port.create({ parentId: twin, kind: 'bookmark', title: 'Private', url: 'https://private.example/' });
    const merged: Tree = { roots: [ROOT], nodes: new Map([['n1', { id: 'n1', kind: 'folder', parent: ROOT, pos: 'a0', title: 'Games', url: '' }]]) };
    const result = await applyMerged(port, { [ROOT]: box }, { roots: [ROOT], nodes: new Map() }, merged, new Set(), { adopt: () => twin, release: () => false });
    expect(result.idmap.get(twin)).toBeUndefined();
    expect((await port.getSubTree(box)).children!.map((c) => [c.title, c.children?.length ?? 0])).toEqual([['Games', 0]]);
  });

  it('never takes over or edits a twin with a different address', async () => {
    const { port, box, twin, result } = await setup('https://evil.example/');
    expect(result.idmap.get(twin)).toBeUndefined();
    expect((await port.getSubTree(box)).children!.map((c) => c.url)).toEqual(['https://evil.example/']);
    expect((await port.getSubTree(FAKE_ROOTS.toolbar)).children!.map((c) => [c.localId, c.url])).toEqual([[twin, 'https://mine.example/']]);
  });
});
