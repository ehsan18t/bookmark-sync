# Cross-browser bookmark sync: implementation document (v2)

This document turns [SPEC.md](SPEC.md) (draft 3) into code-level design: modules, data formats, algorithms, browser and provider details, testing and milestones. The spec says what the extension does; this says how. When they disagree, the spec wins and this document gets fixed.

## As built

Every milestone below is implemented. Where the code ended up differing from this plan:

- **Local state** is one IndexedDB record per group holding the whole `GroupLocal` object (`src/engine/group.ts`), plus a `meta` record and a `keys` store, instead of the many stores in section 5. Each queue task writes the record once at its end.
- **The queue** lives in `SyncApp` (`src/engine/app.ts`). Bookmark events only schedule a sync 3 seconds later; reconcile always compares the whole mapped tree rather than only dirty folders.
- **Crash recovery during apply** uses a persisted apply-in-progress flag instead of a step journal: after an interrupted apply, local items that match merged nodes missing from the mirror (same parent, kind, title and URL) are adopted before reconcile runs.
- **Restore** checks every plan by simulation and patches it until the result is exact (`planRestoreExact`), because re-placing a folder can expose descendants an older delete hid only through it.
- **The large change guard** counts only existing items that would be removed, moved or edited; additions never trigger it.
- **Device files:** `device.json` also carries the device's base frontier, its first retained batch, versions of its markers (so readers fetch a marker only when it changes) and `forkOf` notices for device ID rotations.
- **Profile copies:** besides `createOnce` reporting a different existing batch, every cycle checks the device's newest batches for duplicates, which is how simultaneous uploads by two copies show up on Google Drive. Both copies then rotate with `dropOld`, and readers drop the old ID's ops from the reported point.
- **WebDAV** uploads to a `.tmp-*` file in the same folder and moves it into place; listings skip those names. Leftover temporary files are not swept yet.
- **Google Drive** stores each file's path, folder, group and kind as the appProperties `p`, `dir`, `g` and `k`. The cheap `changes.list` idle check is not implemented; each cycle lists devices and reads their `device.json`.
- **The UI** talks to the background with `runtime.sendMessage` only; there is no long-lived port.
- **The default bookmarks list** is data inside `src/core/defaults.ts`.
- **Firefox** requires version 140 (for `data_collection_permissions`), not 128.
- **Refused items:** apply catches failures per item. A create the browser refuses (Firefox rejects `javascript:` bookmarks from extensions) leaves the node without a local copy and is retried on later applies; a refused move or edit keeps the node's last state in the mirror.
- **Renumbered bookmarks:** when many mirrored local IDs vanish while many unmapped items appear, the ID map is rebuilt by matching parent, kind, title and URL before reconcile; if most cannot be matched the group pauses with `needs-join`.
- **Cursors:** a reader whose base already covers every op of a device fast-forwards its cursor, and a missing batch of a device that left or was removed makes it load the newest snapshot.
- **Keys:** remembered keys are stored non-extractable in IndexedDB; session-only keys live as raw bytes in `storage.session`, which browsers keep in memory.
- **Joins** publish `device.json` only once the join plan is ready, so a failed join leaves nothing behind; previews use placeholder folders and create nothing.
- **Google Drive** treats byte-identical duplicate files (a retried upload) as one file.

## 1. Stack and repository layout

- TypeScript (strict), WXT for building Chromium (MV3 service worker) and Firefox (MV3 event page) packages from one codebase. Firefox must be built with `manifestVersion: 3`, because WXT defaults to MV2 for Firefox.
- pnpm, Vitest for unit tests, fast-check for property-based tests, Playwright for Chromium end-to-end tests, `web-ext` for Firefox runs.
- UI framework: not chosen yet. Nothing below depends on it.

```
src/
  core/              # pure TypeScript: no browser, network or IndexedDB APIs (enforced by a lint rule)
    hlc.ts           # hybrid logical clock
    ids.ts           # random IDs, derived IDs for joins
    position.ts      # fractional index keys
    ops.ts           # op types and validation
    replay.ts        # replay engine: snapshot + ops -> state
    visibility.ts    # which nodes are visible, revival
    tree.ts          # visible tree extraction, diffing two trees
    restore.ts       # restore and revert planning
    join.ts          # join matching
    frontier.ts      # stable frontier, compaction planning, snapshot selection
    reconcile.ts     # live folder listing vs mirror -> ops
    nativeSync.ts    # duplicate matching and repair planning
    guard.ts         # large change sizing
    dedupe.ts        # URL normalization, duplicate groups
    defaults.ts      # browser default bookmark list (data in defaults.json)
    codec.ts         # file envelope, versioning, encryption, batch hashing
  engine/            # pure orchestration over injected ports (no browser APIs)
    ports.ts         # interfaces: StorageProvider, BookmarksPort, Store (local DB), Clock, Crypto
    queue.ts         # global FIFO task queue
    cycle.ts         # pull, apply, push, publish, compact
    groups.ts        # create, join, leave, delete, remove device
    identity.ts      # fork detection and device rotation
    migrate.ts       # encryption migration
    status.ts        # pause reasons
  storage/
    memory.ts        # in-memory provider (tests, simulator)
    webdav.ts
    gdrive.ts
    layout.ts        # logical paths for a group
    contract.test.ts # suite every provider must pass
  browser/
    bookmarksPort.ts # BookmarksPort over browser.bookmarks, with per-browser shims
    roots.ts         # root folder discovery per browser
    adapters/        # chromium.ts, firefox.ts, edge.ts, vivaldi.ts quirks
    db.ts            # Store over IndexedDB, schema migrations
    auth.ts          # OAuth flows
  entrypoints/
    background.ts    # registers all listeners synchronously at top level, owns the queue
    popup/           # status and quick actions
    options/         # accounts, groups, devices, history, duplicates, settings, diagnostics
test/
  sim/               # multi-device simulator: memory provider + fake BookmarksPort per device
  property/          # convergence and oracle properties
  integration/       # provider contract suite against local WebDAV
  e2e/               # Playwright with the unpacked Chromium build
```

`core/` and `engine/` together hold all logic. The engine talks to the browser, the provider and the local database only through the interfaces in `ports.ts`. That lets the simulator run the real engine against fakes, and lets milestone 1 test syncing without a browser.

## 2. Identifiers and clocks

### 2.1 IDs

- **Device ID**: 16 random bytes, base32. Stored locally and published in `device.json`.
- **Stable node ID**: 16 random bytes, base32, for nodes created by normal edits.
- **Derived node ID** (join only): `"j" + base32(sha256(groupId | parentStableId | kind | title | url | occurrence))[0..26]`, where `occurrence` is the 0-based index among earlier siblings in the joiner's local order with the same `(kind, title, url)`.
- **Fixed root IDs**: `root:toolbar`, `root:other`, `root:menu` for `everything` groups; `root:group` for `folder` groups, whose children are the tops. Roots always exist and are always visible.
- **Top hint**: a top's `url` field holds `top:` + the URI-encoded root kind (`toolbar`, `other`, `menu`, `mobile`) and folder titles, joined by `/`. Folders have no URL of their own, and a top is never applied as a local folder, so the hint never reaches the browser.
- **Op reference**: `(device, opSeq)`. `opSeq` starts at 1 per device per group and increases by 1 for every op. It is never reused.
- **Batch number**: `batchNo`, starting at 1 per device per group, contiguous. Batch numbers and `opSeq` are different counters.

### 2.2 HLC

```ts
type Hlc = { wall: number; counter: number; device: string };
// Serialized as `${wall.toString().padStart(15,'0')}-${counter.toString().padStart(6,'0')}-${device}`; string order equals HLC order.
```

