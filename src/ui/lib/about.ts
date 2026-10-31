import { browser } from 'wxt/browser';
import { APP_NAME, HOMEPAGE_URL, PRIVACY_URL, SOURCE_URL, SUPPORT_EMAIL } from '../../config.js';

export interface AboutLink {
  key: string;
  title: string;
  hint: string;
  href: string;
  label: string;
}

const issuesUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(SOURCE_URL) ? `${SOURCE_URL.replace(/\/$/, '')}/issues/new` : '';

export const ABOUT_LINKS: AboutLink[] = [
  { key: 'web', title: 'Website', hint: `News, help, and how ${APP_NAME} works.`, href: HOMEPAGE_URL, label: 'Open' },
  { key: 'privacy', title: 'Privacy policy', hint: 'What happens to your data.', href: PRIVACY_URL, label: 'Read' },
  { key: 'source', title: 'Source code', hint: 'The code is public. Read it or suggest a change.', href: SOURCE_URL, label: 'Open' },
  { key: 'issue', title: 'Report a problem', hint: 'Opens a new issue on GitHub. A diagnostics file from Settings helps.', href: issuesUrl, label: 'Open' },
  { key: 'support', title: 'Support', hint: SUPPORT_EMAIL, href: SUPPORT_EMAIL && `mailto:${SUPPORT_EMAIL}`, label: 'Email' },
].filter((l) => l.href);

export function manifestInfo(): { version: string; description: string } {
  const m = browser.runtime.getManifest();
  return { version: m.version, description: m.description ?? '' };
}
