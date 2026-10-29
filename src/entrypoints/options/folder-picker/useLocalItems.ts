import { useMemo } from 'preact/hooks';
import { folders, groups } from '../../../ui/state/store.js';
import { localItems, type TreeItem } from './treeItems.js';

/** This browser's folder tree, rebuilt only when a new snapshot changes the folders or syncs. */
export function useLocalItems(except?: string): TreeItem[] {
  const local = folders.value;
  const all = groups.value;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each snapshot replaces the folders and groups arrays, so they are real deps
  return useMemo(() => localItems(local, all, except), [local, all, except]);
}