- `now()`: `wall = max(last.wall, Date.now())`; `counter = wall === last.wall ? last.counter + 1 : 0`. `last` is persisted in the same transaction as the ops that use it.
- `observe(remote)`: always `last = max(last, remote)`. The clock check below keeps every writer within 2 minutes of the provider, so this cannot run away. An op whose wall time is more than 1 day ahead of the provider's time is rejected as corrupt, and the group pauses with reason `corrupt`.
- **Clock check**: every provider call returns the server's `Date` header. If it differs from `Date.now()` by more than 2 minutes, the group pauses with reason `clock-skew` before writing anything. Reading `Date` requires the host permission to be granted, which section 7 ensures.
- A device observes the HLC of every op and snapshot frontier it reads, and the server time, before it stamps any new op.

## 3. Data model

### 3.1 Ops

```ts
type Kind = 'bookmark' | 'folder' | 'separator';
type Fields = { title?: string; url?: string };
type OpRef = { device: string; opSeq: number };

type OpBase = { device: string; opSeq: number; hlc: string; node: string };

type CreateOp   = OpBase & { type: 'create';   kind: Kind; parent: string; pos: string; fields: Fields };
type UpdateOp   = OpBase & { type: 'update';   fields: Fields; before: Fields };
type MoveOp     = OpBase & { type: 'move';     parent: string; pos: string; before: { parent: string; pos: string } };
type DeleteOp   = OpBase & { type: 'delete';   seen: Record<string, number>; before: SubtreeSnapshot };
type UndeleteOp = OpBase & { type: 'undelete'; kind: Kind; parent: string; pos: string; fields: Fields };

type Op = CreateOp | UpdateOp | MoveOp | DeleteOp | UndeleteOp;
```

- `seen[d]` is the highest `opSeq` from device `d` that the deleting device had applied when it recorded the delete, including its own (`seen[self] = opSeq - 1`). Ops read but not yet applied (during a guard pause) do not count.
- `before` fields are for history display only. Merging and restoring never use them.
- A folder delete is one `DeleteOp` on the folder. Descendants are hidden by the visibility rule in 4.3.

### 3.2 Replay state (per node)

```ts
type Reg<T> = { value: T; hlc: string } | null;   // null = never set

type NodeState = {
  id: string;
  kind: Kind | null;                                // null for a stub created by an op that arrived before its create
  title: Reg<string>;
  url: Reg<string>;
  placement: (Reg<{ parent: string; pos: string }> & { op: OpRef }) | null;
  aliveEvents: OpRef[];                             // creates and undeletes of this node
  deletes: { op: OpRef; hlc: string; seen: Record<string, number> }[];
};
type GroupState = { nodes: Map<string, NodeState> };
```

A snapshot is a serialized `GroupState` plus its frontier and coverage (section 9.7).

## 4. Merge engine

The engine is a left fold over ops in HLC order, starting from a snapshot. The same snapshot base and the same set of ops give the same state on every device, in any arrival order, because ops are always sorted before folding. A late op with an older HLC triggers a recomputation from the base.

### 4.1 Replay

```ts
function replay(base: GroupState, ops: Op[]): GroupState {
  const s = clone(base);
  for (const op of dedupe(sortByHlc(ops))) applyOp(s, op);    // dedupe by (device, opSeq)
  return s;
}

function applyOp(s: GroupState, op: Op) {
  const n = s.nodes.get(op.node) ?? stub(s, op.node);           // ops on unknown nodes are kept on a stub
  switch (op.type) {
    case 'create': {
      n.kind ??= op.kind;
      if (!n.title) n.title = { value: op.fields.title ?? '', hlc: op.hlc };   // only fills unset registers
      if (!n.url) n.url = { value: op.fields.url ?? '', hlc: op.hlc };
      if (!n.placement && !wouldCycle(s, op.node, op.parent)) setPlacement(n, op);
      n.aliveEvents.push(ref(op));
      break;
    }
    case 'undelete': {
      n.kind ??= op.kind;
      setReg(n, 'title', op.fields.title ?? '', op.hlc);                     // overwrites, like an edit
      setReg(n, 'url', op.fields.url ?? '', op.hlc);
      if (!wouldCycle(s, op.node, op.parent)) setPlacement(n, op);
      n.aliveEvents.push(ref(op));
      break;
    }
    case 'update':
      if (op.fields.title !== undefined) setReg(n, 'title', op.fields.title, op.hlc);
      if (op.fields.url !== undefined) setReg(n, 'url', op.fields.url, op.hlc);
      break;
    case 'move':
      if (!wouldCycle(s, op.node, op.parent)) setPlacement(n, op);           // a skipped move changes nothing
      break;
    case 'delete':
      n.deletes.push({ op: ref(op), hlc: op.hlc, seen: op.seen });
      break;
  }
}
```

- `setReg` and `setPlacement` write only if the register is unset or `op.hlc > reg.hlc`.
- **A `create` on a node that already exists only adds an alive event, and fills registers that were never set.** This is what lets two simultaneous joins with the same derived ID merge. It also stops a late join from reverting the group's newer edits.
- `wouldCycle(s, node, parent)` walks up from `parent` through the placements of **all** nodes, visible or not, and returns true if it reaches `node`. Unknown parents count as no cycle.
- Stubs: with causal HLCs (2.2), an op on a node always sorts after that node's create, so stubs only appear while the create is still unread. A stub with no `kind` is never visible.

### 4.2 Covering

```ts
const covers = (seen: Record<string, number>, r: OpRef) => r.opSeq <= (seen[r.device] ?? 0);
```

A delete covers an op when the deleting device had already applied that op.

### 4.3 Visibility

Computed on the final replayed state, never during the fold.

```ts
function ownAlive(n: NodeState): boolean {
  // observed-remove: alive if some create/undelete is not covered by any delete of this node
  return n.kind !== null && n.aliveEvents.some(a => !n.deletes.some(d => covers(d.seen, a)));
}

function hiddenByAncestor(s: GroupState, n: NodeState): boolean {
  // An ancestor's delete hides n only if the deleter had seen n placed in that subtree:
  // it must cover the placement op of n and of every node between n and that ancestor.
  const chain: OpRef[] = [n.placement!.op];
  for (let a = parentOf(s, n); a && !isRoot(a.id); a = parentOf(s, a)) {
    if (a.deletes.some(d => chain.every(op => covers(d.seen, op)))) return true;
    chain.push(a.placement!.op);
  }
  return false;
}

function visibleSet(s: GroupState): Set<string> {
  const vis = new Set(ROOT_IDS);
  for (const n of s.nodes.values())
    if (ownAlive(n) && n.placement && hasRootPath(s, n) && !hiddenByAncestor(s, n))
      for (let x: NodeState | undefined = n; x && !vis.has(x.id); x = parentOf(s, x)) vis.add(x.id);  // revive ancestors
  return vis;
}
```

How this meets spec rule 12:

| Case | Result |
|---|---|
| A deletes folder F; B concurrently adds x in F | x's create is not covered, so x is visible and F is revived with only x. Children the delete saw stay hidden. |
| B deletes P having seen x in P/F; A deletes P/F without seeing x | P's delete covers x's placement and F's placement, so x is hidden. F and P stay hidden. |
| Folder B deleted, later restored; folder A (with x) moved into B | B's old delete does not cover A's new placement op, so x stays visible (checklist 28). |
| D deletes B having seen x in A; E concurrently moves A into B | B's delete does not cover A's move, so A and x stay visible and B is revived. |
| x moved out of deleted P by a change the delete had not seen | x's ancestors are no longer under P, so x is visible at its new place. |
| Delete of x and a concurrent rename or move of x | Updates and moves are not alive events, so x stays dead. |
| Restore after a delete | The undelete is a new alive event and a new placement op, so the node is visible. |

