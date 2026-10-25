import type { PlaceHint, RootType } from '../../core/ids.js';
import type { GroupSummary, LocalFolder, PartChoice } from '../../engine/app.js';
import type { GroupFolder } from '../../engine/group.js';
import { h } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';

export interface TreeItem {
  id: string;
  parent: string | null;
  title: string;
  /** Why the folder can't be picked, shown next to it. */
  blocked?: string;
}

export interface FolderTree {
  el: HTMLElement;
  value(): string[];
}

/**
 * A collapsible folder tree. With `multi`, ticking a folder includes everything inside it, so its subfolders show
 * as included and can't be ticked on their own; without it, one folder is picked.
 */
export function folderTree(items: TreeItem[], opts: { multi: boolean; selected?: string[]; onchange?: (ids: string[]) => void; label: string }): FolderTree {
  const kids = new Map<string | null, TreeItem[]>();
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const i of items) {
    const p = i.parent !== null && byId.has(i.parent) ? i.parent : null;
    kids.set(p, [...(kids.get(p) ?? []), i]);
  }
  const picked = new Set(opts.selected ?? []);
  const inputs = new Map<string, HTMLInputElement>();
  const name = `tree${Math.random().toString(36).slice(2)}`;

  const ancestorPicked = (id: string) => {
    for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent ?? null) if (picked.has(p)) return true;
    return false;
  };
  const refresh = () => {
    for (const [id, input] of inputs) {
      const item = byId.get(id)!;
      const included = opts.multi && ancestorPicked(id);
      input.checked = picked.has(id) || included;
      input.disabled = !!item.blocked || included;
      input.closest('.tree-row')!.classList.toggle('included', included);
    }
  };
  const toggle = (id: string, on: boolean) => {
    if (!opts.multi) picked.clear();
    if (on) {
      picked.add(id);
      if (opts.multi) for (const d of [...picked]) if (d !== id && ancestorPicked(d)) picked.delete(d);
    } else picked.delete(id);
    refresh();
    opts.onchange?.([...picked]);
  };

  const branch = (parent: string | null, depth: number): HTMLElement => {
    const list = h('ul', { role: parent === null ? 'tree' : 'group', ...(parent === null ? { 'aria-label': opts.label } : {}) });
    for (const item of kids.get(parent) ?? []) {
      const children = kids.get(item.id);
      const input = h('input', { type: opts.multi ? 'checkbox' : 'radio', name, value: item.id });
      input.addEventListener('change', () => toggle(item.id, input.checked));
      inputs.set(item.id, input);
      const sub = children ? branch(item.id, depth + 1) : null;
      const open = depth === 0;
      if (sub) sub.hidden = !open;
      const twisty = children
        ? h('button', { type: 'button', class: 'twisty', 'aria-label': `Show folders in ${item.title}`, 'aria-expanded': String(open) }, icon(open ? 'chevron-down' : 'chevron-right'))
        : h('span', { class: 'twisty' });
      if (sub && twisty instanceof HTMLButtonElement) twisty.addEventListener('click', () => setOpen(twisty, sub, sub.hidden !== false));
      list.append(
        h(
          'li',
          { role: 'treeitem', ...(children ? { 'aria-expanded': String(open) } : {}) },
          h(
            'div',
            { class: `tree-row${item.blocked ? ' blocked' : ''}`, style: `--depth:${depth}` },
            twisty,
            h('label', {}, input, icon('folder'), h('span', { class: 'tree-title' }, item.title), item.blocked ? h('span', { class: 'tree-note' }, item.blocked) : null),
          ),
          sub,
        ),
      );
    }
    return list;
  };

  const el = h('div', { class: 'tree' }, branch(null, 0));
  refresh();
  for (const id of picked) {
    for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent ?? null) {
      const li = inputs.get(p)?.closest('li');
      const sub = li?.querySelector(':scope > ul');
      const twisty = li?.querySelector(':scope > .tree-row > .twisty');
      if (sub instanceof HTMLElement && twisty instanceof HTMLButtonElement) setOpen(twisty, sub, true);
    }
  }
  return { el, value: () => [...picked] };
}

function setOpen(twisty: HTMLButtonElement, sub: HTMLElement, open: boolean) {
  sub.hidden = !open;
  twisty.setAttribute('aria-expanded', String(open));
  twisty.closest('li')?.setAttribute('aria-expanded', String(open));
  twisty.replaceChildren(icon(open ? 'chevron-down' : 'chevron-right'));
}

/** This browser's folders, with the ones another sync already holds (or contains) blocked. */
export function localItems(folders: LocalFolder[], groups: GroupSummary[], except?: string): TreeItem[] {
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  const blocked = new Map<string, string>();
  for (const g of groups) {
    if (g.groupId === except) continue;
    for (const id of g.held) {
      for (const f of folders) {
        for (let cur: string | null | undefined = f.id; cur; cur = parentOf.get(cur)) {
          if (cur === id) blocked.set(f.id, `Synced by “${g.name}”`);
        }
      }
      for (let cur = parentOf.get(id); cur; cur = parentOf.get(cur)) if (!blocked.has(cur)) blocked.set(cur, `Has a folder synced by “${g.name}”`);
    }
  }
  return folders.map((f) => ({ id: f.id, parent: f.parentId, title: f.title, ...(blocked.has(f.id) ? { blocked: blocked.get(f.id) } : {}) }));
}

const FIXED: { id: string; root: RootType; fallback: string }[] = [
  { id: 'root:toolbar', root: 'toolbar', fallback: 'Bookmarks bar' },
  { id: 'root:other', root: 'other', fallback: 'Other bookmarks' },
  { id: 'root:menu', root: 'menu', fallback: 'Bookmarks menu' },
];

