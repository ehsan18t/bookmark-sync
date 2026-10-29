import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { originPattern } from '../../browser/providers.js';
import { APP_NAME, SERVER_FOLDER } from '../../config.js';
import { sameNameKey } from '../../core/names.js';
import type { Target } from '../../engine/app.js';
import type { GroupFolder, JoinPreview } from '../../engine/group.js';
import { Action, Advanced, Banner, Brand, Choice, ErrorText, Field, Icon, RadioCards } from '../../ui/components.js';
import { errorText, send } from '../../ui/util.js';
import { FolderTree, Placements } from './FolderPicker.js';
import { groupItems, localItems, placementChoices } from './folders.js';
import { accounts, caps, folders, groups, load, storageLabel, storageWithAccount, type FoundSync, type PublicAccount } from './shared.js';

type Step =
  | { id: 'storage' }
  | { id: 'google' }
  | { id: 'server' }
  | { id: 'choose'; account: PublicAccount }
  | { id: 'create'; account: PublicAccount; name: string }
  | { id: 'join'; account: PublicAccount; sync: FoundSync }
  | { id: 'done'; account: PublicAccount; groupId: string; joined: boolean };

type Go = (step: Step) => void;

const STEP_INDEX: Record<Step['id'], number> = { storage: 1, google: 2, server: 2, choose: 3, create: 4, join: 4, done: 5 };

export function Setup({ onFinish }: { onFinish: () => void }) {
  const [step, go] = useState<Step>({ id: 'storage' });
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => page.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), .choice')?.focus(), [step]);
  return (
    <div class="page stack lg" ref={page}>
      <div class="row spread">
        <Brand />
        {groups.value.length > 0 && step.id !== 'done' && (
          <button class="ghost" onClick={onFinish}>
            <Icon name="x" />
            Cancel
          </button>
        )}
      </div>
      <div class="steps" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} class={i <= STEP_INDEX[step.id] ? 'done' : ''} />
        ))}
      </div>
      <Body step={step} go={go} onFinish={onFinish} />
    </div>
  );
}

function Body({ step, go, onFinish }: { step: Step; go: Go; onFinish: () => void }) {
  switch (step.id) {
    case 'storage':
      return <StorageStep go={go} />;
    case 'google':
      return <GoogleStep go={go} />;
    case 'server':
      return <ServerStep go={go} />;
    case 'choose':
      return <ChooseStep key={step.account.id} account={step.account} go={go} />;
    case 'create':
      return <CreateStep account={step.account} name={step.name} go={go} />;
    case 'join':
      return <JoinStep account={step.account} sync={step.sync} go={go} />;
    case 'done':
      return <DoneStep step={step} onFinish={onFinish} />;
  }
}

function Head({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="step-head">
      <h1>{title}</h1>
      <p class="muted">{children}</p>
    </div>
  );
}

function Back({ go, to }: { go: Go; to: Step }) {
  return (
    <button class="ghost" onClick={() => go(to)}>
      <Icon name="arrow-left" />
      Back
    </button>
  );
}

function StorageStep({ go }: { go: Go }) {
  const google = caps.value.google;
  const connected = accounts.value;
  return (
    <div class="stack lg">
      <Head title="Where should your bookmarks be stored?">Every browser you connect reads and writes your bookmarks here. Pick the same place in each browser.</Head>
      {connected.length > 0 && (
        <div class="stack">
          <h3>Your connected storage</h3>
          {connected.map((a) => (
            <Choice
              key={a.id}
              icon={a.type === 'gdrive' ? 'brand-google-drive' : 'server'}
              title={storageWithAccount(a)}
              desc={a.type === 'gdrive' ? 'Already connected' : `Already connected · ${a.url ?? ''}`}
              onClick={() => go({ id: 'choose', account: a })}
            />
          ))}
          <h3 style="margin-top:8px">Or connect new storage</h3>
        </div>
      )}
      <div class="stack">
        {google && (
          <Choice icon="brand-google-drive" title="Google Drive" badge="Recommended" recommended desc="Sign in with your Google account. Bookmarks go in a private app folder." onClick={() => go({ id: 'google' })} />
        )}
        {caps.value.googleBlocked && (
          <Banner kind="info" icon="info-circle">
            To use Google Drive in Brave, turn on “Allow Google login for extensions” in Settings, Extensions, then reload this page.
          </Banner>
        )}
        <Choice icon="server" title="Your own server" desc="Nextcloud, ownCloud, Synology, any WebDAV server, or rclone." recommended={!google && !connected.length} onClick={() => go({ id: 'server' })} />
      </div>
    </div>
  );
}