`hasRootPath` returns false when the parent chain reaches a stub or an unknown node. Such nodes stay hidden until the parent arrives.

### 4.4 Ordering inside a folder

- Visible children sort by `(pos, id)`. The ID tie-break makes concurrent inserts at the same key deterministic.
- Keys are fractional-index strings (base-62, as in the `fractional-indexing` package). A new key goes between the left and right neighbors in group order.
- **Equal keys:** if the two neighbors have the same key, the key generator cannot place anything between them. Reconcile also emits a `move` for the right neighbor to a key between the left key and the next distinct key, then inserts between them.
- **Excluded children** (separators on Chromium, excluded items, the `root:menu` helper folder) are skipped when mapping between local indexes and group order. A local insert after local sibling `L` gets a key between `L` and the next group child after `L`.

### 4.5 Diffing two visible trees

`diffTrees(a, b)` returns `{ creates, deletes, moves, updates }` by stable ID, with creates in preorder of `b` and deletes in postorder of `a`. It is used for apply, restore planning, guard sizing and previews.

## 5. Local state (IndexedDB)

One database, `bsync`. Schema changes are forward-only upgrade steps, each tested against a fixture database from the previous version.

| Store | Key | Contents |
|---|---|---|
| `meta` | fixed | device ID, HLC `last`, schema version, session ID |
| `settings` | fixed | history days (7; 0 = off), guard percent (20), guard minimum (10), device name, pull minutes (5) |
| `accounts` | accountId | provider type, WebDAV URL and credentials, or Drive tokens; display name |
| `groups` | groupId | accountId, name, mode, mapping, status, pause reason, encrypted flag, `opSeq`, `lastBatchNo`, `lastBatchHash`, remember-key flag |
| `keys` | groupId | non-extractable `CryptoKey`, session ID it belongs to (or `persistent`) |
| `idmap` | [groupId, localId] | stable ID, plus reverse index |
| `mirror` | [groupId, stableId] | last applied visible node: kind, parent, pos, title, url, local ID |
| `excluded` | [groupId, localId] | reason (default, helper, trash), the local parent at the time |
| `ops` | [groupId, hlc, device, opSeq] | every op known above the base snapshot, from all devices, with its `batchNo` |
| `outbox` | [groupId, opSeq] | own ops not yet in a batch |
| `pendingBatch` | groupId | the frozen next batch: exact encoded bytes, `batchNo`, reserved Drive file ID |
| `cursors` | [groupId, deviceId] | last batch read, its hash, last `opSeq` applied, last known `device.json` |
| `base` | groupId | base snapshot (`GroupState`, frontier, coverage) |
| `restorePoints` | id | groupId, HLC, label (join, guard, manual) |
| `localRestore` | id | a saved local tree (before join), for undoing a join on this browser |
| `localUndo` | id | duplicate cleanups of bookmarks outside every group |
| `recentCreates` | [groupId, opSeq] | own creates of the last 10 minutes: node, kind, title, url, parent path, hlc |
| `applyJournal` | groupId | the apply plan in progress and the steps done |
| `log` | autoincrement | diagnostics ring buffer (2,000 entries, no URLs unless the user turns that on) |

Rules:

- Every queue task reads the browser first, computes, then commits **one** IndexedDB transaction with all its writes. It never awaits a browser, network or crypto call while that transaction is open.
- On background start, the engine loads `base` and `ops`, replays, and caches the state in memory. The first queued task waits for this.

## 6. Storage format at the provider

### 6.1 Logical paths

```
groups/<g>/group.json
groups/<g>/devices/<d>/device.json
groups/<g>/devices/<d>/batches/<batchNo, 12 digits>.json
groups/<g>/devices/<d>/snapshots/<8-char id>.json
groups/<g>/devices/<d>/markers/migration.json | migrated.json | group-deleted.json | removed.json
groups/<g>/devices/<d>/tmp/                     # WebDAV upload staging, swept on start
```

### 6.2 File envelope

Every file is JSON:

```json
{ "format": "bsync", "v": 1, "minor": 0, "kind": "batch", "enc": null, "body": { } }
```

- `v` is the major version: an unknown `v` pauses the group with reason `format-too-new`. Unknown fields at a known `v` are ignored.
- With encryption on, `enc` is `{ "alg": "A256GCM", "iv": "<base64>" }`, and `body` is the base64 ciphertext of the JSON body. The logical path is used as additional authenticated data, so a file cannot be swapped for another one.
- A batch's encoded bytes, including the random IV, are frozen in `pendingBatch` before the first upload attempt, so a retry sends identical bytes.

### 6.3 Bodies

```ts
type GroupHeader = { groupId: string; name: string; mode: 'everything' | 'folder'; createdBy: string; createdAt: string;
  encryption: null | { kdf: 'PBKDF2-SHA256'; iterations: 600000; salt: string; check: string } };

type DeviceInfo = { deviceId: string; name: string; browser: string;
  lastBatchNo: number; lastBatchHash: string;
  lastOpSeq: number;
  bound: string;              // HLC lower bound of every op this device will publish in the future
  firstRetainedOpSeq: number; // first opSeq of its oldest batch still stored
  left: boolean;
  frozenFor: string | null;   // migration ID this device has frozen for
  updatedAt: string };

type Batch = { batchNo: number; prevHash: string; firstOpSeq: number; confirmed: boolean; ops: Op[] };

type Snapshot = { frontier: string; coverage: Record<string, number>; state: SerializedGroupState };

type MigrationMarker = { migrationId: string; hlc: string; encryption: boolean; excluded: string[] };
type MigratedMarker  = { migrationId: string; newGroupId: string; coverage: Record<string, number> };
type GroupDeleted    = { hlc: string };
type Removed         = { devices: string[] };
```

- `prevHash` is the SHA-256 of the previous batch's encoded bytes (empty for batch 1).
- `bound` is `min(oldest outbox or pending op HLC, reserved HLC)` at the moment `device.json` is written. The reserved HLC comes from `HlcClock.reserveBound()`, which first moves the clock up to the current wall time, so every later tick is strictly above it even if the wall clock steps back. The clock state must be persisted before `device.json` is published.
- `confirmed` is true for batches the user explicitly approved (group creation, join, restore, revert, duplicate cleanup, an approved large change). The guard on other devices skips them.
- `device.json` is published when one of its fields changed, and at least once a day.

## 7. Storage providers

```ts
interface StorageProvider {
  listDevices(group: string): Promise<string[]>;
  get(path: string): Promise<Uint8Array | null>;
  createOnce(path: string, data: Uint8Array, reservedId?: string): Promise<'created' | { exists: Uint8Array[] }>;
  overwrite(path: string, data: Uint8Array): Promise<void>;     // device.json and own markers only
  delete(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;                   // snapshots, markers, tmp; not used for batches
  changedSince(token: string | null): Promise<{ changed: boolean; token: string }>;  // cheap idle check
  serverDate(): string;                                         // Date header of the last response
}
```

- Batches are fetched by computed path (`batchNo` from `device.json`), never by listing a batch folder.
- `createOnce` returns every existing file at that path. On WebDAV that is at most one; on Drive there can be several.
- A shared contract test suite runs against every provider.

### 7.1 WebDAV

- **Permissions:** the server origin is requested with `permissions.request({ origins: [origin + '/*'] })` from the click that adds the account in the options page. Before every sync, `permissions.contains` is checked; if access was revoked, the group pauses with reason `permission`.
- **Requests:** `fetch` with `credentials: 'omit'` (avoids Nextcloud cookie and CSRF problems) and Basic auth. Plain HTTP is allowed for servers on the local network, after a warning that the password and bookmarks cross the network unencrypted.
- **`listDevices` and `listFiles`:** `PROPFIND` with `Depth: 1`. Depth infinity is never used.
- **`createOnce`:**
  1. `MKCOL` any missing parent folders (405 means it already exists).
  2. `PUT` to `devices/<d>/tmp/<random>`.
  3. `MOVE` to the final path with `Overwrite: F`.
  4. A 412 response means a file exists: `GET` it and return it as `exists`.
