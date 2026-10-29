import { browser } from 'wxt/browser';
import type { GroupSummary, Target } from '../../engine/app.js';
import type { GroupFolder, JoinPreview } from '../../engine/group.js';
import { originPattern } from '../../browser/providers.js';
import { APP_NAME, SERVER_FOLDER } from '../../config.js';
import { action, brand, errorText, field, h, send } from '../../ui/dom.js';
import { icon, type IconName } from '../../ui/icons.js';
import { folderTree, groupItems, localItems, placements, type FolderTree } from './folderTree.js';
import { sameNameKey } from '../../core/names.js';
import { load, state, storageLabel, storageWithAccount, type FoundSync, type PublicAccount } from './shared.js';

type Step =
  | { id: 'storage' }
  | { id: 'google' }
  | { id: 'server' }
  | { id: 'choose'; account: PublicAccount }
  | { id: 'create'; account: PublicAccount; name: string }
  | { id: 'join'; account: PublicAccount; sync: FoundSync }
  | { id: 'done'; account: PublicAccount; groupId: string; joined: boolean };

const STEP_INDEX: Record<Step['id'], number> = { storage: 1, google: 2, server: 2, choose: 3, create: 4, join: 4, done: 5 };

export function renderSetup(root: HTMLElement, finish: () => void) {
  const show = (step: Step) => {
    root.replaceChildren(
      h(
        'div',
        { class: 'page stack lg' },
        h('div', { class: 'row spread' }, brand(), state.groups.length && step.id !== 'done' ? h('button', { class: 'ghost', onclick: finish }, icon('x'), 'Cancel') : null),
        h('div', { class: 'steps', 'aria-hidden': 'true' }, ...[1, 2, 3, 4].map((i) => h('span', { class: i <= STEP_INDEX[step.id] ? 'done' : '' }))),
        body(step),
      ),
    );
    root.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), .choice')?.focus();
  };

  const head = (title: string, text: string | Node) => h('div', { class: 'step-head' }, h('h1', {}, title), h('p', { class: 'muted' }, text));
  const back = (to: Step) => h('button', { class: 'ghost', onclick: () => show(to) }, icon('arrow-left'), 'Back');
  const choice = (opts: { icon: IconName; title: string; desc: string; badge?: string; recommended?: boolean; onclick: () => void }) =>
    h(
      'button',
      { class: `choice${opts.recommended ? ' recommended' : ''}`, onclick: opts.onclick },
      h('span', { class: 'tile' }, icon(opts.icon, 'lg')),
      h('span', { class: 'text' }, h('span', { class: 'title' }, opts.title, opts.badge ? h('span', { class: 'pill accent' }, opts.badge) : null), h('span', { class: 'desc' }, opts.desc)),
      icon('chevron-right'),
    );

  function body(step: Step): HTMLElement {
    switch (step.id) {
      case 'storage':
        return storageStep();
      case 'google':
        return googleStep();
      case 'server':
        return serverStep();
      case 'choose':
        return chooseStep(step.account);
      case 'create':
        return createStep(step.account, step.name);
      case 'join':
        return joinStep(step.account, step.sync);
      case 'done':
        return doneStep(step);
    }
  }

  function storageStep() {
    const existing = state.accounts.map((a) =>
      choice({ icon: a.type === 'gdrive' ? 'brand-google-drive' : 'server', title: storageWithAccount(a), desc: a.type === 'gdrive' ? 'Already connected' : `Already connected · ${a.url ?? ''}`, onclick: () => show({ id: 'choose', account: a }) }),
    );
    const google = state.caps.google
      ? choice({ icon: 'brand-google-drive', title: 'Google Drive', badge: 'Recommended', recommended: true, desc: 'Sign in with your Google account. Bookmarks go in a private app folder.', onclick: () => show({ id: 'google' }) })
      : null;
    const blocked = state.caps.googleBlocked
      ? h('div', { class: 'banner info' }, icon('info-circle'), h('div', { class: 'body' }, 'To use Google Drive in Brave, turn on “Allow Google login for extensions” in Settings, Extensions, then reload this page.'))
      : null;
    return h(
      'div',
      { class: 'stack lg' },
      head('Where should your bookmarks be stored?', 'Every browser you connect reads and writes your bookmarks here. Pick the same place in each browser.'),
      existing.length ? h('div', { class: 'stack' }, h('h3', {}, 'Your connected storage'), ...existing, h('h3', { style: 'margin-top:8px' }, 'Or connect new storage')) : null,
      h(
        'div',
        { class: 'stack' },
        google,
        blocked,
        choice({ icon: 'server', title: 'Your own server', desc: 'Nextcloud, ownCloud, Synology, any WebDAV server, or rclone.', recommended: !google && !existing.length, onclick: () => show({ id: 'server' }) }),
      ),
    );
  }

  function googleStep() {
    return h(
      'div',
      { class: 'stack lg' },
      head('Connect Google Drive', 'A Google window opens. Choose your account and select Allow.'),
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'row' }, icon('shield-lock', 'lg'), h('div', { class: 'grow' }, h('b', {}, 'Only its own files'), h('p', { class: 'muted small' }, 'The extension can only see the files it creates, kept in a hidden app folder. Your other Drive files stay private.'))),
      ),
      h(
        'div',
        { class: 'footer' },
        back({ id: 'storage' }),
        action(
          'Sign in with Google',
          async () => {
            const id = await send<string>({ t: 'addGoogle', name: 'Google Drive' });
            await load();
            show({ id: 'choose', account: state.accounts.find((a) => a.id === id)! });
          },
          { kind: 'primary', size: 'lg', icon: 'brand-google-drive', busy: 'Waiting for Google…' },
        ),
      ),
    );
  }

  function serverStep() {
    const url = h('input', { type: 'url', placeholder: 'https://cloud.example.com/remote.php/dav/files/alex/', autocomplete: 'url', spellcheck: 'false' });
    const user = h('input', { type: 'text', placeholder: 'alex', autocomplete: 'username' });
    const password = h('input', { type: 'password', autocomplete: 'current-password' });
    const folder = h('input', { type: 'text', value: SERVER_FOLDER });
    const warning = h('div');
    let insecureOk = false;
    url.addEventListener('input', () => {
      insecureOk = false;
      warning.replaceChildren();
    });
    const connect = async () => {
      let base: URL;
      try {
        base = new URL(url.value.trim());
      } catch {
        throw new Error('Enter the full server address, starting with https://');
      }
      if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('Enter the full server address, starting with https://');
      if (!user.value.trim()) throw new Error('Enter your username.');
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
      if (base.protocol === 'http:' && !local && !insecureOk) {
        insecureOk = true;
        warning.replaceChildren(
          h('div', { class: 'banner' }, icon('alert-triangle'), h('div', { class: 'body' }, 'This address uses plain http, so your password and bookmarks travel unencrypted. Use https if the server supports it, or select Connect again to continue anyway.')),
        );
        return;
      }
      const sub = folder.value.trim().replace(/^\/+|\/+$/g, '');
      const full = new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
      if (sub) full.pathname += `${sub.split('/').map(encodeURIComponent).join('/')}/`;
      if (!(await browser.permissions.request({ origins: [originPattern(full.href)] }))) throw new Error('The extension needs permission to reach this server. Select Connect and choose Allow.');
      const id = await send<string>({ t: 'addAccount', account: { type: 'webdav', name: base.host, url: full.href, username: user.value.trim(), password: password.value } });
      await load();
      show({ id: 'choose', account: state.accounts.find((a) => a.id === id)! });
    };
    return h(
      'div',
      { class: 'stack lg' },
      head('Connect your server', 'Use the WebDAV address of your server. The extension checks the connection before going on.'),
      h(
        'div',
        { class: 'card stack lg' },
        field('Server address', url, 'Nextcloud and ownCloud show it in Files, Settings, at the bottom left. For rclone, run rclone serve webdav and use its address.'),
        h('div', { class: 'fields-2' }, field('Username', user), field('Password', password, 'If your server offers app passwords, use one.')),
        h('details', { class: 'advanced' }, h('summary', {}, icon('chevron-right'), 'Advanced'), h('div', { class: 'stack' }, field('Folder on the server', folder, 'Created if it doesn’t exist. Use the same folder in every browser.'))),
        warning,
      ),
      h('div', { class: 'footer' }, back({ id: 'storage' }), action('Connect', connect, { kind: 'primary', size: 'lg', busy: 'Checking the connection…' })),
    );
  }

  function chooseStep(account: PublicAccount) {
    const where = storageWithAccount(account);
    const list = h('div', { class: 'stack' }, h('div', { class: 'row muted' }, icon('loader-2', 'spin'), `Looking for synced bookmarks on ${where}…`));
    const footer = h('div', { class: 'footer' }, back({ id: 'storage' }));
    const wrap = h('div', { class: 'stack lg' }, head('Join or start a sync', where), list, footer);
    void send<FoundSync[]>({ t: 'discover', accountId: account.id }).then(
      (found) => {
        const taken = new Set(found.map((f) => sameNameKey(f.name)));
        let suggested = 'Bookmarks';
        for (let i = 2; taken.has(sameNameKey(suggested)); i++) suggested = `Bookmarks ${i}`;
        const name = h('input', { type: 'text', value: suggested });
        const nameField = h('div', { class: 'card stack' }, field('Name the new sync', name, 'Shown in every browser that joins. It can’t match the name of another sync here.'));
        const start = () => {
          const value = name.value.trim();
          if (!value) throw new Error('Give the new sync a name.');
          const same = found.find((f) => sameNameKey(f.name) === sameNameKey(value));
          if (same) throw new Error(`A sync called “${same.name}” is already on this storage. Join it, or pick another name.`);
          show({ id: 'create', account, name: value });
        };
        const open = found.filter((f) => !f.joined);
        if (!open.length) {
          wrap.replaceChild(
            head('Start syncing', found.length ? `Every sync on ${where} already syncs in this browser, so this starts a new one.` : `Nothing is synced on ${where} yet, so this browser starts the sync. Your other browsers join it later.`),
            wrap.firstChild!,
          );
          list.replaceChildren(nameField);
          footer.append(action('Continue', async () => start(), { kind: 'primary', size: 'lg' }));
          return void name.focus();
        }
        const members = (f: FoundSync) => (f.browsers === null ? null : f.browsers.length ? f.browsers.join(', ') : 'no browsers yet');
        const pick = radios<string>(
          'sync',
          [
            ...found.map((f) => ({
              value: f.groupId,
              title: f.name,
              icon: (f.encrypted ? 'lock' : 'bookmarks') as IconName,
              badge: f.encrypted ? 'Encrypted' : undefined,
              desc: f.joined ? 'Already syncing in this browser' : [f.mode === 'folder' ? 'Chosen folders' : 'All bookmarks', members(f)].filter(Boolean).join(' · '),
              disabled: f.joined,
            })),
            { value: 'new', title: 'Start a new sync', icon: 'plus', desc: 'Keeps a separate set of bookmarks in sync, apart from the ones above.' },
          ],
          open.length === 1 ? open[0]!.groupId : null,
          (v) => ((nameField.hidden = v !== 'new'), v === 'new' && name.focus()),
        );
        nameField.hidden = true;
        list.replaceChildren(pick.el, nameField);
        footer.append(
          action(
            'Continue',
            async () => {
              const v = pick.value();
              if (!v) throw new Error('Pick a sync to join, or start a new one.');
              if (v === 'new') return start();
              show({ id: 'join', account, sync: open.find((f) => f.groupId === v)! });
            },
            { kind: 'primary', size: 'lg' },
          ),
        );
      },
      (e) => list.replaceChildren(h('div', { class: 'error' }, icon('alert-triangle'), h('span', {}, errorText(e))), h('div', { class: 'row' }, h('button', { onclick: () => show({ id: 'choose', account }) }, icon('refresh'), 'Try again'))),
    );
    return wrap;
  }

  /** Radio cards for a small set of exclusive options. */
  function radios<T extends string>(
    name: string,
    options: { value: T; title: string; desc: string; icon: IconName; badge?: string; disabled?: boolean }[],
    initial: T | null,
    onchange: (v: T) => void,
  ) {
    let current = initial;
    const cards = options.map((o) => {
      const input = h('input', { type: 'radio', name, value: o.value, checked: o.value === initial, disabled: !!o.disabled });
      const card = h(
        'label',
        { class: `choice${o.value === initial ? ' selected' : ''}${o.disabled ? ' disabled' : ''}` },
        input,
        h('span', { class: 'tile' }, icon(o.icon, 'lg')),
        h('span', { class: 'text' }, h('span', { class: 'title' }, o.title, o.badge ? h('span', { class: 'pill accent' }, o.badge) : null), h('span', { class: 'desc' }, o.desc)),
      );
      input.addEventListener('change', () => {
        current = o.value;
        for (const c of cards) c.classList.toggle('selected', c === card);
        onchange(o.value);
      });
      return card;
    });
    return { el: h('div', { class: 'stack' }, ...cards), value: () => current };
  }

  function createStep(account: PublicAccount, name: string) {
    const tree = folderTree(localItems(state.folders, state.groups), { multi: true, label: 'Folders to sync' });
    const folderField = h('div', { class: 'stack' }, h('h3', {}, 'Folders to sync'), h('p', { class: 'muted small' }, 'Tick as many as you like. A ticked folder syncs with everything inside it. Other browsers can put each one wherever they want.'), tree.el);
    folderField.hidden = true;
    const what = radios(
      'what',
      [
        { value: 'everything', title: 'All bookmarks', desc: 'The bookmarks bar, other bookmarks, and every folder in them.', icon: 'bookmarks', badge: 'Recommended' },
        { value: 'folder', title: 'Choose folders', desc: 'Only the folders you tick. Good for sharing some bookmarks between browsers.', icon: 'folders' },
      ],
      'everything',
      (v) => (folderField.hidden = v !== 'folder'),
    );
    const defaults = h('input', { type: 'checkbox', checked: true });
    const encrypt = h('input', { type: 'checkbox' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password' });
    const again = h('input', { type: 'password', autocomplete: 'new-password' });
    const passFields = h('div', { class: 'fields-2' }, field('Passphrase', pass, 'At least 8 characters.'), field('Repeat passphrase', again));
    passFields.hidden = true;
    encrypt.addEventListener('change', () => (passFields.hidden = !encrypt.checked));
    const start = async () => {
      if (encrypt.checked) {
        if (pass.value.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
        if (pass.value !== again.value) throw new Error('The passphrases don’t match.');
      }
      const mode = what.value() as 'everything' | 'folder';
      if (mode === 'folder' && !tree.value().length) throw new Error('Tick at least one folder to sync.');
      const target: Target = mode === 'folder' ? { kind: 'folders', folderIds: tree.value() } : { kind: 'whole' };
      const groupId = await send<string>({ t: 'create', input: { accountId: account.id, name, mode, target, passphrase: encrypt.checked ? pass.value : undefined, ignoreDefaults: defaults.checked } });
      await load();
      show({ id: 'done', account, groupId, joined: false });
    };
    return h(
      'div',
      { class: 'stack lg' },
      head('What should sync?', `Starting “${name}” on ${storageWithAccount(account)}.`),
      what.el,
      folderField,
      h('label', { class: 'check' }, defaults, h('span', {}, 'Leave out the sample bookmarks the browser came with', h('div', { class: 'hint' }, 'So every browser doesn’t add its own copies.'))),
      h(
        'details',
        { class: 'advanced' },
        h('summary', {}, icon('chevron-right'), 'Advanced'),
        h(
          'div',
          { class: 'stack' },
          h('label', { class: 'check' }, encrypt, h('span', {}, 'Encrypt with a passphrase', h('div', { class: 'hint' }, 'The storage only sees scrambled data. Every browser needs the passphrase, and it can’t be recovered if you lose it.'))),
          passFields,
        ),
      ),
      h('div', { class: 'footer' }, back({ id: 'choose', account }), action('Start syncing', start, { kind: 'primary', size: 'lg', busy: 'Uploading your bookmarks…' })),
    );
  }

  function joinStep(account: PublicAccount, sync: FoundSync) {
    const preview = h('div', { class: 'banner info' }, icon('info-circle'), h('div', { class: 'body' }, 'Checking what will change…'));
    const how = radios(
      'how',
      [
        { value: 'merge', title: 'Combine', desc: 'Keeps the bookmarks in this browser and adds the synced ones. Bookmarks that match are kept once.', icon: 'git-merge', badge: 'Recommended' },
        { value: 'replace', title: 'Replace', desc: 'Swaps this browser’s bookmarks for the synced ones. You can undo this later.', icon: 'replace' },
      ],
      'merge',
      () => schedulePreview(),
    );
    const isFolder = sync.mode === 'folder';
    const into = h('input', { type: 'checkbox' });
    const intoTree = folderTree(localItems(state.folders, state.groups), { multi: false, label: 'Folder for the synced bookmarks', onchange: () => schedulePreview() });
    const intoField = h('div', { class: 'stack' }, intoTree.el);
    intoField.hidden = true;
    into.addEventListener('change', () => ((intoField.hidden = !into.checked), schedulePreview()));
    const intoOption = h(
      'details',
      { class: 'advanced' },
      h('summary', {}, icon('chevron-right'), 'Advanced'),
      h('div', { class: 'stack' }, h('label', { class: 'check' }, into, h('span', {}, 'Keep the synced bookmarks inside one folder', h('div', { class: 'hint' }, 'Instead of the bookmarks bar and other bookmarks. Only when everything is ticked.'))), intoField),
    );
    intoOption.hidden = isFolder;
    const defaults = h('input', { type: 'checkbox', checked: true });
    defaults.addEventListener('change', () => schedulePreview());
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const remember = h('input', { type: 'checkbox', checked: true });
    pass.addEventListener('input', () => (scheduleFolders(), schedulePreview()));

    const what = h('div', { class: 'stack' }, h('p', { class: 'muted' }, sync.encrypted ? 'Enter the passphrase to see the folders in this sync.' : 'Reading the folders in this sync…'));
    let picker: { tree: FolderTree; place: ReturnType<typeof placements>; tops: string[]; everyRoot: boolean } | null = null;
    let folderTimer: ReturnType<typeof setTimeout> | undefined;
    function scheduleFolders() {
      clearTimeout(folderTimer);
      folderTimer = setTimeout(loadFolders, 400);
    }
    async function loadFolders() {
      if (sync.encrypted && !pass.value) return;
      try {
        const g = await send<{ mode: 'everything' | 'folder'; folders: GroupFolder[] }>({ t: 'groupFolders', accountId: account.id, groupId: sync.groupId, passphrase: sync.encrypted ? pass.value : undefined });
        const items = groupItems(g.mode, g.folders, state.folders);
        const tops = items.filter((i) => i.parent === null).map((i) => i.id);
        const place = placements({ mode: g.mode, groupFolders: g.folders, items, local: state.folders, localTree: () => localItems(state.folders, state.groups), onchange: () => schedulePreview() });
        const tree = folderTree(items, {
          multi: true,
          selected: tops,
          label: 'Folders to sync in this browser',
          onchange: (ids) => (place.set(ids), (intoOption.hidden = isFolder || !wholeTicked()), schedulePreview()),
        });
        picker = { tree, place, tops, everyRoot: g.mode === 'everything' };
        place.set(tops);
        what.replaceChildren(
          h('p', { class: 'muted small' }, 'Everything is ticked. Untick what this browser doesn’t need, or tick single folders deeper down.'),
          tree.el,
          h('h3', {}, 'Where each folder goes here'),
          place.el,
        );
        schedulePreview();
      } catch (e) {
        what.replaceChildren(h('div', { class: 'error' }, icon('alert-triangle'), h('span', {}, errorText(e))));
      }
    }
    queueMicrotask(loadFolders);

    const wholeTicked = () => !!picker && picker.tops.every((t) => picker!.tree.value().includes(t)) && picker.tree.value().length === picker.tops.length;
    const target = (): Target | null => {
      if (!picker || !picker.tree.value().length) return null;
      if (picker.everyRoot && wholeTicked() && picker.place.defaults()) return into.checked ? { kind: 'everything-into', folderId: intoTree.value()[0] ?? '' } : { kind: 'whole' };
      return { kind: 'parts', parts: picker.place.choices(), followTops: isFolder && wholeTicked() };
    };
    const input = (t: Target) => ({
      accountId: account.id,
      groupId: sync.groupId,
      target: t,
      mode: how.value() as 'merge' | 'replace',
      ignoreDefaults: defaults.checked,
      passphrase: sync.encrypted ? pass.value : undefined,
      rememberKey: remember.checked,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    function schedulePreview() {
      clearTimeout(timer);
      timer = setTimeout(runPreview, 400);
    }
    async function runPreview() {
      const mine = ++seq;
      const text = preview.querySelector('.body')!;
      if (sync.encrypted && !pass.value) return void (text.textContent = 'Enter the passphrase to see what will change.');
      const t = target();
      if (!t) return void (text.textContent = picker ? 'Tick at least one folder to sync here.' : 'Reading the folders in this sync…');
      if (t.kind === 'everything-into' && !t.folderId) return void (text.textContent = 'Pick the folder to keep the synced bookmarks in.');
      text.textContent = 'Checking what will change…';
      try {
        const p = await send<JoinPreview>({ t: 'previewJoin', input: input(t) });
        if (mine !== seq) return;
        const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
        const parts = [`This browser gets ${items(p.groupItems)} from the sync.`];
        if (p.added) parts.push(`${items(p.added)} from here ${p.added === 1 ? 'is' : 'are'} added to it.`);
        if (p.matched) parts.push(`${items(p.matched)} already ${p.matched === 1 ? 'matches' : 'match'}.`);
        if (p.removedLocal) parts.push(`${items(p.removedLocal)} ${p.removedLocal === 1 ? 'is' : 'are'} removed from this browser.`);
        if (p.ignoredDefaults) parts.push(`${items(p.ignoredDefaults)} of the browser’s sample bookmarks ${p.ignoredDefaults === 1 ? 'is' : 'are'} left out.`);
        text.textContent = parts.join(' ');
      } catch (e) {
        if (mine === seq) text.textContent = errorText(e);
      }
    }
    const join = async () => {
      if (sync.encrypted && !pass.value) throw new Error('Enter the passphrase for this sync.');
      const t = target();
      if (!t) throw new Error('Tick at least one folder to sync here.');
      if (t.kind === 'everything-into' && !t.folderId) throw new Error('Pick the folder to keep the synced bookmarks in.');
      await send({ t: 'join', input: input(t) });
      await load();
      show({ id: 'done', account, groupId: sync.groupId, joined: true });
    };

    return h(
      'div',
      { class: 'stack lg' },
      head(`Join “${sync.name}”`, isFolder ? 'This sync keeps some folders the same in every browser.' : 'This sync keeps bookmarks the same in every browser.'),
      sync.encrypted
        ? h('div', { class: 'card stack' }, field('Passphrase', pass, 'The passphrase chosen when this sync was started.'), h('label', { class: 'check' }, remember, 'Remember it in this browser'))
        : null,
      h('div', { class: 'stack' }, h('h3', {}, 'What should sync in this browser?'), what),
      h('div', { class: 'stack' }, h('h3', {}, 'What about the bookmarks already here?'), how.el),
      h('label', { class: 'check' }, defaults, h('span', {}, 'Leave out the sample bookmarks this browser came with')),
      intoOption,
      preview,
      h('div', { class: 'footer' }, back({ id: 'choose', account }), action('Join and sync', join, { kind: 'primary', size: 'lg', busy: 'Syncing your bookmarks…' })),
    );
  }

  function doneStep(step: Extract<Step, { id: 'done' }>) {
    const g: GroupSummary | undefined = state.groups.find((x) => x.groupId === step.groupId);
    const count = g?.bookmarks ?? 0;
    return h(
      'div',
      { class: 'stack lg center' },
      h('div', { class: 'done-mark' }, icon('check', 'xl')),
      h('div', { class: 'step-head center' }, h('h1', {}, 'Your bookmarks are syncing'), h('p', { class: 'muted' }, `${count} ${count === 1 ? 'bookmark' : 'bookmarks'} in “${g?.name ?? 'Bookmarks'}”, synced with ${storageLabel(step.account)}. Changes sync on their own from now on.`)),
      h(
        'div',
        { class: 'card stack', style: 'text-align:left;width:100%' },
        h('div', { class: 'row' }, icon('devices', 'lg'), h('div', { class: 'grow' }, h('b', {}, step.joined ? 'Add more browsers the same way' : 'Next, set up your other browsers'), h('p', { class: 'muted small' }, `Install ${APP_NAME} in each browser and connect ${storageWithAccount(step.account)}. They find “${g?.name ?? 'Bookmarks'}” and join it.`))),
      ),
      h('button', { class: 'primary lg', onclick: finish }, 'Open the dashboard'),
    );
  }

  show({ id: 'storage' });
}
