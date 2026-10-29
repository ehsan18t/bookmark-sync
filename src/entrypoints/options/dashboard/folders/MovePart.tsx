import { useState } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { send, withTakeover } from '../../../../ui/lib/messaging.js';
import { folders, groups, load } from '../../../../ui/state/store.js';
import { FolderTree } from '../../folder-picker/FolderTree.js';
import { localItems } from '../../folder-picker/treeItems.js';
import { CancelButton } from './CancelButton.js';

interface MovePartProps {
  g: GroupSummary;
  part: string;
  path: string;
  onClose: () => void;
}

export function MovePart({ g, part, path, onClose }: MovePartProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const items = localItems(folders.value, groups.value, g.groupId).map((i) => (g.held.includes(i.id) ? { ...i, blocked: 'Synced here' } : i));
  return (
    <div class="stack">
      <p class="muted small">Pick the folder that should hold “{path}” from now on. What it already contains is added to the sync. The current folder stays as it is but no longer syncs.</p>
      <FolderTree items={items} multi={false} value={picked} onChange={setPicked} label={`New place for ${path}`} />
      <div class="row">
        <Action
          label="Use this folder"
          kind="primary"
          run={async () => {
            if (!picked[0]) throw new Error('Pick a folder.');
            await withTakeover((takeover) => send({ t: 'movePart', groupId: g.groupId, part, folderId: picked[0]!, takeover }));
            await load();
            onClose();
          }}
        />
        <CancelButton onClose={onClose} />
      </div>
    </div>
  );
}