/** Reloads the store and goes on with the account just added. */
async function connected(go: Go, id: string) {
  await load();
  go({ id: 'choose', account: accounts.value.find((a) => a.id === id)! });
}

function GoogleStep({ go }: { go: Go }) {
  return (
    <div class="stack lg">
      <Head title="Connect Google Drive">A Google window opens. Choose your account and select Allow.</Head>
      <div class="card stack">
        <div class="row">
          <Icon name="shield-lock" class="lg" />
          <div class="grow">
            <b>Only its own files</b>
            <p class="muted small">The extension can only see the files it creates, kept in a hidden app folder. Your other Drive files stay private.</p>
          </div>
        </div>
      </div>
      <div class="footer">
        <Back go={go} to={{ id: 'storage' }} />
        <Action label="Sign in with Google" kind="primary" size="lg" icon="brand-google-drive" busy="Waiting for Google…" run={async () => connected(go, await send<string>({ t: 'addGoogle', name: 'Google Drive' }))} />
      </div>
    </div>
  );
}

function ServerStep({ go }: { go: Go }) {
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState(SERVER_FOLDER);
  const [insecureOk, setInsecureOk] = useState(false);
  const connect = async () => {
    let base: URL;
    try {
      base = new URL(url.trim());
    } catch {
      throw new Error('Enter the full server address, starting with https://');
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('Enter the full server address, starting with https://');
    if (!user.trim()) throw new Error('Enter your username.');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol === 'http:' && !local && !insecureOk) return setInsecureOk(true);
    const sub = folder.trim().replace(/^\/+|\/+$/g, '');
    const full = new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
    if (sub) full.pathname += `${sub.split('/').map(encodeURIComponent).join('/')}/`;
    if (!(await browser.permissions.request({ origins: [originPattern(full.href)] }))) throw new Error('The extension needs permission to reach this server. Select Connect and choose Allow.');
    await connected(go, await send<string>({ t: 'addAccount', account: { type: 'webdav', name: base.host, url: full.href, username: user.trim(), password } }));
  };
  return (
    <div class="stack lg">
      <Head title="Connect your server">Use the WebDAV address of your server. The extension checks the connection before going on.</Head>
      <div class="card stack lg">
        <Field label="Server address" hint="Nextcloud and ownCloud show it in Files, Settings, at the bottom left. For rclone, run rclone serve webdav and use its address.">
          <input
            type="url"
            placeholder="https://cloud.example.com/remote.php/dav/files/alex/"
            autocomplete="url"
            spellcheck={false}
            value={url}
            onInput={(e) => (setUrl(e.currentTarget.value), setInsecureOk(false))}
          />
        </Field>
        <div class="fields-2">
          <Field label="Username">
            <input type="text" placeholder="alex" autocomplete="username" value={user} onInput={(e) => setUser(e.currentTarget.value)} />
          </Field>
          <Field label="Password" hint="If your server offers app passwords, use one.">
            <input type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
          </Field>
        </div>
        <Advanced summary="Advanced">
          <Field label="Folder on the server" hint="Created if it doesn’t exist. Use the same folder in every browser.">
            <input type="text" value={folder} onInput={(e) => setFolder(e.currentTarget.value)} />
          </Field>
        </Advanced>
        {insecureOk && (
          <Banner icon="alert-triangle">
            This address uses plain http, so your password and bookmarks travel unencrypted. Use https if the server supports it, or select Connect again to continue anyway.
          </Banner>
        )}
      </div>
      <div class="footer">
        <Back go={go} to={{ id: 'storage' }} />
        <Action label="Connect" kind="primary" size="lg" busy="Checking the connection…" run={connect} />
      </div>
    </div>
  );
}

