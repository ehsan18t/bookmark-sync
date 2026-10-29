import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { originPattern } from '../../../../browser/providers.js';
import { SERVER_FOLDER } from '../../../../config.js';
import { Action } from '../../../../ui/components/Action.js';
import { Advanced } from '../../../../ui/components/Advanced.js';
import { Banner } from '../../../../ui/components/Banner.js';
import { Field } from '../../../../ui/components/Field.js';
import { send } from '../../../../ui/lib/messaging.js';
import { BackButton } from '../BackButton.js';
import { StepHead } from '../StepHead.js';
import { connected, type Go } from '../steps.js';

interface ServerStepProps {
  go: Go;
}

export function ServerStep({ go }: ServerStepProps) {
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
      <StepHead title="Connect your server">Use the WebDAV address of your server. The extension checks the connection before going on.</StepHead>
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
        <BackButton go={go} to={{ id: 'storage' }} />
        <Action label="Connect" kind="primary" size="lg" busy="Checking the connection…" run={connect} />
      </div>
    </div>
  );
}
