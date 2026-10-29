import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { originPattern } from '../../browser/providers.js';
import { APP_NAME, HOMEPAGE_URL, PRIVACY_URL, SUPPORT_EMAIL } from '../../config.js';
import type { DuplicateGroup } from '../../core/dedupe.js';
import type { GroupSummary, Settings } from '../../engine/app.js';
import type { GroupFolder, TimelineEntry } from '../../engine/group.js';
import { Action, Banner, Brand, EmptyState, ErrorText, Field, Icon, Pill } from '../../ui/components.js';
import { errorText, hlcTime, relativeTime, send } from '../../ui/util.js';
import type { IconName } from '../../ui/icons.js';
import { FolderTree, Placements } from './FolderPicker.js';
import { groupItems, localItems, placementChoices } from './folders.js';
import { accounts, devices, folders, groups, load, now, REASON_TEXT, storageLabel, storageWithAccount } from './shared.js';

export type Tab = 'overview' | 'history' | 'browsers' | 'duplicates' | 'settings';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'browsers', label: 'Browsers', icon: 'devices' },
  { id: 'duplicates', label: 'Duplicates', icon: 'copy' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export const isTab = (s: string): s is Tab => TABS.some((t) => t.id === s);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Loads data for a component, showing its error in place of the content. */
function useLoad<T>(fetch: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    fetch().then(
      (d) => live && (setData(d), setError('')),
      (e) => live && setError(errorText(e)),
    );
    return () => (live = false);
  }, [...deps, round]);
  return { data, error, reload: () => setRound((r) => r + 1) };
}

export function Dashboard({ tab }: { tab: Tab }) {
  const Panel = { overview: Overview, history: History, browsers: Browsers, duplicates: Duplicates, settings: SettingsTab }[tab];
  return (
    <div class="page wide">
      <div class="topbar">
        <Brand />
        <Action label="Sync now" icon="refresh" busy="Syncing…" run={async () => (await send({ t: 'syncNow' }), load())} />
      </div>
      <nav class="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} onClick={() => (location.hash = t.id)}>
            <Icon name={t.icon} />
            {t.label}
          </button>
        ))}
      </nav>
      <div class="stack lg">
        <Panel />
      </div>
    </div>
  );
}

function StatusPill({ g }: { g: GroupSummary }) {
  if (g.status.state === 'active')
    return g.lastError ? (
      <Pill kind="warn" icon="alert-triangle">
        Retrying
      </Pill>
    ) : (
      <Pill kind="ok" icon="circle-check">
        Syncing
      </Pill>
    );
  if (g.status.reason === 'migration')
    return (
      <Pill kind="accent" icon="loader-2" spin>
        Switching encryption
      </Pill>
    );
  return (
    <Pill kind="warn" icon="player-pause">
      Paused
    </Pill>
  );
}

function Overview() {
  return (
    <>
      {groups.value.map((g) => (
        <SyncCard key={g.groupId} g={g} />
      ))}
      <div class="row">
        <button onClick={() => (location.hash = 'setup')}>
          <Icon name="plus" />
          Add another sync
        </button>
      </div>
    </>
  );
}