function ChooseStep({ account, go }: { account: PublicAccount; go: Go }) {
  const where = storageWithAccount(account);
  const [found, setFound] = useState<FoundSync[] | null>(null);
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (found) box.current?.querySelector<HTMLElement>('input[type=text], input[type=radio]:checked, input[type=radio]:not(:disabled)')?.focus();
  }, [found, pick]);

  useEffect(() => {
    setFound(null);
    setFailed('');
    send<FoundSync[]>({ t: 'discover', accountId: account.id }).then(
      (list) => {
        const taken = new Set(list.map((f) => sameNameKey(f.name)));
        let suggested = 'Bookmarks';
        for (let i = 2; taken.has(sameNameKey(suggested)); i++) suggested = `Bookmarks ${i}`;
        const open = list.filter((f) => !f.joined);
        setName(suggested);
        setPick(open.length === 1 ? open[0]!.groupId : open.length ? null : 'new');
        setFound(list);
      },
      (e) => setFailed(errorText(e)),
    );
  }, [account.id, attempt]);

  const start = () => {
    const value = name.trim();
    if (!value) throw new Error('Give the new sync a name.');
    const same = found!.find((f) => sameNameKey(f.name) === sameNameKey(value));
    if (same) throw new Error(`A sync called “${same.name}” is already on this storage. Join it, or pick another name.`);
    go({ id: 'create', account, name: value });
  };
  const next = async () => {
    if (!pick) throw new Error('Pick a sync to join, or start a new one.');
    if (pick === 'new') return start();
    go({ id: 'join', account, sync: found!.find((f) => f.groupId === pick)! });
  };

  const open = found?.filter((f) => !f.joined) ?? [];
  const nameField = (
    <div class="card stack">
      <Field label="Name the new sync" hint="Shown in every browser that joins. It can’t match the name of another sync here.">
        <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
    </div>
  );
  const members = (f: FoundSync) => (f.browsers === null ? null : f.browsers.length ? f.browsers.join(', ') : 'no browsers yet');

  let head = <Head title="Join or start a sync">{where}</Head>;
  let body: ComponentChildren;
  if (failed)
    body = (
      <>
        <ErrorText>{failed}</ErrorText>
        <div class="row">
          <button onClick={() => setAttempt(attempt + 1)}>
            <Icon name="refresh" />
            Try again
          </button>
        </div>
      </>
    );
  else if (!found)
    body = (
      <div class="row muted">
        <Icon name="loader-2" class="spin" />
        Looking for synced bookmarks on {where}…
      </div>
    );
  else if (!open.length) {
    head = (
      <Head title="Start syncing">
        {found.length ? `Every sync on ${where} already syncs in this browser, so this starts a new one.` : `Nothing is synced on ${where} yet, so this browser starts the sync. Your other browsers join it later.`}
      </Head>
    );
    body = nameField;
  } else
    body = (
      <>
        <RadioCards
          name="sync"
          value={pick}
          onChange={setPick}
          options={[
            ...found.map((f) => ({
              value: f.groupId,
              title: f.name,
              icon: f.encrypted ? ('lock' as const) : ('bookmarks' as const),
              badge: f.encrypted ? 'Encrypted' : undefined,
              desc: f.joined ? 'Already syncing in this browser' : [f.mode === 'folder' ? 'Chosen folders' : 'All bookmarks', members(f)].filter(Boolean).join(' · '),
              disabled: f.joined,
            })),
            { value: 'new', title: 'Start a new sync', icon: 'plus' as const, desc: 'Keeps a separate set of bookmarks in sync, apart from the ones above.' },
          ]}
        />
        {pick === 'new' && nameField}
      </>
    );

  return (
    <div class="stack lg">
      {head}
      <div class="stack" ref={box}>
        {body}
      </div>
      <div class="footer">
        <Back go={go} to={{ id: 'storage' }} />
        {found && <Action label="Continue" kind="primary" size="lg" run={next} />}
      </div>
    </div>
  );
}