const rootTitle = (folders: LocalFolder[], root: RootType, fallback: string) => folders.find((f) => f.parentId === null && f.root === root)?.title.replace(/ \((account|this device only)\)$/, '') ?? fallback;

/** A group's folders as tree items: an everything group under its three roots, a folder group by its tops. */
export function groupItems(mode: 'everything' | 'folder', groupFolders: GroupFolder[], local: LocalFolder[]): TreeItem[] {
  if (mode === 'folder') return groupFolders.map((f) => ({ id: f.id, parent: f.parent === 'root:group' ? null : f.parent, title: f.title }));
  return [...FIXED.map((r) => ({ id: r.id, parent: null, title: rootTitle(local, r.root, r.fallback) })), ...groupFolders.map((f) => ({ id: f.id, parent: f.parent, title: f.title }))];
}

/** Where a group folder goes by default: the same path under the same kind of browser folder. */
export function groupHint(mode: 'everything' | 'folder', groupFolders: GroupFolder[], id: string): PlaceHint {
  const byId = new Map(groupFolders.map((f) => [f.id, f]));
  const titles: string[] = [];
  let cur = byId.get(id);
  const fixed = FIXED.find((r) => r.id === id);
  if (fixed) return { root: fixed.root, path: [] };
  while (cur) {
    if (mode === 'folder' && cur.parent === 'root:group') return cur.hint ? { root: cur.hint.root, path: [...cur.hint.path, ...titles] } : { root: 'other', path: [cur.title, ...titles] };
    titles.unshift(cur.title);
    const root = FIXED.find((r) => r.id === cur!.parent);
    if (root) return { root: root.root, path: titles };
    cur = byId.get(cur.parent);
  }
  return { root: 'other', path: titles };
}

/** The local folder at `hint`, or null when it doesn't exist yet. */
export function findLocal(folders: LocalFolder[], hint: PlaceHint): string | null {
  let cur = folders.find((f) => f.parentId === null && f.root === (hint.root === 'menu' ? 'other' : hint.root))?.id;
  const path = hint.root === 'menu' && !folders.some((f) => f.root === 'menu') ? ['Bookmarks Menu', ...hint.path] : hint.path;
  for (const title of path) {
    if (!cur) return null;
    const parent: string = cur;
    cur = folders.find((f) => f.parentId === parent && f.title === title)?.id;
  }
  return cur ?? null;
}

export function hintText(folders: LocalFolder[], hint: PlaceHint): string {
  const fixed = FIXED.find((r) => r.root === hint.root);
  return [rootTitle(folders, hint.root, fixed?.fallback ?? 'Mobile bookmarks'), ...hint.path].join(' / ');
}

/**
 * One row per picked group folder, saying where it goes in this browser. Each defaults to the same place
 * (created if missing) and can be pointed at any local folder instead.
 */
export function placements(opts: { mode: 'everything' | 'folder'; groupFolders: GroupFolder[]; items: TreeItem[]; local: LocalFolder[]; localTree: () => TreeItem[]; onchange: () => void }) {
  const el = h('div', { class: 'placements stack' });
  const chosen = new Map<string, string>();
  let picked: string[] = [];
  const titleOf = (id: string) => opts.items.find((i) => i.id === id)?.title ?? id;
  const render = () => {
    el.replaceChildren(
      ...picked.map((id) => {
        const hint = groupHint(opts.mode, opts.groupFolders, id);
        const own = chosen.get(id);
        const existing = own ?? findLocal(opts.local, hint);
        const where = own ? (opts.local.find((f) => f.id === own)?.path ?? own) : existing ? (opts.local.find((f) => f.id === existing)?.path ?? hintText(opts.local, hint)) : hintText(opts.local, hint);
        const pickerBox = h('div', { class: 'stack' });
        pickerBox.hidden = true;
        const change = h('button', { type: 'button', class: 'ghost' }, own ? 'Change' : 'Put it somewhere else');
        change.addEventListener('click', () => {
          if (!pickerBox.hidden) return void (pickerBox.hidden = true);
          const tree = folderTree(opts.localTree(), { multi: false, selected: own ? [own] : existing ? [existing] : [], label: `Where “${titleOf(id)}” goes`, onchange: (ids) => {
            if (ids[0]) chosen.set(id, ids[0]);
            render();
            opts.onchange();
          } });
          pickerBox.replaceChildren(tree.el);
          if (own) pickerBox.append(h('button', { type: 'button', class: 'ghost', onclick: () => (chosen.delete(id), render(), opts.onchange()) }, 'Use the same place as the other browsers'));
          pickerBox.hidden = false;
        });
        return h(
          'div',
          { class: 'placement' },
          h('div', { class: 'row spread' }, h('div', { class: 'stack', style: 'gap:2px' }, h('b', {}, titleOf(id)), h('span', { class: 'muted small' }, existing ? `Goes into ${where}` : `A new folder is made at ${where}`)), change),
          pickerBox,
        );
      }),
    );
  };
  return {
    el,
    set(ids: string[]) {
      picked = ids;
      for (const k of [...chosen.keys()]) if (!ids.includes(k)) chosen.delete(k);
      render();
    },
    choices: (): PartChoice[] => picked.map((part) => (chosen.has(part) ? { part, folderId: chosen.get(part)! } : { part, hint: groupHint(opts.mode, opts.groupFolders, part) })),
    /** True when nothing was moved away from its default place. */
    defaults: () => chosen.size === 0,
  };
}
