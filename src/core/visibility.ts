import { isRootId } from './ids.js';
import type { OpRef } from './ops.js';
import type { GroupState, NodeState } from './replay.js';

export const covers = (seen: Record<string, number>, r: OpRef): boolean => r.opSeq <= (seen[r.device] ?? 0);

export function ownAlive(n: NodeState): boolean {
  return n.kind !== null && n.aliveEvents.some((a) => !n.deletes.some((d) => covers(d.seen, a)));
}

function parentOf(s: GroupState, n: NodeState): NodeState | undefined {
  const p = n.placement?.parent;
  return p === undefined || isRootId(p) ? undefined : s.nodes.get(p);
}

export function hasRootPath(s: GroupState, n: NodeState): boolean {
  let cur: NodeState | undefined = n;
  for (let depth = 0; depth < 10_000; depth++) {
    const p: string | undefined = cur.placement?.parent;
    if (p === undefined) return false;
    if (isRootId(p)) return true;
    cur = s.nodes.get(p);
    if (!cur || cur.kind === null) return false;
  }
  return false;
}

/**
 * An ancestor's delete hides n only if the deleter saw n placed in that subtree: the delete must
 * cover the placement op of n and of every node between n and that ancestor.
 */
export function hiddenByAncestor(s: GroupState, n: NodeState): boolean {
  if (!n.placement) return true;
  const chain: OpRef[] = [n.placement.op];
  for (let a = parentOf(s, n); a; a = parentOf(s, a)) {
    if (a.deletes.some((d) => chain.every((op) => covers(d.seen, op)))) return true;
    if (!a.placement) return true;
    chain.push(a.placement.op);
  }
  return false;
}

export function visibleSet(s: GroupState): Set<string> {
  const vis = new Set<string>();
  for (const n of s.nodes.values()) {
    if (!ownAlive(n) || !n.placement || !hasRootPath(s, n) || hiddenByAncestor(s, n)) continue;
    for (let x: NodeState | undefined = n; x && !vis.has(x.id); x = parentOf(s, x)) vis.add(x.id);
  }
  return vis;
}
