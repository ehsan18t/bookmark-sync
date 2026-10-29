import { useState } from 'preact/hooks';
import type { GroupSummary } from '../../engine/app.js';
import { groups } from '../state/store.js';

/** The group a tab shows: the picked one, or the first. */
export function useGroupPick(): [GroupSummary | undefined, (groupId: string) => void] {
  const [id, setId] = useState<string | null>(null);
  const list = groups.value;
  return [list.find((x) => x.groupId === id) ?? list[0], setId];
}
