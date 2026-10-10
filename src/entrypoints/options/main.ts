import type { GroupSummary } from '../../engine/app.js';
import { errorText, h, send } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import '../../ui/styles.css';
import { isTab, renderDashboard } from './dashboard.js';
import { renderSetup } from './setup.js';
import { load, state } from './shared.js';

const app = document.getElementById('app')!;

async function route() {
  await load();
  const hash = location.hash.slice(1);
  if (hash === 'setup' || !state.groups.length) {
    renderSetup(app, () => {
      location.hash = 'overview';
      if (!state.groups.length) void route();
    });
    return;
  }
  renderDashboard(app, isTab(hash) ? hash : 'overview', refresh);
}

async function refresh() {
  await load();
  void route();
}

window.addEventListener('hashchange', () => void route().catch(fail));

function fail(e: unknown) {
  app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'banner danger' }, icon('alert-triangle'), h('div', { class: 'body' }, errorText(e)))));
}

void route().catch(fail);

setInterval(() => {
  const hash = location.hash.slice(1) || 'overview';
  if (hash !== 'overview' || document.visibilityState !== 'visible' || document.activeElement?.matches('input, select') || document.querySelector('details[open], button:disabled')) return;
  void send<GroupSummary[]>({ t: 'status' }).then((g) => {
    if (JSON.stringify(g) !== JSON.stringify(state.groups)) void refresh();
  });
}, 5000);