- **Atomicity caveat:** the Go WebDAV server behind `rclone serve webdav` checks and then renames, which is not atomic. The contract suite tests this, and the hash chain (9.8) catches the rare race.
- **`changedSince`:** WebDAV has no change feed. It returns `changed: true` every time, and the cycle relies on `device.json` reads instead.

### 7.2 Google Drive

- **Scope:** `https://www.googleapis.com/auth/drive.appdata`. All files are flat in `appDataFolder`.
- **Locations:** stored as short `appProperties` (Drive limits each key plus value to 124 bytes): `g` (group ID), `d` (device ID), `k` (`group`, `device`, `batch`, `snap`, `marker`, plus `tmp`) and `n` (batch number, snapshot ID or marker name). The file name is a readable short name only.
- **Lookups:** queries such as `appProperties has { key='g' and value='<g>' } and appProperties has { key='d' and value='<d>' } and appProperties has { key='n' and value='42' }`.
- **`createOnce`:**
  - The file ID is reserved once with `files.generateIds` (`space=appDataFolder`) and stored in `pendingBatch`. The file is then created with that ID, so a retry gets a 409.
  - Before creating, a lookup by `(g, d, k, n)` returns any existing files. Drive cannot prevent two different IDs with the same properties, which is how profile copies show up (9.8).
- **`changedSince`:** `changes.list` with `spaces=appDataFolder` and a saved page token. An idle 5-minute check costs one request.
- **Large downloads:** read with HTTP `Range` requests in chunks of 1 MB, so one slow request does not get the Chromium worker stopped.

### 7.3 OAuth (Google)

- **Where it runs:** the flow starts from a click in the options page, which sends a message to the background, which calls `identity.launchWebAuthFlow`. The popup is never used, because it can close mid-flow.
- **Flow:** authorization code with PKCE, `access_type=offline&prompt=consent` so a refresh token is returned. Tokens are stored in the `accounts` store. A failed refresh pauses with reason `auth`.
- **Chromium:**
  - Redirect: `https://<extension-id>.chromiumapp.org/`.
  - Client: one Google "Web application" client listing the redirect for every published extension ID (Chrome Web Store, Edge Add-ons, and the dev build pinned with `key`).
  - Secret: the token endpoint needs `client_secret` for web clients. It ships in the package and is treated as public.
- **Firefox:**
  - Redirect: `http://127.0.0.1/mozoauth2/<subdomain>` (Firefox 86+).
  - Client: a "Desktop app" client, with `browser_specific_settings.gecko.id` pinned.
  - Unverified: Google documents loopback redirects with an explicit port. Whether it accepts this port-less form is a spike in milestone M2. If it doesn't, the fallback is a small redirect page on a domain the project controls.
- **Brave:** if `identity` is unavailable or `launchWebAuthFlow` fails with the Brave error, the options page explains how to turn on "Allow Google login for extensions" in `brave://settings/extensions`.
- **Host permissions:** the googleapis origins are in `host_permissions`. Firefox lets users revoke them, so `permissions.contains` is checked before each sync, and onboarding requests them if missing.

## 8. Browser integration

### 8.1 Background lifecycle and the queue

- **Listeners:** all listeners (`bookmarks.*`, `alarms.onAlarm`, `windows.onFocusChanged`, `runtime.onStartup`, `runtime.onInstalled`, `runtime.onMessage`, `runtime.onConnect`, `notifications.onClicked`) are registered synchronously at the top level of `background.ts`.
- **The queue:** one global FIFO task queue (`engine/queue.ts`) runs everything one task at a time: reconcile, sync cycles, apply, join, restore, revert, cleanup, migration and UI commands. It is global, not per group, because a move between two groups touches both.
- **On every background start:**
  - wait for the database to load
  - `alarms.get('pull')`, creating the alarm (5 minutes) only if it is missing, since re-creating it would reset its timer
  - finish any unfinished `applyJournal`
  - queue a full catch-up for every active group, then a sync cycle
- **`runtime.onStartup`:** generate a new session ID in `meta` and in `storage.session`. Keys tagged with an older session ID are ignored and deleted.
- **Throttling:** the focus trigger is limited to once per 10 seconds, with the last pull time stored in `storage.session` so it survives worker restarts.
- **Push timing:** the push is debounced by 3 seconds with `setTimeout`. If the worker is stopped first, the outbox is pushed on the next start.
- **Keeping the worker alive:** long jobs run while the UI holds a `runtime.connect` port, which keeps the Chromium worker alive, and report progress over it.

### 8.2 Root discovery (`roots.ts`)

- **Chromium (134+):** read the root's children from `getTree()` with their `folderType` (`bookmarks-bar`, `other`, `mobile`, `managed`).
  - When one folder type has two nodes (account and local copies), the user picks one during setup. The mapping stores that node's local ID together with its `folderType`. `syncing` can change, so it is never used as a key.
  - `managed` folders and anything `unmodifiable` are never mapped.
  - Root discovery runs again at the start of every cycle, because Chromium can add or hide root folders without sending an event to extensions.
- **Firefox:** fixed GUIDs `toolbar_____`, `menu________`, `unfiled_____`, `mobile______`. Extensions can create folders and separators under them.
- **`root:menu` on Chromium:** a helper folder created inside the other bookmarks folder, titled with the localized "Bookmarks Menu" name. It is recorded in `excluded` for `root:other` (reason `helper`) and mapped to `root:menu` by local ID. It is never matched by name.
- **`everything` group mapped into one folder:** three helper subfolders (localized Toolbar, Other, Menu) are created inside the chosen folder and mapped to the three roots by local ID.
- **Vivaldi:** the Trash folder is found by adapter rules and treated as outside every group. Speed Dial folders are normal folders.
- **Pausing:** if a mapped root's local ID no longer exists, changed folder type, or moved, the group pauses with reason `root-changed`. A deleted or moved mapped folder in `folder` mode pauses with `mapped-folder-missing`. Both checks run before reconcile, so this never turns into mass deletes.

### 8.3 Capture: events mark folders, reconcile records changes

Bookmark events only mark which folders changed:

| Event | Marked dirty |
|---|---|
| `onCreated` | the parent; the new node if it is a folder (its subtree is read, because a restored folder announces only itself) |
| `onRemoved` | the parent |
| `onChanged` | the node |
| `onMoved` | the old parent and the new parent |
| `onChildrenReordered` (Chromium) | the folder |
| `onImportBegan` / `onImportEnded` (Chromium) | nothing during the import; a full catch-up when it ends |

Each event adds to a dirty set and queues one coalesced `reconcile` task. Many events from a drag, a sort or a paste become one task.

`reconcile(dirty)` in `core/reconcile.ts`, with browser reads done first by the port:

1. Check each affected mapping's root (8.2). If it fails, pause and stop.
2. Read the live children of every dirty folder (and the subtree of every new folder).
3. Compare with the mirror by local ID:
   - **A live child not in `idmap`:** if it is excluded, skip it. Otherwise record a `create`, for its whole subtree if it is a folder.
   - **A mirror child missing from its parent:**
     - found under another dirty folder in the **same** group: `move`
     - found in a **different** group's folder: `delete` in the old group and `create` in the new one
     - gone, or now outside every mapping (including Vivaldi Trash): `delete`
   - **Changed title or URL:** `update`.
   - **Order:**
     1. compare the live order of non-excluded children with the mirror order
     2. keep the longest increasing run of existing keys
     3. emit `move` ops with new keys for the rest
     4. handle equal keys as in 4.4
   - **An excluded item now under a different parent** than recorded: it is no longer excluded and becomes a `create`.
