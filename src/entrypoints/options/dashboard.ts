import { browser } from 'wxt/browser';
import type { DuplicateGroup } from '../../core/dedupe.js';
import type { GroupSummary, Settings } from '../../engine/app.js';
import type { TimelineEntry } from '../../engine/group.js';
import { originPattern } from '../../browser/providers.js';
import { action, brand, errorText, field, h, hlcTime, relativeTime, send } from '../../ui/dom.js';
import { icon, type IconName } from '../../ui/icons.js';
import { load, REASON_TEXT, state, storageLabel } from './shared.js';

type Tab = 'overview' | 'history' | 'browsers' | 'duplicates' | 'settings';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'browsers', label: 'Browsers', icon: 'devices' },
  { id: 'duplicates', label: 'Duplicates', icon: 'copy' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function renderDashboard(root: HTMLElement, tab: Tab, refresh: () => Promise<void>) {
  const panel = h('div', { class: 'stack lg' });
  root.replaceChildren(
    h(
      'div',
      { class: 'page wide' },
      h('div', { class: 'topbar' }, brand(), action('Sync now', async () => (await send({ t: 'syncNow' }), refresh()), { icon: 'refresh', busy: 'Syncing…' })),
      h(
        'nav',
        { class: 'tabs', role: 'tablist' },
        ...TABS.map((t) => h('button', { role: 'tab', 'aria-selected': String(t.id === tab), onclick: () => (location.hash = t.id) }, icon(t.icon), t.label)),
      ),
      panel,
    ),
  );
  const render = { overview, history, browsers, duplicates, settings }[tab];
  void render(panel, refresh).catch((e) => panel.replaceChildren(h('div', { class: 'error' }, icon('alert-triangle'), h('span', {}, errorText(e)))));
}

export const isTab = (s: string): s is Tab => TABS.some((t) => t.id === s);

function statusPill(g: GroupSummary) {
  if (g.status.state === 'active') return g.lastError ? h('span', { class: 'pill warn' }, icon('alert-triangle'), 'Retrying') : h('span', { class: 'pill ok' }, icon('circle-check'), 'Syncing');
  if (g.status.reason === 'migration') return h('span', { class: 'pill accent' }, icon('loader-2', 'spin'), 'Switching encryption');
  return h('span', { class: 'pill warn' }, icon('player-pause'), 'Paused');
}

async function overview(panel: HTMLElement, refresh: () => Promise<void>) {
  panel.replaceChildren(
    ...state.groups.map((g) => syncCard(g, refresh)),
    h('div', { class: 'row' }, h('button', { onclick: () => (location.hash = 'setup') }, icon('plus'), 'Add another sync')),
  );
}

function syncCard(g: GroupSummary, refresh: () => Promise<void>) {
  const account = state.accounts.find((a) => a.id === g.accountId);
  const more = h('div', { class: 'stack' });
  return h(
    'div',
    { class: 'card stack lg' },
    h(
      'div',
      { class: 'row spread' },
      h('div', { class: 'stack', style: 'gap:4px' }, h('div', { class: 'row' }, h('h2', {}, g.name), statusPill(g), g.encrypted ? h('span', { class: 'pill' }, icon('lock'), 'Encrypted') : null), h('span', { class: 'muted' }, `${g.location} · ${storageLabel(account)}`)),
      action('Sync now', async () => (await send({ t: 'syncGroup', groupId: g.groupId }), refresh()), { icon: 'refresh', busy: 'Syncing…' }),
    ),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, String(g.bookmarks)), h('span', {}, 'bookmarks')),
      h('div', { class: 'stat' }, h('b', {}, relativeTime(g.lastSyncAt)), h('span', {}, 'last synced')),
      h('div', { class: 'stat' }, h('b', {}, String(g.pendingChanges)), h('span', {}, 'changes waiting to upload')),
    ),
    pauseBanner(g, refresh),
    g.status.state === 'active' && g.lastError ? h('div', { class: 'banner' }, icon('alert-triangle'), h('div', { class: 'body' }, h('span', {}, `The last sync didn’t finish: ${g.lastError} It retries by itself.`))) : null,
    h(
      'details',
      { class: 'advanced' },
      h('summary', {}, icon('chevron-right'), 'More options'),
      h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'row' },
          h('button', { onclick: () => more.replaceChildren(encryptionPanel(g, refresh)) }, icon('shield-lock'), g.encrypted ? 'Turn off encryption' : 'Turn on encryption'),
          g.canUndoJoin
            ? action('Undo joining', async () => (await send({ t: 'undoJoin', groupId: g.groupId }), refresh()), {
                icon: 'history',
                confirm: 'Undo joining this sync? What this browser added is removed from the sync, this browser’s bookmarks go back to how they were before joining, and syncing stops here.',
              })
            : null,
          action('Stop syncing here', async () => (await send({ t: 'leave', groupId: g.groupId }), refresh()), { icon: 'logout', confirm: 'Stop syncing in this browser? Your bookmarks stay as they are, and your other browsers keep syncing.' }),
          action('Delete this sync', async () => (await send({ t: 'deleteEverywhere', groupId: g.groupId }), refresh()), {
            kind: 'danger',
            icon: 'trash',
            confirm: 'Delete this sync for every browser? Each browser keeps its bookmarks, but nothing syncs any more, and the history is deleted from the storage.',
          }),
        ),
        more,
      ),
    ),
  );
}

