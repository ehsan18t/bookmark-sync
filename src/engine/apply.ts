import { longestIncreasing } from '../core/position.js';
import type { LiveNode, Mirror, MirrorNode } from '../core/reconcile.js';
import { childrenIndex, diffTrees, type Tree } from '../core/tree.js';
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
  const diff = diffTrees({ roots: mirror.roots, nodes: mirror.nodes }, merged);
  const localOf = new Map<string, string>(Object.entries(rootLocal));
  for (const m of mirror.nodes.values()) localOf.set(m.id, m.localId);
  const local = (sid: string): string => {
    const l = localOf.get(sid);
    if (l === undefined) throw new Error(`no local folder for ${sid}`);
    return l;
  };
  const virtual = (sid: string) => localOf.get(sid) === '';

  for (const n of diff.creates) {
    if (n.kind === 'separator' && !port.supportsSeparators) {
      localOf.set(n.id, '');
      continue;
    }
    localOf.set(n.id, await port.create({ parentId: local(n.parent), kind: n.kind, title: n.title, url: n.url }));
  }
  for (const n of diff.moves) {
    if (virtual(n.id)) continue;
    if (mirror.nodes.get(n.id)!.parent !== n.parent) await port.move(local(n.id), { parentId: local(n.parent) });
  }
  for (const n of diff.updates) {
    if (virtual(n.id)) continue;
    await port.update(local(n.id), n.kind === 'bookmark' ? { title: n.title, url: n.url } : { title: n.title });
  }
  const deleted = new Set(diff.deletes.map((n) => n.id));
  for (const n of diff.deletes) {
    const wasVirtual = virtual(n.id);
    localOf.delete(n.id);
    if (wasVirtual || deleted.has(mirror.nodes.get(n.id)!.parent)) continue;
    await port.removeTree(mirror.nodes.get(n.id)!.localId);
  }

  const changed = diff.creates.length + diff.moves.length + diff.updates.length + diff.deletes.length > 0;
  if (changed) await reorder(port, merged, localOf, excluded);

  const nodes = new Map<string, MirrorNode>();
  const idmap = new Map<string, string>();
  for (const n of merged.nodes.values()) {
    const localId = local(n.id);
    nodes.set(n.id, { ...n, localId });
    if (localId) idmap.set(localId, n.id);
  }
  return { mirror: { roots: merged.roots, nodes }, idmap, changed };
}

async function reorder(port: BookmarksPort, merged: Tree, localOf: Map<string, string>, excluded: ReadonlySet<string>): Promise<void> {
  const idx = childrenIndex(merged);
  const live = new Map<string, LiveNode>();
  const index = (n: LiveNode) => {
    live.set(n.localId, n);
    for (const c of n.children ?? []) index(c);
  };
  for (const r of merged.roots) index(await port.getSubTree(localOf.get(r)!));

  const folders = [...merged.roots, ...[...merged.nodes.values()].filter((n) => n.kind === 'folder').map((n) => n.id)];
  for (const folder of folders) {
    const parentLocal = localOf.get(folder)!;
    const current = (live.get(parentLocal)?.children ?? []).map((c) => c.localId);
    const desired = (idx.get(folder) ?? []).map((c) => localOf.get(c.id)!).filter((l) => l !== '');
    const inGroup = current.filter((l) => !excluded.has(l));
    if (inGroup.length === desired.length && inGroup.every((x, i) => x === desired[i])) continue;

    const keep = longestIncreasing(desired.map((l) => (current.indexOf(l) >= 0 ? current.indexOf(l) : null)));
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
