import type { ChangeDetail } from '../../../../core/changes.js';
import type { TimelineEntry } from '../../../../engine/group.js';

/** The latest HLC that sorts before `hlc`: one millisecond earlier, after every op in that millisecond. */
export const justBefore = (hlc: string) => `${String(Number(hlc.slice(0, 15)) - 1).padStart(15, '0')}-999999-~`;

export const timeOf = (hlc: string) => new Date(Number(hlc.slice(0, 15))).toLocaleTimeString();

/** One date, then one time or a range of times; a span across midnight names both dates. */
export function spanText(from: string, to: string): string {
  const [a, b] = [from, to].map((h) => new Date(Number(h.slice(0, 15))));
  const day = a!.toLocaleDateString();
  if (day !== b!.toLocaleDateString()) return `${a!.toLocaleString()} to ${b!.toLocaleString()}`;
  const [ta, tb] = [timeOf(from), timeOf(to)];
  return ta === tb ? `${day}, ${ta}` : `${day}, ${ta} to ${tb}`;
}

const KIND_TEXT: Record<string, string> = { create: 'added', update: 'edited', move: 'moved', delete: 'removed', undelete: 'restored' };

export const describeKinds = (kinds: Record<string, number>) =>
  Object.entries(kinds)
    .map(([type, n]) => `${n} ${KIND_TEXT[type] ?? type}`)
    .join(', ');

const ROOT_TEXT: Record<string, string> = { 'root:toolbar': 'Bookmarks bar', 'root:other': 'Other bookmarks', 'root:menu': 'Bookmarks menu' };

export const folderText = (path: readonly string[]) => path.map((p) => ROOT_TEXT[p] ?? (p || 'Untitled folder')).join(' / ');

export const itemName = (c: ChangeDetail) => (c.kind === 'separator' ? 'a separator' : `“${c.title || c.url || 'Untitled'}”`);

export const actionText = (c: ChangeDetail) => (c.type === 'move' && !c.from ? 'reordered' : (KIND_TEXT[c.type] ?? c.type));

/** A row with one change names it; a row with several counts them. */
export const describeEntry = (e: TimelineEntry) => (e.count === 1 && e.changes[0] ? `${actionText(e.changes[0])} ${itemName(e.changes[0])}` : describeKinds(e.kinds));
