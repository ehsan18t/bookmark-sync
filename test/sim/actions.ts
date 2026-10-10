// User actions for the simulator, chosen from plain numbers so fast-check can shrink failing runs.

import type { SimDevice, Simulator } from './simulator.js';

export interface Action {
  k: number;
  a: number;
  b: number;
  c: number;
}

export type EditKind = 'addBookmark' | 'addFolder' | 'rename' | 'setUrl' | 'move' | 'remove';

const TITLES = ['News', 'Docs', 'Recipes', 'Work', 'Music', 'Docs'];
const URLS = ['https://a.example/', 'https://b.example/x', 'https://c.example/?q=1', 'https://a.example/'];

export interface EditResult {
  kind: EditKind;
  device: SimDevice;
  /** Local IDs involved, for the oracle to translate into stable IDs. */
  node?: string;
  parent?: string;
  index?: number;
  title?: string;
  url?: string;
}

export const DEFAULT_KINDS: EditKind[] = ['addBookmark', 'addBookmark', 'addFolder', 'rename', 'setUrl', 'move', 'move', 'remove'];
export const FOLDER_HEAVY_KINDS: EditKind[] = ['addFolder', 'addFolder', 'addBookmark', 'move', 'move', 'move', 'remove', 'rename'];

/** Perform one edit on a device's local tree, as a user would. Returns null if it was a no-op. */
export async function performEdit(
  sim: Simulator,
  d: SimDevice,
  act: Action,
  kinds: readonly EditKind[] = DEFAULT_KINDS,
): Promise<EditResult | null> {
  const bm = d.bookmarks;
  const nodes = bm.allNodes();
  const folders = bm.folders();
  const kind = kinds[act.a % kinds.length]!;
  const title = TITLES[act.c % TITLES.length]!;
  const url = URLS[(act.c >> 3) % URLS.length]!;

  switch (kind) {
    case 'addBookmark':
    case 'addFolder': {
      const parent = folders[act.b % folders.length]!;
      const index = act.c % (bm.childCount(parent) + 1);
      const isFolder = kind === 'addFolder';
      const node = await bm.create({ parentId: parent, index, kind: isFolder ? 'folder' : 'bookmark', title, url: isFolder ? '' : url });
      return { kind, device: d, node, parent, index, title, url: isFolder ? '' : url };
    }
    case 'rename': {
      const n = nodes[act.b % Math.max(nodes.length, 1)];
      if (!n || n.kind === 'separator') return null;
      await bm.update(n.id, { title });
      return { kind, device: d, node: n.id, title };
    }
    case 'setUrl': {
      const n = nodes.filter((x) => x.kind === 'bookmark')[act.b % Math.max(nodes.length, 1)];
      if (!n) return null;
      await bm.update(n.id, { url });
      return { kind, device: d, node: n.id, url };
    }
    case 'move': {
      const n = nodes[act.b % Math.max(nodes.length, 1)];
      if (!n) return null;
      const targets = folders.filter((f) => !bm.isAncestorOrSelf(n.id, f));
      const parent = targets[act.c % targets.length]!;
      const index = (act.c >> 2) % (bm.childCount(parent) + 1);
      await bm.move(n.id, { parentId: parent, index });
      return { kind, device: d, node: n.id, parent, index };
    }
    case 'remove': {
      const n = nodes[act.b % Math.max(nodes.length, 1)];
      if (!n) return null;
      await bm.removeTree(n.id);
      return { kind, device: d, node: n.id };
    }
  }
  void sim;
  return null;
}