function pauseBanner(g: GroupSummary, refresh: () => Promise<void>) {
  if (g.status.state !== 'paused') return null;
  const reason = g.status.reason;
  const buttons = h('div', { class: 'row' });
  const resolve = (choice: 'apply' | 'revert' | 'resume') => async () => (await send({ t: 'resolve', groupId: g.groupId, choice }), refresh());
  let text = REASON_TEXT[reason] ?? 'Syncing is paused.';
  if ((reason === 'large-remote-change' || reason === 'large-local-change') && g.guard) text += ` ${g.guard.count} of ${g.guard.total} bookmarks would be removed, moved, or edited.`;
  if (reason === 'large-remote-change' || reason === 'large-local-change') {
    buttons.append(
      action(reason === 'large-remote-change' ? 'Apply the change here' : 'Send the change', resolve('apply'), { kind: 'primary' }),
      action(reason === 'large-remote-change' ? 'Undo it everywhere' : 'Put my bookmarks back', resolve('revert')),
    );
  } else if (reason === 'locked') {
    const pass = h('input', { type: 'password', placeholder: 'Passphrase', style: 'max-width:260px' });
    const remember = h('input', { type: 'checkbox', checked: true });
    buttons.append(pass, h('label', { class: 'check' }, remember, 'Remember in this browser'), action('Unlock', async () => (await send({ t: 'unlock', groupId: g.groupId, passphrase: pass.value, remember: remember.checked }), refresh()), { kind: 'primary' }));
  } else if (reason === 'migration' && g.migration) {
    if (g.migration.waitingFor.length) {
      buttons.append(h('span', { class: 'muted' }, `Waiting for ${g.migration.waitingFor.length} other ${g.migration.waitingFor.length === 1 ? 'browser' : 'browsers'} to move over.`));
      if (g.migration.initiator) buttons.append(action('Continue without them', async () => (await send({ t: 'continueMigration', groupId: g.groupId, deviceIds: g.migration!.waitingFor }), refresh())));
    }
  } else if (reason === 'permission') {
    const account = state.accounts.find((a) => a.id === g.accountId);
    if (account?.url)
      buttons.append(action('Allow access', async () => {
        if (!(await browser.permissions.request({ origins: [originPattern(account.url!)] }))) throw new Error('Choose Allow so the extension can reach the server.');
        await send({ t: 'resolve', groupId: g.groupId, choice: 'resume' });
        await refresh();
      }, { kind: 'primary' }));
  } else if (reason === 'auth') {
    buttons.append(h('button', { onclick: () => (location.hash = 'settings') }, 'Open Settings'));
  } else if (reason !== 'group-deleted' && reason !== 'format-too-new') {
    buttons.append(action('Resume syncing', resolve('resume'), { kind: 'primary' }));
  }
  return h('div', { class: 'banner' }, icon('player-pause'), h('div', { class: 'body' }, h('span', {}, text), buttons.childElementCount ? buttons : null));
}

