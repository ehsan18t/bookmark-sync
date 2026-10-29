import { EmptyState } from '../../../../ui/components/EmptyState.js';
import { useGroupPick } from '../../../../ui/hooks/useGroupPick.js';
import { GroupPicker } from '../GroupPicker.js';
import { SectionTitle } from '../SectionTitle.js';
import { Timeline } from './Timeline.js';

export function History() {
  const [g, pick] = useGroupPick();
  if (!g) return <EmptyState icon="history" title="Nothing synced yet" text="Set up a sync to keep a history of changes." />;
  return (
    <>
      <SectionTitle>
        <p class="muted">Every change from every browser, kept for the number of days set in Settings. Going back applies to every browser, and can itself be undone.</p>
        <GroupPicker value={g} onChange={pick} />
      </SectionTitle>
      <Timeline key={g.groupId} g={g} />
    </>
  );
}
