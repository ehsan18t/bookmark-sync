import { useState } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { sendAndReload } from '../../../../ui/state/store.js';
import { AddFromSync } from './AddFromSync.js';
import { AddLocal } from './AddLocal.js';
import { MovePart } from './MovePart.js';

type Adder = { kind: 'local' } | { kind: 'sync' } | { kind: 'move'; part: string; path: string };

interface FoldersPanelProps {
  g: GroupSummary;
}

export function FoldersPanel({ g }: FoldersPanelProps) {
  const [adder, setAdder] = useState<Adder | null>(null);
  const close = () => setAdder(null);
  return (
    <div class="card stack">
      <h3>Folders synced in this browser</h3>
      {g.parts.length ? (
        <div class="part-list">
          {g.parts.map((p) => (
            <div key={p.part} class="row spread part">
              <span class="row">
                <Icon name="folder" />
                {p.path}
              </span>
              <div class="row">
                <button type="button" class="ghost" onClick={() => setAdder({ kind: 'move', part: p.part, path: p.path })}>
                  Move it
                </button>
                <Action
                  label="Stop syncing it here"
                  kind="ghost"
                  confirm="Stop syncing this folder in this browser? It stays here as it is, and other browsers keep syncing it."
                  run={() => sendAndReload({ t: 'removePart', groupId: g.groupId, part: p.part, everywhere: false })}
                />
                {p.top && (
                  <Action
                    label="Remove for every browser"
                    kind="danger"
                    confirm="Remove this folder from the sync for every browser? Each browser keeps its copy, but it no longer syncs anywhere."
                    run={() => sendAndReload({ t: 'removePart', groupId: g.groupId, part: p.part, everywhere: true })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p class="muted">No folders of this sync are synced here.</p>
      )}
      <div class="row">
        {g.mode === 'folder' && (
          <button type="button" onClick={() => setAdder({ kind: 'local' })}>
            <Icon name="plus" />
            Add a folder from this browser
          </button>
        )}
        <button type="button" onClick={() => setAdder({ kind: 'sync' })}>
          <Icon name="folders" />
          Sync another folder of this sync here
        </button>
      </div>
      {adder?.kind === 'local' && <AddLocal key="local" g={g} onClose={close} />}
      {adder?.kind === 'sync' && <AddFromSync key="sync" g={g} onClose={close} />}
      {adder?.kind === 'move' && <MovePart key={adder.part} g={g} part={adder.part} path={adder.path} onClose={close} />}
    </div>
  );
}
