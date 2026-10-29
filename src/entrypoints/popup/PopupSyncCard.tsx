import type { GroupSummary } from '../../engine/app.js';
import { plural, relativeTime } from '../../ui/lib/format.js';
import { now } from '../../ui/state/store.js';
import { openPage } from './openPage.js';
import { PopupStatusPill } from './PopupStatusPill.js';

interface PopupSyncCardProps {
  g: GroupSummary;
}

export function PopupSyncCard({ g }: PopupSyncCardProps) {
  const paused = g.status.state === 'paused' && g.status.reason !== 'migration';
  return (
    <div class="popup-card stack compact">
      <div class="row spread">
        <b>{g.name}</b>
        <PopupStatusPill g={g} />
      </div>
      <div class="muted small">
        {plural(g.bookmarks, 'bookmark', 'bookmarks')} · synced {relativeTime(g.lastSyncAt, now.value)}
        {g.pendingChanges ? ` · ${g.pendingChanges} waiting` : ''}
      </div>
      {paused && (
        <button type="button" class="primary block" onClick={openPage('overview')}>
          Fix this
        </button>
      )}
    </div>
  );
}
