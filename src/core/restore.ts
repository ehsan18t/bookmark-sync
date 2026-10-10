// Restore and revert planning (IMPLEMENTATION.md 9.3).
// The plan turns the merged tree "now" into the merged tree "then". Placement ops are emitted in
// preorder of "then", so a folder is always placed before anything moves into it and no restore op
// can be skipped as a cycle.

import type { OpDraft, SubtreeSnapshot } from './ops.js';
import { childrenIndex, preorder, type Tree, type TreeNode } from './tree.js';

export function planRestore(now: Tree, then: Tree, only?: ReadonlySet<string>): OpDraft[] {
  const scope = only ? closeOverParents(now, then, only) : undefined;
  const inScope = (id: string) => !scope || scope.has(id);
  const drafts: OpDraft[] = [];

  for (const t of preorder(then)) {
    if (!inScope(t.id)) continue;
    const n = now.nodes.get(t.id);
    if (!n) {
      drafts.push({
        type: 'undelete',
        node: t.id,
        kind: t.kind,
        parent: t.parent,
        pos: t.pos,
        fields: t.kind === 'bookmark' ? { title: t.title, url: t.url } : { title: t.title },
      });
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

  // Deletes for nodes visible now but not then. Only the topmost one of each removed subtree is
  // needed, and any node it contains that survives has already been moved out above.
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
 * Plan a restore and check it by simulation. Re-placing a folder (an undelete or a move) gives it a
 * new placement op that older deletes never saw, which can make descendants that were hidden only
 * through an ancestor's delete visible again. Simulating the plan finds such nodes so they get their
 * own delete, and finds anything still missing, until the result is exactly the target.
 *
 * `simulate` replays the merged state plus the drafts (stamped as if recorded now, in order) and
 * returns the resulting visible tree.
 */
export function planRestoreExact(
  now: Tree,
  then: Tree,
  simulate: (drafts: OpDraft[]) => Tree,
  only?: ReadonlySet<string>,
): OpDraft[] {
  const drafts = planRestore(now, then, only);
  const scope = only ? closeOverParents(now, then, only) : undefined;
  const target = (id: string) => (scope && !scope.has(id) ? now.nodes.has(id) : then.nodes.has(id));
  for (let round = 0; round < 8; round++) {
    const result = simulate(drafts);
    const extra = preorder(result).filter((n) => !target(n.id));
    const missing = preorder(then).filter((n) => (!scope || scope.has(n.id)) && !result.nodes.has(n.id));
    if (extra.length === 0 && missing.length === 0) return drafts;
    const idx = childrenIndex(result);
    for (const n of missing) {
      drafts.push({
        type: 'undelete',
        node: n.id,
        kind: n.kind,
        parent: n.parent,
        pos: n.pos,
        fields: n.kind === 'bookmark' ? { title: n.title, url: n.url } : { title: n.title },
      });
    }
    const extraIds = new Set(extra.map((n) => n.id));
    for (const n of extra) {
      if (extraIds.has(n.parent)) continue; // the topmost delete covers it
      drafts.push({ type: 'delete', node: n.id, before: snapshot(n, idx) });
    }
  }
  throw new Error('restore plan did not reach the target state');
}

/** A revert of a set of nodes also needs every ancestor (at "then") that is not visible now. */
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

function snapshot(n: TreeNode, idx: Map<string, TreeNode[]>): SubtreeSnapshot {
  return { id: n.id, kind: n.kind, title: n.title, url: n.url, children: (idx.get(n.id) ?? []).map((c) => snapshot(c, idx)) };
}
