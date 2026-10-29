import { APP_NAME, HOMEPAGE_URL, PRIVACY_URL, SUPPORT_EMAIL } from '../../../../config.js';
import { ExternalLink } from './ExternalLink.js';
import { Setting } from './Setting.js';

export function About() {
  const rows = [
    HOMEPAGE_URL && (
      <Setting key="web" title="Website" hint={`News, help, and how ${APP_NAME} works.`}>
        <ExternalLink href={HOMEPAGE_URL} label="Open" />
      </Setting>
    ),
    PRIVACY_URL && (
      <Setting key="privacy" title="Privacy policy" hint="What happens to your data.">
        <ExternalLink href={PRIVACY_URL} label="Read" />
      </Setting>
    ),
    SUPPORT_EMAIL && (
      <Setting key="support" title="Support" hint={SUPPORT_EMAIL}>
        <ExternalLink href={`mailto:${SUPPORT_EMAIL}`} label="Email" />
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
