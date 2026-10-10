import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

/** Public half of the key that fixes the Chromium extension ID (nmoonfocibpibidcccliemgjddogdcmc), so the Google sign-in redirect stays the same wherever the folder is loaded from. */
const CHROMIUM_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAngEaGEsnr/KsUwppxrkjN98Eh0HwlEzEDYoHrtx3sGAhoIYcyv87pwKFRFFFlMLZ4AR3vIzdrAnxtHEex0VyZ6r+dvp1h1hj4Xj0c/WSpT5BVYNY4FLFOu7ZU6k35LJCeRCyUW68ouZP1tkNkHS39YBS+ZhrehUb7bJ9JH6Xnv2eqLXixTNWB9iqCtZVy4fcpu7RnQdR+0qCAg6zASwTNjAMIoTryCTNHphyIljPIqWudAW/38BLfP2NGXfnToZ/G8qpxx1NKceowpXSdaNX0M1kwlGNtbU9e+3Vq0XwGzH1E25KOpVESXlSBVPzM6eWxzr2iBriiAWSvIi6EYlvAQIDAQAB';

function envValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  for (const file of ['.env.production.local', '.env.production', '.env.local', '.env']) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') || undefined;
  }
  return undefined;
}

if (process.env.BSYNC_RELEASE) {
  const missing = ['WXT_GOOGLE_CLIENT_ID_CHROMIUM', 'WXT_GOOGLE_CLIENT_SECRET_CHROMIUM', 'WXT_GOOGLE_CLIENT_ID_FIREFOX', 'WXT_GOOGLE_CLIENT_SECRET_FIREFOX'].filter((n) => !envValue(n));
  if (missing.length) throw new Error(`A release build needs the Google client settings. Missing: ${missing.join(', ')}. See docs/google-setup.md.`);
}

export default defineConfig({
  srcDir: 'src',
  outDir: process.env.BSYNC_E2E ? '.output-e2e' : '.output',
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: ['bookmarks', 'storage', 'unlimitedStorage', 'alarms', 'notifications', 'identity'],
    host_permissions: [
      'https://www.googleapis.com/*',
      'https://oauth2.googleapis.com/*',
      ...(process.env.BSYNC_E2E ? ['http://127.0.0.1/*'] : []),
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: 'Bookmark Sync' },
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'bookmark-sync@example.com', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } }, gecko_android: { strict_min_version: '142.0' } } }
      : { minimum_chrome_version: '134', key: CHROMIUM_KEY }),
  }),
});
