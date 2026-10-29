import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

/** WXT loads .env and .env.local into process.env before it builds the manifest. */
function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function checkEnv(browser: string) {
  const missing = ['WXT_APP_NAME', 'WXT_APP_DESCRIPTION', 'WXT_GECKO_ID', 'WXT_CHROMIUM_KEY', 'WXT_SERVER_FOLDER'].filter((n) => !env(n));
  if (missing.length) throw new Error(`.env is missing ${missing.join(', ')}.`);
  const engine = browser === 'firefox' ? 'FIREFOX' : 'CHROMIUM';
  if (env(`WXT_GOOGLE_CLIENT_ID_${engine}`) && !env(`WXT_GOOGLE_CLIENT_SECRET_${engine}`)) {
    throw new Error(`.env sets WXT_GOOGLE_CLIENT_ID_${engine} but not WXT_GOOGLE_CLIENT_SECRET_${engine}. Google rejects sign-in without it. See docs/google-setup.md.`);
  }
  if (!process.env.BSYNC_RELEASE) return;
  const release = [
    'WXT_GOOGLE_CLIENT_ID_CHROMIUM',
    'WXT_GOOGLE_CLIENT_SECRET_CHROMIUM',
    'WXT_GOOGLE_CLIENT_ID_FIREFOX',
    'WXT_GOOGLE_CLIENT_SECRET_FIREFOX',
    'WXT_HOMEPAGE_URL',
    'WXT_PRIVACY_URL',
  ].filter((n) => !env(n));
  if (env('WXT_GECKO_ID').endsWith('@example.com')) release.push('WXT_GECKO_ID (still the example.com placeholder)');
  if (release.length) throw new Error(`A release build needs these set in .env or .env.local: ${release.join(', ')}. See docs/google-setup.md.`);
}

export default defineConfig({
  srcDir: 'src',
  vite: () => ({ plugins: [preact()] }),
  outDir: process.env.BSYNC_E2E ? '.output-e2e' : '.output',
  manifestVersion: 3,
  manifest: ({ browser }) => {
    checkEnv(browser);
    return {
      name: env('WXT_APP_NAME'),
      description: env('WXT_APP_DESCRIPTION'),
      default_locale: 'en',
      ...(env('WXT_HOMEPAGE_URL') ? { homepage_url: env('WXT_HOMEPAGE_URL') } : {}),
      permissions: ['bookmarks', 'storage', 'unlimitedStorage', 'alarms', 'notifications', 'identity'],
      host_permissions: [
        'https://www.googleapis.com/*',
        'https://oauth2.googleapis.com/*',
        ...(process.env.BSYNC_E2E ? ['http://127.0.0.1/*'] : []),
      ],
      optional_host_permissions: ['https://*/*', 'http://*/*'],
      action: { default_title: env('WXT_APP_NAME') },
      ...(browser === 'firefox'
        ? { browser_specific_settings: { gecko: { id: env('WXT_GECKO_ID'), strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } }, gecko_android: { strict_min_version: '142.0' } } }
        : { minimum_chrome_version: '134', key: env('WXT_CHROMIUM_KEY') }),
    };
  },
});
