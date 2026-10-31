import type { Settings } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { ErrorText } from '../../../../ui/components/ErrorText.js';
import { useLoad } from '../../../../ui/hooks/useLoad.js';
import { send } from '../../../../ui/lib/messaging.js';
import { Setting } from './Setting.js';
import { SettingsForm } from './SettingsForm.js';
import { StorageList } from './StorageList.js';

export function SettingsTab() {
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
                const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
                a.href = url;
                a.download = 'bookmark-sync-diagnostics.json';
                a.click();
                // Firefox cancels the download when the URL is revoked before it starts.
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
              }}
            />
          </Setting>
        </div>
      </div>
    </>
  );
}
