import type { JoinPreview } from '../../../engine/group.js';
import { plural } from '../../../ui/lib/format.js';

const count = (n: number) => plural(n, 'item', 'items');

export function previewText(p: JoinPreview) {
  const parts = [`This browser gets ${count(p.groupItems)} from the sync.`];
  if (p.added) parts.push(`${count(p.added)} from here ${p.added === 1 ? 'is' : 'are'} added to it.`);
  if (p.matched) parts.push(`${count(p.matched)} already ${p.matched === 1 ? 'matches' : 'match'}.`);
  if (p.removedLocal) parts.push(`${count(p.removedLocal)} ${p.removedLocal === 1 ? 'is' : 'are'} removed from this browser.`);
  if (p.ignoredDefaults) parts.push(`${count(p.ignoredDefaults)} of the browser’s sample bookmarks ${p.ignoredDefaults === 1 ? 'is' : 'are'} left out.`);
  return parts.join(' ');
}
