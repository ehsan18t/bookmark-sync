import type { OpDraft, SubtreeSnapshot } from './ops.js';
import { childrenIndex, preorder, type Tree, type TreeNode } from './tree.js';

const fieldsOf = (n: TreeNode) => (n.kind === 'bookmark' ? { title: n.title, url: n.url } : { title: n.title });

/**
 * Drafts that turn `now` into `then` (or, with `only`, just those nodes). Placement ops follow the
 * preorder of `then`, so a folder is placed before anything moves into it and none is a cycle.
 */
export function planRestore(now: Tree, then: Tree, only?: ReadonlySet<string>): OpDraft[] {
  const scope = only ? closeOverParents(now, then, only) : undefined;
  const inScope = (id: string) => !scope || scope.has(id);
  const drafts: OpDraft[] = [];

  for (const t of preorder(then)) {
    if (!inScope(t.id)) continue;
    const n = now.nodes.get(t.id);
    if (!n) {
      drafts.push({ type: 'undelete', node: t.id, kind: t.kind, parent: t.parent, pos: t.pos, fields: fieldsOf(t) });
      continue;
    }
    if (n.parent !== t.parent || n.pos !== t.pos) {
      drafts.push({ type: 'move', node: t.id, parent: t.parent, pos: t.pos, before: { parent: n.parent, pos: n.pos } });
    }
    const fields: { title?: string; url?: string } = {};
    const before: { title?: string; url?: string } = {};
    if (n.title !== t.title) {
      fields.title = t.title;
      before.title = n.title;
    }
    if (t.kind === 'bookmark' && n.url !== t.url) {
      fields.url = t.url;
      before.url = n.url;
    }
    if (Object.keys(fields).length) drafts.push({ type: 'update', node: t.id, fields, before });
  }

  const idx = childrenIndex(now);
  for (const n of preorder(now)) {
    if (then.nodes.has(n.id) || !inScope(n.id)) continue;
    const parent = now.nodes.get(n.parent);
    if (parent && !then.nodes.has(parent.id) && inScope(parent.id)) continue;
    drafts.push({ type: 'delete', node: n.id, before: snapshot(n, idx) });
  }
  return drafts;
}

/**
 * Re-placing a folder gives it a placement op older deletes never saw, which can make descendants
 * hidden only through an ancestor's delete visible again. So the plan is replayed by `simulate` and
 * patched until the result is exactly the target.
 */
export function planRestoreExact(now: Tree, then: Tree, simulate: (drafts: OpDraft[]) => Tree, only?: ReadonlySet<string>): OpDraft[] {
  const drafts = planRestore(now, then, only);
  const scope = only ? closeOverParents(now, then, only) : undefined;
  const target = (id: string) => (scope && !scope.has(id) ? now.nodes.has(id) : then.nodes.has(id));
  for (let round = 0; round < 8; round++) {
    const result = simulate(drafts);
    const extra = preorder(result).filter((n) => !target(n.id));
    const missing = preorder(then).filter((n) => (!scope || scope.has(n.id)) && !result.nodes.has(n.id));
    if (extra.length === 0 && missing.length === 0) return drafts;
    for (const n of missing) {
      drafts.push({ type: 'undelete', node: n.id, kind: n.kind, parent: n.parent, pos: n.pos, fields: fieldsOf(n) });
    }
    const idx = childrenIndex(result);
    const extraIds = new Set(extra.map((n) => n.id));
    for (const n of extra) {
      if (!extraIds.has(n.parent)) drafts.push({ type: 'delete', node: n.id, before: snapshot(n, idx) });
    }
  }
  throw new Error('restore plan did not reach the target state');
}

function closeOverParents(now: Tree, then: Tree, only: ReadonlySet<string>): Set<string> {
  const scope = new Set(only);
  for (const id of only) {
    let cur = then.nodes.get(id);
    while (cur) {
      const parent = then.nodes.get(cur.parent);
      if (!parent || now.nodes.has(parent.id)) break;
      scope.add(parent.id);
      cur = parent;
    }
  }
  return scope;
}

export function snapshot(n: TreeNode, idx: Map<string, TreeNode[]>): SubtreeSnapshot {
  return { id: n.id, kind: n.kind, title: n.title, url: n.url, children: (idx.get(n.id) ?? []).map((c) => snapshot(c, idx)) };
}
