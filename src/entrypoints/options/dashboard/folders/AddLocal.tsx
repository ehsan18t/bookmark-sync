import { useMemo, useState } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { send, withTakeover } from '../../../../ui/lib/messaging.js';
import { load } from '../../../../ui/state/store.js';
import { FolderTree } from '../../folder-picker/FolderTree.js';
import { blockHeld } from '../../folder-picker/treeItems.js';
import { useLocalItems } from '../../folder-picker/useLocalItems.js';
import { CancelButton } from './CancelButton.js';

interface AddLocalProps {
  g: GroupSummary;
  onClose: () => void;
}

export function AddLocal({ g, onClose }: AddLocalProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const local = useLocalItems(g.groupId);
  const items = useMemo(() => blockHeld(local, g.held), [local, g.held]);
  return (
    <div class="stack">
      <p class="muted small">Each ticked folder is added to the sync for every browser.</p>
      <FolderTree items={items} multi value={picked} onChange={setPicked} label="Folders to add" />
      <div class="row">
        <Action
          label="Add to the sync"
          kind="primary"
          run={async () => {
            if (!picked.length) throw new Error('Tick at least one folder.');
            await withTakeover((takeover) => send({ t: 'addTops', groupId: g.groupId, folderIds: picked, takeover }));
            await load();
            onClose();
          }}
        />
        <CancelButton onClose={onClose} />
      </div>
    </div>
  );
}
