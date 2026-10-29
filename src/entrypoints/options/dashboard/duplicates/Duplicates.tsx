import { useState } from 'preact/hooks';
import type { DuplicateGroup } from '../../../../core/dedupe.js';
import { Action } from '../../../../ui/components/Action.js';
import { Banner } from '../../../../ui/components/Banner.js';
import { EmptyState } from '../../../../ui/components/EmptyState.js';
import { useLoad } from '../../../../ui/hooks/useLoad.js';
import { plural, relativeTime } from '../../../../ui/lib/format.js';
import { send } from '../../../../ui/lib/messaging.js';
import { now } from '../../../../ui/state/store.js';
import { SectionTitle } from '../SectionTitle.js';
import { DuplicateCard, KEEP_ALL } from './DuplicateCard.js';

const setKey = (d: DuplicateGroup) => `${d.key}:${d.items.map((i) => i.localId).join()}`;

/** A copy that syncs, so other browsers keep it too. */
const syncedCopy = (d: DuplicateGroup) => (d.items.find((i) => i.group) ?? d.items[0]!).localId;

const defaultChoice = (d: DuplicateGroup) => (d.level === 'exact' ? syncedCopy(d) : KEEP_ALL);

export function Duplicates() {
  const [found, setFound] = useState<DuplicateGroup[] | null>(null);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const undo = useLoad(() => send<{ id: string; at: number; label: string }[]>({ t: 'localUndo' }), []);
  const scan = async () => {
    const groups = await send<DuplicateGroup[]>({ t: 'scanDuplicates' });
    setFound(groups);
    setKeep(Object.fromEntries(groups.map((d) => [setKey(d), defaultChoice(d)])));
    undo.reload();
  };
  const sets = found ?? [];
  const acted = sets.filter((d) => keep[setKey(d)] !== KEEP_ALL);
  const remove = acted.flatMap((d) => d.items.map((i) => i.localId).filter((id) => id !== keep[setKey(d)]));
  const setAll = (choose: (d: DuplicateGroup) => string) => setKeep(Object.fromEntries(sets.map((d) => [setKey(d), choose(d)])));
  return (
    <>
      <SectionTitle>
        <p class="muted">Find bookmarks that point to the same page. Nothing is removed until you choose, and synced cleanups can be undone from History.</p>
        <Action label="Find duplicates" kind="primary" icon="copy" busy="Searching…" run={scan} />
      </SectionTitle>
      {undo.data?.map((u) => (
        <Banner key={u.id} kind="info" icon="history">
          <div class="row spread">
            <span>
              {u.label} · {relativeTime(u.at, now.value)}
            </span>
            <Action
              label="Undo"
              run={async () => {
                await send({ t: 'undoLocal', id: u.id });
                undo.reload();
              }}
            />
          </div>
        </Banner>
      ))}
      {found &&
        (found.length ? (
          <div class="stack">
            <h3>{plural(found.length, 'set', 'sets')} of duplicates</h3>
            <div class="dupe-bar">
              <span class="grow" role="status">
                {remove.length ? `Removes ${plural(remove.length, 'bookmark', 'bookmarks')} from ${plural(acted.length, 'set', 'sets')}` : 'Nothing to remove'}
                {sets.length > acted.length && ` · ${plural(sets.length - acted.length, 'set', 'sets')} left as ${sets.length - acted.length === 1 ? 'it is' : 'they are'}`}
              </span>
              <div class="row snug">
                <button type="button" class="ghost" onClick={() => setAll(syncedCopy)}>
                  Keep the synced copy everywhere
                </button>
                <button type="button" class="ghost" onClick={() => setAll(() => KEEP_ALL)}>
                  Leave all as they are
                </button>
                <Action
                  label="Apply"
                  kind="primary"
                  busy="Removing…"
                  disabled={!remove.length}
                  confirm={`Remove ${plural(remove.length, 'bookmark', 'bookmarks')}? Synced ones are removed in your other browsers too. You can undo this.`}
                  run={async () => {
                    await send({ t: 'applyDedupe', action: { remove } });
                    await scan();
                  }}
                />
              </div>
            </div>
            {found.map((d) => (
              <DuplicateCard key={setKey(d)} d={d} keep={keep[setKey(d)] ?? KEEP_ALL} onKeep={(id) => setKeep((k) => ({ ...k, [setKey(d)]: id }))} rescan={scan} />
            ))}
          </div>
        ) : (
          <EmptyState icon="circle-check" title="No duplicates" text="Every bookmark points to a different page." />
        ))}
    </>
  );
}
