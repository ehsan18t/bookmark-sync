import { signal } from '@preact/signals';
import { render } from 'preact';
import { browser } from 'wxt/browser';
import { APP_NAME } from '../../config.js';
import type { GroupSummary } from '../../engine/app.js';
import { SHORT_REASON } from '../options/shared.js';
import { Action, Brand, ErrorText, Icon, Pill } from '../../ui/components.js';
import { errorText, relativeTime, send } from '../../ui/util.js';
import '../../ui/styles.css';

document.title = APP_NAME;

const groups = signal<GroupSummary[] | null>(null);
const failure = signal('');

async function load() {
  try {
    groups.value = await send<GroupSummary[]>({ t: 'status' });
  } catch (e) {
    failure.value = errorText(e);
  }
}

const open = (hash: string) => async () => {
  await browser.tabs.create({ url: browser.runtime.getURL(`/options.html#${hash}`) });
  window.close();
};

function StatusPill({ g }: { g: GroupSummary }) {
  const reason = g.status.state === 'paused' ? g.status.reason : null;
  if (reason === 'migration')
    return (
      <Pill kind="accent" icon="loader-2" spin>
        Switching encryption
      </Pill>
    );
  if (reason)
    return (
      <Pill kind="warn" icon="player-pause">
        {SHORT_REASON[reason] ?? 'Paused'}
      </Pill>
    );
  if (g.lastError)
    return (
      <Pill kind="warn" icon="alert-triangle">
        Retrying
      </Pill>
    );
  return (
    <Pill kind="ok" icon="circle-check">
      Up to date
    </Pill>
  );
}

function SyncCard({ g }: { g: GroupSummary }) {
  const paused = g.status.state === 'paused' && g.status.reason !== 'migration';
  return (
    <div class="popup-card stack" style="gap:8px">
      <div class="row spread">
        <b>{g.name}</b>
        <StatusPill g={g} />
      </div>
      <div class="muted small">
        {g.bookmarks} {g.bookmarks === 1 ? 'bookmark' : 'bookmarks'} · synced {relativeTime(g.lastSyncAt)}
        {g.pendingChanges ? ` · ${g.pendingChanges} waiting` : ''}
      </div>
      {paused && (
        <button class="primary block" onClick={open('overview')}>
          Fix this
        </button>
      )}
    </div>
  );
}

function Popup() {
  if (failure.value) return <ErrorText>{failure.value}</ErrorText>;
  const list = groups.value;
  if (!list) return null;
  if (!list.length)
    return (
      <>
        <div class="popup-head">
          <Brand />
        </div>
        <div class="popup-card stack center">
          <div class="done-mark" style="width:48px;height:48px;background:var(--accent-bg);color:var(--accent-text)">
            <Icon name="cloud-upload" class="lg" />
          </div>
          <b>Sync isn’t set up yet</b>
          <p class="muted small">Connect Google Drive or your own server to keep bookmarks the same in every browser.</p>
          <button class="primary block" onClick={open('setup')}>
            Set up sync
          </button>
        </div>
      </>
    );
  return (
    <>
      <div class="popup-head">
        <Brand />
        <Action label="Sync now" kind="ghost" icon="refresh" busy="Syncing…" run={async () => (await send({ t: 'syncNow' }), load())} />
      </div>
      {list.map((g) => (
        <SyncCard key={g.groupId} g={g} />
      ))}
      <div class="popup-foot">
        <button class="ghost" onClick={open('overview')}>
          <Icon name="layout-dashboard" />
          Open dashboard
        </button>
        <button class="ghost" onClick={open('history')}>
          <Icon name="history" />
          History
        </button>
      </div>
    </>
  );
}

render(<Popup />, document.getElementById('app')!);
void load();
