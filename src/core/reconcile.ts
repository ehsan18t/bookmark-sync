// Reconcile (IMPLEMENTATION.md 8.3): compare the live bookmark tree with the mirror and record the
// differences as op drafts. Ops come only from this comparison, never from individual events, so
// late, repeated or reordered browser events cannot produce duplicate ops.
//
// v1 always compares the whole mapped tree. Narrowing it to the folders marked dirty by events is
// a later optimization and does not change the result.

import type { Kind, OpDraft, SubtreeSnapshot } from './ops.js';
import { assignKeys } from './position.js';
import { childrenIndex, type Tree, type TreeNode } from './tree.js';

export interface LiveNode {
  localId: string;
  kind: Kind;
  title: string;
  url: string;
  children?: LiveNode[];
}

export interface MirrorNode extends TreeNode {
  localId: string;
}

export interface Mirror {
  roots: readonly string[];
  nodes: Map<string, MirrorNode>;
}

export interface ReconcileInput {
  /** Each group root with the live local folder it is mapped to. */
  roots: { groupRoot: string; live: LiveNode }[];
  mirror: Mirror;
  idmap: Map<string, string>;
  excluded: ReadonlySet<string>;
  newId: () => string;
}

export interface ReconcileResult {
  drafts: OpDraft[];
  mirror: Mirror;
  idmap: Map<string, string>;
}

interface Placed {
  live: LiveNode;
  sid: string;
  parent: string;
  pos: string;
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { mirror, idmap, excluded, newId } = input;
  const sidOf = new Map<LiveNode, string>();
  const liveSids = new Set<string>();

  // Pass 1: stable IDs for every live node (new nodes get fresh IDs).
  const assign = (n: LiveNode) => {
    for (const c of n.children ?? []) {
      if (excluded.has(c.localId)) continue;
      const sid = idmap.get(c.localId) ?? newId();
      sidOf.set(c, sid);
      liveSids.add(sid);
      assign(c);
    }
  };
  for (const r of input.roots) assign(r.live);

  // Pass 2: position keys per folder, keeping as many existing keys as possible.
  const placed = new Map<LiveNode, Placed>();
  const placeChildren = (folder: LiveNode, folderSid: string) => {
    const kids = (folder.children ?? []).filter((c) => !excluded.has(c.localId));
    const current = kids.map((c) => {
      const m = mirror.nodes.get(sidOf.get(c)!);
      return m && m.parent === folderSid ? m.pos : null;
    });
    const keys = assignKeys(current);
    kids.forEach((c, i) => {
      const sid = sidOf.get(c)!;
      placed.set(c, { live: c, sid, parent: folderSid, pos: keys[i]! });
      if (c.kind === 'folder') placeChildren(c, sid);
    });
  };
  for (const r of input.roots) placeChildren(r.live, r.groupRoot);

  // Pass 3: drafts in preorder of the live tree, so a folder is placed before anything moves into it.
  const drafts: OpDraft[] = [];
  const nextMirror = new Map<string, MirrorNode>();
  const nextIdmap = new Map<string, string>();
  const walk = (folder: LiveNode) => {
    for (const c of folder.children ?? []) {
      const p = placed.get(c);
      if (!p) continue; // excluded
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
          drafts.push({
            type: 'move',
            node: p.sid,
            parent: p.parent,
            pos: p.pos,
            before: { parent: old.parent, pos: old.pos },
          });
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

  // Pass 4: deletes for the topmost mirror nodes that are gone. A folder delete covers its contents.
  const mirrorTree: Tree = { roots: mirror.roots, nodes: mirror.nodes };
  const idx = childrenIndex(mirrorTree);
  for (const m of mirror.nodes.values()) {
    if (liveSids.has(m.id)) continue;
    const parent = mirror.nodes.get(m.parent);
    if (parent && !liveSids.has(parent.id)) continue; // covered by the parent's delete
    drafts.push({ type: 'delete', node: m.id, before: snapshotOf(m, idx) });
  }

  return { drafts, mirror: { roots: mirror.roots, nodes: nextMirror }, idmap: nextIdmap };
}

function snapshotOf(n: TreeNode, idx: Map<string, TreeNode[]>): SubtreeSnapshot {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    url: n.url,
    children: (idx.get(n.id) ?? []).map((c) => snapshotOf(c, idx)),
  };
}
