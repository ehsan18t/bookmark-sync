import { Icon } from '../../../../ui/components/Icon.js';
import { groups } from '../../../../ui/state/store.js';
import { SyncCard } from './SyncCard.js';

export function Overview() {
  return (
    <>
      {groups.value.map((g) => (
        <SyncCard key={g.groupId} g={g} />
      ))}
      <div class="row">
        <button type="button" onClick={() => (location.hash = 'setup')}>
          <Icon name="plus" />
          Add another sync
        </button>
      </div>
    </>
  );
}
