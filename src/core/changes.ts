import type { Hlc } from './hlc.js';
import { isRootId, ROOT_GROUP } from './ids.js';
import { compareOps, type Kind, type Op, opKey, type SubtreeSnapshot } from './ops.js';
import type { GroupState } from './replay.js';

export interface ChangeDetail {
  type: Op['type'];
  at: Hlc;
  kind: Kind;
  title: string;
  url: string;
  /** Folder titles from the top down; a fixed browser root is its ID (`root:toolbar`). */
  folder: string[];
  /** Moves: the folder it left. */
  from?: string[];
  edits?: { field: 'title' | 'url'; before: string; after: string }[];
  /** Removed folders: how many items they held. */
  items?: number;
}

interface Known {
  kind: Kind;
  title: string;
  url: string;
  parent: string;
}

const countItems = (s: SubtreeSnapshot): number => s.children.reduce((n, c) => n + 1 + countItems(c), 0);

/** Each op with names and folders as they were when it was made; concurrent edits are taken in op order. */
export function describeOps(base: GroupState, ops: readonly Op[]): Map<string, ChangeDetail> {
  const known = new Map<string, Known>();
  for (const n of base.nodes.values()) {
    if (n.kind && n.placement) known.set(n.id, { kind: n.kind, title: n.title?.value ?? '', url: n.url?.value ?? '', parent: n.placement.parent });
  }
  const folderOf = (parent: string): string[] => {
    const path: string[] = [];
    for (let id = parent, depth = 0; depth < 1_000; depth++) {
      if (isRootId(id)) {
        if (id !== ROOT_GROUP) path.unshift(id);
        break;
      }
      const k = known.get(id);
      if (!k) break;
      path.unshift(k.title);
      id = k.parent;
    }
    return path;
  };

  const out = new Map<string, ChangeDetail>();
  for (const op of [...ops].sort(compareOps)) {
    const was = known.get(op.node);
    const put = (d: Omit<ChangeDetail, 'at'>) => out.set(opKey(op), { ...d, at: op.hlc });
    switch (op.type) {
      case 'create':
      case 'undelete': {
        const k: Known = { kind: op.kind, title: op.fields.title ?? '', url: op.fields.url ?? '', parent: op.parent };
        known.set(op.node, k);
        put({ type: op.type, kind: k.kind, title: k.title, url: k.url, folder: folderOf(k.parent) });
        break;
      }
      case 'update': {
        const old = (f: 'title' | 'url') => op.before[f] ?? was?.[f] ?? '';
        const edits = (['title', 'url'] as const).flatMap((f) => {
          const after = op.fields[f];
          return after === undefined || after === old(f) ? [] : [{ field: f, before: old(f), after }];
        });
        const k: Known = { kind: was?.kind ?? 'bookmark', parent: was?.parent ?? '', title: op.fields.title ?? was?.title ?? '', url: op.fields.url ?? was?.url ?? '' };
        if (was) known.set(op.node, k);
        put({ type: 'update', kind: k.kind, title: k.title, url: k.url, folder: folderOf(k.parent), edits });
        break;
      }
      case 'move': {
        const k: Known = { kind: was?.kind ?? 'bookmark', title: was?.title ?? '', url: was?.url ?? '', parent: op.parent };
        if (was) known.set(op.node, k);
        const from = op.before.parent === op.parent ? undefined : folderOf(op.before.parent);
        put({ type: 'move', kind: k.kind, title: k.title, url: k.url, folder: folderOf(op.parent), ...(from ? { from } : {}) });
        break;
      }
      case 'delete': {
        const s = op.before;
        put({ type: 'delete', kind: s.kind, title: s.title, url: s.url, folder: was ? folderOf(was.parent) : [], ...(s.kind === 'folder' ? { items: countItems(s) } : {}) });
        break;
      }
    }
  }
  return out;
}