4. Commit the ops, outbox, `recentCreates`, mirror, `idmap` and `excluded` changes in one transaction.

v1 reconciles the whole mapped tree on every task; narrowing the comparison to the dirty folders is an optimization for later and does not change the result.

This design is idempotent. Events caused by the extension's own changes arrive after the apply task has updated the mirror, so they find nothing to record. Late, repeated or reordered events cannot produce duplicate ops, because ops come only from comparing live state with the mirror. Firefox sorts (one `onMoved` per child) and Chromium sorts (`onChildrenReordered`) both end up as one reorder diff.

**Catch-up** is `reconcile` with every folder of every mapping marked dirty. If the browser's local IDs no longer match the mirror (Chromium native sync reload), nodes are matched by `(path, title, url)` and `idmap` is rewritten. If more than half the nodes fail to match, the group goes to `needs-join` instead of recording mass deletes.

### 8.4 Applying merged state

1. `plan = diffTrees(mirrorTree, mergedVisibleTree)`, mapped to local folders (8.2), skipping excluded children.
2. Run the large change guard (9.4) on the unconfirmed part of the plan.
3. Store the plan in `applyJournal`.
4. Execute in this order:
   1. creates, in preorder
   2. moves and updates
   3. deletes, in postorder, using `removeTree` for folders after any surviving children have been moved out
5. After each browser call, one small transaction updates the mirror, `idmap` and the journal step.
6. Clear the journal.

- **Chromium `move` shim:** when moving a node forward within the same parent, Chromium counts the index from before removal, so the shim adds 1. Firefox treats the index as the final position.
- **Separators** are created only on Firefox.
- **Crash recovery:** on start, an unfinished journal is completed. For a create step whose call ran but whose result was not recorded, the item is found by `(parent, kind, title, url)` before the step is retried.

### 8.5 Mappings

- **Parts:** `config.mapping` maps each held group folder (a fixed root, a top, or any group folder) to a local folder, and the engine's roots are its keys. `visibleTree` gives each node to its nearest listed ancestor and leaves the held folders themselves out, so their names never sync. Adding a part runs `planJoin` for that part only; removing one drops its mirror and `idmap` entries and keeps the local folder.
- **After each pull** (`reviewParts`, before apply): held parts no longer visible are let go with a notice; held parts nested inside each other in the group pause with `mapping-overlap`; a `folder` group with `followTops` places new tops via `EnginePorts.place` (except `declined` ones), which always creates a new folder at the hinted path and returns null (the top is then declined) when that place overlaps a folder of the same group or lies in a folder another group holds, since sharing a folder is the user's choice; a device left with no parts pauses with `nothing-held`.
- **Overlap:** for chosen folders and parts, a new mapping is rejected if one of its folders is inside or equal to another folder of the same mapping. If a user later moves one into another, the overlap is detected before each sync and the group pauses with reason `mapping-overlap`. Different groups may map the same folder or nested folders.
- **Bridges:** before each sync pass the app marks groups that share a folder with another group (`GroupEngine.bridged`). Before a bridged group's cycle, every group sharing a folder with it records its pending local changes unconfirmed, so they still face the local guard. When the cycle applies changes, those groups run `recordLocalChanges({ confirmed: true })`, so the changes it brought in skip the local guard here and the remote guard on that group's other devices. A group whose first recording failed does not confirm. Changes the user makes while the cycle runs can be confirmed with them; that window is one cycle.
- **Shared items:** a local item can belong to several groups, each with its own node id. Three rules keep them one item:
  - *Linked ids.* When a group first sees a local item that another group here already holds, its node id is `linkId(otherId, otherGroup, thisGroup)`, taken from the other group with the lowest id. Linking twice gives the id back, so every device bridging the two groups picks the same id whichever group saw the item first, and items two bridges record independently merge instead of duplicating.
  - *Adopting twins.* Applying a create whose linked twin another group here holds moves that local item into place instead of creating a copy, but only when the twin is identical (same kind, and the same URL for a bookmark or title for a folder), and it never edits it. Node ids come from storage other people may write, so a forged id can at most move an identical item: linked ids derive from items once shared with that group.
  - *Moved out, not removed.* A delete records `left: true` when the item still exists on that device, outside the group's folders. Applying such a delete releases the item when another group here holds it: it stays, and is excluded from this group until it moves, so a move across a nested boundary stays a move for the outer group. A delete without `left` removes the item as usual.
- **Moves between groups** are handled by reconcile (8.3).
- **Leave:** see 9.6.

## 9. Engine

### 9.1 Sync cycle (`engine/cycle.ts`)

One queued task per group:

```
cycle(group):
  if paused (other than checks that can clear themselves, like clock-skew): return
  check permissions, roots (8.2), clock, lock state
  if changedSince says nothing changed and the outbox is empty: publish device.json if due; return
  pull:
    devices = union(listDevices(group), devices known in cursors), minus removed devices
    for each device d != self:
      info = get device.json (format check, observe hlc, skip if left and fully read)
      if info.firstRetainedOpSeq > cursor[d].opSeq + 1: switch to snapshot (9.7) and restart pull
      for b = cursor[d].batch + 1 .. info.lastBatchNo:
        batch = get(batch path); missing or unparsable: stop reading d for this cycle
        verify batch.prevHash = cursor[d].hash, else fork handling (9.8)
        store ops; cursor[d] = (b, hash, last opSeq)
    read markers of every device (migration, migrated, group-deleted, removed)
    if new ops: state = replay(base, ops); nativeSync check (9.5); apply (8.4)
  push:
    if pendingBatch exists: createOnce it (identity check in 9.8), then commit
    else if outbox non-empty and the guard allows:
      encode the outbox as batch lastBatchNo+1 with prevHash; store as pendingBatch (and reserve a Drive ID) in one transaction
      createOnce; on created (or exists with identical bytes): lastBatchNo++, lastBatchHash, clear outbox entries and pendingBatch
  publish device.json if any field changed or a day has passed
  maybeCompact (9.7)
```

- **Triggers:** background start; the `pull` alarm; `windows.onFocusChanged` to a real window (at most every 10 seconds); 3 seconds after the last reconcile that recorded ops (push, then a pull).
- **Errors:** network errors back off for 1, 5, then 15 minutes. HTTP 401 or 403 pauses with reason `auth`. A full or read-only provider pauses with reason `provider`.

### 9.2 Groups (`engine/groups.ts`)

- **Create:**
  1. Pick the account, name, mode, encryption and passphrase, and mapping.
  2. Generate the group ID, then `createOnce(group.json)`. If it already exists, generate a new ID.
  3. Publish `device.json`.
  4. Record the mapped folder's current contents as creates with random IDs, in one `confirmed` batch.
- **Discover:** list `groups/` (WebDAV) or query `k=group` (Drive), and read each `group.json` for its name and mode.
- **Join:**
  1. Read the group header and unlock it if encrypted.
  2. Wait for a consistent view: two reads in a row of every `device.json` agree on `lastBatchNo`. If they don't, wait 5 seconds and retry, for up to 1 minute.
  3. Publish this device's `device.json` before its first batch. `bound` must come from an HLC that has already observed the server time and every op read.
  4. Load the newest complete snapshot (9.7) and every batch after it, then replay.
  5. Build the local tree `L` of the mapped folder.
  6. If the box is checked, record the browser default bookmarks found in `L` in `excluded` (reason `default`) and remove them from `L`.
  7. Save `L` to `localRestore`, and record a restore point at the current HLC.
  8. **Merge mode,** top-down over `L`:
     - **Folder:** link to the first unmatched visible group child folder with the same title. Otherwise, create it with a derived ID.
     - **Bookmark:** link to the first unmatched visible group child with the exact same URL. Otherwise, create it with a derived ID.
     - **Separator (Firefox):** create with a derived ID.
     - New items are appended after the last group child, in local order.
  9. **Replace mode:** clear the mapped folder through the port. These local items were never in the group, so nothing is recorded.
  10. Record the creates as one `confirmed` batch, then apply the merged state. The preview counts come from this plan before anything is written.
