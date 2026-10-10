import { browser } from 'wxt/browser';
import type { DuplicateGroup } from '../../core/dedupe.js';
import type { Account, GroupSummary, Settings, Target } from '../../engine/app.js';
import type { JoinPreview, TimelineEntry } from '../../engine/group.js';
import { originPattern } from '../../browser/providers.js';
import { action, h, hlcTime, relativeTime, send } from '../../ui/dom.js';
import '../../ui/styles.css';

type PublicAccount = Pick<Account, 'id' | 'type' | 'name'> & { url?: string; username?: string };
type Folder = { id: string; path: string };

const app = document.getElementById('app')!;
const state: { accounts: PublicAccount[]; groups: GroupSummary[]; folders: Folder[] } = { accounts: [], groups: [], folders: [] };

const REASON_TEXT: Record<string, string> = {
  'large-remote-change': 'Another browser made a large change. Apply it here, or revert it for every browser.',
  'large-local-change': 'You changed many bookmarks at once. Upload the change, or put the bookmarks back.',
  'native-sync':
    'Two browsers in this group seem to be linked by the browser’s own bookmark sync, which makes duplicates. Turn off bookmark sync in the browser settings (Chrome and Edge: Settings, You and Google / Profiles, Sync, Bookmarks; Firefox: Settings, Sync, Bookmarks), then resume.',
  locked: 'This group is encrypted. Enter its passphrase to keep syncing.',
  'clock-skew': 'This computer’s clock is off by more than two minutes. Fix the clock; syncing resumes on its own.',
  auth: 'The storage account rejected the sign-in. Remove and add the account again.',
  permission: 'The extension no longer has access to the storage server. Grant access again.',
  'mapped-folder-missing': 'The folder this group syncs into was deleted or moved. Leave the group, or put the folder back and resume.',
  'root-changed': 'The browser’s own bookmark folders changed. Leave and join again to pick them anew.',
  'mapping-overlap': 'Two synced folders now overlap. Move one of them, then resume.',
  'group-deleted': 'This group was deleted from another browser. Leave it; your bookmarks stay here.',
  'format-too-new': 'A newer version of the extension wrote these files. Update the extension.',
  corrupt: 'A file in the group could not be read. Export diagnostics and resume.',
  migration: 'Encryption is being switched for this group.',
  'needs-join': 'This browser needs to join the group again.',
};

async function refresh() {
  [state.groups, state.accounts, state.folders] = await Promise.all([
    send<GroupSummary[]>({ t: 'status' }),
    send<PublicAccount[]>({ t: 'accounts' }),
    send<Folder[]>({ t: 'folders' }),
  ]);
  render();
}

function render() {
  app.replaceChildren(
    h('h1', {}, 'Bookmark sync'),
    h('p', { class: 'muted' }, 'Sync bookmarks between your browsers through storage you choose.'),
    groupsSection(),
    addGroupSection(),
    accountsSection(),
    duplicatesSection(),
    settingsSection(),
  );
}

// Groups

function statusPill(g: GroupSummary) {
  if (g.status.state === 'active') return h('span', { class: 'pill ok' }, 'Syncing');
  return h('span', { class: 'pill warn' }, g.status.reason === 'migration' ? 'Switching encryption' : 'Paused');
}

function groupsSection() {
  if (state.groups.length === 0) return h('section', {}, h('h2', {}, 'Groups'), h('p', { class: 'muted' }, 'No groups yet. Add a storage account, then create or join a group.'));
  return h('section', {}, h('h2', {}, 'Groups'), ...state.groups.map(groupCard));
}

