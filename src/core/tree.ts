// Visible trees in group terms and diffs between them (IMPLEMENTATION.md 4.4 and 4.5).

import type { Kind } from './ops.js';
import type { GroupState } from './replay.js';
import { visibleSet } from './visibility.js';

export interface TreeNode {
  id: string;
  kind: Kind;
  parent: string;
  pos: string;
  title: string;
  url: string;
}

export interface Tree {
  roots: readonly string[];
  nodes: Map<string, TreeNode>;
}

export function compareSiblings(a: TreeNode, b: TreeNode): number {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function visibleTree(s: GroupState, roots: readonly string[]): Tree {
  const vis = visibleSet(s);
  const nodes = new Map<string, TreeNode>();
  for (const id of vis) {
    const n = s.nodes.get(id)!;
    nodes.set(id, {
      id,
      kind: n.kind!,
      parent: n.placement!.parent,
      pos: n.placement!.pos,
      title: n.title?.value ?? '',
      url: n.url?.value ?? '',
    });
  }
  // Nodes whose root is not one of this group's roots cannot be shown anywhere.
  for (const [id] of nodes) if (!roots.includes(rootOf(nodes, id))) nodes.delete(id);
  return { roots, nodes };
}

function rootOf(nodes: Map<string, TreeNode>, id: string): string {
  let cur = nodes.get(id);
  while (cur) {
    const p = nodes.get(cur.parent);
    if (!p) return cur.parent;
    cur = p;
  }
  return id;
}

/** Children of every folder (roots included), in group order. */
export function childrenIndex(t: Tree): Map<string, TreeNode[]> {
  const idx = new Map<string, TreeNode[]>();
  for (const r of t.roots) idx.set(r, []);
  for (const n of t.nodes.values()) {
    let list = idx.get(n.parent);
    if (!list) idx.set(n.parent, (list = []));
    list.push(n);
  }
  for (const list of idx.values()) list.sort(compareSiblings);
  return idx;
}

export function preorder(t: Tree): TreeNode[] {
  const idx = childrenIndex(t);
  const out: TreeNode[] = [];
  const walk = (parent: string) => {
    for (const c of idx.get(parent) ?? []) {
      out.push(c);
      walk(c.id);
    }
  };
  for (const r of t.roots) walk(r);
  return out;
}

export interface TreeDiff {
  /** In preorder of the target tree, so parents come first. */
  creates: TreeNode[];
  /** Nodes whose parent or position changed, in preorder of the target tree. */
  moves: TreeNode[];
  updates: TreeNode[];
  /** In postorder of the source tree, so children come first. */
  deletes: TreeNode[];
}

export function diffTrees(a: Tree, b: Tree): TreeDiff {
  const diff: TreeDiff = { creates: [], moves: [], updates: [], deletes: [] };
  for (const n of preorder(b)) {
    const old = a.nodes.get(n.id);
    if (!old) diff.creates.push(n);
    else {
      if (old.parent !== n.parent || old.pos !== n.pos) diff.moves.push(n);
      if (old.title !== n.title || old.url !== n.url) diff.updates.push(n);
    }
  }
  for (const n of preorder(a).reverse()) if (!b.nodes.has(n.id)) diff.deletes.push(n);
  return diff;
}

export const diffSize = (d: TreeDiff): number =>
  new Set([...d.creates, ...d.moves, ...d.updates, ...d.deletes].map((n) => n.id)).size;

/** A canonical, comparable rendering: nested [kind, title, url, children] by group order, IDs included. */
export function canonical(t: Tree, withIds = true): unknown {
  const idx = childrenIndex(t);
  const render = (parent: string): unknown[] =>
    (idx.get(parent) ?? []).map((c) =>
      withIds ? [c.id, c.kind, c.title, c.url, render(c.id)] : [c.kind, c.title, c.url, render(c.id)],
    );
  return t.roots.map((r) => [r, render(r)]);
}
