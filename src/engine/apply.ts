import { settleLimited } from '../core/pool.js';
import { longestIncreasing } from '../core/position.js';
import type { LiveNode, Mirror, MirrorNode } from '../core/reconcile.js';
import { childrenIndex, diffTrees, type Tree, type TreeNode } from '../core/tree.js';
import type { BookmarksPort } from './ports.js';

/** Browser calls kept in flight at once; each waits on the browser, not on this worker. */
const PARALLEL_WRITES = 32;

export interface ApplyResult {
  mirror: Mirror;
  idmap: Map<string, string>;
  changed: boolean;
}

export async function applyMerged(port: BookmarksPort, rootLocal: Readonly<Record<string, string>>, mirror: Mirror, merged: Tree, excluded: ReadonlySet<string>): Promise<ApplyResult> {
  const retried = new Map([...mirror.nodes].filter(([, m]) => m.localId !== '' || (m.kind === 'separator' && !port.supportsSeparators)));
  const diff = diffTrees({ roots: mirror.roots, nodes: retried }, merged);
  const localOf = new Map<string, string>(Object.entries(rootLocal));
  for (const m of retried.values()) localOf.set(m.id, m.localId);
  const local = (sid: string): string => {
    const l = localOf.get(sid);
    if (l === undefined) throw new Error(`no local folder for ${sid}`);
    return l;
  };
  const virtual = (sid: string) => localOf.get(sid) === '';

  // The browser may refuse single items (Firefox rejects javascript: bookmarks from extensions). A refused
  // create has no local copy; a refused move or edit keeps its last state, so it is retried, not recorded back.
  const kept = new Map<string, MirrorNode>();
  // A folder level at a time, so every parent exists first. Siblings go in turn: the browser then appends them in
  // order, which a restart before reorder adopts as is.
  const depth = new Map<string, number>();
  const levels: Map<string, TreeNode[]>[] = [];
  for (const n of diff.creates) {
    const d = (depth.get(n.parent) ?? -1) + 1;
    depth.set(n.id, d);
    const level = levels[d] ?? new Map<string, TreeNode[]>();
    levels[d] = level;
    level.set(n.parent, [...(level.get(n.parent) ?? []), n]);
  }
  for (const level of levels) {
    await settleLimited([...level.values()], PARALLEL_WRITES, async (siblings) => {
      for (const n of siblings) {
        const parent = localOf.get(n.parent);
        if ((n.kind === 'separator' && !port.supportsSeparators) || !parent) {
          localOf.set(n.id, '');
          continue;
        }
        try {
          localOf.set(n.id, await port.create({ parentId: parent, kind: n.kind, title: n.title, url: n.url }));
        } catch {
          localOf.set(n.id, '');
        }
      }
    });
  }
  for (const n of diff.moves) {
    const old = retried.get(n.id)!;
    if (virtual(n.id) || old.parent === n.parent) continue;
    try {
      if (!localOf.get(n.parent)) throw new Error('no local folder');
      await port.move(local(n.id), { parentId: local(n.parent) });
    } catch {
      kept.set(n.id, old);
    }
  }
  await settleLimited(diff.updates, PARALLEL_WRITES, async (n) => {
    if (virtual(n.id)) return;
    try {
      await port.update(local(n.id), n.kind === 'bookmark' ? { title: n.title, url: n.url } : { title: n.title });
    } catch {
      const old = retried.get(n.id)!;
      kept.set(n.id, { ...(kept.get(n.id) ?? { ...n, localId: old.localId }), title: old.title, url: old.url });
    }
  });
  const deleted = new Set(diff.deletes.map((n) => n.id));
  const refusedDeletes = new Set<string>();
  await settleLimited(diff.deletes, PARALLEL_WRITES, async (n) => {
    if (virtual(n.id) || deleted.has(retried.get(n.id)!.parent)) return;
    const localId = retried.get(n.id)!.localId;
    try {
      await port.removeTree(localId);
    } catch {
      if (await port.exists(localId)) refusedDeletes.add(n.id);
    }
  });
  const underRefused = (sid: string): boolean => {
    for (let cur = retried.get(sid); cur; cur = retried.get(cur.parent)) if (refusedDeletes.has(cur.id)) return true;
    return false;
  };

  const changed = diff.creates.length + diff.moves.length + diff.updates.length + diff.deletes.length > 0;
  if (changed) await reorder(port, merged, localOf, excluded);

  const nodes = new Map<string, MirrorNode>();
  const idmap = new Map<string, string>();
  for (const n of merged.nodes.values()) {
    const localId = localOf.get(n.id) ?? '';
    const k = kept.get(n.id);
    nodes.set(n.id, k ? { ...n, parent: k.parent, pos: k.pos, title: k.title, url: k.url, localId } : { ...n, localId });
    if (localId) idmap.set(localId, n.id);
  }
  for (const n of diff.deletes) {
    const old = retried.get(n.id)!;
    if (!underRefused(n.id) || !old.localId) continue;
    nodes.set(n.id, old);
    idmap.set(old.localId, n.id);
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
  for (const tree of await Promise.all(merged.roots.map((r) => port.getSubTree(localOf.get(r)!)))) index(tree);

  // Folders are reordered at once; moves inside one folder depend on each other's indexes, so they stay in turn.
  const folders = [...merged.roots, ...[...merged.nodes.values()].filter((n) => n.kind === 'folder').map((n) => n.id)];
  await settleLimited(folders, PARALLEL_WRITES, async (folder) => {
    const parentLocal = localOf.get(folder)!;
    const current = (live.get(parentLocal)?.children ?? []).map((c) => c.localId);
    const desired = (idx.get(folder) ?? []).map((c) => localOf.get(c.id)!).filter((l) => l !== '');
    const inGroup = current.filter((l) => !excluded.has(l));
    if (inGroup.length === desired.length && inGroup.every((x, i) => x === desired[i])) return;

    const keep = longestIncreasing(desired.map((l) => (current.indexOf(l) >= 0 ? current.indexOf(l) : null)));
    for (let j = 0; j < desired.length; j++) {
      if (keep.has(j)) continue;
      const l = desired[j]!;
      const from = current.indexOf(l);
      if (from >= 0) current.splice(from, 1);
      const target = j === 0 ? 0 : current.indexOf(desired[j - 1]!) + 1;
      current.splice(target, 0, l);
      await port.move(l, { parentId: parentLocal, index: target, ...(from >= 0 ? { from } : {}) }).catch(() => {});
    }
  });
}

/**
 * Creates `nodes` in `parentId` and below, leaving out what `keep` rejects. Siblings go in order, separate folders at
 * once. A refused item is skipped; the first refusal is thrown once everything else is made.
 */
export async function recreate(port: BookmarksPort, parentId: string, nodes: readonly LiveNode[], keep: (n: LiveNode) => boolean = () => true, index?: number): Promise<void> {
  const folders: [string, LiveNode[]][] = [];
  const refused: unknown[] = [];
  for (const [i, n] of nodes.filter(keep).entries()) {
    try {
      const id = await port.create({ parentId, index: index === undefined ? undefined : index + i, kind: n.kind, title: n.title, url: n.url });
      if (n.kind === 'folder' && n.children?.length) folders.push([id, n.children]);
    } catch (e) {
      refused.push(e);
    }
  }
  for (const r of await settleLimited(folders, PARALLEL_WRITES, ([id, kids]) => recreate(port, id, kids, keep))) if (r.status === 'rejected') refused.push(r.reason);
  if (refused.length) throw refused[0];
}

/** Removes each item with its contents, all at once; the results say, in order, which removals failed. */
export function removeEach(port: BookmarksPort, localIds: readonly string[]): Promise<PromiseSettledResult<void>[]> {
  return settleLimited(localIds, PARALLEL_WRITES, (l) => port.removeTree(l));
}

/** Removes each item with its contents, all at once; throws the first refusal after trying every one. */
export async function removeAll(port: BookmarksPort, localIds: readonly string[]): Promise<void> {
  const failed = (await removeEach(port, localIds)).find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}
