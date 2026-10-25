import { browser } from 'wxt/browser';
import type { Excluded } from '../core/reconcile.js';
import type { RootType } from '../core/ids.js';
import { PENDING_PREFIX, pendingAt, type LocalFolder, type RootsPort } from '../engine/app.js';
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

const CHROMIUM_TYPES: Record<string, RootType> = { 'bookmarks-bar': 'toolbar', other: 'other', mobile: 'mobile' };

function rootType(engine: Engine, top: Node): RootType | undefined {
  if (engine === 'firefox') return (Object.entries(FIREFOX) as [RootType, string][]).find(([, id]) => id === top.id)?.[0];
  return top.folderType ? CHROMIUM_TYPES[top.folderType] : undefined;
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
      const tops = ((root?.children ?? []) as Node[]).filter((c) => c.url === undefined && c.folderType !== 'managed');
      const out: LocalFolder[] = [];
      const walk = (n: Node, path: string[]) => {
        for (const c of (n.children ?? []) as Node[]) {
          if (c.url !== undefined || c.type === 'separator') continue;
          const p = [...path, c.title || '(untitled)'];
          out.push({ id: c.id, parentId: n.id, title: c.title || '(untitled)', path: p.join(' / ') });
          walk(c, p);
        }
      };
      for (const t of tops) {
        const type = rootType(engine, t);
        const twin = type && tops.filter((x) => rootType(engine, x) === type).length > 1;
        const title = `${t.title || '(untitled)'}${twin ? (t.syncing ? ' (account)' : ' (this device only)') : ''}`;
        out.push({ id: t.id, parentId: null, title, path: title, ...(type ? { root: type } : {}) });
        walk(t, [title]);
      }
      return out;
    },

    async describe(localId) {
      const chain: Node[] = [];
      for (let id: string | undefined = localId; id; ) {
        const found: Node[] = await browser.bookmarks.get(id).catch(() => []);
        const n = found[0];
        if (!n || !n.parentId) break;
        chain.unshift(n);
        id = n.parentId;
      }
      const title = chain.at(-1)?.title ?? '';
      const top = chain[0];
      const type = top && rootType(engine, top);
      if (!type) return { title, hint: null };
      const path = chain.slice(1).map((n) => n.title);
      if (engine === 'chromium' && type === 'other' && path.length && chain[1]!.id === (await existingHelper(top.id))) return { title, hint: { root: 'menu', path: path.slice(1) } };
      return { title, hint: { root: type, path } };
    },

    async resolve(hint, create) {
      let parent: string;
      let path = hint.path;
      if (engine === 'firefox') parent = FIREFOX[hint.root];
      else {
        const { bar, other, all } = await chromiumRoots();
        if (hint.root === 'toolbar') parent = bar.id;
        else if (hint.root === 'mobile') parent = (all.find((n) => n.folderType === 'mobile') ?? other).id;
        else if (hint.root === 'other') parent = other.id;
        else {
          const helper = await existingHelper(other.id);
          if (helper) parent = helper;
          else {
            parent = other.id;
            path = [message('bookmarksMenu', 'Bookmarks Menu'), ...path];
          }
        }
      }
      for (const [i, title] of path.entries()) {
        const kids = (await browser.bookmarks.getChildren(parent)) as Node[];
        const found = kids.find((k) => k.url === undefined && k.type !== 'separator' && k.title === title);
        if (found) parent = found.id;
        else if (!create) return pendingAt(parent, path.slice(i));
        else parent = (await browser.bookmarks.create({ parentId: parent, title })).id;
      }
      return parent;
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
