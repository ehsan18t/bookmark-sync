import { useState } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { Banner } from '../../../../ui/components/Banner.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { Pill } from '../../../../ui/components/Pill.js';
import { plural, relativeTime } from '../../../../ui/lib/format.js';
import { storageWithAccount } from '../../../../ui/lib/storageLabels.js';
import { accounts, devices, now, sendAndReload } from '../../../../ui/state/store.js';
import { FoldersPanel } from '../folders/FoldersPanel.js';
import { EncryptionPanel } from './EncryptionPanel.js';
import { PauseBanner } from './PauseBanner.js';
import { RenamePanel } from './RenamePanel.js';
import { StatusPill } from './StatusPill.js';

interface SyncCardProps {
  g: GroupSummary;
}

export function SyncCard({ g }: SyncCardProps) {
  const account = accounts.value.find((a) => a.id === g.accountId);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'folders' | 'encryption' | 'rename' | null>(null);
  const others = devices.value[g.groupId]?.filter((d) => !d.self && !d.left && !d.removed).map((d) => d.name);
  const showFolders = () => {
    setOpen(true);
    setPanel('folders');
  };
  return (
    <div class="card stack lg">
      <div class="row spread">
        <div class="row">
          <h2>{g.name}</h2>
          <StatusPill g={g} />
          {g.encrypted && <Pill icon="lock">Encrypted</Pill>}
        </div>
        <Action label="Sync now" icon="refresh" busy="Syncing…" run={() => sendAndReload({ t: 'syncGroup', groupId: g.groupId })} />
      </div>
      <dl class="facts">
        <dt>Syncs here</dt>
        <dd>{g.location}</dd>
        <dt>Stored in</dt>
        <dd>{storageWithAccount(account)}</dd>
        <dt>Shared with</dt>
        <dd class={others?.length ? '' : 'muted'}>{!others ? 'Not known yet' : others.length ? others.join(', ') : 'No other browsers yet'}</dd>
        {g.links.length > 0 && (
          <>
            <dt>Linked with</dt>
            <dd>{g.links.map((l) => (l.via ? `“${l.name}” through ${l.via}` : `“${l.name}” here`)).join(', ')}</dd>
          </>
        )}
      </dl>
      <p class="muted small">
        {[
          plural(g.bookmarks, 'bookmark', 'bookmarks'),
          g.lastSyncAt ? `synced ${relativeTime(g.lastSyncAt, now.value)}` : 'not synced yet',
          `${plural(g.pendingChanges, 'change', 'changes')} waiting to upload`,
        ].join(' · ')}
      </p>
      <PauseBanner g={g} onAddFolders={showFolders} />
      {g.notices.length > 0 && (
        <Banner kind="info" icon="info-circle">
          {g.notices.map((n, i) => (
            <span key={i}>{n.text}</span>
          ))}
          <div class="row">
            <Action label="Got it" run={() => sendAndReload({ t: 'dismissNotices', groupId: g.groupId })} />
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
            <button type="button" onClick={() => setPanel('rename')}>
              <Icon name="pencil" />
              Rename
            </button>
            {(g.parts.length > 0 || g.mode === 'folder') && (
              <button type="button" onClick={() => setPanel('folders')}>
                <Icon name="folders" />
                Folders synced here
              </button>
            )}
            <button type="button" onClick={() => setPanel('encryption')}>
              <Icon name="shield-lock" />
              {g.encrypted ? 'Turn off encryption' : 'Turn on encryption'}
            </button>
            {g.canUndoJoin && (
              <Action
                label="Undo joining"
                icon="history"
                confirm="Undo joining this sync? What this browser added is removed from the sync, this browser’s bookmarks go back to how they were before joining, and syncing stops here."
                run={() => sendAndReload({ t: 'undoJoin', groupId: g.groupId })}
              />
            )}
            <Action
              label="Stop syncing here"
              icon="logout"
              confirm="Stop syncing in this browser? Your bookmarks stay as they are, and your other browsers keep syncing."
              run={() => sendAndReload({ t: 'leave', groupId: g.groupId })}
            />
            <Action
              label="Delete this sync"
              kind="danger"
              icon="trash"
              confirm="Delete this sync for every browser? Each browser keeps its bookmarks, but nothing syncs any more, and the history is deleted from the storage."
              run={() => sendAndReload({ t: 'deleteEverywhere', groupId: g.groupId })}
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