function CreateStep({ account, name, go }: { account: PublicAccount; name: string; go: Go }) {
  const [mode, setMode] = useState<'everything' | 'folder'>('everything');
  const [picked, setPicked] = useState<string[]>([]);
  const [defaults, setDefaults] = useState(true);
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const start = async () => {
    if (encrypt) {
      if (pass.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      if (pass !== again) throw new Error('The passphrases don’t match.');
    }
    if (mode === 'folder' && !picked.length) throw new Error('Tick at least one folder to sync.');
    const target: Target = mode === 'folder' ? { kind: 'folders', folderIds: picked } : { kind: 'whole' };
    const groupId = await send<string>({ t: 'create', input: { accountId: account.id, name, mode, target, passphrase: encrypt ? pass : undefined, ignoreDefaults: defaults } });
    await load();
    go({ id: 'done', account, groupId, joined: false });
  };
  return (
    <div class="stack lg">
      <Head title="What should sync?">
        Starting “{name}” on {storageWithAccount(account)}.
      </Head>
      <RadioCards
        name="what"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'everything', title: 'All bookmarks', desc: 'The bookmarks bar, other bookmarks, and every folder in them.', icon: 'bookmarks', badge: 'Recommended' },
          { value: 'folder', title: 'Choose folders', desc: 'Only the folders you tick. Good for sharing some bookmarks between browsers.', icon: 'folders' },
        ]}
      />
      {mode === 'folder' && (
        <div class="stack">
          <h3>Folders to sync</h3>
          <p class="muted small">Tick as many as you like. A ticked folder syncs with everything inside it. Other browsers can put each one wherever they want.</p>
          <FolderTree items={localItems(folders.value, groups.value)} multi value={picked} onChange={setPicked} label="Folders to sync" />
        </div>
      )}
      <label class="check">
        <input type="checkbox" checked={defaults} onChange={(e) => setDefaults(e.currentTarget.checked)} />
        <span>
          Leave out the sample bookmarks the browser came with
          <div class="hint">So every browser doesn’t add its own copies.</div>
        </span>
      </label>
      <Advanced summary="Advanced">
        <label class="check">
          <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.currentTarget.checked)} />
          <span>
            Encrypt with a passphrase
            <div class="hint">The storage only sees scrambled data. Every browser needs the passphrase, and it can’t be recovered if you lose it.</div>
          </span>
        </label>
        {encrypt && (
          <div class="fields-2">
            <Field label="Passphrase" hint="At least 8 characters.">
              <input type="password" autocomplete="new-password" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
            </Field>
            <Field label="Repeat passphrase">
              <input type="password" autocomplete="new-password" value={again} onInput={(e) => setAgain(e.currentTarget.value)} />
            </Field>
          </div>
        )}
      </Advanced>
      <div class="footer">
        <Back go={go} to={{ id: 'choose', account }} />
        <Action label="Start syncing" kind="primary" size="lg" busy="Uploading your bookmarks…" run={start} />
      </div>
    </div>
  );
}

/** Runs `fn` once its inputs have been still for 400 ms; its returned cleanup runs when they change again. */
function useDebounced(fn: () => void | (() => void), deps: unknown[]) {
  useEffect(() => {
    let cleanup: void | (() => void);
    const t = setTimeout(() => (cleanup = fn()), 400);
    return () => (clearTimeout(t), cleanup?.());
  }, deps);
}

const count = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

function previewText(p: JoinPreview) {
  const parts = [`This browser gets ${count(p.groupItems)} from the sync.`];
  if (p.added) parts.push(`${count(p.added)} from here ${p.added === 1 ? 'is' : 'are'} added to it.`);
  if (p.matched) parts.push(`${count(p.matched)} already ${p.matched === 1 ? 'matches' : 'match'}.`);
  if (p.removedLocal) parts.push(`${count(p.removedLocal)} ${p.removedLocal === 1 ? 'is' : 'are'} removed from this browser.`);
  if (p.ignoredDefaults) parts.push(`${count(p.ignoredDefaults)} of the browser’s sample bookmarks ${p.ignoredDefaults === 1 ? 'is' : 'are'} left out.`);
  return parts.join(' ');
}