function encryptionPanel(g: GroupSummary, refresh: () => Promise<void>) {
  const pass = h('input', { type: 'password', autocomplete: 'new-password' });
  const again = h('input', { type: 'password', autocomplete: 'new-password' });
  const run = async () => {
    if (!g.encrypted) {
      if (pass.value.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      if (pass.value !== again.value) throw new Error('The passphrases don’t match.');
    }
    await send({ t: 'setEncryption', groupId: g.groupId, passphrase: g.encrypted ? null : pass.value });
    await refresh();
  };
  return h(
    'div',
    { class: 'card stack' },
    h('p', { class: 'muted' }, g.encrypted ? 'Your bookmarks will be stored without encryption. Every browser moves over by itself, and nothing is lost.' : 'Your bookmarks will be stored encrypted. Every browser needs the passphrase, and it can’t be recovered if you lose it.'),
    g.encrypted ? null : h('div', { class: 'fields-2' }, field('Passphrase', pass), field('Repeat passphrase', again)),
    action(g.encrypted ? 'Turn off encryption' : 'Turn on encryption', run, { kind: 'primary', busy: 'Switching…' }),
  );
}

function groupPicker(onpick: (g: GroupSummary) => void) {
  if (state.groups.length < 2) return null;
  const select = h('select', { style: 'max-width:280px' }, ...state.groups.map((g) => h('option', { value: g.groupId }, g.name)));
  select.addEventListener('change', () => onpick(state.groups.find((g) => g.groupId === select.value)!));
  return select;
}

function emptyState(iconName: IconName, title: string, text: string, button?: HTMLElement) {
  return h('div', { class: 'card empty' }, icon(iconName, 'xl'), h('h3', {}, title), h('p', { class: 'muted' }, text), button ?? null);
}

/** The latest HLC that sorts before `hlc`: one millisecond earlier, after every op in that millisecond. */
const justBefore = (hlc: string) => `${String(Number(hlc.slice(0, 15)) - 1).padStart(15, '0')}-999999-~`;

const KIND_TEXT: Record<string, string> = { create: 'added', update: 'edited', move: 'moved', delete: 'removed', undelete: 'restored' };

async function history(panel: HTMLElement, refresh: () => Promise<void>) {
  const body = h('div', { class: 'stack lg' });
  const show = async (g: GroupSummary) => {
    body.replaceChildren(h('div', { class: 'row muted' }, icon('loader-2', 'spin'), 'Loading history…'));
    const [entries, devices] = await Promise.all([send<TimelineEntry[]>({ t: 'timeline', groupId: g.groupId }), send<{ deviceId: string; name: string; self: boolean }[]>({ t: 'devices', groupId: g.groupId })]);
    const name = (d: string) => {
      const x = devices.find((v) => v.deviceId === d);
      return x ? (x.self ? 'This browser' : x.name) : 'A removed browser';
    };
    const describe = (k: Record<string, number>) =>
      Object.entries(k)
        .map(([type, n]) => `${n} ${KIND_TEXT[type] ?? type}`)
        .join(', ');
    const restoreTo = async (hlc: string) => {
      const p = await send<{ restored: number; removed: number; changed: number }>({ t: 'previewRestore', groupId: g.groupId, hlc });
      if (!window.confirm(`Go back to how bookmarks were at ${hlcTime(hlc)}?\n\n${p.restored} come back, ${p.removed} are removed, and ${p.changed} change. Every browser follows, and you can undo this from the history.`)) return;
      await send({ t: 'restore', groupId: g.groupId, hlc });
      await refresh();
    };
    body.replaceChildren(h('div', { class: 'stack lg' },
      g.restorePoints.length
        ? h(
            'div',
            { class: 'stack' },
            h('h3', {}, 'Saved points'),
            h('div', { class: 'card flush' }, h('ul', { class: 'list' }, ...g.restorePoints.map((r) => h('li', {}, icon('clock'), h('div', { class: 'grow' }, h('div', {}, r.label), h('div', { class: 'meta' }, hlcTime(r.hlc))), action('Go back to this', () => restoreTo(r.hlc)))))),
          )
        : null,
      h(
        'div',
        { class: 'stack' },
        h('h3', {}, 'Recent changes'),
        entries.length
          ? h(
              'div',
              { class: 'card flush' },
              h(
                'ul',
                { class: 'list' },
                ...entries.map((e) =>
                  h(
                    'li',
                    {},
                    h('div', { class: 'grow' }, h('div', {}, `${name(e.device)} · ${describe(e.kinds)}`), h('div', { class: 'meta' }, hlcTime(e.to))),
                    e.from > g.oldestRestorable ? action('Undo from here', () => restoreTo(justBefore(e.from)), { kind: 'ghost' }) : null,
                  ),
                ),
              ),
            )
          : emptyState('history', 'No changes yet', 'Changes from every browser show up here, so you can go back to an earlier point.'),
      ),
    ));
  };
  if (!state.groups.length) return void panel.replaceChildren(emptyState('history', 'Nothing synced yet', 'Set up a sync to keep a history of changes.'));
  panel.replaceChildren(
    h('div', { class: 'section-title' }, h('p', { class: 'muted' }, 'Every change from every browser, kept for the number of days set in Settings. Going back applies to every browser, and can itself be undone.'), groupPicker((g) => void show(g))),
    body,
  );
  await show(state.groups[0]!);
}

async function browsers(panel: HTMLElement) {
  if (!state.groups.length) return void panel.replaceChildren(emptyState('devices', 'Nothing synced yet', 'Browsers that sync with you show up here.'));
  const body = h('div');
  const show = async (g: GroupSummary) => {
    const list = await send<{ deviceId: string; name: string; browser: string; lastSeen: number; left: boolean; removed: boolean; self: boolean }[]>({ t: 'devices', groupId: g.groupId });
    const active = list.filter((d) => !d.left && !d.removed);
    body.replaceChildren(
      h(
        'div',
        { class: 'card flush' },
        h(
          'ul',
          { class: 'list' },
          ...active.map((d) =>
            h(
              'li',
              {},
              icon('world', 'lg'),
              h('div', { class: 'grow' }, h('div', { class: 'row', style: 'gap:8px' }, h('b', {}, d.name), d.self ? h('span', { class: 'pill accent' }, 'This browser') : null), h('div', { class: 'meta' }, d.self ? 'Online now' : `Last synced ${relativeTime(d.lastSeen)}`)),
              d.self ? null : action('Remove', async () => (await send({ t: 'removeDevice', groupId: g.groupId, deviceId: d.deviceId }), show(g)), { kind: 'ghost', confirm: `Remove ${d.name} from this sync? Do this after uninstalling the extension there, or if you no longer use that browser.` }),
            ),
          ),
        ),
      ),
    );
  };
  panel.replaceChildren(h('div', { class: 'section-title' }, h('p', { class: 'muted' }, 'Browsers that share these bookmarks.'), groupPicker((g) => void show(g))), body);
  await show(state.groups[0]!);
}

async function duplicates(panel: HTMLElement) {
  const out = h('div', { class: 'stack' });
  const undo = h('div', { class: 'stack' });
  const showUndo = async () => {
    const list = await send<{ id: string; at: number; label: string }[]>({ t: 'localUndo' });
    undo.replaceChildren(...list.map((u) => h('div', { class: 'banner info' }, icon('history'), h('div', { class: 'body row spread' }, h('span', {}, `${u.label} · ${relativeTime(u.at)}`), action('Undo', async () => (await send({ t: 'undoLocal', id: u.id }), showUndo()))))));
  };
  const scan = async () => {
    const groups = await send<DuplicateGroup[]>({ t: 'scanDuplicates' });
    out.replaceChildren(groups.length ? h('div', { class: 'stack' }, h('h3', {}, `${groups.length} ${groups.length === 1 ? 'set' : 'sets'} of duplicates`), ...groups.map((g) => duplicateCard(g, scan))) : emptyState('circle-check', 'No duplicates', 'Every bookmark points to a different page.'));
    await showUndo();
  };
  panel.replaceChildren(
    h('div', { class: 'section-title' }, h('p', { class: 'muted' }, 'Find bookmarks that point to the same page. Nothing is removed until you choose, and synced cleanups can be undone from History.'), action('Find duplicates', scan, { kind: 'primary', icon: 'copy', busy: 'Searching…' })),
    undo,
    out,
  );
  await showUndo();
}

function duplicateCard(g: DuplicateGroup, rescan: () => Promise<void>) {
  const name = `dup-${g.key}`;
  const radios = g.items.map((it, i) => h('input', { type: 'radio', name, value: it.localId, checked: i === 0 }));
  const folder = h('select', { style: 'max-width:260px' }, ...state.folders.map((f) => h('option', { value: f.id }, f.path)));
  const keep = () => radios.find((r) => r.checked)!.value;
  return h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'row spread' }, h('span', { class: 'pill' }, g.level === 'exact' ? 'Same page' : 'Probably the same page'), h('span', { class: 'muted small' }, 'Pick the one to keep')),
    h(
      'div',
      { class: 'stack' },
      ...g.items.map((it, i) => h('label', { class: 'check' }, radios[i]!, h('span', { class: 'grow' }, it.title || 'Untitled', h('div', { class: 'url' }, `${it.url} · ${it.path}${it.group ? ` · synced in ${it.group}` : ''}`)))),
    ),
    h(
      'div',
      { class: 'row' },
      action('Keep this one, remove the rest', async () => (await send({ t: 'applyDedupe', action: { remove: g.items.map((i) => i.localId).filter((id) => id !== keep()) } }), rescan()), { kind: 'primary' }),
      h('span', { class: 'muted' }, 'or'),
      folder,
      action('Move them all here', async () => (await send({ t: 'applyDedupe', action: { move: g.items.map((i) => i.localId), folderId: folder.value } }), rescan())),
    ),
  );
}

