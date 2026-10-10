// Applying merged state to the browser (IMPLEMENTATION.md 8.4).
// Runs inside a queue task, right after reconcile, so the live tree equals the mirror when it starts.

import type { LiveNode, Mirror, MirrorNode } from '../core/reconcile.js';
import { childrenIndex, diffTrees, type Tree, type TreeNode } from '../core/tree.js';
import type { BookmarksPort } from './ports.js';

export interface ApplyResult {
  mirror: Mirror;
  idmap: Map<string, string>;
  changed: boolean;
}

export async function applyMerged(
  port: BookmarksPort,
  rootLocal: Readonly<Record<string, string>>,
  mirror: Mirror,
  merged: Tree,
  excluded: ReadonlySet<string>,
): Promise<ApplyResult> {
  const mirrorTree: Tree = { roots: mirror.roots, nodes: mirror.nodes };
  const diff = diffTrees(mirrorTree, merged);
  const localOf = new Map<string, string>(Object.entries(rootLocal));
  for (const m of mirror.nodes.values()) localOf.set(m.id, m.localId);
  const local = (sid: string): string => {
    const l = localOf.get(sid);
    if (l === undefined) throw new Error(`no local folder for ${sid}`);
    return l;
  };

  // 1. Creates, parents first. They go to the end of the parent; step 5 fixes the order.
  for (const n of diff.creates) {
    const id = await port.create({ parentId: local(n.parent), kind: n.kind, title: n.title, url: n.url });
    localOf.set(n.id, id);
  }
  // 2. Moves to a different parent.
  for (const n of diff.moves) {
    const old = mirror.nodes.get(n.id)!;
    if (old.parent !== n.parent) await port.move(local(n.id), { parentId: local(n.parent) });
  }
  // 3. Field updates.
  for (const n of diff.updates) {
    await port.update(local(n.id), n.kind === 'bookmark' ? { title: n.title, url: n.url } : { title: n.title });
  }
  // 4. Deletes: only the topmost node of each removed subtree. Survivors were moved out in step 2.
  const deleted = new Set(diff.deletes.map((n) => n.id));
  for (const n of diff.deletes) {
    if (deleted.has(mirror.nodes.get(n.id)!.parent)) continue;
    await port.removeTree(local(n.id));
    localOf.delete(n.id);
  }

  // 5. Order: for every folder whose children are not in group order, move the fewest children.
  const changed = diff.creates.length + diff.moves.length + diff.updates.length + diff.deletes.length > 0;
  if (changed) await reorder(port, merged, localOf, excluded);

  const nodes = new Map<string, MirrorNode>();
  const idmap = new Map<string, string>();
  for (const n of merged.nodes.values()) {
    const localId = local(n.id);
    nodes.set(n.id, { ...n, localId });
    idmap.set(localId, n.id);
  }
  return { mirror: { roots: merged.roots, nodes }, idmap, changed };
}

async function reorder(
  port: BookmarksPort,
  merged: Tree,
  localOf: Map<string, string>,
  excluded: ReadonlySet<string>,
): Promise<void> {
  const idx = childrenIndex(merged);
  const folders: string[] = [...merged.roots, ...[...merged.nodes.values()].filter((n) => n.kind === 'folder').map((n) => n.id)];
  const liveByLocal = new Map<string, LiveNode>();
  for (const r of merged.roots) index(await port.getSubTree(localOf.get(r)!), liveByLocal);

  for (const folder of folders) {
    const parentLocal = localOf.get(folder)!;
    const current = (liveByLocal.get(parentLocal)?.children ?? []).map((c) => c.localId);
    const desired = (idx.get(folder) ?? []).map((c: TreeNode) => localOf.get(c.id)!);
    const inGroup = current.filter((l) => !excluded.has(l));
    if (sameOrder(inGroup, desired)) continue;

    const keep = longestIncreasingByPosition(desired.map((l) => current.indexOf(l)));
    for (let j = 0; j < desired.length; j++) {
      if (keep.has(j)) continue;
      const l = desired[j]!;
      current.splice(current.indexOf(l), 1);
      const target = j === 0 ? 0 : current.indexOf(desired[j - 1]!) + 1;
      current.splice(target, 0, l);
      await port.move(l, { parentId: parentLocal, index: target });
    }
  }
}

function index(n: LiveNode, out: Map<string, LiveNode>): void {
  out.set(n.localId, n);
  for (const c of n.children ?? []) index(c, out);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function longestIncreasingByPosition(positions: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(positions.length).fill(-1);
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    if (p < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (positions[tails[mid]!]! < p) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let cur = tails.length ? tails[tails.length - 1]! : -1;
  while (cur !== -1) {
    keep.add(cur);
    cur = prev[cur]!;
  }
  return keep;
}
