import { browser } from 'wxt/browser';
import type { Excluded } from '../core/reconcile.js';
import { PENDING_PREFIX, type RootsPort } from '../engine/app.js';
import type { Engine, Node } from './bookmarksPort.js';

const FIREFOX = { toolbar: 'toolbar_____', menu: 'menu________', other: 'unfiled_____', mobile: 'mobile______' };

type MessageKey = 'bookmarksMenu' | 'rootToolbar' | 'rootOther' | 'rootMenu';

const message = (key: MessageKey, fallback: string) => {
  try {
    return browser.i18n.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
};

async function chromiumRoots(): Promise<{ bar: Node; other: Node; all: Node[] }> {
  const [root] = (await browser.bookmarks.getTree()) as Node[];
  const kids = ((root?.children ?? []) as Node[]).filter((n) => n.folderType !== 'managed' && !n.unmodifiable);
  const pick = (type: string, fallbackIndex: number) => {
    const typed = kids.filter((n) => n.folderType === type);
    if (typed.length) return typed.find((n) => n.syncing) ?? typed[0]!;
    return kids[fallbackIndex]!;
  };
  return { bar: pick('bookmarks-bar', 0), other: pick('other', 1), all: kids };
}

/** The Bookmarks Menu helper folder made for an earlier group, if it still sits in the other bookmarks folder. */
async function existingHelper(otherId: string): Promise<string | null> {
  const { menuHelperId } = (await browser.storage.local.get('menuHelperId')) as { menuHelperId?: string };
  if (!menuHelperId) return null;
  const found: Node[] = await browser.bookmarks.get(menuHelperId).catch(() => []);
  const n = found[0];
  return n && n.parentId === otherId && n.url === undefined ? n.id : null;
}

export function browserRoots(engine: Engine): RootsPort {
  return {
    async wholeTree(create) {
      if (engine === 'firefox') return { mapping: { 'root:toolbar': FIREFOX.toolbar, 'root:other': FIREFOX.other, 'root:menu': FIREFOX.menu }, excluded: [] };
      const { bar, other } = await chromiumRoots();
      let helper = await existingHelper(other.id);
      if (!helper && create) {
        helper = (await browser.bookmarks.create({ parentId: other.id, title: message('bookmarksMenu', 'Bookmarks Menu') })).id;
        await browser.storage.local.set({ menuHelperId: helper });
      }
      const menu = helper ?? `${PENDING_PREFIX}menu`;
      const excluded: [string, Excluded][] = [[menu, { parent: other.id, sticky: true }]];
      return { mapping: { 'root:toolbar': bar.id, 'root:other': other.id, 'root:menu': menu }, excluded };
    },

    async everythingInto(folderId, create) {
      const make = async (key: MessageKey, fallback: string) =>
        create ? (await browser.bookmarks.create({ parentId: folderId, title: message(key, fallback) })).id : `${PENDING_PREFIX}${key}`;
      return {
        mapping: { 'root:toolbar': await make('rootToolbar', 'Toolbar'), 'root:other': await make('rootOther', 'Other'), 'root:menu': await make('rootMenu', 'Menu') },
        excluded: [],
      };
    },

    async topLevel() {
      if (engine === 'firefox') return Object.values(FIREFOX);
      return (await chromiumRoots()).all.map((n) => n.id);
    },

    async folders() {
      const [root] = (await browser.bookmarks.getTree()) as Node[];
      const out: { id: string; path: string }[] = [];
      const walk = (n: Node, path: string[]) => {
        for (const c of (n.children ?? []) as Node[]) {
          if (c.url !== undefined || c.type === 'separator' || c.folderType === 'managed') continue;
          const p = [...path, c.title || '(untitled)'];
          out.push({ id: c.id, path: p.join(' / ') });
          walk(c, p);
        }
      };
      if (root) walk(root, []);
      return out;
    },

    async pathOf(localId) {
      const parts: string[] = [];
      for (let id: string | undefined = localId; id; ) {
        const found: Node[] = await browser.bookmarks.get(id).catch(() => []);
        const n = found[0];
        if (!n || !n.parentId) break;
        parts.unshift(n.title || '(untitled)');
        id = n.parentId;
      }
      return parts.join(' / ');
    },
  };
}
