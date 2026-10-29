import { useState } from 'preact/hooks';
import type { DuplicateGroup } from '../../../../core/dedupe.js';
import { Action } from '../../../../ui/components/Action.js';
import { send } from '../../../../ui/lib/messaging.js';
import { folders } from '../../../../ui/state/store.js';

/** The choice that leaves every copy in a set as it is. */
export const KEEP_ALL = '';

interface DuplicateCardProps {
  d: DuplicateGroup;
  keep: string;
  onKeep: (localId: string) => void;
  rescan: () => Promise<void>;
}

export function DuplicateCard({ d, keep, onKeep, rescan }: DuplicateCardProps) {
  const [folder, setFolder] = useState(folders.value[0]?.id ?? '');
  const name = `dup-${d.key}-${d.items[0]!.localId}`;
  return (
    <div class="card stack">
      <div class="row spread">
        <span class="pill">{d.level === 'exact' ? 'Same page' : 'Probably the same page'}</span>
        <span class="muted small">Pick the one to keep</span>
      </div>
      <div class="stack">
        {d.items.map((it) => (
          <label key={it.localId} class="check">
            <input type="radio" name={name} checked={keep === it.localId} onChange={() => onKeep(it.localId)} />
            <span class="grow">
              {it.title || 'Untitled'}
              <div class="url">
                {it.url} · {it.path}
                {it.group ? ` · synced in ${it.group}` : ''}
              </div>
            </span>
          </label>
        ))}
        <label class="check">
          <input type="radio" name={name} checked={keep === KEEP_ALL} onChange={() => onKeep(KEEP_ALL)} />
          <span class="grow muted">Keep all of these</span>
        </label>
      </div>
      <div class="row">
        <span class="muted small">Or move them all to</span>
        <select class="narrow" value={folder} onChange={(e) => setFolder(e.currentTarget.value)}>
          {folders.value.map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
        </select>
        <Action
          label="Move"
          run={async () => {
            await send({ t: 'applyDedupe', action: { move: d.items.map((i) => i.localId), folderId: folder } });
            await rescan();
          }}
        />
      </div>
    </div>
  );
}
