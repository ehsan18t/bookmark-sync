import type { Kind, OpDraft } from './ops.js';
import { assignKeys } from './position.js';
import { snapshot } from './restore.js';
import { childrenIndex, type Tree, type TreeNode } from './tree.js';

export interface LiveNode {
  localId: string;
  kind: Kind;
  title: string;
  url: string;
  children?: LiveNode[];
}

/** An empty localId means the node has no local copy (a separator on Chromium). */
export interface MirrorNode extends TreeNode {
  localId: string;
}

export interface Mirror {
  roots: readonly string[];
  nodes: Map<string, MirrorNode>;
}

export interface Excluded {
  parent: string;
  sticky: boolean;
}

export interface ReconcileInput {
  roots: { groupRoot: string; live: LiveNode }[];
  mirror: Mirror;
  idmap: Map<string, string>;
  excluded: ReadonlyMap<string, Excluded>;
  /** The id for a newly seen local item. */
  newId: (localId: string) => string;
}

export interface ReconcileResult {
  drafts: OpDraft[];
  mirror: Mirror;
  idmap: Map<string, string>;
  released: string[];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { mirror, idmap, excluded, newId } = input;
  const released: string[] = [];
  const isExcluded = (c: LiveNode, parentLocal: string) => {
    const e = excluded.get(c.localId);
    if (!e) return false;
    if (e.sticky || e.parent === parentLocal) return true;
    released.push(c.localId);
    return false;
  };

  const kidsOf = new Map<LiveNode, LiveNode[]>();
  const sidOf = new Map<LiveNode, string>();
  const liveSids = new Set<string>();
  const assign = (n: LiveNode) => {
    const kids = (n.children ?? []).filter((c) => !isExcluded(c, n.localId));
    kidsOf.set(n, kids);
    for (const c of kids) {
      const sid = idmap.get(c.localId) ?? newId(c.localId);
      sidOf.set(c, sid);
      liveSids.add(sid);
      assign(c);
    }
  };
  for (const r of input.roots) assign(r.live);

  const placed = new Map<LiveNode, { sid: string; parent: string; pos: string }>();
  const placeChildren = (folder: LiveNode, folderSid: string) => {
    const kids = kidsOf.get(folder)!;
    const keys = assignKeys(
      kids.map((c) => {
        const m = mirror.nodes.get(sidOf.get(c)!);
        return m && m.parent === folderSid ? m.pos : null;
      }),
    );
    kids.forEach((c, i) => {
      const sid = sidOf.get(c)!;
      placed.set(c, { sid, parent: folderSid, pos: keys[i]! });
      if (c.kind === 'folder') placeChildren(c, sid);
    });
  };
  for (const r of input.roots) placeChildren(r.live, r.groupRoot);

  const drafts: OpDraft[] = [];
  const nextMirror = new Map<string, MirrorNode>();
  const nextIdmap = new Map<string, string>();
  const walk = (folder: LiveNode) => {
    for (const c of kidsOf.get(folder)!) {
      const p = placed.get(c)!;
      const old = mirror.nodes.get(p.sid);
      if (!old) {
        drafts.push({
          type: 'create',
          node: p.sid,
          kind: c.kind,
          parent: p.parent,
          pos: p.pos,
          fields: c.kind === 'bookmark' ? { title: c.title, url: c.url } : { title: c.title },
        });
      } else {
        if (old.parent !== p.parent || old.pos !== p.pos) {
          drafts.push({ type: 'move', node: p.sid, parent: p.parent, pos: p.pos, before: { parent: old.parent, pos: old.pos } });
        }
        const fields: { title?: string; url?: string } = {};
        const before: { title?: string; url?: string } = {};
        if (old.title !== c.title) {
          fields.title = c.title;
          before.title = old.title;
        }
        if (c.kind === 'bookmark' && old.url !== c.url) {
          fields.url = c.url;
          before.url = old.url;
        }
        if (Object.keys(fields).length) drafts.push({ type: 'update', node: p.sid, fields, before });
      }
      nextMirror.set(p.sid, {
        id: p.sid,
        kind: c.kind,
        parent: p.parent,
        pos: p.pos,
        title: c.title,
        url: c.kind === 'bookmark' ? c.url : '',
        localId: c.localId,
      });
      nextIdmap.set(c.localId, p.sid);
      walk(c);
    }
  };
  for (const r of input.roots) walk(r.live);

  const alive = (sid: string) => liveSids.has(sid) || nextMirror.has(sid) || input.roots.some((r) => r.groupRoot === sid);
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of mirror.nodes.values()) {
      if (m.localId === '' && !nextMirror.has(m.id) && alive(m.parent)) {
        nextMirror.set(m.id, m);
        changed = true;
      }
    }
  }

  const idx = childrenIndex({ roots: mirror.roots, nodes: mirror.nodes } satisfies Tree);
  for (const m of mirror.nodes.values()) {
    if (liveSids.has(m.id) || nextMirror.has(m.id)) continue;
    const parent = mirror.nodes.get(m.parent);
    if (parent && !liveSids.has(parent.id) && !nextMirror.has(parent.id)) continue;
    drafts.push({ type: 'delete', node: m.id, before: snapshot(m, idx) });
  }

  return { drafts, mirror: { roots: mirror.roots, nodes: nextMirror }, idmap: nextIdmap, released };
}
