# bookmark-sync

A browser extension that syncs bookmarks between Chromium browsers (Chrome, Edge, Brave, Vivaldi) and Firefox through storage you choose: any WebDAV server (Nextcloud, ownCloud, Synology, Koofr, rclone and more) or Google Drive. It records every bookmark change as it happens and merges changes from different browsers with fixed, tested rules, instead of comparing whole bookmark trees.

- [SPEC.md](SPEC.md): what the extension does, the decisions behind it, and the acceptance checklist.
- [IMPLEMENTATION.md](IMPLEMENTATION.md): how it is built, module by module.

## Status

Every milestone in the implementation plan is built: the merge engine, joins, folder mappings, history and restore, the large change guard, native sync detection, compaction, profile copy detection, encryption and switching it on or off, the duplicate finder, WebDAV and Google Drive, and the options page and popup.

What has been checked:

- 113 unit, property and scenario tests, including randomized runs with up to 5 simulated browsers, provider faults and clock skew, a check against a plain tree model, and scenarios for crashes, lost responses, copied profiles, departed devices and renumbered bookmarks.
- The WebDAV provider against a real WebDAV server, and the Google Drive provider against a fake of the Drive API.
- 2 end-to-end tests that load the built extension into two real Chromium profiles syncing through a local WebDAV server.
- The Firefox package passes `web-ext lint` with no warnings.

An independent code review of the finished branch found 12 bugs (lost or duplicated bookmarks in rare races, a deadlock in the encryption switch, keys written to disk, and others), and a second review of those fixes found 10 more problems in them. All are fixed, each with a test where it could be simulated.

Not checked yet: Firefox, Edge, Brave and Vivaldi at runtime, a real Google account, and a real Nextcloud server. See "Known limits" below.

## Building

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm build:firefox
```

The Chromium package lands in `.output/chrome-mv3` and the Firefox package in `.output/firefox-mv3`. `pnpm zip` makes zip files of both.

## Loading the extension

**Chrome, Edge, Brave, Vivaldi:** open the extensions page (`chrome://extensions`), turn on Developer mode, choose "Load unpacked" and pick `.output/chrome-mv3`.

**Firefox (140 or later):** open `about:debugging`, choose "This Firefox", then "Load Temporary Add-on", and pick `.output/firefox-mv3/manifest.json`. Temporary add-ons are removed when Firefox closes; for a permanent install the package has to be signed through addons.mozilla.org.

## Using it

1. Open the extension's settings (the popup has an "Open settings" button).
2. Add a storage account. For Nextcloud the WebDAV URL looks like `https://cloud.example.com/remote.php/dav/files/USERNAME/bookmark-sync/`; use an app password. For any rclone remote, run `rclone serve webdav REMOTE:bookmark-sync --addr 127.0.0.1:8080 --user me --pass secret` and use `http://127.0.0.1:8080/`.
3. In the first browser, create a group: the whole bookmark tree, or one folder. Encryption is optional.
4. In every other browser, add the same account, choose "Join an existing group", preview, and join. Merge keeps both sides' bookmarks; replace takes the group's.

Turn off the browser's own bookmark sync in any browser that has the extension and shares a sync account with another browser that also has it. Using native sync as a backup for a single browser is fine.

## Google Drive setup

Google sign-in needs OAuth clients from your own Google Cloud project:

1. Create a project, enable the Google Drive API, and configure the OAuth consent screen with the `drive.appdata` scope. Move it to production status so sign-ins do not expire after 7 days.
2. For Chromium browsers, create a "Web application" client with the redirect URI `https://EXTENSION_ID.chromiumapp.org/`. The extension ID is shown on the extensions page and stays the same as long as you load the package from the same folder.
3. For Firefox, create a "Desktop app" client. Firefox signs in through `http://127.0.0.1/mozoauth2/...`.
4. Put the IDs in a `.env` file at the project root before building:

```
WXT_GOOGLE_CLIENT_ID_CHROMIUM=...
WXT_GOOGLE_CLIENT_SECRET_CHROMIUM=...
WXT_GOOGLE_CLIENT_ID_FIREFOX=...
WXT_GOOGLE_CLIENT_SECRET_FIREFOX=...
```

Google treats secrets of these client types as public, so shipping them in the package is expected. In Brave, turn on "Allow Google login for extensions" in `brave://settings/extensions`.

## Tests

```bash
pnpm check
```

```bash
pnpm test:e2e
```

`pnpm check` runs the type checker and every unit, property and scenario test. The randomized tests pick new random cases on every run; when one fails, fast-check shrinks it to a minimal case first, which can take a few minutes. `pnpm test:e2e` builds a test copy of the extension and drives two headless Chromium profiles with Playwright; run `npx playwright install chromium` once before.

## Layout

- `src/core/`: pure logic: clock, IDs, positions, replay, visibility, trees, reconcile, restore, join planning, frontier, duplicate finding, default bookmarks, file format and encryption.
- `src/engine/`: the per-group sync engine (`group.ts`) and the app layer (`app.ts`) that runs every command through one queue. Both reach the browser, storage and local database only through the interfaces in `ports.ts`.
- `src/storage/`: the WebDAV, Google Drive and in-memory providers.
- `src/browser/`: the real bookmarks API, root folders, IndexedDB, Google sign-in.
- `src/entrypoints/`: the background script, options page and popup.
- `test/`: the simulator, property tests, scenarios, provider integration tests and end-to-end tests.

## Known limits

- Firefox, Edge, Brave and Vivaldi have only been built and linted, not run. Vivaldi's Trash is recognized by its title, which is a guess.
- Google sign-in has not been tried against a real Google account. Whether Google accepts Firefox's loopback redirect without a port is unconfirmed; if it does not, Firefox needs a small redirect page on a domain you control.
- The Firefox add-on ID is `bookmark-sync@example.com`; change it in `wxt.config.ts` before publishing.
- If a Chromium browser renumbers all its bookmarks, the IDs of mapped folders change too, and the group pauses because its folder is missing; leave the group and join it again in merge mode.
- Deleted items are never dropped from snapshots, costing about 200 bytes each.
- Restores cannot reach back past an encryption switch.