function JoinStep({ account, sync, go }: { account: PublicAccount; sync: FoundSync; go: Go }) {
  const isFolder = sync.mode === 'folder';
  const [how, setHow] = useState<'merge' | 'replace'>('merge');
  const [defaults, setDefaults] = useState(true);
  const [into, setInto] = useState(false);
  const [intoFolder, setIntoFolder] = useState<string[]>([]);
  const [pass, setPass] = useState('');
  const [remember, setRemember] = useState(true);
  const [group, setGroup] = useState<{ mode: 'everything' | 'folder'; folders: GroupFolder[] } | null>(null);
  const [groupError, setGroupError] = useState('');
  const [ticked, setTicked] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState('');

  const items = useMemo(() => (group ? groupItems(group.mode, group.folders, folders.value) : []), [group]);
  const tops = useMemo(() => items.filter((i) => i.parent === null).map((i) => i.id), [items]);
  const wholeTicked = tops.length > 0 && ticked.length === tops.length && tops.every((t) => ticked.includes(t));

  useDebounced(() => {
    if (sync.encrypted && !pass) return;
    let live = true;
    send<{ mode: 'everything' | 'folder'; folders: GroupFolder[] }>({ t: 'groupFolders', accountId: account.id, groupId: sync.groupId, passphrase: sync.encrypted ? pass : undefined }).then(
      (g) => {
        if (!live) return;
        const top = groupItems(g.mode, g.folders, folders.value).filter((i) => i.parent === null).map((i) => i.id);
        setGroup(g);
        setGroupError('');
        setTicked(top);
        setChosen({});
      },
      (e) => live && setGroupError(errorText(e)),
    );
    return () => (live = false);
  }, [pass]);

  const target = (): Target | null => {
    if (!group || !ticked.length) return null;
    if (group.mode === 'everything' && wholeTicked && !Object.keys(chosen).length) return into ? { kind: 'everything-into', folderId: intoFolder[0] ?? '' } : { kind: 'whole' };
    return { kind: 'parts', parts: placementChoices(group.mode, group.folders, ticked, chosen), followTops: isFolder && wholeTicked };
  };
  const input = (t: Target) => ({ accountId: account.id, groupId: sync.groupId, target: t, mode: how, ignoreDefaults: defaults, passphrase: sync.encrypted ? pass : undefined, rememberKey: remember });

  useDebounced(() => {
    let live = true;
    const t = target();
    if (sync.encrypted && !pass) setPreview('Enter the passphrase to see what will change.');
    else if (!t) setPreview(group ? 'Tick at least one folder to sync here.' : 'Reading the folders in this sync…');
    else if (t.kind === 'everything-into' && !t.folderId) setPreview('Pick the folder to keep the synced bookmarks in.');
    else {
      setPreview('Checking what will change…');
      send<JoinPreview>({ t: 'previewJoin', input: input(t) }).then(
        (p) => live && setPreview(previewText(p)),
        (e) => live && setPreview(errorText(e)),
      );
    }
    return () => (live = false);
  }, [group, ticked, chosen, how, defaults, into, intoFolder, pass]);

  const join = async () => {
    if (sync.encrypted && !pass) throw new Error('Enter the passphrase for this sync.');
    const t = target();
    if (!t) throw new Error('Tick at least one folder to sync here.');
    if (t.kind === 'everything-into' && !t.folderId) throw new Error('Pick the folder to keep the synced bookmarks in.');
    await send({ t: 'join', input: input(t) });
    await load();
    go({ id: 'done', account, groupId: sync.groupId, joined: true });
  };

  let what: ComponentChildren;
  if (groupError) what = <ErrorText>{groupError}</ErrorText>;
  else if (!group) what = <p class="muted">{sync.encrypted && !pass ? 'Enter the passphrase to see the folders in this sync.' : 'Reading the folders in this sync…'}</p>;
  else
    what = (
      <>
        <p class="muted small">Everything is ticked. Untick what this browser doesn’t need, or tick single folders deeper down.</p>
        <FolderTree items={items} multi value={ticked} onChange={(ids) => (setTicked(ids), setChosen(Object.fromEntries(Object.entries(chosen).filter(([k]) => ids.includes(k)))))} label="Folders to sync in this browser" />
        <h3>Where each folder goes here</h3>
        <Placements mode={group.mode} groupFolders={group.folders} items={items} local={folders.value} localTree={localItems(folders.value, groups.value)} picked={ticked} chosen={chosen} onChange={setChosen} />
      </>
    );

  return (
    <div class="stack lg">
      <Head title={`Join “${sync.name}”`}>{isFolder ? 'This sync keeps some folders the same in every browser.' : 'This sync keeps bookmarks the same in every browser.'}</Head>
      {sync.encrypted && (
        <div class="card stack">
          <Field label="Passphrase" hint="The passphrase chosen when this sync was started.">
            <input type="password" autocomplete="current-password" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
          </Field>
          <label class="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
            Remember it in this browser
          </label>
        </div>
      )}
      <div class="stack">
        <h3>What should sync in this browser?</h3>
        <div class="stack">{what}</div>
      </div>
      <div class="stack">
        <h3>What about the bookmarks already here?</h3>
        <RadioCards
          name="how"
          value={how}
          onChange={setHow}
          options={[
            { value: 'merge', title: 'Combine', desc: 'Keeps the bookmarks in this browser and adds the synced ones. Bookmarks that match are kept once.', icon: 'git-merge', badge: 'Recommended' },
            { value: 'replace', title: 'Replace', desc: 'Swaps this browser’s bookmarks for the synced ones. You can undo this later.', icon: 'replace' },
          ]}
        />
      </div>
      <label class="check">
        <input type="checkbox" checked={defaults} onChange={(e) => setDefaults(e.currentTarget.checked)} />
        <span>Leave out the sample bookmarks this browser came with</span>
      </label>
      {!isFolder && wholeTicked && (
        <Advanced summary="Advanced">
          <label class="check">
            <input type="checkbox" checked={into} onChange={(e) => setInto(e.currentTarget.checked)} />
            <span>
              Keep the synced bookmarks inside one folder
              <div class="hint">Instead of the bookmarks bar and other bookmarks. Only when everything is ticked.</div>
            </span>
          </label>
          {into && <FolderTree items={localItems(folders.value, groups.value)} multi={false} value={intoFolder} onChange={setIntoFolder} label="Folder for the synced bookmarks" />}
        </Advanced>
      )}
      <Banner kind="info" icon="info-circle">
        {preview || 'Checking what will change…'}
      </Banner>
      <div class="footer">
        <Back go={go} to={{ id: 'choose', account }} />
        <Action label="Join and sync" kind="primary" size="lg" busy="Syncing your bookmarks…" run={join} />
      </div>
    </div>
  );
}

function DoneStep({ step, onFinish }: { step: Extract<Step, { id: 'done' }>; onFinish: () => void }) {
  const g = groups.value.find((x) => x.groupId === step.groupId);
  const n = g?.bookmarks ?? 0;
  const name = g?.name ?? 'Bookmarks';
  return (
    <div class="stack lg center">
      <div class="done-mark">
        <Icon name="check" class="xl" />
      </div>
      <div class="step-head center">
        <h1>Your bookmarks are syncing</h1>
        <p class="muted">
          {n} {n === 1 ? 'bookmark' : 'bookmarks'} in “{name}”, synced with {storageLabel(step.account)}. Changes sync on their own from now on.
        </p>
      </div>
      <div class="card stack" style="text-align:left;width:100%">
        <div class="row">
          <Icon name="devices" class="lg" />
          <div class="grow">
            <b>{step.joined ? 'Add more browsers the same way' : 'Next, set up your other browsers'}</b>
            <p class="muted small">
              Install {APP_NAME} in each browser and connect {storageWithAccount(step.account)}. They find “{name}” and join it.
            </p>
          </div>
        </div>
      </div>
      <button class="primary lg" onClick={onFinish}>
        Open the dashboard
      </button>
    </div>
  );
}