function SyncCard({ g }: { g: GroupSummary }) {
  const account = accounts.value.find((a) => a.id === g.accountId);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'folders' | 'encryption' | 'rename' | null>(null);
  const others = devices.value[g.groupId]?.filter((d) => !d.self && !d.left && !d.removed).map((d) => d.name);
  const showFolders = () => (setOpen(true), setPanel('folders'));
  return (
    <div class="card stack lg">
      <div class="row spread">
        <div class="row">
          <h2>{g.name}</h2>
          <StatusPill g={g} />
          {g.encrypted && <Pill icon="lock">Encrypted</Pill>}
        </div>
        <Action label="Sync now" icon="refresh" busy="Syncing…" run={async () => (await send({ t: 'syncGroup', groupId: g.groupId }), load())} />
      </div>
      <dl class="facts">
        <dt>Syncs here</dt>
        <dd>{g.location}</dd>
        <dt>Stored in</dt>
        <dd>{storageWithAccount(account)}</dd>
        <dt>Shared with</dt>
        <dd class={others?.length ? '' : 'muted'}>{!others ? 'Not known yet' : others.length ? others.join(', ') : 'No other browsers yet'}</dd>
      </dl>
      <p class="muted small">
        {[plural(g.bookmarks, 'bookmark', 'bookmarks'), g.lastSyncAt ? `synced ${relativeTime(g.lastSyncAt, now.value)}` : 'not synced yet', `${plural(g.pendingChanges, 'change', 'changes')} waiting to upload`].join(' · ')}
      </p>
      <PauseBanner g={g} onAddFolders={showFolders} />
      {g.notices.length > 0 && (
        <Banner kind="info" icon="info-circle">
          {g.notices.map((n, i) => (
            <span key={i}>{n.text}</span>
          ))}
          <div class="row">
            <Action label="Got it" run={async () => (await send({ t: 'dismissNotices', groupId: g.groupId }), load())} />
          </div>
        </Banner>
      )}
      {g.status.state === 'active' && g.lastError && (
        <Banner icon="alert-triangle">
          <span>The last sync didn’t finish: {g.lastError} It retries by itself.</span>
        </Banner>
      )}
      <details class="advanced" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <Icon name="chevron-right" />
          More options
        </summary>
        <div class="stack">
          <div class="row">
            <button onClick={() => setPanel('rename')}>
              <Icon name="pencil" />
              Rename
            </button>
            {(g.parts.length > 0 || g.mode === 'folder') && (
              <button onClick={() => setPanel('folders')}>
                <Icon name="folders" />
                Folders synced here
              </button>
            )}
            <button onClick={() => setPanel('encryption')}>
              <Icon name="shield-lock" />
              {g.encrypted ? 'Turn off encryption' : 'Turn on encryption'}
            </button>
            {g.canUndoJoin && (
              <Action
                label="Undo joining"
                icon="history"
                confirm="Undo joining this sync? What this browser added is removed from the sync, this browser’s bookmarks go back to how they were before joining, and syncing stops here."
                run={async () => (await send({ t: 'undoJoin', groupId: g.groupId }), load())}
              />
            )}
            <Action
              label="Stop syncing here"
              icon="logout"
              confirm="Stop syncing in this browser? Your bookmarks stay as they are, and your other browsers keep syncing."
              run={async () => (await send({ t: 'leave', groupId: g.groupId }), load())}
            />
            <Action
              label="Delete this sync"
              kind="danger"
              icon="trash"
              confirm="Delete this sync for every browser? Each browser keeps its bookmarks, but nothing syncs any more, and the history is deleted from the storage."
              run={async () => (await send({ t: 'deleteEverywhere', groupId: g.groupId }), load())}
            />
          </div>
          {panel === 'folders' && <FoldersPanel g={g} />}
          {panel === 'encryption' && <EncryptionPanel g={g} onDone={() => setPanel(null)} />}
          {panel === 'rename' && <RenamePanel g={g} onDone={() => setPanel(null)} />}
        </div>
      </details>
    </div>
  );
}

