import { browser } from 'wxt/browser';
import type { GroupSummary } from '../../engine/app.js';
import { action, h, relativeTime, send } from '../../ui/dom.js';
import '../../ui/styles.css';

const app = document.getElementById('app')!;

async function render() {
  const groups = await send<GroupSummary[]>({ t: 'status' });
  app.replaceChildren(
    h('div', { class: 'row spread' }, h('h3', {}, 'Bookmark sync'), action('Sync now', async () => (await send({ t: 'syncNow' }), render()), { kind: 'primary' })),
    groups.length
      ? h(
          'ul',
          { class: 'list', style: 'margin-top:8px' },
          ...groups.map((g) =>
            h(
              'li',
              {},
              h('div', { class: 'row spread' }, h('strong', {}, g.name), g.status.state === 'active' ? h('span', { class: 'pill ok' }, 'Syncing') : h('span', { class: 'pill warn' }, 'Needs attention')),
              h('div', { class: 'muted' }, `Last sync ${relativeTime(g.lastSyncAt)}${g.pendingChanges ? ` · ${g.pendingChanges} waiting` : ''}`),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'Nothing is syncing yet.'),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { onclick: () => void browser.runtime.openOptionsPage() }, 'Open settings')),
  );
}

void render().catch((e) => app.replaceChildren(h('p', { class: 'inline-error' }, e instanceof Error ? e.message : String(e))));
