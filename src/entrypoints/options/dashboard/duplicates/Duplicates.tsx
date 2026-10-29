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
import { DuplicateCard } from './DuplicateCard.js';

export function Duplicates() {
  const [found, setFound] = useState<DuplicateGroup[] | null>(null);
  const undo = useLoad(() => send<{ id: string; at: number; label: string }[]>({ t: 'localUndo' }), []);
  const scan = async () => {
    setFound(await send<DuplicateGroup[]>({ t: 'scanDuplicates' }));
    undo.reload();
  };
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
            <Action label="Undo" run={async () => {
                await send({ t: 'undoLocal', id: u.id });
                undo.reload();
              }} />
          </div>
        </Banner>
      ))}
      {found &&
        (found.length ? (
          <div class="stack">
            <h3>{plural(found.length, 'set', 'sets')} of duplicates</h3>
            {found.map((d) => (
              <DuplicateCard key={`${d.key}:${d.items.map((i) => i.localId).join()}`} d={d} rescan={scan} />
            ))}
          </div>
        ) : (
          <EmptyState icon="circle-check" title="No duplicates" text="Every bookmark points to a different page." />
        ))}
    </>
  );
}