function groupCard(g: GroupSummary) {
  const detail = h('div');
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'row spread' },
      h('div', {}, h('h3', {}, g.name, ' ', statusPill(g)), h('div', { class: 'muted' }, `${g.location} · ${g.encrypted ? 'encrypted' : 'not encrypted'} · last sync ${relativeTime(g.lastSyncAt)}${g.pendingChanges ? ` · ${g.pendingChanges} changes waiting` : ''}`)),
      h('div', { class: 'row' }, action('Sync now', async () => (await send({ t: 'syncGroup', groupId: g.groupId }), refresh()), { kind: 'primary' })),
    ),
    g.lastError ? h('div', { class: 'inline-error' }, `Last error: ${g.lastError}`) : null,
    pauseBanner(g),
    h(
      'div',
      { class: 'row', style: 'margin-top:12px' },
      action('History', async () => detail.replaceChildren(await historyPanel(g)), { kind: 'quiet' }),
      action('Devices', async () => detail.replaceChildren(await devicesPanel(g)), { kind: 'quiet' }),
      action('Encryption', async () => detail.replaceChildren(encryptionPanel(g)), { kind: 'quiet' }),
      action('Leave', async () => (await send({ t: 'leave', groupId: g.groupId }), refresh()), { kind: 'quiet', confirm: 'Stop syncing this group here? Your bookmarks stay as they are.' }),
      g.canUndoJoin
        ? action('Undo join', async () => (await send({ t: 'undoJoin', groupId: g.groupId }), refresh()), {
            kind: 'quiet',
            confirm: 'Remove what this browser added to the group, put this browser’s bookmarks back as they were before joining, and leave?',
          })
        : null,
      action('Delete everywhere', async () => (await send({ t: 'deleteEverywhere', groupId: g.groupId }), refresh()), {
        kind: 'danger',
        confirm: 'Delete this group for every browser? Bookmarks stay in each browser, but nothing syncs any more.',
      }),
    ),
    detail,
  );
}

function pauseBanner(g: GroupSummary) {
  if (g.status.state !== 'paused') return null;
  const reason = g.status.reason;
  const text = h('p', { style: 'margin:0 0 8px' }, REASON_TEXT[reason] ?? reason, g.status.detail ? h('span', { class: 'muted' }, ` (${g.status.detail})`) : null);
  const buttons = h('div', { class: 'row' });
  const resolve = (choice: 'apply' | 'revert' | 'resume') => async () => (await send({ t: 'resolve', groupId: g.groupId, choice }), refresh());
  if (reason === 'large-remote-change' || reason === 'large-local-change') {
    buttons.append(
      action(reason === 'large-remote-change' ? 'Apply here' : 'Upload the change', resolve('apply'), { kind: 'primary' }),
      action(reason === 'large-remote-change' ? 'Revert for everyone' : 'Put my bookmarks back', resolve('revert')),
    );
  } else if (reason === 'locked') {
    const pass = h('input', { type: 'password', placeholder: 'Passphrase' });
    const remember = h('input', { type: 'checkbox' });
    buttons.append(pass, h('label', { class: 'check' }, remember, 'Remember on this device'), action('Unlock', async () => (await send({ t: 'unlock', groupId: g.groupId, passphrase: pass.value, remember: remember.checked }), refresh()), { kind: 'primary' }));
  } else if (reason === 'migration' && g.migration) {
    if (g.migration.waitingFor.length) {
      buttons.append(h('span', { class: 'muted' }, `Waiting for ${g.migration.waitingFor.length} browser(s) to confirm.`));
      if (g.migration.initiator) buttons.append(action('Continue without them', async () => (await send({ t: 'continueMigration', groupId: g.groupId, deviceIds: g.migration!.waitingFor }), refresh())));
    }
  } else if (reason === 'permission') {
    const account = state.accounts.find((a) => a.id === g.accountId);
    if (account?.url) buttons.append(action('Grant access', async () => (await browser.permissions.request({ origins: [originPattern(account.url!)] }), await send({ t: 'resolve', groupId: g.groupId, choice: 'resume' }), refresh()), { kind: 'primary' }));
  } else if (reason !== 'group-deleted' && reason !== 'format-too-new') {
    buttons.append(action('Resume', resolve('resume'), { kind: 'primary' }));
  }
  return h('div', { class: 'banner' }, text, buttons);
}

/** The latest HLC that sorts before `hlc`: one millisecond earlier, after every op in that millisecond. */
const justBefore = (hlc: string) => `${String(Number(hlc.slice(0, 15)) - 1).padStart(15, '0')}-999999-~`;

