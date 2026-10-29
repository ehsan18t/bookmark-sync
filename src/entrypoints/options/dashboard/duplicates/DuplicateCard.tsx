import { useState } from 'preact/hooks';
import type { DuplicateGroup } from '../../../../core/dedupe.js';
import type { Command } from '../../../../messages.js';
import { Action } from '../../../../ui/components/Action.js';
import { send } from '../../../../ui/lib/messaging.js';
import { folders } from '../../../../ui/state/store.js';

interface DuplicateCardProps {
  d: DuplicateGroup;
  rescan: () => Promise<void>;
}

export function DuplicateCard({ d, rescan }: DuplicateCardProps) {
  const [keep, setKeep] = useState(d.items[0]!.localId);
  const [folder, setFolder] = useState(folders.value[0]?.id ?? '');
  const apply = async (action: Extract<Command, { t: 'applyDedupe' }>['action']) => {
    await send({ t: 'applyDedupe', action });
    await rescan();
  };
  return (
    <div class="card stack">
      <div class="row spread">
        <span class="pill">{d.level === 'exact' ? 'Same page' : 'Probably the same page'}</span>
        <span class="muted small">Pick the one to keep</span>
      </div>
      <div class="stack">
        {d.items.map((it) => (
          <label key={it.localId} class="check">
            <input type="radio" name={`dup-${d.key}`} checked={keep === it.localId} onChange={() => setKeep(it.localId)} />
            <span class="grow">
              {it.title || 'Untitled'}
              <div class="url">
                {it.url} · {it.path}
                {it.group ? ` · synced in ${it.group}` : ''}
              </div>
            </span>
          </label>
        ))}
      </div>
      <div class="row">
        <Action label="Keep this one, remove the rest" kind="primary" run={() => apply({ remove: d.items.map((i) => i.localId).filter((id) => id !== keep) })} />
        <span class="muted">or</span>
        <select class="narrow" value={folder} onChange={(e) => setFolder(e.currentTarget.value)}>
          {folders.value.map((f) => (
            <option key={f.id} value={f.id}>
              {f.path}
            </option>
          ))}
        </select>
        <Action label="Move them all here" run={() => apply({ move: d.items.map((i) => i.localId), folderId: folder })} />
      </div>
    </div>
  );
}
