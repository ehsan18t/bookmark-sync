import { Action } from '../../../../ui/components/Action.js';
import { EmptyState } from '../../../../ui/components/EmptyState.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { storageLabel, storageWithAccount } from '../../../../ui/lib/storageLabels.js';
import { accounts, groups, sendAndReload } from '../../../../ui/state/store.js';
import { SectionTitle } from '../SectionTitle.js';

export function StorageList() {
  return (
    <div class="stack">
      <SectionTitle>
        <h3>Storage</h3>
        <button type="button" onClick={() => (location.hash = 'setup')}>
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
                    run={() => sendAndReload({ t: 'removeAccount', id: a.id })}
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