async function historyPanel(g: GroupSummary) {
  const entries = await send<TimelineEntry[]>({ t: 'timeline', groupId: g.groupId });
  const devices = await send<{ deviceId: string; name: string }[]>({ t: 'devices', groupId: g.groupId });
  const name = (d: string) => devices.find((x) => x.deviceId === d)?.name ?? d.slice(0, 6);
  const out = h('div', { class: 'stack', style: 'margin-top:12px' });
  const describe = (k: Record<string, number>) =>
    Object.entries(k)
      .map(([type, n]) => `${n} ${{ create: 'added', update: 'edited', move: 'moved', delete: 'removed', undelete: 'restored' }[type] ?? type}`)
      .join(', ');
  const restoreTo = async (hlc: string) => {
    const p = await send<{ restored: number; removed: number; changed: number }>({ t: 'previewRestore', groupId: g.groupId, hlc });
    if (!window.confirm(`Restore to ${hlcTime(hlc)}?\n${p.restored} items come back, ${p.removed} are removed, ${p.changed} change. Every browser follows, and you can undo this from the history.`)) return;
    await send({ t: 'restore', groupId: g.groupId, hlc });
    await refresh();
  };
  out.append(h('h3', {}, 'History'));
  if (g.restorePoints.length) {
    out.append(h('ul', { class: 'list' }, ...g.restorePoints.map((r) => h('li', { class: 'row spread' }, h('span', {}, `${r.label} · ${hlcTime(r.hlc)}`), action('Restore', () => restoreTo(r.hlc))))));
  }
  if (!entries.length) out.append(h('p', { class: 'muted' }, 'No changes in the kept history.'));
  out.append(
    h(
      'ul',
      { class: 'list' },
      ...entries.map((e) =>
        h('li', { class: 'row spread' }, h('span', {}, `${hlcTime(e.to)} · ${name(e.device)} · ${describe(e.kinds)}`), e.from > g.oldestRestorable ? action('Restore to before this', () => restoreTo(justBefore(e.from))) : null),
      ),
    ),
  );
  return out;
}

async function devicesPanel(g: GroupSummary) {
  const list = await send<{ deviceId: string; name: string; browser: string; lastSeen: number; left: boolean; removed: boolean; self: boolean }[]>({ t: 'devices', groupId: g.groupId });
  return h(
    'div',
    { style: 'margin-top:12px' },
    h('h3', {}, 'Browsers in this group'),
    h(
      'ul',
      { class: 'list' },
      ...list.map((d) =>
        h(
          'li',
          { class: 'row spread' },
          h('span', {}, `${d.name}${d.self ? ' (this browser)' : ''} · last seen ${relativeTime(d.lastSeen)}${d.left ? ' · left' : ''}${d.removed ? ' · removed' : ''}`),
          d.self || d.removed || d.left
            ? null
            : action('Remove', async () => (await send({ t: 'removeDevice', groupId: g.groupId, deviceId: d.deviceId }), refresh()), { kind: 'quiet', confirm: `Remove ${d.name}? Use this after uninstalling the extension there.` }),
        ),
      ),
    ),
  );
}

