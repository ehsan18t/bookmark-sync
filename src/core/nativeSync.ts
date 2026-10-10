import type { Hlc } from './hlc.js';
import type { CreateOp } from './ops.js';
import { pathOf, type Tree } from './tree.js';

export interface RecentCreate {
  node: string;
  hlc: Hlc;
  device: string;
}

export interface DuplicatePair {
  own: RecentCreate;
  remote: RecentCreate;
  ownIsLater: boolean;
}

export function findDuplicatePairs(merged: Tree, remoteCreates: readonly CreateOp[], recent: readonly RecentCreate[]): DuplicatePair[] {
  const sig = (id: string) => {
    const n = merged.nodes.get(id);
    if (!n || n.kind === 'separator') return null;
    return `${n.kind}\u0000${n.title}\u0000${n.url}\u0000${pathOf(merged, id)}`;
  };
  const ownBySig = new Map<string, RecentCreate[]>();
  for (const r of recent) {
    const s = sig(r.node);
    if (s) ownBySig.set(s, [...(ownBySig.get(s) ?? []), r]);
  }
  const pairs: DuplicatePair[] = [];
  const usedOwn = new Set<string>();
  for (const op of remoteCreates) {
    const s = sig(op.node);
    if (!s) continue;
    const own = (ownBySig.get(s) ?? []).find((o) => o.node !== op.node && !usedOwn.has(o.node));
    if (!own) continue;
    usedOwn.add(own.node);
    const remote = { node: op.node, hlc: op.hlc, device: op.device };
    const ownIsLater = own.hlc > remote.hlc || (own.hlc === remote.hlc && own.device > remote.device);
    pairs.push({ own, remote, ownIsLater });
  }
  return pairs;
}