function FoldersPanel({ g }: { g: GroupSummary }) {
  const [adder, setAdder] = useState<{ kind: 'local' } | { kind: 'sync' } | { kind: 'move'; part: string; path: string } | null>(null);
  const close = () => setAdder(null);
  return (
    <div class="card stack">
      <h3>Folders synced in this browser</h3>
      {g.parts.length ? (
        <div class="part-list">
          {g.parts.map((p) => (
            <div key={p.part} class="row spread part">
              <span class="row">
                <Icon name="folder" />
                {p.path}
              </span>
              <div class="row">
                <button class="ghost" onClick={() => setAdder({ kind: 'move', part: p.part, path: p.path })}>
                  Move it
                </button>
                <Action
                  label="Stop syncing it here"
                  kind="ghost"
                  confirm="Stop syncing this folder in this browser? It stays here as it is, and other browsers keep syncing it."
                  run={async () => (await send({ t: 'removePart', groupId: g.groupId, part: p.part, everywhere: false }), load())}
                />
                {p.top && (
                  <Action
                    label="Remove for every browser"
                    kind="danger"
                    confirm="Remove this folder from the sync for every browser? Each browser keeps its copy, but it no longer syncs anywhere."
                    run={async () => (await send({ t: 'removePart', groupId: g.groupId, part: p.part, everywhere: true }), load())}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p class="muted">No folders of this sync are synced here.</p>
      )}
      <div class="row">
        {g.mode === 'folder' && (
          <button onClick={() => setAdder({ kind: 'local' })}>
            <Icon name="plus" />
            Add a folder from this browser
          </button>
        )}
        <button onClick={() => setAdder({ kind: 'sync' })}>
          <Icon name="folders" />
          Sync another folder of this sync here
        </button>
      </div>
      {adder?.kind === 'local' && <AddLocal key="local" g={g} onClose={close} />}
      {adder?.kind === 'sync' && <AddFromSync key="sync" g={g} onClose={close} />}
      {adder?.kind === 'move' && <MovePart key={adder.part} g={g} part={adder.part} path={adder.path} onClose={close} />}
    </div>
  );
}

function Cancel({ onClose }: { onClose: () => void }) {
  return (
    <button class="ghost" onClick={onClose}>
      Cancel
    </button>
  );
}

function AddLocal({ g, onClose }: { g: GroupSummary; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div class="stack">
      <p class="muted small">Each ticked folder is added to the sync for every browser.</p>
      <FolderTree items={localItems(folders.value, groups.value, g.groupId).map((i) => (g.held.includes(i.id) ? { ...i, blocked: 'Synced here' } : i))} multi value={picked} onChange={setPicked} label="Folders to add" />
      <div class="row">
        <Action
          label="Add to the sync"
          kind="primary"
          run={async () => {
            if (!picked.length) throw new Error('Tick at least one folder.');
            await send({ t: 'addTops', groupId: g.groupId, folderIds: picked });
            await load();
            onClose();
          }}
        />
        <Cancel onClose={onClose} />
      </div>
    </div>
  );
}

function MovePart({ g, part, path, onClose }: { g: GroupSummary; part: string; path: string; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const items = localItems(folders.value, groups.value, g.groupId).map((i) => (g.held.includes(i.id) ? { ...i, blocked: 'Synced here' } : i));
  return (
    <div class="stack">
      <p class="muted small">Pick the folder that should hold “{path}” from now on. What it already contains is added to the sync. The current folder stays as it is but no longer syncs.</p>
      <FolderTree items={items} multi={false} value={picked} onChange={setPicked} label={`New place for ${path}`} />
      <div class="row">
        <Action
          label="Use this folder"
          kind="primary"
          run={async () => {
            if (!picked[0]) throw new Error('Pick a folder.');
            await send({ t: 'movePart', groupId: g.groupId, part, folderId: picked[0] });
            await load();
            onClose();
          }}
        />
        <Cancel onClose={onClose} />
      </div>
    </div>
  );
}

function AddFromSync({ g, onClose }: { g: GroupSummary; onClose: () => void }) {
  const r = useLoad(() => send<{ mode: 'everything' | 'folder'; folders: GroupFolder[] }>({ t: 'groupFolders', accountId: g.accountId, groupId: g.groupId }), [g.groupId]);
  const [picked, setPicked] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  if (r.error) return <ErrorText>{r.error}</ErrorText>;
  if (!r.data) return <p class="muted">Reading the folders in this sync…</p>;
  const { mode, folders: groupFolders } = r.data;
  const items = groupItems(mode, groupFolders, folders.value).map((i) => (g.parts.some((p) => p.part === i.id) ? { ...i, blocked: 'Synced here' } : i));
  return (
    <div class="stack">
      <FolderTree items={items} multi value={picked} onChange={setPicked} label="Folders of this sync" />
      <Placements mode={mode} groupFolders={groupFolders} items={items} local={folders.value} localTree={localItems(folders.value, groups.value)} picked={picked} chosen={chosen} onChange={setChosen} />
      <div class="row">
        <Action
          label="Sync them here"
          kind="primary"
          run={async () => {
            if (!picked.length) throw new Error('Tick at least one folder.');
            await send({ t: 'addParts', groupId: g.groupId, parts: placementChoices(mode, groupFolders, picked, chosen) });
            await load();
            onClose();
          }}
        />
        <Cancel onClose={onClose} />
      </div>
    </div>
  );
}

function PauseBanner({ g, onAddFolders }: { g: GroupSummary; onAddFolders: () => void }) {
  const [pass, setPass] = useState('');
  const [remember, setRemember] = useState(true);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  if (g.status.state !== 'paused') return null;
  const reason = g.status.reason;
  const detail = g.status.detail;
  const resolve = (choice: 'apply' | 'revert' | 'resume') => async () => (await send({ t: 'resolve', groupId: g.groupId, choice }), load());
  const big = reason === 'large-remote-change' || reason === 'large-local-change';
  let text = REASON_TEXT[reason] ?? 'Syncing is paused.';
  if (big && g.guard) text += ` ${g.guard.count} of ${g.guard.total} bookmarks would be removed, moved, or edited.`;

  let buttons: ComponentChildren = null;
  let extra: ComponentChildren = null;
  if (big) {
    buttons = (
      <>
        <Action label={reason === 'large-remote-change' ? 'Apply the change here' : 'Send the change'} kind="primary" run={resolve('apply')} />
        <Action label={reason === 'large-remote-change' ? 'Undo it everywhere' : 'Put my bookmarks back'} run={resolve('revert')} />
      </>
    );
  } else if (reason === 'locked') {
    buttons = (
      <>
        <input type="password" placeholder="Passphrase" style="max-width:260px" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
        <label class="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
          Remember in this browser
        </label>
        <Action label="Unlock" kind="primary" run={async () => (await send({ t: 'unlock', groupId: g.groupId, passphrase: pass, remember }), load())} />
      </>
    );
  } else if (reason === 'migration' && g.migration) {
    const waiting = g.migration.waitingFor;
    if (waiting.length)
      buttons = (
        <>
          <span class="muted">Waiting for {plural(waiting.length, 'other browser', 'other browsers')} to move over.</span>
          {g.migration.initiator && <Action label="Continue without them" run={async () => (await send({ t: 'continueMigration', groupId: g.groupId, deviceIds: waiting }), load())} />}
        </>
      );
  } else if (reason === 'permission') {
    const url = accounts.value.find((a) => a.id === g.accountId)?.url;
    if (url)
      buttons = (
        <Action
          label="Allow access"
          kind="primary"
          run={async () => {
            if (!(await browser.permissions.request({ origins: [originPattern(url)] }))) throw new Error('Choose Allow so the extension can reach the server.');
            await resolve('resume')();
          }}
        />
      );
  } else if (reason === 'auth') {
    buttons = <button onClick={() => (location.hash = 'settings')}>Open Settings</button>;
  } else if (reason === 'mapped-folder-missing' && detail && g.parts.some((p) => p.part === detail)) {
    buttons = (
      <>
        <Action label="Resume syncing" kind="primary" run={resolve('resume')} />
        <button onClick={() => setPicking(true)}>Pick another folder</button>
        <Action
          label="Stop syncing it here"
          run={async () => {
            await send({ t: 'removePart', groupId: g.groupId, part: detail, everywhere: false });
            await resolve('resume')();
          }}
        />
      </>
    );
    if (picking)
      extra = (
        <div class="stack">
          <FolderTree items={localItems(folders.value, groups.value, g.groupId)} multi={false} value={picked} onChange={setPicked} label="New folder for it" />
          <Action
            label="Use this folder"
            kind="primary"
            run={async () => {
              if (!picked[0]) throw new Error('Pick a folder.');
              await send({ t: 'movePart', groupId: g.groupId, part: detail, folderId: picked[0] });
              await load();
            }}
          />
        </div>
      );
  } else if (reason === 'nothing-held') {
    buttons = <button onClick={onAddFolders}>Add folders</button>;
  } else if (reason !== 'group-deleted' && reason !== 'format-too-new') {
    buttons = <Action label="Resume syncing" kind="primary" run={resolve('resume')} />;
  }
  return (
    <Banner icon="player-pause">
      <span>{text}</span>
      {buttons && <div class="row">{buttons}</div>}
      {extra}
    </Banner>
  );
}

function EncryptionPanel({ g, onDone }: { g: GroupSummary; onDone: () => void }) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const run = async () => {
    if (!g.encrypted) {
      if (pass.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      if (pass !== again) throw new Error('The passphrases don’t match.');
    }
    await send({ t: 'setEncryption', groupId: g.groupId, passphrase: g.encrypted ? null : pass });
    await load();
    onDone();
  };
  return (
    <div class="card stack">
      <p class="muted">
        {g.encrypted
          ? 'Your bookmarks will be stored without encryption. Every browser moves over by itself, and nothing is lost.'
          : 'Your bookmarks will be stored encrypted. Every browser needs the passphrase, and it can’t be recovered if you lose it.'}
      </p>
      {!g.encrypted && (
        <div class="fields-2">
          <Field label="Passphrase">
            <input type="password" autocomplete="new-password" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
          </Field>
          <Field label="Repeat passphrase">
            <input type="password" autocomplete="new-password" value={again} onInput={(e) => setAgain(e.currentTarget.value)} />
          </Field>
        </div>
      )}
      <Action label={g.encrypted ? 'Turn off encryption' : 'Turn on encryption'} kind="primary" busy="Switching…" run={run} />
    </div>
  );
}

function RenamePanel({ g, onDone }: { g: GroupSummary; onDone: () => void }) {
  const [name, setName] = useState(g.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  return (
    <div class="card stack">
      <Field label="New name" hint="Every browser in this sync shows the new name after its next sync.">
        <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} ref={input} />
      </Field>
      <div class="row">
        <Action label="Save name" kind="primary" busy="Renaming…" run={async () => (await send({ t: 'rename', groupId: g.groupId, name }), await load(), onDone())} />
      </div>
    </div>
  );
}

/** The group a tab shows, with a picker when there is more than one. */
function useGroupPick(): [GroupSummary | undefined, ComponentChildren] {
  const [id, setId] = useState<string | null>(null);
  const list = groups.value;
  const g = list.find((x) => x.groupId === id) ?? list[0];
  const picker =
    list.length < 2 ? null : (
      <select style="max-width:280px" value={g?.groupId} onChange={(e) => setId(e.currentTarget.value)}>
        {list.map((x) => (
          <option key={x.groupId} value={x.groupId}>
            {x.name}
          </option>
        ))}
      </select>
    );
  return [g, picker];
}

function SectionTitle({ children }: { children: ComponentChildren }) {
  return <div class="section-title">{children}</div>;
}

/** The latest HLC that sorts before `hlc`: one millisecond earlier, after every op in that millisecond. */
const justBefore = (hlc: string) => `${String(Number(hlc.slice(0, 15)) - 1).padStart(15, '0')}-999999-~`;

const KIND_TEXT: Record<string, string> = { create: 'added', update: 'edited', move: 'moved', delete: 'removed', undelete: 'restored' };

function History() {
  const [g, picker] = useGroupPick();
  if (!g) return <EmptyState icon="history" title="Nothing synced yet" text="Set up a sync to keep a history of changes." />;
  return (
    <>
      <SectionTitle>
        <p class="muted">Every change from every browser, kept for the number of days set in Settings. Going back applies to every browser, and can itself be undone.</p>
        {picker}
      </SectionTitle>
      <Timeline key={g.groupId} g={g} />
    </>
  );
}

function Timeline({ g }: { g: GroupSummary }) {
  const r = useLoad(() => send<TimelineEntry[]>({ t: 'timeline', groupId: g.groupId }), [g.groupId, g.lastSyncAt]);
  if (r.error) return <ErrorText>{r.error}</ErrorText>;
  if (!r.data)
    return (
      <div class="row muted">
        <Icon name="loader-2" class="spin" />
        Loading history…
      </div>
    );
  const entries = r.data;
  const who = (d: string) => {
    const x = devices.value[g.groupId]?.find((v) => v.deviceId === d);
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
    await load();
  };
  return (
    <div class="stack lg">
      {g.restorePoints.length > 0 && (
        <div class="stack">
          <h3>Saved points</h3>
          <div class="card flush">
            <ul class="list">
              {g.restorePoints.map((p) => (
                <li key={p.hlc}>
                  <Icon name="clock" />
                  <div class="grow">
                    <div>{p.label}</div>
                    <div class="meta">{hlcTime(p.hlc)}</div>
                  </div>
                  <Action label="Go back to this" run={() => restoreTo(p.hlc)} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div class="stack">
        <h3>Recent changes</h3>
        {entries.length ? (
          <div class="card flush">
            <ul class="list">
              {entries.map((e) => (
                <li key={e.from}>
                  <div class="grow">
                    <div>
                      {who(e.device)} · {describe(e.kinds)}
                    </div>
                    <div class="meta">{hlcTime(e.to)}</div>
                  </div>
                  {e.from > g.oldestRestorable && <Action label="Undo from here" kind="ghost" run={() => restoreTo(justBefore(e.from))} />}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState icon="history" title="No changes yet" text="Changes from every browser show up here, so you can go back to an earlier point." />
        )}
      </div>
    </div>
  );
}

function Browsers() {
  const [g, picker] = useGroupPick();
  if (!g) return <EmptyState icon="devices" title="Nothing synced yet" text="Browsers that sync with you show up here." />;
  return (
    <>
      <SectionTitle>
        <p class="muted">Browsers that share these bookmarks.</p>
        {picker}
      </SectionTitle>
      <DeviceList key={g.groupId} g={g} />
    </>
  );
}

function DeviceList({ g }: { g: GroupSummary }) {
  const list = devices.value[g.groupId];
  if (!list) return null;
  return (
    <div class="card flush">
      <ul class="list">
        {list
          .filter((d) => !d.left && !d.removed)
          .map((d) => (
            <li key={d.deviceId}>
              <Icon name="world" class="lg" />
              <div class="grow">
                <div class="row" style="gap:8px">
                  <b>{d.name}</b>
                  {d.self && <span class="pill accent">This browser</span>}
                </div>
                <div class="meta">{d.self ? 'Online now' : `Last synced ${relativeTime(d.lastSeen, now.value)}`}</div>
              </div>
              {!d.self && (
                <Action
                  label="Remove"
                  kind="ghost"
                  confirm={`Remove ${d.name} from this sync? Do this after uninstalling the extension there, or if you no longer use that browser.`}
                  run={async () => (await send({ t: 'removeDevice', groupId: g.groupId, deviceId: d.deviceId }), load())}
                />
              )}
            </li>
          ))}
      </ul>
    </div>
  );
}

function Duplicates() {
  const [found, setFound] = useState<DuplicateGroup[] | null>(null);
  const undo = useLoad(() => send<{ id: string; at: number; label: string }[]>({ t: 'localUndo' }), []);
  const scan = async () => {
    setFound(await send<DuplicateGroup[]>({ t: 'scanDuplicates' }));
    undo.reload();
  };
  return (
    <>
      <SectionTitle>
        <p class="muted">Find bookmarks that point to the same page. Nothing is removed until you choose, and synced cleanups can be undone from History.</p>
        <Action label="Find duplicates" kind="primary" icon="copy" busy="Searching…" run={scan} />
      </SectionTitle>
      {undo.data?.map((u) => (
        <Banner key={u.id} kind="info" icon="history">
          <div class="row spread">
            <span>
              {u.label} · {relativeTime(u.at, now.value)}
            </span>
            <Action label="Undo" run={async () => (await send({ t: 'undoLocal', id: u.id }), undo.reload())} />
          </div>
        </Banner>
      ))}
      {found &&
        (found.length ? (
          <div class="stack">
            <h3>{plural(found.length, 'set', 'sets')} of duplicates</h3>
            {found.map((d) => (
              <DuplicateCard key={`${d.key}:${d.items.map((i) => i.localId).join()}`} d={d} rescan={scan} />
            ))}
          </div>
        ) : (
          <EmptyState icon="circle-check" title="No duplicates" text="Every bookmark points to a different page." />
        ))}
    </>
  );
}

function DuplicateCard({ d, rescan }: { d: DuplicateGroup; rescan: () => Promise<void> }) {
  const [keep, setKeep] = useState(d.items[0]!.localId);
  const [folder, setFolder] = useState(folders.value[0]?.id ?? '');
  return (
    <div class="card stack">
      <div class="row spread">
        <span class="pill">{d.level === 'exact' ? 'Same page' : 'Probably the same page'}</span>
        <span class="muted small">Pick the one to keep</span>
      </div>
      <div class="stack">
        {d.items.map((it) => (
          <label key={it.localId} class="check">
            <input type="radio" name={`dup-${d.key}`} checked={keep === it.localId} onChange={() => setKeep(it.localId)} />
            <span class="grow">
              {it.title || 'Untitled'}
              <div class="url">
                {it.url} · {it.path}
                {it.group ? ` · synced in ${it.group}` : ''}
              </div>
            </span>
          </label>
        ))}
      </div>
      <div class="row">
        <Action
          label="Keep this one, remove the rest"
          kind="primary"
          run={async () => (await send({ t: 'applyDedupe', action: { remove: d.items.map((i) => i.localId).filter((id) => id !== keep) } }), rescan())}
        />
        <span class="muted">or</span>
        <select style="max-width:260px" value={folder} onChange={(e) => setFolder(e.currentTarget.value)}>
          {folders.value.map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
        </select>
        <Action label="Move them all here" run={async () => (await send({ t: 'applyDedupe', action: { move: d.items.map((i) => i.localId), folderId: folder } }), rescan())} />
      </div>
    </div>
  );
}

function Setting({ title, hint, children }: { title: string; hint: string; children: ComponentChildren }) {
  return (
    <div class="setting">
      <div class="label">
        <b>{title}</b>
        <span class="hint">{hint}</span>
      </div>
      {children}
    </div>
  );
}

function SettingsTab() {
  const r = useLoad(() => send<Settings & { deviceName: string }>({ t: 'settings' }), []);
  if (r.error) return <ErrorText>{r.error}</ErrorText>;
  if (!r.data) return null;
  return (
    <>
      <SettingsForm initial={r.data} />
      <StorageList />
      <div class="stack">
        <h3>Troubleshooting</h3>
        <div class="card flush">
          <Setting title="Diagnostics" hint="A file with sync details for reporting a problem. It contains no bookmarks, passwords, or passphrases.">
            <Action
              label="Export"
              run={async () => {
                const data = await send({ t: 'diagnostics' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
                a.download = 'bookmark-sync-diagnostics.json';
                a.click();
              }}
            />
          </Setting>
        </div>
      </div>
      <About />
    </>
  );
}

function SettingsForm({ initial }: { initial: Settings & { deviceName: string } }) {
  const [deviceName, setDeviceName] = useState(initial.deviceName);
  const [history, setHistory] = useState(String(initial.historyDays));
  const [percent, setPercent] = useState(String(initial.guardPercent));
  const [min, setMin] = useState(String(initial.guardMin));
  const [pull, setPull] = useState(String(initial.pullMinutes));
  const [saved, setSaved] = useState(false);
  const num = (value: string, set: (v: string) => void, bounds: { min: number; max?: number }) => (
    <input type="number" min={bounds.min} max={bounds.max} value={value} onInput={(e) => set(e.currentTarget.value)} />
  );
  const save = async () => {
    const n = (v: string, lo: number, hi: number, what: string) => {
      const x = Number(v);
      if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${what} must be between ${lo} and ${hi}.`);
      return Math.round(x);
    };
    await send({
      t: 'updateSettings',
      patch: {
        deviceName: deviceName.trim() || initial.deviceName,
        historyDays: n(history, 0, 365, 'Days of history'),
        guardPercent: n(percent, 1, 100, 'The percentage'),
        guardMin: n(min, 1, 100_000, 'The number of bookmarks'),
        pullMinutes: n(pull, 1, 60, 'Minutes'),
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  return (
    <div class="stack">
      <h3>This browser</h3>
      <div class="card flush">
        <Setting title="Name" hint="How this browser appears in your other browsers.">
          <input type="text" value={deviceName} onInput={(e) => setDeviceName(e.currentTarget.value)} />
        </Setting>
        <Setting title="History" hint="How long changes are kept so you can go back. 0 turns history off.">
          <span class="inline-num">Keep {num(history, setHistory, { min: 0, max: 365 })} days</span>
        </Setting>
        <Setting title="Big changes" hint="Syncing pauses and asks first when a change would remove, move, or edit at least this much.">
          <div class="stack" style="gap:6px">
            <span class="inline-num">More than {num(percent, setPercent, { min: 1, max: 100 })} % of bookmarks</span>
            <span class="inline-num">and at least {num(min, setMin, { min: 1 })} bookmarks</span>
          </div>
        </Setting>
        <Setting title="Checking for changes" hint="Changes made here sync within seconds. Changes from other browsers are checked this often, and when you switch windows.">
          <span class="inline-num">Every {num(pull, setPull, { min: 1, max: 60 })} minutes</span>
        </Setting>
      </div>
      <div class="row">
        <Action label="Save changes" kind="primary" run={save} />
        <span class="pill ok" role="status">
          {saved ? 'Saved' : ''}
        </span>
      </div>
    </div>
  );
}

function StorageList() {
  return (
    <div class="stack">
      <SectionTitle>
        <h3>Storage</h3>
        <button onClick={() => (location.hash = 'setup')}>
          <Icon name="plus" />
          Connect storage
        </button>
      </SectionTitle>
      {accounts.value.length ? (
        <div class="card flush">
          <ul class="list">
            {accounts.value.map((a) => {
              const used = groups.value.filter((g) => g.accountId === a.id).map((g) => g.name);
              const meta = [a.type === 'webdav' && a.url ? decodeURI(a.url) : null, used.length ? `Used by ${used.join(', ')}` : 'Not used by any sync'].filter(Boolean).join(' · ');
              return (
                <li key={a.id}>
                  <Icon name={a.type === 'gdrive' ? 'brand-google-drive' : 'server'} class="lg" />
                  <div class="grow">
                    <b>{storageWithAccount(a)}</b>
                    <div class="meta">{meta}</div>
                  </div>
                  <Action
                    label="Remove"
                    kind="ghost"
                    confirm={`Remove ${storageLabel(a)} from this browser? Nothing is deleted from the storage.`}
                    run={async () => (await send({ t: 'removeAccount', id: a.id }), load())}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <EmptyState icon="cloud" title="No storage connected" text="Connect Google Drive or your own server to start syncing." />
      )}
    </div>
  );
}

function About() {
  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener" class="btn">
      {label}
      <Icon name="external-link" />
    </a>
  );
  const rows = [
    HOMEPAGE_URL && (
      <Setting key="web" title="Website" hint={`News, help, and how ${APP_NAME} works.`}>
        {link(HOMEPAGE_URL, 'Open')}
      </Setting>
    ),
    PRIVACY_URL && (
      <Setting key="privacy" title="Privacy policy" hint="What happens to your data.">
        {link(PRIVACY_URL, 'Read')}
      </Setting>
    ),
    SUPPORT_EMAIL && (
      <Setting key="support" title="Support" hint={SUPPORT_EMAIL}>
        {link(`mailto:${SUPPORT_EMAIL}`, 'Email')}
      </Setting>
    ),
  ].filter(Boolean);
  if (!rows.length) return null;
  return (
    <div class="stack">
      <h3>About</h3>
      <div class="card flush">{rows}</div>
    </div>
  );
}
