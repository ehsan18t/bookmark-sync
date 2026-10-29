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
export async function planJoin(group: Tree, roots: { groupRoot: string; live: LiveNode }[], groupId: string, excluded: ReadonlyMap<string, Excluded>): Promise<JoinPlan> {
  const idx = childrenIndex(group);
  const plan: JoinPlan = { drafts: [], mirror: new Map(), idmap: new Map(), added: 0, matched: 0 };

  // A folder matches by title and a bookmark by URL, each with the first group item left that fits.
  const matchKey = (n: { kind: string; title: string; url: string }) => (n.kind === 'folder' ? `f\u0000${n.title}` : n.kind === 'bookmark' ? `b\u0000${n.url}` : null);

  const visit = async (local: LiveNode, parentSid: string, groupKids: TreeNode[]) => {
    const unmatched = new Map<string, TreeNode[]>();
    for (const g of groupKids) {
      const k = matchKey(g);
      if (k !== null) unmatched.set(k, [...(unmatched.get(k) ?? []), g]);
    }
    let lastKey = groupKids.length ? groupKids[groupKids.length - 1]!.pos : null;
    const occurrences = new Map<string, number>();
    const kids = (local.children ?? [])
      .filter((c) => !excluded.has(c.localId))
      .map((c) => {
        const sig = `${c.kind}\u0000${c.title}\u0000${c.kind === 'bookmark' ? c.url : ''}`;
        const occurrence = occurrences.get(sig) ?? 0;
        occurrences.set(sig, occurrence + 1);
        const k = matchKey(c);
        return { c, occurrence, match: k === null ? undefined : unmatched.get(k)?.shift() };
      });
    const sids = await Promise.all(kids.map(({ c, occurrence, match }) => (match ? null : derivedId(groupId, parentSid, c.kind, c.title, c.kind === 'bookmark' ? c.url : '', occurrence))));
    for (const [i, { c, match: g }] of kids.entries()) {
      if (g) {
        plan.matched++;
        plan.idmap.set(c.localId, g.id);
        plan.mirror.set(g.id, { ...g, title: c.title, url: c.kind === 'bookmark' ? c.url : '', localId: c.localId });
        if (c.kind === 'folder') await visit(c, g.id, idx.get(g.id) ?? []);
        continue;
      }

      const sid = sids[i]!;
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
