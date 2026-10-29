import type { PlaceHint, RootType } from '../../core/ids.js';
import type { GroupSummary, LocalFolder, PartChoice } from '../../engine/app.js';
import type { GroupFolder } from '../../engine/group.js';

export interface TreeItem {
  id: string;
  parent: string | null;
  title: string;
  /** Why the folder can't be picked, shown next to it. */
  blocked?: string;
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

export function placementChoices(mode: 'everything' | 'folder', groupFolders: GroupFolder[], picked: string[], chosen: Record<string, string>): PartChoice[] {
  return picked.map((part) => (chosen[part] ? { part, folderId: chosen[part] } : { part, hint: groupHint(mode, groupFolders, part) }));
}
