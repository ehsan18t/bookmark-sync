# Cross-browser bookmark sync: design spec (draft 3)

A browser extension for desktop Chromium browsers and Firefox that syncs bookmarks through a cloud storage provider the user picks. It records every change as it happens (like a database write-ahead log) instead of comparing snapshots, so concurrent changes on different browsers merge predictably.

Status: personal project first, public open source release later. Date: 2026-10-10. Implementation details live in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Goals

- Keep bookmarks consistent across different browsers (for example Chrome and Firefox on the same machine), which native browser sync cannot do.
- Merge concurrent offline changes without losing data or producing inconsistent state.
- Let the user choose the storage provider and which folders sync.
- Make every sync action reversible within a history window.

## Non-goals (v1)

- Passwords. Users keep using Bitwarden, KeePassXC or similar.
- Mobile browsers (Firefox for Android may come later) and Safari.
- Firefox-only bookmark data (tags, keywords) and favicons.
- Running two extension installs that are also linked by native sync (detected, repaired and paused, not supported).

## Glossary

- **Account**: a configured storage provider login (a WebDAV server or a Google account). Several groups can use one account.
- **Group**: one synced bookmark collection stored in one place at the provider. A browser can belong to several groups, each mapped to a different local folder.
- **Device**: one browser profile with the extension installed, identified by a device ID. A copied or restored profile is detected when its uploads diverge from the original's, and the copies then get new device IDs.
- **Mapping**: which local bookmark folder on a device holds a group's contents. Different devices can map the same group to different folders.
- **Group mode**: `everything` (the group holds the whole bookmark tree, using the root folder mapping) or `folder` (the group holds the contents of one folder).
- **Excluded items**: bookmarks or folders inside a mapped folder that never sync, such as ignored browser default bookmarks and the helper folder that holds the Bookmarks Menu on Chromium.
- **Stable ID**: the extension's own ID for a bookmark or folder, shared across all devices. Browser-local IDs are mapped to it per device. Group roots have fixed, well-known stable IDs.
- **Change**: one recorded edit of one item, with an HLC timestamp. Types: create, update, move, delete, undelete.
- **Batch**: a numbered file of changes uploaded by one device. Batch numbers per device are contiguous and never reused, and each batch records a hash of the previous one.
- **Change log**: all batches of all devices in a group.
- **HLC**: hybrid logical clock. Orders changes across devices. Devices whose clock is far off from the provider's clock pause instead of writing.
- **Mirror**: the extension's local copy of the last known state of each mapped folder, used to detect changes and to compute "before" states.
- **Snapshot**: a compacted copy of a group's merged state, including deleted items and per-field timestamps, covering a known range of every device's batches.
- **Stable frontier**: the point in the log before which every device has already published all of its changes, so no new change can ever land behind it. Only changes behind it can be compacted.
- **History window**: how far back the user can restore. Default 7 days, configurable, can be turned off.
- **Restore**: returning a group, or a chosen set of items, to an earlier state, done by recording new changes.
- **Join**: the first sync of a device into an existing group.
- **Browser default bookmarks**: the bookmarks a browser ships with (for example Firefox's "Mozilla Firefox" folder), kept in a list that ships with the extension.
- **Storage provider**: a backend that can list, read, write and delete files (WebDAV, Google Drive, and others later).
- **Paused**: a group on one device that neither pushes nor pulls until the user resolves the reason shown.
- **Locked**: an encrypted group whose passphrase has not been entered in this browser session.

## Decisions

1. **Scope is bookmarks only.** Passwords are out of scope.
2. **Platforms:** desktop Chromium browsers (Chrome, Edge, Brave, Vivaldi, version 134 or later) and desktop Firefox (140 or later, the current ESR), from one codebase with one package per browser family.
3. **Sync model is a change log, not snapshot comparison.** Bookmark changes are recorded as changes. Snapshots are only checkpoints of the log.
4. **Each device writes only to its own folder at the provider**, including its own snapshots. The only shared file is the group header, written once by the group's creator. The one exception: files of a device that left the group or was removed may be deleted by any device, once a snapshot covers them.
5. **Encryption is optional, off by default, and fixed for the lifetime of a group.** Turning it on or off migrates everyone to a new group with the new setting: the old group is frozen first, then the new group starts from its complete final state. Nobody rewrites another device's files.
6. **Data formats carry a version number from day one.** An unknown newer major version pauses the group with a clear message.
7. **Native sync stays allowed.** Two extension installs linked by native sync are detected; duplicates are repaired, and the device shows a warning and pauses.
8. **History:** the history window defaults to 7 days, is configurable, and can be turned off. Turned off, the timeline is hidden, but the extension still keeps 1 day of history so joins and large changes can be undone.
9. **Restoring adds new changes and never rewrites the log.** A restore syncs to every device like a normal edit and can itself be undone. Restores are computed from merged states, not from any one device's view.
10. **Log retention is separate from the history setting.** A change is compacted only when it is behind the stable frontier and older than the history window (at least 1 day).
11. **Guard against large changes.** If one sync cycle would delete, move or edit more than 20% of a group's existing items (minimum 10 items), the group pauses on that device and asks. Adding items never triggers it. The user can apply the change, or revert just the items it touched (which syncs to everyone). Changes the user already confirmed elsewhere (creating or joining a group, a restore, a duplicate cleanup, an approved large change) do not trigger the guard.
12. **Conflict rules:**
    - An item added to or moved into a folder by a change the folder's delete had not seen survives, and the folder comes back containing only such items.
    - A delete removes exactly what the deleting device saw inside the folder at that moment. Items that were moved into the folder later, even by a later move of a parent folder, are not affected by it.
    - An item moved out of a deleted folder by a change the delete had not seen survives at its new place.
    - A delete and a concurrent field update or move of the same item: the delete wins. The update stays in history.
    - Edits to the same field: the latest edit (by HLC) wins. Fields are independent, so a rename on one device and a URL change on another both apply.
    - Moves of the same item: the latest move wins. A move that would put a folder inside itself is skipped.
    - An undelete (from a restore) wins over a delete it has seen.
13. **Joining a group** offers two options. The browser's own bookmarks in the mapped folder are saved locally first, and the group gets a restore point:
    - Merge with the group (default). An item with the exact same URL in the same folder path is linked, not duplicated. Nothing is deleted.
    - Replace this browser's bookmarks (within the mapped folder) with the group's.
    - A checkbox, on by default, ignores the browser's default bookmarks. They stay in this browser as excluded items and never enter the group.
    - Two devices joining at the same time end up with one copy of each shared bookmark, not two.
    - Undoing a join removes what it added to the group, puts this browser's own bookmarks back, and leaves the group.
14. **Providers:** Google Drive and WebDAV in v1. WebDAV also covers Nextcloud, ownCloud, Synology, Koofr and any rclone remote via `rclone serve webdav`. Dropbox and OneDrive next, Mega last.
15. **Folder selection is in v1**, Floccus-style: each device maps each group to its whole tree or to one chosen folder. See "Folder mapping".
16. **Duplicate finder is in v1.** It uses cleaned-up URLs, is separate from sync identity, and every cleanup can be undone.
17. **A device with a badly wrong clock pauses.** If the device clock differs from the provider's clock by more than 2 minutes, the group pauses with a message to fix the clock.

## Behavior

### Storage at the provider

Logically, per group:

```
groups/<group-id>/
  group.json                                  # written once by the creator: name, format version, mode, encryption settings
  devices/<device-id>/device.json             # name, browser, last batch and its hash, lower bound of future changes, first retained batch
  devices/<device-id>/batches/<number>.json   # contiguous, never overwritten, each with the previous batch's hash
  devices/<device-id>/snapshots/<id>.json     # this device's snapshots
  devices/<device-id>/markers/...             # announcements by this device: migration, group deleted, devices removed
```

- WebDAV stores this as real folders. Google Drive stores it as flat files in the app's hidden data folder, with the logical location in short file metadata fields, because Drive allows duplicate names and has no real paths.
- A batch is written once, under its final number, with its exact bytes frozen before the first upload attempt. Retries are idempotent.

### Sync cycle

- **Capture:** every bookmark event marks the affected folders as changed. A single queue then compares those folders with the mirror and records the differences as changes. All capture, syncing, joins, restores and cleanups run through this one queue, one task at a time.
- **Push:** about 3 seconds after the last local change, the recorded changes become the next batch. If the browser closes within that time, the batch goes up on next start. Nothing is lost.
- **Pull:** on background start, every 5 minutes, and when a browser window gains focus (at most every 10 seconds). A device reads other devices' batches strictly in order and never skips a number. A batch that fails to download or parse is retried, never skipped. If a device has fallen behind what was already compacted, it loads the newest snapshot instead.
- **Catch-up:** on every background start, before the first pull, every mapped folder is compared with the mirror. This covers edits made while the extension was off, imports, sorts, and changes from native sync.
- **Own edits are not re-recorded:** changes the extension makes to the browser update the mirror first, so the events they cause match the mirror and record nothing. Anything else (for example the user editing at the same moment) is recorded as a real local change.

### Root folder mapping (`everything` mode)

| Group root (fixed ID) | Chromium | Firefox |
|---|---|---|
| `root:toolbar` | the bookmarks bar folder (Edge: Favorites bar) | Bookmarks Toolbar |
| `root:other` | the other bookmarks folder (Edge: Other favorites) | Other Bookmarks |
| `root:menu` | a folder "Bookmarks Menu" inside other bookmarks (excluded from `root:other`), tracked by ID not by name | Bookmarks Menu |
| (not synced) | mobile bookmarks, managed folders | Mobile Bookmarks |

- Chromium root folders are found by folder type, never by name. Since Chrome 134 a profile can have both an account copy and a local copy of a root. If both exist, the user picks which one to map during setup, and the extension remembers that folder.
- If a mapped root appears, disappears or changes, the group pauses on that device and asks.
- Vivaldi's bookmark Trash counts as outside the group, so moving something into it is a delete.
- When an `everything` group is mapped into one folder, its three roots appear there as subfolders named Toolbar, Other and Menu in the browser's language. Their names are local and do not sync.

### Folder mapping

- A group is created in `everything` mode or `folder` mode.
- A device maps an `everything` group either to its whole tree (using the root folder mapping) or into one chosen folder.
- A device maps a `folder` group to one chosen folder only.
- The same group can map to different folders on different devices.
- One device can belong to several groups. Mappings on one device cannot overlap; if a user moves one mapped folder inside another, both groups pause and ask.
- Moving an item out of the mapped folder removes it from the group, and other devices delete it (restorable from history). Moving an item in adds it. Moving an item from one group's folder to another's removes it from the first and adds it to the second.
- Excluded items stay in this browser only. Moving an excluded item to a different folder inside the mapping makes it a normal synced item.
- Deleting or losing the mapped folder itself does not propagate. The group pauses on that device and asks the user to pick a folder again or leave the group.

### Groups

- **Create:** pick an account, a name, the mode, encryption (and passphrase), and the mapping. The current contents of the mapped folder become the group's first batch.
- **Leave:** this browser stops syncing the group and keeps its bookmarks as they are. Its device entry is marked as left, so it no longer holds back compaction.
- **Delete everywhere:** the group is marked as deleted. Other browsers pause, explain, and leave it (keeping their bookmarks). The group's files are removed.
- **Remove a device:** a device list shows each browser's name and when it last synced. Removing one (for example after an uninstall) stops it from holding back compaction. If it comes back, it rejoins in merge mode.

### Join flow

1. Pick the account, then pick an existing group.
2. Pick the mapping (whole tree or one folder, and which root copy if Chromium has two).
3. Pick merge (default) or replace, with "ignore browser default bookmarks" on by default.
4. The extension reads the group until it has a complete, consistent view (two listings in a row that agree).
5. Show a preview, for example "120 will be added to the group, 180 matched, 0 removed".
6. Save this browser's bookmarks and a group restore point, then apply.

Bookmarks a device brings into a group at join time get IDs derived from their group, folder path, URL, title and occurrence number. Two devices joining at once with the same bookmarks therefore produce the same IDs and the copies merge into one. A derived ID that already exists in the group never overwrites the group's newer edits to that item.

### Device identity

- Each batch records the hash of the device's previous batch, and `device.json` publishes the newest batch and its hash.
- If a device finds batches under its own ID that it did not write, or any reader finds two different files for the same batch number or a broken hash chain, another copy of the profile is writing as the same device. The copies take new device IDs and rejoin in merge mode, and readers stop reading the old ID at the point where it diverged.
- A crash right after an upload is not mistaken for a copy: the device recognizes its own frozen batch and finishes recording it.
- After a reinstall, the extension has no local state and simply joins again in merge mode. If the browser's own bookmark IDs change (which native sync can cause on Chromium), catch-up rebuilds the ID map by matching folder path, URL and title.

### Native sync detection

- On every pull, each incoming bookmark or folder created by another device is compared with what this device itself recorded as new in the last 10 minutes. Same URL, title and folder path (or title and folder path for folders) means both are the same item.
- For each matching pair, only the copy created later is removed, by the device that created it, which then links its local item to the other copy. The two devices therefore never both delete their copy.
- A single match is repaired quietly. Identical bookmarks made on two browsers within minutes are the same bookmark either way.
- Three or more matches in one pull means another sync channel is delivering bookmarks, which is native sync between two extension installs. The device repairs them, shows a warning explaining how to turn off native bookmark sync, and pauses.
- Other browsers may briefly see a duplicate before the repair arrives. No upload delay is added, so normal syncing stays fast.
- Detection is skipped during a Chromium bookmark import. A single browser using native sync only as a backup never triggers it, because nothing else in the group makes matching changes.

### History and restore

- A timeline view lists changes grouped by batch, with the device and time.
- Restoring to a time T compares the merged state now with the merged state at T, and records the changes that turn one into the other, ordered so that folders are placed before their contents.
- Reverting a set of items (used by the large change guard) does the same for only those items.
- The restore screen shows how many items will change before applying, and the restore can be undone.
- Changes from a browser that was offline can still arrive after a restore and apply on top of it, as with any other edit.

### Duplicate finder

- Builds an in-memory map from normalized URL to the bookmarks with that URL, across the whole browser, labeled by group (or "not synced").
- **Exact duplicates:** identical after lowercasing the scheme and host and removing a trailing `/` and the `#fragment`.
- **Possible duplicates:** additionally ignore `http` vs `https`, `www.`, and tracking parameters (`utm_*`, `fbclid`, `gclid`, and similar). Listed separately because other query differences can be real.
- A review screen groups duplicates with their folder paths and offers "keep this one, remove the others" and "move all into one folder". Nothing is removed automatically.
- Cleanup of synced bookmarks goes through the change log, so it syncs and can be restored from history. Cleanup of bookmarks outside every group is kept in a local undo list on this browser.

### Encryption (when on)

- AES-GCM 256 via WebCrypto. The key comes from a passphrase via PBKDF2-SHA256 (600,000 iterations).
- `group.json` stores the salt, KDF parameters and an encrypted key check, so a wrong passphrase is detected immediately.
- The passphrase is asked once per browser session; until then the group is locked. The key is kept in memory only. "Remember on this device" keeps it across restarts, which means the key is stored on disk.
- File names and sizes stay visible to the provider. Contents do not.
- **Turning encryption on or off:**
  1. The device announces a migration.
  2. Every other device uploads its pending changes and then holds new ones.
  3. When all devices have confirmed (or the user chooses to continue without a device that is offline), the new group is created from the old group's complete final state.
  4. Every device moves over and uploads its held changes there.
  5. If two devices start a migration at the same time, the earlier one wins.
  6. A device that comes back later finds the pointer to the new group and joins it in merge mode.

### Providers

- **WebDAV:** URL, username and app password. The extension asks for access to that server's address when the user adds it, and checks that it still has access before each sync. Built first because it can be tested against a local server without OAuth.
- **Google Drive:** sign-in through the browser's web auth flow, using the app's hidden data folder. Chromium and Firefox use different OAuth client types because their redirect addresses differ. Brave needs "Allow Google login for extensions" turned on; the extension detects this and explains it.

### When the user needs to act

Pauses, locked groups, the large change guard, native sync detection and clock problems show a browser notification and a badge on the extension icon. Clicking the notification opens the extension's page with the details and choices.

## Acceptance checklist

Each statement can be checked by hand or by an automated test.

1. A bookmark added in Chrome appears in Firefox on the same machine as soon as the Firefox window gains focus, and within 5 minutes otherwise. Exception: if Chrome closes within 3 seconds of the edit, it appears after Chrome's next start.
2. After two browsers make different offline edits and both sync, both trees are identical and contain both sets of edits.
3. Folder deleted on browser A while browser B adds a bookmark inside it: after both sync, both browsers show the folder containing only the new bookmark.
4. Browser A deletes folder P (having seen bookmark x inside P/F) while B deletes P/F without having seen x: after syncing, x, F and P are all gone.
5. Both browsers rename the same bookmark offline: after syncing, both show the later rename.
6. A rename on A and a URL change on B to the same bookmark: both changes apply.
7. Concurrent moves that would create a cycle: one move is skipped and both trees are identical.
8. Random concurrent change sequences on 3 or more simulated devices, including deletes, undeletes, moves, joins, compaction and late batches, always converge to the same tree (property-based test).
9. A fresh Firefox joining in merge mode with defaults ignored adds no "Mozilla Firefox" folder to the group, creates no duplicates of exact matches, and the result matches the preview counts.
10. Two browsers joining the same new group at the same time with the same bookmarks end with one copy of each.
11. Joining in replace mode leaves the mapped folder identical to the group, and the replaced bookmarks can be brought back.
12. Every join and every restore can be undone.
13. Deleting a folder and then restoring to before the delete brings the folder back with its contents on every browser.
14. A browser that was closed longer than the history window catches up from the change log or the newest snapshot without falling back to comparing bookmark trees.
15. A batch that uploads late (after the device read newer changes) is still merged correctly by every device, including devices that started from a snapshot.
16. Two installs linked by native sync: the warning appears, that device pauses, and after the repairs no duplicates remain in the group.
17. A single browser with native sync as a backup never sees the warning.
18. A sync cycle deleting, moving or editing more than 20% of a group's existing items (at least 10) pauses the group and asks, and both choices leave all browsers identical. Adding items never pauses it.
19. With encryption on, files at the provider cannot be read without the passphrase. Turning encryption on or off moves every browser to the new group without losing any edit, including edits made during the migration.
20. A group mapped to Chrome "Other bookmarks/Work" and Firefox "Bookmarks Toolbar/Work" keeps items in those folders. Moving an item out on one browser removes it on the other.
21. Deleting a mapped folder pauses that group on that device and does not delete the group's contents elsewhere.
22. The duplicate finder lists exact and possible duplicates separately. Cleanup syncs to other browsers and can be undone.
23. Every stored file has a format version. A file with a newer, unknown major version pauses the group with a clear message.
24. Copying a browser profile to another machine results in separate devices, with no batch overwritten and no edits lost after the copies rejoin.
25. A device whose clock is more than 2 minutes off pauses with a message and writes nothing.
26. Sorting a folder by name in Chromium or Firefox syncs the new order to other browsers.
27. The same codebase builds packages that install and sync on Chrome, Edge, Brave, Vivaldi and Firefox desktop.
28. A folder that was deleted and restored keeps working normally: moving another folder into it later keeps that folder's contents visible on every browser.
29. The same bookmark added on two browsers within a few minutes ends as exactly one copy on every browser.
30. Undoing a merge join puts the joining browser's own bookmarks back exactly as they were and leaves the group.

## Assumptions

- Push happens about 3 seconds after the last change. Pull happens on background start, every 5 minutes, and on window focus at most every 10 seconds.
- Synced fields are title, URL, folder and position, plus separators from Firefox.
- Stack: TypeScript with WXT. The UI framework is not chosen yet.
- Large change guard threshold: 20% of items, minimum 10, configurable.
- A device that has not synced for 90 days (by the provider's clock) is marked stale. When it returns, it loads the newest snapshot and re-timestamps its unsynced changes, so they are kept.
- PBKDF2 at 600,000 iterations for v1 key derivation.
- WebDAV provider is built first, Google Drive second.
- During the personal phase, the Google OAuth consent screen is moved to production status so sign-ins do not expire after 7 days.
- Edits made while the extension was off are timestamped when catch-up finds them, so they can lose to remote edits made in the meantime. History makes this recoverable.

## Later

- Firefox for Android, then Dropbox, OneDrive and Mega providers.
- Public release work: store listings, Google OAuth review, Floccus import, license.
- Firefox tags and keywords, favicons.
- Argon2id key derivation.
- Dropping old deleted-item records from snapshots (v1 keeps them all, which costs roughly 200 bytes per deleted item).

## Changes from draft 2

Draft 2 was reviewed by four separate reviews: merge correctness, storage protocol, browser integration, and consistency between the two documents. Main changes:

- **Delete visibility:** a delete now only affects items that were inside the folder when it happened. Before, a folder that had been deleted and restored could hide anything moved into it later.
- **Native sync repair:** only the later copy of a matched pair is removed. Before, both devices could delete their copy and lose the bookmark.
- **Joins:** a join can no longer overwrite the group's newer edits through a reused derived ID.
- **Undoing a join:** this now restores the browser's own bookmarks and leaves the group.
- **Restore order:** restores now place folders before their contents.
- **Moves out of a deleted folder:** items moved out by a change the delete had not seen now survive at their new place.
- **Capture:** recording changes is now one queue comparing folders with the mirror. Rapid or late browser events can no longer corrupt the log or duplicate items.
- **Encryption migration:** the old group is now frozen first, so edits pushed during the migration are not lost.
- **Compaction:** it now fails safe when a device is missing from a listing. It also never runs within 1 day of the present, and devices that fall behind load a snapshot instead of waiting for deleted files.
- **Copied profiles:** they are now detected through hashed batch chains, which also works on Google Drive. A crash after an upload no longer looks like a copied profile.
- **New features:** creating, leaving and deleting groups, removing devices, excluded items, locked encrypted groups, a local undo for duplicates that are not synced, and exemptions from the large change guard for confirmed changes.
- **Version minimums:** Chromium 134+ and Firefox 140+. The clock tolerance is tightened to 2 minutes.
