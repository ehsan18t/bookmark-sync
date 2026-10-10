import { derivedId } from './ids.js';
import type { OpDraft } from './ops.js';
import { keyBetween } from './position.js';
import type { Excluded, LiveNode, MirrorNode } from './reconcile.js';
import { childrenIndex, type Tree, type TreeNode } from './tree.js';

export interface JoinPlan {
  drafts: OpDraft[];
  mirror: Map<string, MirrorNode>;
  idmap: Map<string, string>;
  added: number;
  matched: number;
}

/**
 * Linked items keep their local titles in the mirror, so the apply that follows updates them to the
 * group's values. New items get derived IDs, so identical simultaneous joins produce the same IDs.
 */
export async function planJoin(
  group: Tree,
  roots: { groupRoot: string; live: LiveNode }[],
  groupId: string,
  excluded: ReadonlyMap<string, Excluded>,
): Promise<JoinPlan> {
  const idx = childrenIndex(group);
  const plan: JoinPlan = { drafts: [], mirror: new Map(), idmap: new Map(), added: 0, matched: 0 };

  const visit = async (local: LiveNode, parentSid: string, groupKids: TreeNode[]) => {
    const unmatched = [...groupKids];
    let lastKey = groupKids.length ? groupKids[groupKids.length - 1]!.pos : null;
    const occurrences = new Map<string, number>();
    for (const c of local.children ?? []) {
      if (excluded.has(c.localId)) continue;
      const sig = `${c.kind}\u0000${c.title}\u0000${c.kind === 'bookmark' ? c.url : ''}`;
      const occurrence = occurrences.get(sig) ?? 0;
      occurrences.set(sig, occurrence + 1);

      const i = unmatched.findIndex((g) =>
        c.kind === 'folder' ? g.kind === 'folder' && g.title === c.title : c.kind === 'bookmark' && g.kind === 'bookmark' && g.url === c.url,
      );
      if (i >= 0) {
        const g = unmatched.splice(i, 1)[0]!;
        plan.matched++;
        plan.idmap.set(c.localId, g.id);
        plan.mirror.set(g.id, { ...g, title: c.title, url: c.kind === 'bookmark' ? c.url : '', localId: c.localId });
        if (c.kind === 'folder') await visit(c, g.id, idx.get(g.id) ?? []);
        continue;
      }

      const sid = await derivedId(groupId, parentSid, c.kind, c.title, c.kind === 'bookmark' ? c.url : '', occurrence);
      const pos = keyBetween(lastKey, null);
      lastKey = pos;
      const fields = c.kind === 'bookmark' ? { title: c.title, url: c.url } : { title: c.title };
      plan.drafts.push({ type: 'create', node: sid, kind: c.kind, parent: parentSid, pos, fields });
      plan.added++;
      plan.idmap.set(c.localId, sid);
      plan.mirror.set(sid, { id: sid, kind: c.kind, parent: parentSid, pos, title: c.title, url: fields.url ?? '', localId: c.localId });
      if (c.kind === 'folder') await visit(c, sid, []);
    }
  };

  for (const r of roots) await visit(r.live, r.groupRoot, idx.get(r.groupRoot) ?? []);
  return plan;
}
