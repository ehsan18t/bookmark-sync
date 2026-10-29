import { EmptyState } from '../../../../ui/components/EmptyState.js';
import { useGroupPick } from '../../../../ui/hooks/useGroupPick.js';
import { GroupPicker } from '../GroupPicker.js';
import { SectionTitle } from '../SectionTitle.js';
import { DeviceList } from './DeviceList.js';

export function Browsers() {
  const [g, pick] = useGroupPick();
  if (!g) return <EmptyState icon="devices" title="Nothing synced yet" text="Browsers that sync with you show up here." />;
  return (
    <>
      <SectionTitle>
        <p class="muted">Browsers that share these bookmarks.</p>
        <GroupPicker value={g} onChange={pick} />
      </SectionTitle>
      <DeviceList key={g.groupId} g={g} />
    </>
  );
}
