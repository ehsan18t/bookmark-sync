import { describe, expect, it } from 'vitest';
import { describeOps } from './changes.js';
import { ROOT_OTHER, ROOT_TOOLBAR } from './ids.js';
import type { Op } from './ops.js';
import { emptyState } from './replay.js';

const at = (n: number) => `${String(n).padStart(15, '0')}-000000-a`;
const base = { device: 'a', node: '' };

describe('describeOps', () => {
  it('names items and folders as they were when each change was made', () => {
    const ops: Op[] = [
      { ...base, opSeq: 1, hlc: at(1), type: 'create', node: 'dev', kind: 'folder', parent: ROOT_TOOLBAR, pos: 'a', fields: { title: 'Dev' } },
      { ...base, opSeq: 2, hlc: at(2), type: 'create', node: 'mdn', kind: 'bookmark', parent: 'dev', pos: 'a', fields: { title: 'MDN Web Docs', url: 'https://mdn.example/' } },
      { ...base, opSeq: 3, hlc: at(3), type: 'update', node: 'mdn', fields: { title: 'MDN' }, before: { title: 'MDN Web Docs' } },
      { ...base, opSeq: 4, hlc: at(4), type: 'move', node: 'mdn', parent: ROOT_OTHER, pos: 'a', before: { parent: 'dev', pos: 'a' } },
      { ...base, opSeq: 5, hlc: at(5), type: 'update', node: 'dev', fields: { title: 'Work' }, before: { title: 'Dev' } },
      {
        ...base,
        opSeq: 6,
        hlc: at(6),
        type: 'delete',
        node: 'dev',
        seen: {},
        before: { id: 'dev', kind: 'folder', title: 'Work', url: '', children: [{ id: 'x', kind: 'bookmark', title: 'X', url: 'https://x.example/', children: [] }] },
      },
    ];
    const d = describeOps(emptyState(), ops);
    expect(d.get('a:2')).toMatchObject({ type: 'create', title: 'MDN Web Docs', folder: [ROOT_TOOLBAR, 'Dev'] });
    expect(d.get('a:3')).toMatchObject({ type: 'update', title: 'MDN', edits: [{ field: 'title', before: 'MDN Web Docs', after: 'MDN' }] });
    expect(d.get('a:4')).toMatchObject({ type: 'move', title: 'MDN', from: [ROOT_TOOLBAR, 'Dev'], folder: [ROOT_OTHER] });
    expect(d.get('a:6')).toMatchObject({ type: 'delete', kind: 'folder', title: 'Work', folder: [ROOT_TOOLBAR], items: 1 });
  });

  it('leaves out fields an edit did not change and marks a reorder as a move without a source', () => {
    const ops: Op[] = [
      { ...base, opSeq: 1, hlc: at(1), type: 'create', node: 'b', kind: 'bookmark', parent: ROOT_OTHER, pos: 'a', fields: { title: 'B', url: 'https://b.example/' } },
      { ...base, opSeq: 2, hlc: at(2), type: 'update', node: 'b', fields: { title: 'B', url: 'https://b2.example/' }, before: { title: 'B', url: 'https://b.example/' } },
      { ...base, opSeq: 3, hlc: at(3), type: 'move', node: 'b', parent: ROOT_OTHER, pos: 'b', before: { parent: ROOT_OTHER, pos: 'a' } },
    ];
    const d = describeOps(emptyState(), ops);
    expect(d.get('a:2')?.edits).toEqual([{ field: 'url', before: 'https://b.example/', after: 'https://b2.example/' }]);
    expect(d.get('a:3')?.from).toBeUndefined();
  });
});
