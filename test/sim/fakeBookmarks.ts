import type { RootType } from '../../src/core/ids.js';
import type { Kind } from '../../src/core/ops.js';
import type { LiveNode } from '../../src/core/reconcile.js';
import { PENDING_PREFIX, pendingAt, type RootsPort } from '../../src/engine/app.js';
import type { BookmarksPort } from '../../src/engine/ports.js';

interface FakeNode {
  id: string;
  kind: Kind;
  title: string;
  url: string;
  parent: string | null;
  children: string[];
}

export const FAKE_ROOTS = { toolbar: 'toolbar_____', menu: 'menu________', other: 'unfiled_____' } as const;
export const FAKE_TOP = 'root________';

const ROOT_TYPE: Record<string, RootType> = { [FAKE_ROOTS.toolbar]: 'toolbar', [FAKE_ROOTS.other]: 'other', [FAKE_ROOTS.menu]: 'menu' };

/** Roots port over fake bookmarks, laid out like Firefox. */
export function fakeRoots(bm: FakeBookmarks): RootsPort {
  const path = (id: string) => [...bm.pathTitles(id), bm.node(id).title].join(' / ');
  const chain = (id: string) => {
    const out: string[] = [];
    for (let cur: string | null = id; cur && cur !== FAKE_TOP; cur = bm.node(cur).parent) out.unshift(cur);
    return out;
  };
  return {
    wholeTree: async () => ({ mapping: { 'root:toolbar': FAKE_ROOTS.toolbar, 'root:other': FAKE_ROOTS.other, 'root:menu': FAKE_ROOTS.menu }, excluded: [] }),
    everythingInto: async (folderId, create) => {
      const make = async (title: string) => (create ? bm.create({ parentId: folderId, kind: 'folder', title, url: '' }) : `${PENDING_PREFIX}${title}`);
      return { mapping: { 'root:toolbar': await make('Toolbar'), 'root:other': await make('Other'), 'root:menu': await make('Menu') }, excluded: [] };
    },
    topLevel: async () => Object.values(FAKE_ROOTS),
    folders: async () =>
      bm.folders().map((id) => {
        const parent = bm.node(id).parent;
        return { id, parentId: parent === FAKE_TOP ? null : parent, title: bm.node(id).title, path: path(id), ...(ROOT_TYPE[id] ? { root: ROOT_TYPE[id] } : {}) };
      }),
    pathOf: async (id) => path(id),
    describe: async (id) => {
      const [top, ...rest] = chain(id);
      const root = top ? ROOT_TYPE[top] : undefined;
      return { title: bm.node(id).title, hint: root ? { root, path: rest.map((x) => bm.node(x).title) } : null };
    },
    resolve: async (hint, create) => {
      let cur: string = { toolbar: FAKE_ROOTS.toolbar, other: FAKE_ROOTS.other, menu: FAKE_ROOTS.menu, mobile: FAKE_ROOTS.other }[hint.root];
      for (const [i, title] of hint.path.entries()) {
        const found = ((await bm.getSubTree(cur)).children ?? []).find((c) => c.kind === 'folder' && c.title === title);
        if (found) cur = found.localId;
        else if (!create) return pendingAt(cur, hint.path.slice(i));
        else cur = await bm.create({ parentId: cur, kind: 'folder', title, url: '' });
      }
      return cur;
    },
  };
}

export class FakeBookmarks implements BookmarksPort {
  readonly supportsSeparators: boolean;
  private nodes = new Map<string, FakeNode>();
  private counter = 0;
  writes = 0;
  onChange: ((kind: 'create', id: string) => void) | null = null;

  constructor(
    private readonly prefix: string,
    opts: { separators?: boolean } = {},
  ) {
    this.supportsSeparators = opts.separators ?? true;
    this.nodes.set(FAKE_TOP, { id: FAKE_TOP, kind: 'folder', title: '', url: '', parent: null, children: [] });
    for (const id of Object.values(FAKE_ROOTS)) this.addNode(id, 'folder', id, '', FAKE_TOP);
  }

  async getSubTree(localId: string): Promise<LiveNode> {
    return this.snapshot(localId);
  }

  async exists(localId: string): Promise<boolean> {
    return this.nodes.has(localId);
  }

  async parentOf(localId: string): Promise<string | null> {
    return this.nodes.get(localId)?.parent ?? null;
  }

  /** URLs this browser refuses, like Firefox with javascript: bookmarks created by extensions. */
  rejectUrl: ((url: string) => boolean) | null = null;
  refuseCreate: ((args: { kind: Kind; title: string }) => boolean) | null = null;
  refuseRemove: ((localId: string) => boolean) | null = null;

  /** Throw on the nth write from now, like a background worker being stopped mid-apply. */
  crashAfter: number | null = null;
  onCrash: (() => void) | null = null;

  async create(args: { parentId: string; index?: number; kind: Kind; title: string; url: string }): Promise<string> {
    this.writes++;
    if (this.crashAfter !== null && --this.crashAfter < 0) {
      this.crashAfter = null;
      this.onCrash?.();
      throw new Error('worker stopped');
    }
    if (args.kind === 'bookmark' && this.rejectUrl?.(args.url)) throw new Error('refused URL');
    if (this.refuseCreate?.(args)) throw new Error('refused create');
    const id = `${this.prefix}${++this.counter}`;
    this.addNode(id, args.kind, args.kind === 'separator' ? '' : args.title, args.kind === 'bookmark' ? args.url : '', args.parentId, args.index);
    return id;
  }