function encryptionPanel(g: GroupSummary) {
  const pass = h('input', { type: 'password', placeholder: 'New passphrase' });
  const again = h('input', { type: 'password', placeholder: 'Repeat passphrase' });
  const run = async () => {
    if (!g.encrypted) {
      if (pass.value.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      if (pass.value !== again.value) throw new Error('The passphrases do not match.');
    }
    await send({ t: 'setEncryption', groupId: g.groupId, passphrase: g.encrypted ? null : pass.value });
    await refresh();
  };
  return h(
    'div',
    { class: 'stack', style: 'margin-top:12px' },
    h('h3', {}, g.encrypted ? 'Turn encryption off' : 'Turn encryption on'),
    h('p', { class: 'muted' }, 'Every browser in the group moves to a new copy of the group with the new setting. Each browser waits until the others have uploaded their changes, so nothing is lost.'),
    g.encrypted ? null : h('div', { class: 'row' }, pass, again),
    action(g.encrypted ? 'Turn off encryption' : 'Turn on encryption', run, { kind: 'primary' }),
  );
}

// Create or join

function targetPicker(mode: () => 'everything' | 'folder') {
  const kind = h('select', {}, h('option', { value: 'whole' }, 'My whole bookmark tree'), h('option', { value: 'everything-into' }, 'Inside one folder'));
  const folder = h('select', {}, ...state.folders.map((f) => h('option', { value: f.id }, f.path)));
  const wrap = h('div', { class: 'row' });
  const update = () => {
    wrap.replaceChildren(...(mode() === 'folder' ? [h('label', {}, 'Folder', folder)] : [h('label', {}, 'Where', kind), kind.value === 'whole' ? null : h('label', {}, 'Folder', folder)].filter(Boolean) as HTMLElement[]));
  };
  kind.addEventListener('change', update);
  update();
  return {
    el: wrap,
    update,
    value: (): Target => (mode() === 'folder' ? { kind: 'folder', folderId: folder.value } : kind.value === 'whole' ? { kind: 'whole' } : { kind: 'everything-into', folderId: folder.value }),
  };
}

function addGroupSection() {
  if (!state.accounts.length) return h('section', {}, h('h2', {}, 'Add a group'), h('p', { class: 'muted' }, 'Add a storage account below first.'));
  const body = h('div', { class: 'card stack' });
  const tab = (name: 'create' | 'join') => {
    createBtn.setAttribute('aria-pressed', String(name === 'create'));
    joinBtn.setAttribute('aria-pressed', String(name === 'join'));
    body.replaceChildren(name === 'create' ? createForm() : joinForm());
  };
  const createBtn = h('button', { onclick: () => tab('create') }, 'Create a new group');
  const joinBtn = h('button', { onclick: () => tab('join') }, 'Join an existing group');
  queueMicrotask(() => tab('join'));
  return h('section', {}, h('h2', {}, 'Add a group'), h('div', { class: 'row tabs', style: 'margin-bottom:8px' }, joinBtn, createBtn), body);
}

function accountSelect() {
  return h('select', {}, ...state.accounts.map((a) => h('option', { value: a.id }, `${a.name} (${a.type === 'gdrive' ? 'Google Drive' : 'WebDAV'})`)));
}

function createForm() {
  const account = accountSelect();
  const name = h('input', { type: 'text', value: 'My bookmarks' });
  const mode = h('select', {}, h('option', { value: 'everything' }, 'Everything (toolbar, other bookmarks and menu)'), h('option', { value: 'folder' }, 'One folder'));
  const target = targetPicker(() => mode.value as 'everything' | 'folder');
  mode.addEventListener('change', target.update);
  const encrypt = h('input', { type: 'checkbox' });
  const pass = h('input', { type: 'password', placeholder: 'Passphrase' });
  const defaults = h('input', { type: 'checkbox', checked: true });
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'grid' }, h('label', {}, 'Storage', account), h('label', {}, 'Group name', name), h('label', {}, 'What to sync', mode)),
    target.el,
    h('label', { class: 'check' }, defaults, 'Leave out the browser’s built-in default bookmarks'),
    h('div', { class: 'row' }, h('label', { class: 'check' }, encrypt, 'Encrypt with a passphrase'), pass),
    action(
      'Create group',
      async () => {
        if (encrypt.checked && pass.value.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
        await send({ t: 'create', input: { accountId: account.value, name: name.value.trim() || 'Bookmarks', mode: mode.value as 'everything' | 'folder', target: target.value(), passphrase: encrypt.checked ? pass.value : undefined, ignoreDefaults: defaults.checked } });
        await refresh();
      },
      { kind: 'primary' },
    ),
  );
}

function joinForm() {
  const account = accountSelect();
  const results = h('div', { class: 'stack' });
  const find = async () => {
    const groups = await send<{ groupId: string; name: string; mode: 'everything' | 'folder'; encrypted: boolean; joined: boolean }[]>({ t: 'discover', accountId: account.value });
    const open = groups.filter((g) => !g.joined);
    results.replaceChildren(open.length ? h('div', { class: 'stack' }, ...open.map((g) => joinCard(account.value, g))) : h('p', { class: 'muted' }, 'No groups to join on this storage.'));
  };
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('label', {}, 'Storage', account), action('Find groups', find, { kind: 'primary' })), results);
}

