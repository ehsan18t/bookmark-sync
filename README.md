# bookmark-sync

A browser extension that syncs bookmarks between Chromium browsers (Chrome, Edge, Brave, Vivaldi) and Firefox through storage you choose: any WebDAV server (Nextcloud, ownCloud, Synology, Koofr, rclone and more) or Google Drive. It records every bookmark change as it happens and merges changes from different browsers with fixed, tested rules, instead of comparing whole bookmark trees.

- [SPEC.md](SPEC.md): what the extension does, the decisions behind it, and the acceptance checklist.
- [IMPLEMENTATION.md](IMPLEMENTATION.md): how it is built, module by module.

## Status

Every milestone in the implementation plan is built: the merge engine, joins, folder mappings, history and restore, the large change guard, native sync detection, compaction, profile copy detection, encryption and switching it on or off, the duplicate finder, WebDAV and Google Drive, a guided setup, a dashboard, and the popup.

What has been checked:

- 122 unit, property and scenario tests, including randomized runs with up to 5 simulated browsers and browsers that hold only some folders, provider faults and clock skew, a check against a plain tree model, and scenarios for crashes, lost responses, copied profiles, departed devices and renumbered bookmarks.
- The WebDAV provider against a real WebDAV server, and the Google Drive provider against a fake of the Drive API.
- 3 end-to-end tests that load the built extension into two real Chromium profiles syncing through a local WebDAV server. One of them clicks through the setup pages in both profiles: a wrong password, then starting a sync in one and joining it from the other.
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

Installing the extension opens its setup page. It goes one step at a time:

1. **Choose storage.** Google Drive (when the build includes the Google clients, see below), or your own server. For Nextcloud the server address looks like `https://cloud.example.com/remote.php/dav/files/USERNAME/`; use an app password. For any rclone remote, run `rclone serve webdav REMOTE: --addr 127.0.0.1:8080 --user me --pass secret` and use `http://127.0.0.1:8080/`. The bookmarks go in a folder on the server (`WXT_SERVER_FOLDER` in `.env`), which users can change under Advanced.
2. **Connect.** The extension checks the sign-in before going on.
3. **Start or join.** If the storage already holds a sync from another browser, the page suggests joining it. Otherwise this browser starts one.
4. **Choose what to sync.** All bookmarks, or any folders ticked in a folder tree, when starting. When joining, tick which folders of the sync this browser holds and where each one goes, then pick Combine (keeps this browser's bookmarks and adds the synced ones) or Replace (takes the synced ones, and can be undone), with a live preview of what changes. Encryption is under Advanced.

After setup, the settings page is a dashboard with Overview, History, Browsers, Duplicates and Settings tabs, and the popup shows each sync's state.

Turn off the browser's own bookmark sync in any browser that has the extension and shares a sync account with another browser that also has it. Using native sync as a backup for a single browser is fine.

## Google Drive setup

Google Drive sign-in needs two OAuth clients from a Google Cloud project, registered once by whoever publishes the extension. [docs/google-setup.md](docs/google-setup.md) walks through it step by step. In short: put the client IDs in `.env` and the secrets in `.env.local` before building. Builds without them hide Google Drive, and `pnpm zip` refuses to build release packages without them.

The Chromium extension ID is fixed by `WXT_CHROMIUM_KEY`, so the Google redirect URI stays the same wherever the package is loaded from. `pnpm extension-id` prints the ID and redirect URI, and `pnpm make-key` makes a new key.

## Website

`site/` holds the homepage and privacy policy that Google's consent screen and the stores need. `pnpm site` builds them from `.env` into `.output/site`, and a GitHub Actions workflow publishes them to GitHub Pages. [docs/website.md](docs/website.md) covers publishing, using a subdomain of your own domain, and verifying it for Google.

## Go-live settings

Every value to change before going live is in `.env`, and nothing else needs editing: the name and description, the homepage, privacy policy and support email (shown in Settings when set), the website's store and source links, the Firefox add-on ID, the Chromium key, the default server folder, and the Google client IDs. The Google client secrets go in `.env.local`, which git ignores (see `.env.local.example`). `pnpm zip` refuses to build release packages while the Google clients, homepage or privacy policy are missing, or while the Firefox ID is still the `example.com` placeholder.

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
- The Firefox add-on ID is still the `bookmark-sync@example.com` placeholder; set `WXT_GECKO_ID` in `.env` before publishing.
- If a Chromium browser renumbers all its bookmarks, the IDs of mapped folders change too, and the group pauses because its folder is missing; leave the group and join it again in merge mode.
- Deleted items are never dropped from snapshots, costing about 200 bytes each.
- Restores cannot reach back past an encryption switch.
