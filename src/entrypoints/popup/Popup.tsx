import { useSignal } from '@preact/signals';
import { Action } from '../../ui/components/Action.js';
import { Brand } from '../../ui/components/Brand.js';
import { ErrorText } from '../../ui/components/ErrorText.js';
import { Icon } from '../../ui/components/Icon.js';
import { failure, ready } from '../../ui/state/boot.js';
import { groups, refreshError, sendAndReload } from '../../ui/state/store.js';
import { openPage } from './openPage.js';
import { PopupAbout } from './PopupAbout.js';
import { PopupSyncCard } from './PopupSyncCard.js';

export function Popup() {
  const about = useSignal(false);
  if (failure.value) return <ErrorText>{failure.value}</ErrorText>;
  if (!ready.value) return null;
  if (about.value) return <PopupAbout onBack={() => (about.value = false)} />;
  const aboutButton = (
    <button type="button" class="ghost" aria-label="About" title="About" onClick={() => (about.value = true)}>
      <Icon name="info-circle" />
    </button>
  );
  const stale = refreshError.value && <ErrorText>{refreshError.value} What you see may be out of date.</ErrorText>;
  const list = groups.value;
  if (!list.length)
    return (
      <>
        <div class="popup-head">
          <Brand />
          {aboutButton}
        </div>
        {stale}
        <div class="popup-card stack center">
          <div class="done-mark invite">
            <Icon name="cloud-upload" class="lg" />
          </div>
          <b>Sync isn’t set up yet</b>
          <p class="muted small">Connect Google Drive or your own server to keep bookmarks the same in every browser.</p>
          <button type="button" class="primary block" onClick={openPage('setup')}>
            Set up sync
          </button>
        </div>
      </>
    );
  return (
    <>
      <div class="popup-head">
        <Brand />
        <div class="popup-head-actions">
          <Action label="Sync now" kind="ghost" icon="refresh" busy="Syncing…" run={() => sendAndReload({ t: 'syncNow' })} />
          <button type="button" class="ghost" aria-label="Settings" title="Settings" onClick={openPage('settings')}>
            <Icon name="settings" />
          </button>
          {aboutButton}
        </div>
      </div>
      {stale}
      {list.map((g) => (
        <PopupSyncCard key={g.groupId} g={g} />
      ))}
      <div class="popup-foot">
        <button type="button" class="ghost" onClick={openPage('overview')}>
          <Icon name="layout-dashboard" />
          Open dashboard
        </button>
        <button type="button" class="ghost" onClick={openPage('history')}>
          <Icon name="history" />
          History
        </button>
      </div>
    </>
  );
}