- **Undo join:**
  1. Revert (9.3) the nodes the join batch created, as of the restore point.
  2. Clear the mapped folder.
  3. Rebuild it from `localRestore`.
  4. Leave the group.
- **Leave:**
  1. Push the outbox.
  2. Publish `device.json` with `left: true`.
  3. Delete local group state, keeping the bookmarks.

  Other devices stop counting a left device toward the frontier. Once a complete snapshot covers its ops, any device may delete its folder (spec decision 4).
- **Remove device:** add its ID to this device's `markers/removed.json`. All devices exclude IDs from every `removed.json` when computing the frontier.

  A removed device that returns sees its ID removed. It takes a new device ID, loads the newest snapshot, and re-stamps its unpublished ops (new HLCs; `opSeq` from 1 under the new ID).
- **Delete everywhere:**
  1. Write `markers/group-deleted.json`.
  2. Delete every device's batches and snapshots. Deletes are idempotent, so other devices doing the same is harmless.

  Other devices pause with reason `group-deleted`, and their only resolution is leave. `group.json` and the markers are removed after 90 days.

### 9.3 Restore and revert (`core/restore.ts`)

- **Restore to T:** `then = visibleTree(replay(base, ops with hlc <= T))`, `now = visibleTree(state)`.
- **Plan:** walk `then` in preorder. For each node:
  - not visible now: `undelete` with its T placement and fields
  - visible but in a different place: `move`
  - visible with different fields: `update`

  Then `delete` every node visible now but not at T, in postorder. HLCs are assigned in that order. Preorder means a folder is always placed before anything is moved into it, so no restore op can hit a cycle skip.
- **Revert a set S (guard, undo join):** the same plan limited to S. If a node's parent at T is not visible now, the parent is added to S as well, recursively.
- **Checking the plan by simulation:** re-placing a folder (an undelete or a move) gives it a placement op that older deletes never saw. That can make descendants that were hidden only through an ancestor's delete visible again, for example a bookmark created after T inside a folder that a later restore brings back. So the engine replays the merged state plus the planned ops, stamped as they would be recorded, and compares the result with the target. Anything visible that should not be gets its own `delete`; anything missing gets an `undelete`. This repeats until the result matches exactly (`planRestoreExact`). The sequential oracle property found this case.
- **Recording:** the ops are recorded as one `confirmed` batch and applied.
- **Limits:** a restore needs `T >= base.frontier`. The history window and the 1-day minimum (9.7) keep that true for every T offered in the UI. The restore screen notes that changes from a browser that is still offline can arrive later.
- **Undo:** undoing a restore is a restore to the moment just before it.

### 9.4 Large change guard (`core/guard.ts`)

- **Size:** the number of distinct existing nodes that would be removed, moved or edited, counting only changes from unconfirmed batches (on apply) or unconfirmed outbox ops (on push). Additions are not counted, so importing or creating many bookmarks never pauses a group.
- **Trigger:** size above `guardPercent` of the visible node count without the change, and size of at least `guardMin`.
- **On apply:** nothing is applied, the cursors stay as they are, push is blocked, and the status becomes `paused(large-remote-change)` with the counts.
- **On push:** status becomes `paused(large-local-change)`.
- **Choices:**
  - **Apply / Upload:** proceed once. When uploading, the batch is marked `confirmed`.
  - **Revert the change:**
    - Remote: revert (9.3) the touched nodes to the HLC just before the first op of the change, as a `confirmed` batch, then apply.
    - Local: push the outbox together with a `confirmed` revert of the touched nodes.

  Both choices end with every device converging.

### 9.5 Native sync detection (`core/nativeSync.ts`)

Runs after new remote ops are replayed and before apply:

1. For each remote `create` r (bookmark or folder) whose node is visible in the merged state, look in `recentCreates` for an own create o whose node is still visible, with the same kind, title, URL (bookmarks only) and parent path (titles from the root).
2. For each pair, compare `(hlc, device)`:
   - **Own copy is later:** record a `delete` of o's node (its `seen` covers o). Move o's children that have no remote match into r's node. Point the local item's `idmap` entry and mirror at r's node.
   - **Remote copy is later:** do nothing. The other device removes its copy.
3. **Three or more pairs in one pull:** after the repairs are pushed, status becomes `paused(native-sync)`. The resolution screen shows the steps for turning off bookmark sync in Chrome, Edge and Firefox.
4. **During a Chromium import:** matching is disabled.

Known limit: edits that other devices made to the removed copy within the window are lost (they stay in history).

### 9.6 Status and pause reasons (`engine/status.ts`)

| Reason | Cleared by |
|---|---|
| `clock-skew` | the clock coming back within 2 minutes (checked every cycle) |
| `format-too-new` | updating the extension |
| `corrupt` | user acknowledgment after diagnostics export |
| `auth` | signing in again |
| `permission` | granting access again |
| `provider` | the provider accepting writes again (retried hourly) |
| `locked` | entering the passphrase |
| `root-changed`, `mapped-folder-missing`, `mapping-overlap` | picking a folder again, or leaving |
| `nothing-held` | holding a part again, or leaving |
| `large-remote-change`, `large-local-change` | the user's choice (9.4) |
| `native-sync` | the user confirming native bookmark sync is off |
| `migration` | the migration finishing (9.9) |
| `needs-join` | completing a join in merge mode |
| `group-deleted` | leaving |

Each reason sets the badge (`!` on a colored background) and shows one notification. Firefox notifications have no buttons, so clicking any notification opens the options page on that group. A paused group neither pushes nor pulls, except to check whether the cause has cleared.

### 9.7 Frontier, compaction and snapshots (`core/frontier.ts`)

- **Known devices K:** devices listed now, plus devices in `cursors`, minus left devices and removed devices. For a device whose `device.json` cannot be read this cycle, its last known value is used. If some device in K has never been read, compaction is skipped.
- **Stale devices:** devices whose `device.json` was last modified at the provider (server time) more than 90 days ago. They are excluded from the frontier but still read.
- **Frontier:** `F = min(bound of every non-stale device in K, own bound)`.
- **Compaction point:** `C = min(F, hlcOf(serverNow - max(historyWindow, 1 day)))`. The 1-day minimum also protects against devices this one cannot see yet: any device writing now stamps ops within 2 minutes of the server time.
- **When:** at most once a day, if at least 500 ops lie between the base frontier and `C`.
- **Steps:**
  1. Precondition: for every device with batches (stale ones included), `cursor[d].batch >= lastBatchNo` from the same `device.json` read that supplied its bound. That guarantees every op below `C` has been read.
  2. `snap = replay(base, ops with hlc < C)`. Coverage: for each device, the last `opSeq` with `hlc < C`. That is a prefix, because each device's HLCs increase with `opSeq`.
  3. `createOnce(devices/<self>/snapshots/<id>.json)`.
  4. Publish `device.json` with the new `firstRetainedOpSeq`.
  5. Delete this device's own batches whose ops are all at or below `snap.coverage[self]`.
  6. Keep this device's two newest snapshots and delete older ones.
  7. Locally, set `base = snap` and drop ops below `C`.

  The order matters: snapshot first, then `device.json`, then deletes. A reader therefore never sees a raised `firstRetainedOpSeq` without a snapshot that covers it.
