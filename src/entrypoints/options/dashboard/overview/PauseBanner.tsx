import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { originPattern } from '../../../../browser/providers.js';
import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { Banner } from '../../../../ui/components/Banner.js';
import { plural } from '../../../../ui/lib/format.js';
import { send, withTakeover } from '../../../../ui/lib/messaging.js';
import { REASON_TEXT } from '../../../../ui/lib/reasons.js';
import { accounts, folders, groups, load } from '../../../../ui/state/store.js';
import { FolderTree } from '../../folder-picker/FolderTree.js';
import { localItems } from '../../folder-picker/treeItems.js';

interface PauseBannerProps {
  g: GroupSummary;
  onAddFolders: () => void;
}

export function PauseBanner({ g, onAddFolders }: PauseBannerProps) {
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
        <input type="password" placeholder="Passphrase" class="narrow" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
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
    buttons = (
      <button type="button" onClick={() => (location.hash = 'settings')}>
        Open Settings
      </button>
    );
  } else if (reason === 'mapped-folder-missing' && detail && g.parts.some((p) => p.part === detail)) {
    buttons = (
      <>
        <Action label="Resume syncing" kind="primary" run={resolve('resume')} />
        <button type="button" onClick={() => setPicking(true)}>
          Pick another folder
        </button>
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
              await withTakeover((takeover) => send({ t: 'movePart', groupId: g.groupId, part: detail, folderId: picked[0]!, takeover }));
              await load();
            }}
          />
        </div>
      );
  } else if (reason === 'nothing-held') {
    buttons = (
      <button type="button" onClick={onAddFolders}>
        Add folders
      </button>
    );
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