function joinCard(accountId: string, g: { groupId: string; name: string; mode: 'everything' | 'folder'; encrypted: boolean }) {
  const target = targetPicker(() => g.mode);
  const mode = h('select', {}, h('option', { value: 'merge' }, 'Merge with my bookmarks'), h('option', { value: 'replace' }, 'Replace my bookmarks with the group’s'));
  const defaults = h('input', { type: 'checkbox', checked: true });
  const pass = h('input', { type: 'password', placeholder: 'Group passphrase' });
  const remember = h('input', { type: 'checkbox' });
  const preview = h('p', { class: 'muted' });
  const input = () => ({ accountId, groupId: g.groupId, target: target.value(), mode: mode.value as 'merge' | 'replace', ignoreDefaults: defaults.checked, passphrase: g.encrypted ? pass.value : undefined, rememberKey: remember.checked });
  return h(
    'div',
    { class: 'card stack' },
    h('h3', {}, g.name, ' ', h('span', { class: 'pill' }, g.mode === 'folder' ? 'one folder' : 'everything'), g.encrypted ? h('span', { class: 'pill' }, 'encrypted') : null),
    target.el,
    h('div', { class: 'row' }, h('label', {}, 'How', mode)),
    h('label', { class: 'check' }, defaults, 'Leave out this browser’s built-in default bookmarks'),
    g.encrypted ? h('div', { class: 'row' }, pass, h('label', { class: 'check' }, remember, 'Remember on this device')) : null,
    h(
      'div',
      { class: 'row' },
      action('Preview', async () => {
        preview.textContent = 'Reading the group…';
        const p = await send<JoinPreview>({ t: 'previewJoin', input: input() });
        preview.textContent = `${p.added} of your items will be added to the group, ${p.matched} already match, ${p.removedLocal} will be removed here, ${p.groupItems} come from the group${p.ignoredDefaults ? `, ${p.ignoredDefaults} default bookmarks left out` : ''}.`;
      }),
      action('Join', async () => (await send({ t: 'join', input: input() }), refresh()), { kind: 'primary' }),
    ),
    preview,
  );
}

// Accounts

