# bookmark-sync

A browser extension that syncs bookmarks between Chromium browsers and Firefox through storage you choose (WebDAV, Google Drive, more later). It records every bookmark change as it happens and merges changes from different browsers with fixed, tested rules, instead of comparing whole bookmark trees.

- [SPEC.md](SPEC.md): what the extension does, the decisions behind it, and the acceptance checklist.
- [IMPLEMENTATION.md](IMPLEMENTATION.md): how it is built, module by module, and the milestone plan.

## Status

Milestone M1 is done: the merge engine and the sync cycle, running against an in-memory storage provider and a fake bookmarks API. There is no browser extension yet; that starts in M2.

## Layout

- `src/core/`: pure logic (clock, IDs, positions, replay, visibility, trees, reconcile, restore, file format). No browser or network APIs.
- `src/engine/`: the per-group sync engine, which reaches the browser, the provider and local storage only through the interfaces in `ports.ts`.
- `src/storage/`: storage providers (only the in-memory one so far) and the file layout.
- `test/sim/`: the multi-device simulator and a fake bookmarks API.
- `test/property/`: randomized tests that run the real engine on several simulated browsers.

## Running the tests

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` runs the type checker and every test. The randomized tests pick new random cases on every run; when one fails, fast-check shrinks it to a minimal case and prints it, which can take a few minutes. Setting `ORACLE_TRACE=1` prints each step of the sequential oracle test.
