import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { googleAvailable, identityAvailable, signInWithGoogle } from '../browser/auth.js';
import { BrowserBookmarks, type Engine, type Node } from '../browser/bookmarksPort.js';
import { friendlyError } from '../browser/friendlyError.js';
import { IdbStore } from '../browser/idbStore.js';
import { providerFactory } from '../browser/providers.js';
import { browserRoots } from '../browser/roots.js';
import { APP_NAME } from '../config.js';
import type { BrowserFamily } from '../core/defaults.js';
import { BridgeTakenError } from '../core/errors.js';
import { SyncApp } from '../engine/app.js';
import type { GroupStatus } from '../engine/group.js';
import { type Capabilities, type Command, type PublicAccount, type Reply, SNAPSHOT_KEY, type Snapshot } from '../messages.js';

function detect(): { engine: Engine; family: BrowserFamily; name: string } {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return { engine: 'firefox', family: 'firefox', name: 'Firefox' };
  if (/Edg\//.test(ua)) return { engine: 'chromium', family: 'edge', name: 'Edge' };
  if (/OPR\//.test(ua)) return { engine: 'chromium', family: 'opera', name: 'Opera' };
  if (/Vivaldi/.test(ua)) return { engine: 'chromium', family: 'vivaldi', name: 'Vivaldi' };
  if ((navigator as { brave?: unknown }).brave) return { engine: 'chromium', family: 'brave', name: 'Brave' };
  return { engine: 'chromium', family: 'chrome', name: 'Chrome' };
}

function platformName(): string {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'desktop';
}

const REASONS: Record<string, string> = {
  'large-remote-change': 'Another browser made a large change. Review it before it is applied here.',
  'large-local-change': 'You changed many bookmarks at once. Confirm before it is uploaded.',
  'native-sync': 'Two browsers seem to be linked by the browser’s own bookmark sync.',
  locked: 'Enter the passphrase to keep syncing this encrypted group.',
  'clock-skew': 'This computer’s clock is off. Fix the clock to keep syncing.',
  auth: 'The storage account needs you to sign in again.',
  permission: 'The extension lost access to the storage server.',
  'mapped-folder-missing': 'The synced folder was deleted or moved.',
  'root-changed': 'The browser’s bookmark folders changed.',
  'mapping-overlap': 'Two synced folders now overlap.',
  'bridge-moved': 'Another browser now links this sync with one that shares its folders here.',
  'group-deleted': 'This group was deleted from another browser.',
  'format-too-new': 'A newer version of the extension wrote these files. Update the extension.',
  corrupt: 'A file in the group could not be read.',
  migration: 'Encryption is being switched for this group.',
  'needs-join': 'This browser needs to join the group again.',
  'nothing-held': 'This browser no longer syncs any folder of this group.',
};

export default defineBackground({
  type: 'module',
  main() {
    const env = detect();
    const vivaldiTrash = (n: Node) => env.family === 'vivaldi' && n.url === undefined && n.title === 'Trash';
    const bookmarks = new BrowserBookmarks(env.engine, vivaldiTrash);
    const app = new SyncApp({
      store: new IdbStore(),
      bookmarks,
      roots: browserRoots(env.engine),
      providerFor: providerFactory(env.engine),
      clock: { now: () => Date.now() },
      browser: env.family,
      defaultDeviceName: `${env.name} on ${platformName()}`,
      notify: (groupId, status) => logged(onStatus(groupId, status)),
      describeError: friendlyError,
    });
    const ready = app.init().then(() => ensureAlarm());

    function logged(work: Promise<unknown>) {
      work.catch((e: unknown) => console.error(e));
    }

    async function ensureAlarm() {
      const minutes = app.settings().pullMinutes;
      const existing = await browser.alarms.get('pull');
      if (!existing || existing.periodInMinutes !== minutes) await browser.alarms.create('pull', { periodInMinutes: minutes });
    }

    const caps = (): Capabilities => ({ google: googleAvailable(env.engine) && identityAvailable(), googleBlocked: googleAvailable(env.engine) && !identityAvailable(), browser: env.name });

    /** Saves what the pages show, so they draw it at once instead of waiting behind a sync. */
    let last: Snapshot | null = null;
    let lastJson = '';
    let publishing: Promise<Snapshot | null> = Promise.resolve(null);
    let pending = false;
    /** One pass waits at most; requests made before it starts share it. */
    const publish = (): Promise<Snapshot | null> => {
      if (pending) return publishing;
      pending = true;
      publishing = publishing.then(() => {
        pending = false;
        return writeSnapshot();
      });
      return publishing;
    };
    logged(ready.then(publish));
    async function writeSnapshot(): Promise<Snapshot | null> {
      try {
        const groups = await app.status();
        const devices: Snapshot['devices'] = {};
        for (const g of groups) {
          // The group can be left or migrated between the two queue slots.
          const list = await app.devices(g.groupId).catch(() => null);
          if (list) devices[g.groupId] = list;
        }
        const body = { groups, accounts: app.accounts() as PublicAccount[], folders: await app.folders(), caps: caps(), devices };
        const attention = groups.some((g) => g.status.state === 'paused' && g.status.reason !== 'migration');
        await browser.action.setBadgeText({ text: attention ? '!' : '' });
        await browser.action.setBadgeBackgroundColor({ color: '#c2410c' });
        const json = JSON.stringify(body);
        if (last && json === lastJson) return last;
        // Continue from the saved stamp: a restarted worker under a clock set back would go below what pages show.
        const prevAt = last?.at ?? ((await browser.storage.local.get(SNAPSHOT_KEY))[SNAPSHOT_KEY] as Snapshot | undefined)?.at ?? 0;
        const next: Snapshot = { ...body, at: Math.max(Date.now(), prevAt + 1) };
        await browser.storage.local.set({ [SNAPSHOT_KEY]: next });
        last = next;
        lastJson = json;
        return next;
      } catch (e) {
        console.error('Saving the status snapshot failed', e);
        return null;
      }
    }

    async function onStatus(groupId: string, status: GroupStatus) {
      await publish();
      if (status.state !== 'paused' || status.reason === 'migration') return;
      const name = (await app.status()).find((g) => g.groupId === groupId)?.name ?? APP_NAME;
      await browser.notifications.create(`bsync:${groupId}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: `${name} is paused`,
        message: REASONS[status.reason] ?? status.reason,
      });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSync = () => {
      clearTimeout(timer);
      timer = setTimeout(() => logged(ready.then(() => app.syncAll()).then(publish)), 3000);
    };

    browser.bookmarks.onCreated.addListener(scheduleSync);
    browser.bookmarks.onRemoved.addListener(scheduleSync);
    browser.bookmarks.onChanged.addListener(scheduleSync);
    browser.bookmarks.onMoved.addListener(scheduleSync);
    const extra = browser.bookmarks as unknown as Record<string, { addListener(f: () => void): void } | undefined>;
    extra.onChildrenReordered?.addListener(scheduleSync);
    extra.onImportBegan?.addListener(() => app.setImporting(true));
    extra.onImportEnded?.addListener(() => {
      app.setImporting(false);
      void publish();
    });

    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'pull') logged(ready.then(() => app.syncAll()).then(publish));
    });

    browser.windows.onFocusChanged.addListener(async (windowId) => {
      if (windowId === browser.windows.WINDOW_ID_NONE) return;
      const { lastFocusSync = 0 } = (await browser.storage.session.get('lastFocusSync')) as { lastFocusSync?: number };
      if (Date.now() - lastFocusSync < 10_000) return;
      await browser.storage.session.set({ lastFocusSync: Date.now() });
      logged(ready.then(() => app.syncAll()).then(publish));
    });

    browser.runtime.onInstalled.addListener(({ reason }) => {
      if (reason === 'install') void browser.tabs.create({ url: browser.runtime.getURL('/options.html#setup') });
    });

    browser.runtime.onStartup.addListener(() => logged(ready.then(() => app.syncAll()).then(publish)));
    browser.notifications.onClicked.addListener((id) => {
      if (id.startsWith('bsync:')) void browser.runtime.openOptionsPage();
    });

    async function handle(cmd: Command): Promise<unknown> {
      await ready;
      switch (cmd.t) {
        case 'snapshot': {
          const snapshot = await publish();
          if (!snapshot) throw new Error('The extension couldn’t read its status. Try again.');
          return snapshot;
        }
        case 'status':
          return app.status();
        case 'capabilities':
          return caps();
        case 'accounts':
          return app.accounts();
        case 'addAccount':
          return app.addAccount(cmd.account);
        case 'addGoogle': {
          const tokens = await signInWithGoogle(env.engine);
          return app.addAccount({ type: 'gdrive', name: cmd.name, ...tokens });
        }
        case 'removeAccount':
          return app.removeAccount(cmd.id);
        case 'discover':
          return app.discoverGroups(cmd.accountId);
        case 'folders':
          return app.folders();
        case 'create':
          return app.createGroup(cmd.input);
        case 'previewJoin':
          return app.previewJoin(cmd.input);
        case 'join':
          return app.joinGroup(cmd.input);
        case 'leave':
          return app.leaveGroup(cmd.groupId);
        case 'undoJoin':
          return app.undoJoin(cmd.groupId);
        case 'deleteEverywhere':
          return app.deleteEverywhere(cmd.groupId);
        case 'rename':
          return app.renameGroup(cmd.groupId, cmd.name);
        case 'devices':
          return app.devices(cmd.groupId);
        case 'removeDevice':
          return app.removeDevice(cmd.groupId, cmd.deviceId);
        case 'groupFolders':
          return app.groupFolders(cmd);
        case 'addParts':
          return app.addParts(cmd.groupId, cmd.parts, cmd.takeover);
        case 'addTops':
          return app.addTops(cmd.groupId, cmd.folderIds, cmd.takeover);
        case 'removePart':
          return app.removePart(cmd.groupId, cmd.part, cmd.everywhere);
        case 'movePart':
          return app.movePart(cmd.groupId, cmd.part, cmd.folderId, cmd.takeover);
        case 'dismissNotices':
          return app.dismissNotices(cmd.groupId);
        case 'timeline':
          return app.timeline(cmd.groupId);
        case 'previewRestore':
          return app.previewRestore(cmd.groupId, cmd.hlc);
        case 'restore':
          return app.restore(cmd.groupId, cmd.hlc);
        case 'resolve':
          return app.resolvePause(cmd.groupId, cmd.choice);
        case 'unlock':
          return app.unlock(cmd.groupId, cmd.passphrase, cmd.remember);
        case 'setEncryption':
          return app.setEncryption(cmd.groupId, cmd.passphrase);
        case 'continueMigration':
          return app.continueMigrationWithout(cmd.groupId, cmd.deviceIds);
        case 'syncNow':
          return app.syncAll();
        case 'syncGroup':
          return app.syncGroup(cmd.groupId);
        case 'settings':
          return app.settings();
        case 'updateSettings':
          await app.updateSettings(cmd.patch);
          return ensureAlarm();
        case 'scanDuplicates':
          return app.scanDuplicates();
        case 'applyDedupe':
          return app.applyDedupe(cmd.action);
        case 'localUndo':
          return app.localUndo();
        case 'undoLocal':
          return app.undoLocal(cmd.id);
        case 'diagnostics':
          return app.diagnostics();
      }
    }

    browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (r: Reply) => void) => {
      handle(msg as Command)
        .then((value) => sendResponse({ ok: true, value }))
        .catch((e: unknown) => sendResponse({ ok: false, error: friendlyError(e), ...(e instanceof BridgeTakenError ? { code: e.code } : {}) }))
        .finally(() => (msg as Command).t !== 'snapshot' && void publish());
      return true;
    });
  },
});
