import { Banner } from '../../../../ui/components/Banner.js';
import { Choice } from '../../../../ui/components/Choice.js';
import { storageWithAccount } from '../../../../ui/lib/storageLabels.js';
import { accounts, caps } from '../../../../ui/state/store.js';
import { StepHead } from '../StepHead.js';
import type { Go } from '../steps.js';

interface StorageStepProps {
  go: Go;
}

export function StorageStep({ go }: StorageStepProps) {
  const google = caps.value.google;
  const connected = accounts.value;
  return (
    <div class="stack lg">
      <StepHead title="Where should your bookmarks be stored?">Every browser you connect reads and writes your bookmarks here. Pick the same place in each browser.</StepHead>
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
          <h3 class="connect-new">Or connect new storage</h3>
        </div>
      )}
      <div class="stack">
        {google && (
          <Choice
            icon="brand-google-drive"
            title="Google Drive"
            badge="Recommended"
            recommended
            desc="Sign in with your Google account. Bookmarks go in a private app folder."
            onClick={() => go({ id: 'google' })}
          />
        )}
        {caps.value.googleBlocked && (
          <Banner kind="info" icon="info-circle">
            To use Google Drive in Brave, turn on “Allow Google login for extensions” in Settings, Extensions, then reload this page.
          </Banner>
        )}
        <Choice
          icon="server"
          title="Your own server"
          desc="Nextcloud, ownCloud, Synology, any WebDAV server, or rclone."
          recommended={!google && !connected.length}
          onClick={() => go({ id: 'server' })}
        />
      </div>
    </div>
  );
}