- **Snapshot selection (join, falling behind):** a snapshot is **complete** if every device with batches has `firstRetainedOpSeq <= coverage[device] + 1`. Use the complete snapshot with the highest frontier. If its file disappears while loading, or a batch after it is missing, start the selection again.
- **Falling behind:** a device whose next needed batch was compacted away loads the newest complete snapshot as its new base and continues. Its outbox is safe: its bound was part of `F`, so its ops are above every frontier.
- **Returning stale device:** if its bound is below the newest complete snapshot's frontier, its unpublished ops are re-stamped with fresh HLCs (same `opSeq` values, in order) before pushing. Then it continues like a device that fell behind.
- **Tombstones:** v1 never drops deleted nodes from snapshots.

### 9.8 Device identity and forks (`engine/identity.ts`)

- **Before every push:** `createOnce` reports the existing files at the target batch path.
  - **One file with bytes identical to `pendingBatch`:** a retry after a crash. Commit it.
  - **Anything else:** another copy of this profile wrote this batch number. That is a fork.
- **Readers:** a fork is also seen by any reader that finds two files for one batch number (Drive), or a `prevHash` that does not match.
- **Fork point P:** the lowest batch number of the device with more than one version.
- **Readers' handling:**
  1. Drop every op of that device ID from batch P onward.
  2. Replay from the base. Replay is a pure function, so this is exact.
  3. Stop reading that device ID beyond P - 1, and add it to their `removed.json`.
- **Each copy's handling:**
  1. It discovers the fork when its own push or a read finds a version it did not write.
  2. It takes a new device ID.
  3. It republishes its own ops from batch P onward, plus its outbox, under the new ID: new `opSeq` values, fresh HLCs, same node IDs.
  4. In republished deletes, `seen[oldId]` is capped at `firstOpSeq(P) - 1`, and its own republished ops are mapped to the new ID.
  5. It continues as a normal device.

  Republished ops target the same nodes, so readers that had already applied one copy's version end in the same state as readers that had not.
- **Profile copies on WebDAV:** `createOnce` is exclusive, so only the later copy ever sees `exists`. Only that copy rotates, and the earlier copy keeps the ID.

### 9.9 Encryption migration (`engine/migrate.ts`)

1. **Announce:** the initiating device writes `markers/migration.json` with a new migration ID and its HLC.
2. **Freeze:** every device that sees a migration marker uses the one with the lowest HLC. It:
   1. Pushes its outbox to the old group g1.
   2. Publishes `device.json` with `frozenFor` set to that migration ID.
   3. Switches to status `migration`.

   From then on it keeps recording local changes but holds them instead of pushing. An initiator whose marker lost behaves like any other device.
3. **Wait:**
   - The winning initiator waits until every non-stale device in K has `frozenFor` set to the migration ID.
   - The options page lists devices still pending. The user can continue without them: their IDs go into the marker's `excluded`.
4. **Seed:**
   1. The initiator reads g1 completely and replays it.
   2. It builds the seed state from the visible nodes only. Every node keeps its stable ID, fields and register HLCs, but its `aliveEvents` and `placement.op` are rewritten to the synthetic reference `{ device: 'seed', opSeq: 0 }`.
   3. It creates g2 (`group.json` with the new encryption setting) and writes the seed as a snapshot in its g2 folder (frontier = the seed HLC, coverage `{}`).
   4. Finally it writes `markers/migrated.json` in g1, with the g2 ID and the g1 coverage per device that the seed includes.
5. **Move:**
   1. Each device that sees `migrated.json` unlocks g2 if needed (status `locked` until then).
   2. It loads the seed and re-stamps its held ops into g2: new `opSeq` from 1, fresh HLCs. In deletes, `seen` becomes `{ seed: 0 }` plus its own g2 references.
   3. It pushes them and continues in g2.
   4. Any op it published to g1 above `migrated.coverage[self]` (possible only for excluded devices) is re-stamped and republished the same way.
6. **Late devices:** a device that returns later finds `migrated.json` and does step 5 with its outbox. Its mirror and `idmap` stay valid, because the stable IDs are unchanged.
7. **Cleanup:** each device deletes its own g1 batches and snapshots after moving. `group.json` and `migrated.json` stay as a permanent pointer.
8. **History:** restores cannot reach back past a migration in v1.

Known limit: a delete held during the freeze covers every seed node. If another device had published a create into the same folder to g1 that the deleting device had not read, that create is hidden instead of surviving. The window is the few seconds between a device's last pull and its freeze.

## 10. Encryption (`core/codec.ts`)

- **Key:** `PBKDF2-SHA256`, 600,000 iterations, 16-byte random salt, producing an AES-GCM 256 key with `extractable: false`.
- **Key check:** `check` in the group header is the encryption of a fixed string under that key. Failing to decrypt it means the passphrase is wrong.
- **Per file:** 12-byte random IV, with the logical path as additional authenticated data. The encoded bytes are frozen before upload (6.2).
- **Key storage:** the `CryptoKey` object is stored in the `keys` store (structured clone keeps it non-extractable in both browsers). It is tagged with the current session ID, or `persistent` if the user chose "Remember on this device".
- Derivation takes up to about a second and runs once per session.

## 11. Duplicate finder (`core/dedupe.ts`)

```ts
function exactKey(u: URL): string     // scheme and host lowercased, fragment removed, trailing "/" removed from path
function possibleKey(u: URL): string  // exactKey, then: scheme dropped, leading "www." dropped, tracking params removed, params sorted
```

- **Tracking parameters:** `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`. The list lives in `dedupe.ts` and can grow.
- **Grouping:** group bookmarks across the whole browser by `exactKey`, then the rest by `possibleKey`. Groups of size 1 are dropped. Each entry shows its folder path and its group name, or "not synced".
- **Other URL schemes:** `javascript:`, `place:` and `data:` URLs use the raw string as their key.
- **Actions:** "Keep this one, remove the others" and "Move all into one folder" are run as a queue task through the port.
  - **Synced bookmarks:** reconcile turns the action into ops. The batch is marked `confirmed`, so it syncs and can be restored.
  - **Bookmarks outside every group:** the removed or moved items are saved in `localUndo`, which has an Undo button.

## 12. UI and background messages

The popup and the options page talk to the background only through typed messages:

```ts
type Command =
  | { t: 'status' }                                           // groups, statuses, pause reasons, last sync
  | { t: 'accounts.add'; provider: 'webdav' | 'gdrive'; config?: WebDavConfig }
  | { t: 'accounts.remove'; accountId: string }
  | { t: 'groups.discover'; accountId: string }
  | { t: 'groups.create'; spec: CreateSpec }
  | { t: 'groups.joinPreview'; spec: JoinSpec } | { t: 'groups.joinCommit'; previewId: string }
  | { t: 'groups.leave' | 'groups.undoJoin' | 'groups.deleteEverywhere'; groupId: string }
  | { t: 'devices.list' | 'devices.remove'; groupId: string; deviceId?: string }
  | { t: 'history.timeline'; groupId: string; before?: string }
  | { t: 'history.restorePreview'; groupId: string; at: string } | { t: 'history.restoreCommit'; previewId: string }
  | { t: 'pause.resolve'; groupId: string; choice: string }
  | { t: 'unlock'; groupId: string; passphrase: string; remember: boolean }
  | { t: 'encryption.toggle'; groupId: string; passphrase?: string }
  | { t: 'dedupe.scan' } | { t: 'dedupe.apply'; action: DedupeAction } | { t: 'dedupe.undo'; id: string }
  | { t: 'settings.get' } | { t: 'settings.set'; patch: Partial<Settings> }
  | { t: 'diagnostics.export'; includeUrls: boolean };
```

- **Short commands** use `runtime.sendMessage`.
- **Long commands** (join, restore, migration, dedupe apply, diagnostics export) use a `runtime.connect` port, which streams progress events and keeps the Chromium worker alive.
- Every command that changes anything runs as a queue task. While a long job runs, the UI shows its progress and disables other changing actions.
- `permissions.request` is called from the options page itself, inside the click handler, because it needs a user gesture.

