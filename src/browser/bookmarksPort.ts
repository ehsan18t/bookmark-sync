import { type Browser, browser } from 'wxt/browser';
import type { Kind } from '../core/ops.js';
import type { LiveNode } from '../core/reconcile.js';
import type { BookmarksPort } from '../engine/ports.js';

export type Node = Browser.bookmarks.BookmarkTreeNode & { type?: 'bookmark' | 'folder' | 'separator'; folderType?: string; syncing?: boolean };

export type Engine = 'chromium' | 'firefox';

export function kindOf(n: Node): Kind {
  if (n.type === 'separator') return 'separator';
  return n.url !== undefined ? 'bookmark' : 'folder';
}

export class BrowserBookmarks implements BookmarksPort {
  constructor(
    readonly engine: Engine,
    private readonly isOutside: (n: Node) => boolean = () => false,
  ) {}

  get supportsSeparators(): boolean {
    return this.engine === 'firefox';
  }

  async getSubTree(localId: string): Promise<LiveNode> {
    const [n] = (await browser.bookmarks.getSubTree(localId)) as Node[];
    if (!n) throw new Error(`no bookmark ${localId}`);
    return this.toLive(n);
  }

  async exists(localId: string): Promise<boolean> {
    try {
      return (await browser.bookmarks.get(localId)).length > 0;
    } catch {
      return false;
    }
  }

  async positions(): Promise<Map<string, { parentId: string; index: number }>> {
    const out = new Map<string, { parentId: string; index: number }>();
    const walk = (n: Node) => {
      for (const [i, c] of ((n.children ?? []) as Node[]).entries()) {
        out.set(c.id, { parentId: n.id, index: c.index ?? i });
        walk(c);
      }
    };
    for (const r of (await browser.bookmarks.getTree()) as Node[]) walk(r);
    return out;
  }

  async create(args: { parentId: string; index?: number; kind: Kind; title: string; url: string }): Promise<string> {
    const details: Record<string, unknown> = { parentId: args.parentId, index: args.index };
    if (args.kind === 'separator') {
      if (!this.supportsSeparators) throw new Error('separators are not supported here');
      details.type = 'separator';
    } else {
      details.title = args.title;
      if (args.kind === 'bookmark') details.url = args.url;
    }
    const created = await browser.bookmarks.create(details as Browser.bookmarks.CreateDetails);
    return created.id;
  }

  async update(localId: string, changes: { title?: string; url?: string }): Promise<void> {
    await browser.bookmarks.update(localId, changes);
  }

  async move(localId: string, dest: { parentId: string; index?: number; from?: number }): Promise<void> {
    let index = dest.index;
    if (this.engine === 'chromium' && index !== undefined) {
      // Chromium counts the index before removing the node, so a forward move within one folder is off by one.
      if (dest.from !== undefined) {
        if (dest.from < index) index += 1;
      } else {
        const [n] = await browser.bookmarks.get(localId);
        if (n && n.parentId === dest.parentId && n.index !== undefined && n.index < index) index += 1;
      }
    }
    await browser.bookmarks.move(localId, index === undefined ? { parentId: dest.parentId } : { parentId: dest.parentId, index });
  }

  async removeTree(localId: string): Promise<void> {
    const [n] = (await browser.bookmarks.get(localId)) as Node[];
    if (!n) return;
    if (kindOf(n) === 'folder') await browser.bookmarks.removeTree(localId);
    else await browser.bookmarks.remove(localId);
  }

  private toLive(n: Node): LiveNode {
    const kind = kindOf(n);
    const live: LiveNode = { localId: n.id, kind, title: kind === 'separator' ? '' : (n.title ?? ''), url: kind === 'bookmark' ? (n.url ?? '') : '' };
    if (kind === 'folder') live.children = ((n.children ?? []) as Node[]).filter((c) => !this.isOutside(c)).map((c) => this.toLive(c));
    return live;
  }
}
