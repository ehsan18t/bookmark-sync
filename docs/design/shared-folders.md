# Shared folders

A folder can belong to more than one sync on a browser. That browser carries changes between those syncs, so every change reaches every browser of every sync that shares the folder.

## Glossary

- **Sync (group):** a set of folders kept the same across browsers through one storage.
- **Shared folder:** a local folder held by two or more syncs on one browser, either the same folder or one inside another sync's folder.
- **Bridge:** the one browser that holds a shared folder in two syncs. Changes cross between those syncs only there.
- **Bridge claim:** a marker a bridge writes into each sync it links, naming the other sync and when the claim was made.
- **Takeover:** another browser becoming the bridge for a pair of syncs.
- **Release:** what an old bridge does after a takeover: it keeps the folder in one sync and stops syncing it in the other.

## Decisions

1. **One bridge per pair of syncs.** Two browsers translating between the same two syncs each re-derive the other sync's changes from their own bookmarks and disagree about which bookmark is which, which duplicated and lost bookmarks in review. With one bridge, each sync keeps its own identities and the bridge's local bookmarks are the only translation.
2. **Every change reaches every browser through the bridge.** A change on any browser of either sync travels through that sync's storage to the bridge, which records it in the other sync. Changes cross only while the bridge runs; each sync keeps syncing among its own browsers regardless.
3. **A second bridge is refused up front, with a takeover.** Putting a shared folder in both syncs on another browser fails with "Edge on this PC already links Bookmarks New and Bookmarks" and offers to make this browser the link instead.
4. **The latest claim wins.** Claims are ordered by time. A takeover writes a newer claim; an old bridge that finds a newer claim from another browser releases on its next sync, before applying anything.
5. **Release stops syncing the inner folder in its own sync** on the old bridge, with a notice, so the outer sync keeps everything; when both syncs hold the same folder, it stays in the sync that held it first. Bookmarks stay as they are. Two syncs of all bookmarks can't drop anything, so the later one pauses and asks.
6. **A takeover claims at once.** Confirming a takeover writes this browser's claim right away, newer than the old one; a browser that finds another browser's claim without having one of its own steps back.
7. **Big changes are confirmed once.** When a sync applies changes in a shared folder, the bridge first records the other syncs' own pending changes unconfirmed, so they still face the big-change check, then records what the apply brought in as confirmed.
8. **Sharing is chosen, never automatic.** Folders another browser adds are never placed inside another sync's folder.
9. **Several syncs can share a folder on one bridge**, and the syncs may live on different storage or accounts: the claim is written to each sync's storage.

## Mechanism

- **Claims** are the `bridges` marker of the bridge device in each linked group: `{ links: { [otherGroupId]: { name, at } } }`. Devices read them with the other markers on every pull.
- **Before each sync pass** of a group, the app works out which local syncs share folders with it, re-reads the claims in both syncs' storage, compares its own claims with other devices' claims for each pair (equal times go to the later device name), writes a claim where it bridges and has none, and releases pairs another device claimed later.
- **Up-front check:** creating, joining, adding folders or moving a folder so that two syncs overlap reads both syncs' claims; another device's claim refuses the change unless the request is a takeover.
- **Recording:** before a bridged sync's cycle, sharing syncs record their pending changes unconfirmed; after the cycle applies, they record again with `confirmed: true`, and sync once more at the end of the pass so the change crosses in one pass.

## Known limits

- During a takeover, until the old bridge syncs, both browsers bridge. A bookmark created in the shared folder then can appear twice; the duplicate repair merges copies made within ten minutes.
- Restoring history, joining, or adding folders on the bridge changes bookmarks outside a sync pass, so the other sync records them unconfirmed and may ask to confirm a big change.
- Older extension versions refuse shared folders, so they never become bridges and ignore claims.
- A bridge that disappears without leaving its syncs keeps its claim, so other browsers are refused until one takes over or the browser is removed on the Browsers tab.
- A claim counts only when both linked syncs hold it, so a browser that can see only one of the two syncs can't make the bridge release.