## 13. Manifest and permissions

| Item | Chromium | Firefox |
|---|---|---|
| `permissions` | `bookmarks`, `storage`, `unlimitedStorage`, `alarms`, `notifications`, `identity` | same |
| `host_permissions` | `https://www.googleapis.com/*`, `https://oauth2.googleapis.com/*` | same |
| `optional_host_permissions` | `https://*/*`, `http://*/*` (WebDAV, requested per server; plain HTTP is for servers on the local network) | same |
| Background | service worker | event page (`background.scripts`), MV3 |
| Version floor | `minimum_chrome_version: "134"` | `strict_min_version: "140.0"` (needed for `optional_host_permissions` and `data_collection_permissions`) |
| ID pinning | `key` in the dev manifest | `browser_specific_settings.gecko.id` |

The test hook page used by end-to-end tests is included only in test builds.

## 14. Default bookmarks list

- `core/defaults.json` holds, per browser family, the default folders and bookmark URLs. Matching uses the host and path, ignoring query strings and the language segment, so different versions and locales match.
- **Sources:** fresh profiles of each browser in a few locales, checked when the extension is updated.
- **Contributions:** add entries to the JSON file, plus a test fixture.

## 15. Testing

### 15.1 Unit (Vitest)

- HLC ordering, serialization, observe, the corrupt-time check.
- Fractional keys, including concurrent inserts, the ID tie-break and equal keys.
- Every row of the table in 4.3, as named tests. Also "create on an existing node does not overwrite" and "restore of an inverted nesting".
- `reconcile` cases: sort, move within a group and between groups, folder restored with children, excluded item moved, mapped root missing, late echo events.
- Chromium `move` shim.
- URL normalization tables for the duplicate finder.
- Codec: version handling, encryption round trip, wrong passphrase, path swapped as AAD, frozen-bytes retry.

### 15.2 Property-based (fast-check) with the simulator

The simulator runs the real `engine/` with 3 to 5 devices. Each device has a fake `BookmarksPort` (Chromium or Firefox flavor), an in-memory `Store` and its own clock. All devices share one memory provider, which can:

- delay listing visibility per file
- fail uploads after writing
- return stale `device.json` files
- create Drive-style duplicate files

The simulator also keeps an oracle copy of every batch ever written, so compaction cannot hide history from the checks.

Generated actions:

- local edits: create, rename, change URL, move, delete item, delete folder, sort, insert next to a separator
- moves into and out of mappings, and between two groups
- joins, including two devices joining at once, in merge and replace mode
- restores to random earlier times; reverts
- push, pull, compaction, crashes between steps
- going offline; clock jitter within 2 minutes and occasional jumps beyond (which must pause)
- a device going stale and returning; profile copies (forks)
- an encryption migration

Guard pauses are resolved automatically by a policy chosen per run (always apply, or always revert).

Properties, checked after a final quiet phase in which every device syncs until nothing changes:

1. **Convergence:** all devices' group trees (in group terms, ignoring mapping location and Chromium separators) are identical (checklist 8).
2. **Structure:** no cycles; every visible node's parent is visible or a root.
3. **Sequential oracle:** in runs with a single device, or where every action is followed by a full sync of all devices, the final tree equals a plain in-memory tree model that applies the same actions directly. This catches rules that converge on the wrong answer, such as the bug fixed in 4.3.
4. **Snapshots:** replaying the oracle log from scratch gives the same state as replaying from any complete snapshot (checklist 15).
5. **No overwrites:** no batch path ever held two different contents, except in injected forks.
6. **No lost edits:** every edit made on a device that later synced is reflected in the final tree or in history (checklists 19, 24).

### 15.3 Adapter tests

The fake `BookmarksPort` reproduces each browser family's roots, event shapes and quirks:

- Chromium: `folderType`, account and local copies, `onChildrenReordered`, import events, the move index rule, restored folders announcing only themselves
- Firefox: GUIDs, separators, no reorder events, `onRemoved` without children
- Edge: names
- Vivaldi: Trash

Tests also deliver events late, duplicated and out of order.

### 15.4 Provider integration

The provider contract suite runs against:

- the memory provider
- a local WebDAV server (`rclone serve webdav ./tmp --addr 127.0.0.1:8080 --user test --pass test`), started by the test setup, including a concurrent `createOnce` race test
- Google Drive, manually, with a test account, before releases

### 15.5 End to end

- **Chromium:** Playwright with `channel: 'chromium'` launches two persistent profiles with the unpacked build, both pointed at the local WebDAV server. Scripts edit bookmarks through the test hook page and check the other profile. Sorting is driven through the `chrome://bookmarks` page.
- **Manual for v1:**
  - Firefox (`web-ext run`)
  - Edge, Brave and Vivaldi
  - Firefox sort
  - Brave's Google login setting
  - Google sign-in on both browser families

### 15.6 Checklist coverage

| Spec checklist | Covered by |
|---|---|
| 2 to 8, 13, 15, 28 | unit tests for 4.3, property tests |
| 1 | e2e (Chromium to Chromium), manual (Chrome to Firefox) |
| 9 to 12, 30 | simulator join tests, e2e for defaults |
| 14, 24, 25 | simulator (stale device, forks, clock) |
| 16, 17, 29 | simulator with a "native sync" channel between two fake trees |
| 18 | simulator plus guard unit tests |
| 19 | simulator (migration), codec tests |
| 20, 21 | adapter tests, e2e |
| 22 | unit (normalization), e2e (cleanup syncs and undoes) |
| 23 | codec tests |
| 26 | e2e for Chromium, manual for Firefox |
| 27 | manual |

## 16. Milestones

Each milestone ends with its tests green.

| # | Milestone | Exit criteria |
|---|---|---|
| M1 (done) | `core/` merge engine and `engine/` cycle over ports; memory provider; fake bookmarks; simulator | 4.3 unit tests; properties 1 to 3 and 5 in the simulator (whole-tree mapping, no compaction) |
| M2 | IndexedDB store; Chromium and Firefox ports and adapters; reconcile; apply; WebDAV provider and contract suite; minimal group create and merge join; status and badge; message protocol; Firefox Google sign-in spike | checklist 1, 2, 26 (e2e plus manual Firefox); WebDAV contract suite green |
| M3 | Frontier, compaction, snapshot selection, falling behind, stale devices, identity and forks, clock checks | properties 4 and 6; checklist 14, 15, 23, 24, 25 |
| M4 | Folder mappings, excluded items, full join (replace, defaults, undo), leave, remove device, delete group, overlap checks | checklist 9 to 12, 20, 21, 30 |
| M5 | Restore and revert with the history UI, large change guard, native sync detection | checklist 13, 16 to 18, 28, 29 |
| M6 | Duplicate finder | checklist 22 |
| M7 | Google Drive provider, encryption, locked state, migration | checklist 19; manual Drive pass on Chromium and Firefox |
| M8 | Options and popup polish, settings, diagnostics export, manual browser pass | checklist 27; full checklist pass |

## 17. Known limits in v1

- Deleted nodes are never dropped from snapshots, costing about 200 bytes each.
- Restores cannot reach back past an encryption migration.
- A delete held during an encryption migration can hide a concurrent create made just before the freeze (9.9).
- Edits made while the extension was off are timestamped at catch-up time.
- With two installs linked by native sync, other browsers may briefly see a duplicate before the repair arrives, and edits made to the removed copy within those minutes are lost (they stay in history).
- A batch made within 3 seconds of the browser closing uploads on the next start.
- On WebDAV, every 5-minute check reads each device's `device.json`, because there is no change feed.