  async update(localId: string, changes: { title?: string; url?: string }): Promise<void> {
    this.writes++;
    const n = this.must(localId);
    if (changes.url !== undefined && this.rejectUrl?.(changes.url)) throw new Error('refused URL');
    if (changes.title !== undefined) n.title = changes.title;
    if (changes.url !== undefined && n.kind === 'bookmark') n.url = changes.url;
  }

  async move(localId: string, dest: { parentId: string; index?: number }): Promise<void> {
    this.writes++;
    const n = this.must(localId);
    if (this.isAncestorOrSelf(localId, dest.parentId)) throw new Error('cannot move a folder into itself');
    const oldParent = this.must(n.parent!);
    oldParent.children.splice(oldParent.children.indexOf(localId), 1);
    const p = this.must(dest.parentId);
    const index = dest.index === undefined ? p.children.length : Math.min(dest.index, p.children.length);
    p.children.splice(index, 0, localId);
    n.parent = dest.parentId;
  }

  async removeTree(localId: string): Promise<void> {
    this.writes++;
    if (this.refuseRemove?.(localId)) throw new Error('refused remove');
    const n = this.must(localId);
    const p = this.must(n.parent!);
    p.children.splice(p.children.indexOf(localId), 1);
    const drop = (id: string) => {
      for (const c of this.must(id).children) drop(c);
      this.nodes.delete(id);
    };
    drop(localId);
  }

  async userCreate(args: { parentId: string; index?: number; kind: Kind; title: string; url: string }): Promise<string> {
    const id = await this.create(args);
    this.onChange?.('create', id);
    return id;
  }

  has(localId: string): boolean {
    return this.nodes.has(localId);
  }

  node(localId: string): { kind: Kind; title: string; url: string; parent: string | null } {
    const n = this.must(localId);
    return { kind: n.kind, title: n.title, url: n.url, parent: n.parent };
  }

  pathTitles(localId: string): string[] {
    const out: string[] = [];
    for (let cur = this.nodes.get(localId)?.parent ?? null; cur && cur !== FAKE_TOP; cur = this.nodes.get(cur)?.parent ?? null) {
      out.unshift(this.must(cur).title);
    }
    return out;
  }

  allNodes(): { id: string; kind: Kind; parent: string; index: number }[] {
    const out: { id: string; kind: Kind; parent: string; index: number }[] = [];
    const walk = (id: string) => {
      this.must(id).children.forEach((c, index) => {
        out.push({ id: c, kind: this.must(c).kind, parent: id, index });
        walk(c);
      });
    };
    for (const r of Object.values(FAKE_ROOTS)) walk(r);
    return out;
  }

  folders(): string[] {
    return [
      ...Object.values(FAKE_ROOTS),
      ...this.allNodes()
        .filter((n) => n.kind === 'folder')
        .map((n) => n.id),
    ];
  }

  childCount(folder: string): number {
    return this.must(folder).children.length;
  }

  isAncestorOrSelf(ancestor: string, id: string): boolean {
    for (let cur: string | null = id; cur; cur = this.nodes.get(cur)?.parent ?? null) if (cur === ancestor) return true;
    return false;
  }

  /** Give every bookmark a new local ID, as Chromium may when native sync reloads its data. */
  reassignIds(prefix: string): void {
    const fixed = new Set([FAKE_TOP, ...Object.values(FAKE_ROOTS)]);
    const map = new Map<string, string>();
    for (const id of this.nodes.keys()) map.set(id, fixed.has(id) ? id : `${prefix}${++this.counter}`);
    const next = new Map<string, FakeNode>();
    for (const n of this.nodes.values()) {
      const id = map.get(n.id)!;
      next.set(id, { ...n, id, parent: n.parent && map.get(n.parent)!, children: n.children.map((c) => map.get(c)!) });
    }
    this.nodes = next;
  }

  clone(prefix: string): FakeBookmarks {
    const c = new FakeBookmarks(prefix, { separators: this.supportsSeparators });
    c.nodes = new Map([...this.nodes].map(([k, v]) => [k, { ...v, children: [...v.children] }]));
    c.counter = this.counter + 10_000;
    return c;
  }

  private snapshot(id: string): LiveNode {
    const n = this.must(id);
    const out: LiveNode = { localId: n.id, kind: n.kind, title: n.title, url: n.url };
    if (n.kind === 'folder') out.children = n.children.map((c) => this.snapshot(c));
    return out;
  }

  private addNode(id: string, kind: Kind, title: string, url: string, parent: string, index?: number): void {
    const p = this.must(parent);
    if (p.kind !== 'folder') throw new Error('parent is not a folder');
    this.nodes.set(id, { id, kind, title, url, parent, children: [] });
    const i = index === undefined ? p.children.length : Math.min(index, p.children.length);
    p.children.splice(i, 0, id);
  }

  private must(id: string): FakeNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`no such bookmark: ${id}`);
    return n;
  }
}
