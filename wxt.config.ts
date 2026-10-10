import { defineConfig } from 'wxt';

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
    optional_host_permissions: ['https://*/*', 'http://127.0.0.1/*', 'http://localhost/*'],
    action: { default_title: 'Bookmark Sync' },
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'bookmark-sync@example.com', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } }, gecko_android: { strict_min_version: '142.0' } } }
      : { minimum_chrome_version: '134' }),
  }),
});
