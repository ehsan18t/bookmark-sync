import { useSignal } from '@preact/signals';
import { APP_NAME } from '../../../../config.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { ABOUT_LINKS, manifestInfo } from '../../../../ui/lib/about.js';
import { caps } from '../../../../ui/state/store.js';
import { ExternalLink } from '../settings/ExternalLink.js';
import { Setting } from '../settings/Setting.js';

const CREDITS = [
  { name: 'Preact', license: 'MIT', href: 'https://preactjs.com/' },
  { name: 'Preact Signals', license: 'MIT', href: 'https://github.com/preactjs/signals' },
  { name: 'Tabler Icons', license: 'MIT', href: 'https://tabler.io/icons' },
  { name: 'fractional-indexing', license: 'CC0', href: 'https://github.com/rocicorp/fractional-indexing' },
];

export function AboutTab() {
  const { version, description } = manifestInfo();
  const copied = useSignal(false);
  const details = `${APP_NAME} ${version}\nBrowser: ${caps.value.browser}\n${navigator.userAgent}`;
  const copy = async () => {
    await navigator.clipboard.writeText(details);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  };
  return (
    <>
      <div class="about-hero">
        <div class="about-logo">
          <Icon name="bookmarks" />
        </div>
        <div>
          <h2>
            {APP_NAME} <span class="pill">Version {version}</span>
          </h2>
          {description && <p class="muted">{description}</p>}
        </div>
      </div>

      <div class="stack">
        <h3>How it works</h3>
        <div class="card prose">
          <p>
            Each browser keeps a record of the changes you make to your bookmarks and saves it to your storage. The other browsers read those changes and apply them, so every browser ends up with the
            same bookmarks.
          </p>
          <p>
            When two browsers change the same bookmark, the latest change wins. Nothing is lost for good. History keeps every change for the number of days set in Settings, and you can go back to any
            point.
          </p>
          <p>A large change, such as removing many bookmarks at once, waits for you to confirm it before it reaches your other browsers.</p>
        </div>
      </div>

      <div class="stack">
        <h3>Your privacy</h3>
        <div class="card prose">
          <p>Your bookmarks are stored only in the Google Drive or WebDAV server you chose. There is no account to create and no server of ours in between.</p>
          <p>The extension collects no analytics and sends nothing anywhere else.</p>
          <p>With encryption turned on, your bookmarks are encrypted in this browser before they are uploaded, with a passphrase only you know.</p>
        </div>
      </div>

      {ABOUT_LINKS.length > 0 && (
        <div class="stack">
          <h3>Links</h3>
          <div class="card flush">
            {ABOUT_LINKS.map((l) => (
              <Setting key={l.key} title={l.title} hint={l.hint}>
                <ExternalLink href={l.href} label={l.label} />
              </Setting>
            ))}
          </div>
        </div>
      )}

      <div class="stack">
        <h3>This browser</h3>
        <div class="card flush">
          <Setting title={`${caps.value.browser} · ${APP_NAME} ${version}`} hint="Include these details when you report a problem.">
            <button type="button" onClick={copy}>
              <Icon name={copied.value ? 'check' : 'copy'} />
              {copied.value ? 'Copied' : 'Copy details'}
            </button>
          </Setting>
        </div>
      </div>

      <div class="stack">
        <h3>Credits</h3>
        <div class="card prose">
          <p>
            {APP_NAME} is built with these open-source projects:{' '}
            {CREDITS.map((c, i) => (
              <span key={c.name}>
                <a href={c.href} target="_blank" rel="noopener">
                  {c.name}
                </a>{' '}
                ({c.license}){i < CREDITS.length - 1 ? ', ' : '.'}
              </span>
            ))}
          </p>
        </div>
      </div>
    </>
  );
}