async function settings(panel: HTMLElement, refresh: () => Promise<void>) {
  const s = await send<Settings & { deviceName: string }>({ t: 'settings' });
  const deviceName = h('input', { type: 'text', value: s.deviceName });
  const history = h('input', { type: 'number', min: 0, max: 365, value: s.historyDays });
  const percent = h('input', { type: 'number', min: 1, max: 100, value: s.guardPercent });
  const min = h('input', { type: 'number', min: 1, value: s.guardMin });
  const pull = h('input', { type: 'number', min: 1, max: 60, value: s.pullMinutes });
  const setting = (title: string, hint: string, control: Node) => h('div', { class: 'setting' }, h('div', { class: 'label' }, h('b', {}, title), h('span', { class: 'hint' }, hint)), control);
  const num = (before: string, input: HTMLInputElement, after: string) => h('span', { class: 'inline-num' }, before, input, after);
  const save = async () => {
    const n = (i: HTMLInputElement, lo: number, hi: number, what: string) => {
      const v = Number(i.value);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} must be between ${lo} and ${hi}.`);
      return Math.round(v);
    };
    await send({
      t: 'updateSettings',
      patch: {
        deviceName: deviceName.value.trim() || s.deviceName,
        historyDays: n(history, 0, 365, 'Days of history'),
        guardPercent: n(percent, 1, 100, 'The percentage'),
        guardMin: n(min, 1, 100_000, 'The number of bookmarks'),
        pullMinutes: n(pull, 1, 60, 'Minutes'),
      },
    });
    saved.textContent = 'Saved';
    setTimeout(() => (saved.textContent = ''), 2000);
  };
  const saved = h('span', { class: 'pill ok', role: 'status' });
  const exportDiagnostics = async () => {
    const data = await send({ t: 'diagnostics' });
    h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'bookmark-sync-diagnostics.json' }).click();
  };
  panel.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h('h3', {}, 'This browser'),
      h(
        'div',
        { class: 'card flush' },
        setting('Name', 'How this browser appears in your other browsers.', deviceName),
        setting('History', 'How long changes are kept so you can go back. 0 turns history off.', num('Keep', history, 'days')),
        setting('Big changes', 'Syncing pauses and asks first when a change would remove, move, or edit at least this much.', h('div', { class: 'stack', style: 'gap:6px' }, num('More than', percent, '% of bookmarks'), num('and at least', min, 'bookmarks'))),
        setting('Checking for changes', 'Changes made here sync within seconds. Changes from other browsers are checked this often, and when you switch windows.', num('Every', pull, 'minutes')),
      ),
      h('div', { class: 'row' }, action('Save changes', save, { kind: 'primary' }), saved),
    ),
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'section-title' }, h('h3', {}, 'Storage'), h('button', { onclick: () => (location.hash = 'setup') }, icon('plus'), 'Connect storage')),
      state.accounts.length
        ? h(
            'div',
            { class: 'card flush' },
            h(
              'ul',
              { class: 'list' },
              ...state.accounts.map((a) => {
                const used = state.groups.filter((g) => g.accountId === a.id).map((g) => g.name);
                return h(
                  'li',
                  {},
                  icon(a.type === 'gdrive' ? 'brand-google-drive' : 'server', 'lg'),
                  h('div', { class: 'grow' }, h('b', {}, storageLabel(a)), h('div', { class: 'meta' }, [a.type === 'webdav' && a.url ? decodeURI(a.url) : null, used.length ? `Used by ${used.join(', ')}` : 'Not used by any sync'].filter(Boolean).join(' · '))),
                  action('Remove', async () => (await send({ t: 'removeAccount', id: a.id }), await load(), refresh()), { kind: 'ghost', confirm: `Remove ${storageLabel(a)} from this browser? Nothing is deleted from the storage.` }),
                );
              }),
            ),
          )
        : emptyState('cloud', 'No storage connected', 'Connect Google Drive or your own server to start syncing.'),
    ),
    h('div', { class: 'stack' }, h('h3', {}, 'Troubleshooting'), h('div', { class: 'card flush' }, setting('Diagnostics', 'A file with sync details for reporting a problem. It contains no bookmarks, passwords, or passphrases.', action('Export', exportDiagnostics)))),
  );
}
