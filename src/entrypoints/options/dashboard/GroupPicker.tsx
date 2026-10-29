import type { GroupSummary } from '../../../engine/app.js';
import { groups } from '../../../ui/state/store.js';

interface GroupPickerProps {
  value: GroupSummary | undefined;
  onChange: (groupId: string) => void;
}

/** Picks the group a tab shows; hidden while there is only one. */
export function GroupPicker({ value, onChange }: GroupPickerProps) {
  const list = groups.value;
  if (list.length < 2) return null;
  return (
    <select class="picker" value={value?.groupId} onChange={(e) => onChange(e.currentTarget.value)}>
      {list.map((x) => (
        <option key={x.groupId} value={x.groupId}>
          {x.name}
        </option>
      ))}
    </select>
  );
}
