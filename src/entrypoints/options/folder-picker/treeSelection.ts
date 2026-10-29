import type { TreeItem } from './treeItems.js';

export function ancestors(byId: Map<string, TreeItem>, id: string): string[] {
  const out: string[] = [];
  for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent ?? null) out.push(p);
  return out;
}

/** With `multi`, ticking a folder takes in its subfolders, so ticks below it are dropped. */
export function toggle(items: TreeItem[], multi: boolean, value: string[], id: string, on: boolean): string[] {
  if (!multi) return on ? [id] : [];
  if (!on) return value.filter((v) => v !== id);
  const byId = new Map(items.map((i) => [i.id, i]));
  return [...value.filter((v) => !ancestors(byId, v).includes(id)), id];
}