function accountsSection() {
  const name = h('input', { type: 'text', placeholder: 'Name, for example Home server' });
  const url = h('input', { type: 'url', placeholder: 'https://cloud.example.com/remote.php/dav/files/me/bookmarks/' });
  const user = h('input', { type: 'text', placeholder: 'Username' });
  const password = h('input', { type: 'password', placeholder: 'App password' });
  const googleName = h('input', { type: 'text', value: 'Google Drive' });
  return h(
    'section',
    {},
    h('h2', {}, 'Storage accounts'),
    state.accounts.length
      ? h(
          'div',
          { class: 'card' },
          h('ul', { class: 'list' }, ...state.accounts.map((a) => h('li', { class: 'row spread' }, h('span', {}, a.name, ' ', h('span', { class: 'url' }, a.type === 'gdrive' ? 'Google Drive' : (a.url ?? ''))), action('Remove', async () => (await send({ t: 'removeAccount', id: a.id }), refresh()), { kind: 'quiet' })))),
        )
      : null,
    h(
      'div',
      { class: 'card stack' },
      h('h3', {}, 'Add a WebDAV server'),
      h('p', { class: 'muted' }, 'Works with Nextcloud, ownCloud, Synology, Koofr, most hosting, and any rclone remote through rclone serve webdav.'),
      h('div', { class: 'grid' }, name, url, user, password),
      action(
        'Add server',
        async () => {
          const pattern = originPattern(url.value);
          if (!(await browser.permissions.request({ origins: [pattern] }))) throw new Error('Access to the server was not granted.');
          await send({ t: 'addAccount', account: { type: 'webdav', name: name.value.trim() || new URL(url.value).host, url: url.value, username: user.value, password: password.value } });
          await refresh();
        },
        { kind: 'primary' },
      ),
    ),
    h('div', { class: 'card row' }, h('label', {}, 'Add Google Drive', googleName), action(
        'Sign in with Google',
        async () => {
          if (!(await browser.permissions.request({ origins: ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'] }))) throw new Error('Access to Google was not granted.');
          await send({ t: 'addGoogle', name: googleName.value });
          await refresh();
        },
        { kind: 'primary' },
      )),
  );
}

// Duplicates

function duplicatesSection() {
  const out = h('div', { class: 'stack' });
  const undo = h('div');
  const showUndo = async () => {
    const list = await send<{ id: string; at: number; label: string }[]>({ t: 'localUndo' });
    undo.replaceChildren(...list.map((u) => h('div', { class: 'row' }, h('span', { class: 'muted' }, `${u.label} (not synced) · ${relativeTime(u.at)}`), action('Undo', async () => (await send({ t: 'undoLocal', id: u.id }), showUndo())))));
  };
  const scan = async () => {
    const groups = await send<DuplicateGroup[]>({ t: 'scanDuplicates' });
    out.replaceChildren(groups.length ? h('div', { class: 'stack' }, ...groups.map((g) => duplicateCard(g, scan))) : h('p', { class: 'muted' }, 'No duplicates found.'));
    await showUndo();
  };
  return h('section', {}, h('h2', {}, 'Duplicates'), h('div', { class: 'card stack' }, h('p', { class: 'muted' }, 'Find bookmarks that point to the same page. Nothing is removed without your choice, and synced cleanups can be restored from a group’s history.'), action('Scan for duplicates', scan, { kind: 'primary' }), out, undo));
}

function duplicateCard(g: DuplicateGroup, rescan: () => Promise<void>) {
  const name = `dup-${g.key}`;
  const radios = g.items.map((it, i) => h('input', { type: 'radio', name, value: it.localId, checked: i === 0 }));
  const folder = h('select', {}, ...state.folders.map((f) => h('option', { value: f.id }, f.path)));
  const keep = () => radios.find((r) => r.checked)!.value;
  return h(
    'div',
    { class: 'card stack' },
    h('div', {}, h('span', { class: 'pill' }, g.level === 'exact' ? 'same page' : 'possibly the same page')),
    h('ul', { class: 'list' }, ...g.items.map((it, i) => h('li', {}, h('label', { class: 'check' }, radios[i]!, h('span', {}, it.title || '(untitled)', h('div', { class: 'url' }, `${it.url} · ${it.path}${it.group ? ` · synced in ${it.group}` : ' · not synced'}`)))))),
    h(
      'div',
      { class: 'row' },
      action('Keep the selected one, remove the others', async () => (await send({ t: 'applyDedupe', action: { remove: g.items.map((i) => i.localId).filter((id) => id !== keep()) } }), rescan()), { kind: 'primary' }),
      folder,
      action('Move all into this folder', async () => (await send({ t: 'applyDedupe', action: { move: g.items.map((i) => i.localId), folderId: folder.value } }), rescan())),
    ),
  );
}

// Settings

function settingsSection() {
  const form = h('div', { class: 'card stack' }, h('p', { class: 'muted' }, 'Loading…'));
  void send<Settings & { deviceName: string }>({ t: 'settings' }).then((s) => {
    const deviceName = h('input', { type: 'text', value: s.deviceName });
    const history = h('input', { type: 'number', min: 0, max: 365, value: s.historyDays });
    const percent = h('input', { type: 'number', min: 1, max: 100, value: s.guardPercent });
    const min = h('input', { type: 'number', min: 1, value: s.guardMin });
    const pull = h('input', { type: 'number', min: 1, max: 60, value: s.pullMinutes });
    form.replaceChildren(
      h(
        'div',
        { class: 'grid' },
        h('label', {}, 'This browser’s name', deviceName),
        h('label', {}, 'Days of history (0 turns the timeline off)', history),
        h('label', {}, 'Ask before changes larger than (%)', percent),
        h('label', {}, '…and at least this many items', min),
        h('label', {}, 'Check for changes every (minutes)', pull),
      ),
      h(
        'div',
        { class: 'row' },
        action(
          'Save settings',
          async () =>
            send({ t: 'updateSettings', patch: { deviceName: deviceName.value, historyDays: Number(history.value), guardPercent: Number(percent.value), guardMin: Number(min.value), pullMinutes: Number(pull.value) } }),
          { kind: 'primary' },
        ),
        action('Export diagnostics', async () => {
          const data = await send({ t: 'diagnostics' });
          const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'bookmark-sync-diagnostics.json' });
          a.click();
        }),
      ),
    );
  });
  return h('section', {}, h('h2', {}, 'Settings'), form);
}

void refresh().catch((e) => app.replaceChildren(h('p', { class: 'inline-error' }, e instanceof Error ? e.message : String(e))));
setInterval(() => {
  if (document.visibilityState === 'visible' && !document.activeElement?.matches('input, select')) void send<GroupSummary[]>({ t: 'status' }).then((g) => {
    if (JSON.stringify(g) !== JSON.stringify(state.groups)) void refresh();
  });
}, 5000);
