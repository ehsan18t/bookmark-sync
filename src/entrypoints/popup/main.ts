import { browser } from 'wxt/browser';
import { APP_NAME } from '../../config.js';
import type { GroupSummary } from '../../engine/app.js';
import { SHORT_REASON } from '../options/shared.js';
import { action, brand, errorText, h, relativeTime, send } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import '../../ui/styles.css';

const app = document.getElementById('app')!;
document.title = APP_NAME;

const open = (hash: string) => async () => {
  await browser.tabs.create({ url: browser.runtime.getURL(`/options.html#${hash}`) });
  window.close();
};

function syncCard(g: GroupSummary) {
  const reason = g.status.state === 'paused' ? g.status.reason : null;
  const paused = reason !== null && reason !== 'migration';
  const pill = paused
    ? h('span', { class: 'pill warn' }, icon('player-pause'), SHORT_REASON[reason] ?? 'Paused')
    : reason
      ? h('span', { class: 'pill accent' }, icon('loader-2', 'spin'), 'Switching encryption')
      : g.lastError
        ? h('span', { class: 'pill warn' }, icon('alert-triangle'), 'Retrying')
        : h('span', { class: 'pill ok' }, icon('circle-check'), 'Up to date');
  return h(
    'div',
    { class: 'popup-card stack', style: 'gap:8px' },
    h('div', { class: 'row spread' }, h('b', {}, g.name), pill),
    h('div', { class: 'muted small' }, `${g.bookmarks} ${g.bookmarks === 1 ? 'bookmark' : 'bookmarks'} · synced ${relativeTime(g.lastSyncAt)}${g.pendingChanges ? ` · ${g.pendingChanges} waiting` : ''}`),
    paused ? h('button', { class: 'primary block', onclick: open('overview') }, 'Fix this') : null,
  );
}

async function render() {
  const groups = await send<GroupSummary[]>({ t: 'status' });
  if (!groups.length) {
    app.replaceChildren(
      h('div', { class: 'popup-head' }, brand()),
      h(
        'div',
        { class: 'popup-card stack center' },
        h('div', { class: 'done-mark', style: 'width:48px;height:48px;background:var(--accent-bg);color:var(--accent-text)' }, icon('cloud-upload', 'lg')),
        h('b', {}, 'Sync isn’t set up yet'),
        h('p', { class: 'muted small' }, 'Connect Google Drive or your own server to keep bookmarks the same in every browser.'),
        h('button', { class: 'primary block', onclick: open('setup') }, 'Set up sync'),
      ),
    );
    return;
  }
  app.replaceChildren(
    h('div', { class: 'popup-head' }, brand(), action('Sync now', async () => (await send({ t: 'syncNow' }), render()), { kind: 'ghost', icon: 'refresh', busy: 'Syncing…' })),
    ...groups.map(syncCard),
    h('div', { class: 'popup-foot' }, h('button', { class: 'ghost', onclick: open('overview') }, icon('layout-dashboard'), 'Open dashboard'), h('button', { class: 'ghost', onclick: open('history') }, icon('history'), 'History')),
  );
}

void render().catch((e) => app.replaceChildren(h('div', { class: 'error' }, icon('alert-triangle'), h('span', {}, errorText(e)))));
