import { useState } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import type { GroupFolder } from '../../../../engine/group.js';
import { Action } from '../../../../ui/components/Action.js';
import { ErrorText } from '../../../../ui/components/ErrorText.js';
import { useLoad } from '../../../../ui/hooks/useLoad.js';
import { send, withTakeover } from '../../../../ui/lib/messaging.js';
import { folders, groups, load } from '../../../../ui/state/store.js';
import { FolderTree } from '../../folder-picker/FolderTree.js';
import { Placements } from '../../folder-picker/Placements.js';
import { groupItems, localItems, placementChoices } from '../../folder-picker/treeItems.js';
import { CancelButton } from './CancelButton.js';

interface AddFromSyncProps {
  g: GroupSummary;
  onClose: () => void;
}

export function AddFromSync({ g, onClose }: AddFromSyncProps) {
  const r = useLoad(() => send<{ mode: 'everything' | 'folder'; folders: GroupFolder[] }>({ t: 'groupFolders', accountId: g.accountId, groupId: g.groupId }), [g.accountId, g.groupId]);
  const [picked, setPicked] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  if (r.error) return <ErrorText>{r.error}</ErrorText>;
  if (!r.data) return <p class="muted">Reading the folders in this sync…</p>;
  const { mode, folders: groupFolders } = r.data;
  const items = groupItems(mode, groupFolders, folders.value).map((i) => (g.parts.some((p) => p.part === i.id) ? { ...i, blocked: 'Synced here' } : i));
  return (
    <div class="stack">
      <FolderTree items={items} multi value={picked} onChange={setPicked} label="Folders of this sync" />
      <Placements
        mode={mode}
        groupFolders={groupFolders}
        items={items}
        local={folders.value}
        localTree={localItems(folders.value, groups.value)}
        picked={picked}
        chosen={chosen}
        onChange={setChosen}
      />
      <div class="row">
        <Action
          label="Sync them here"
          kind="primary"
          run={async () => {
            if (!picked.length) throw new Error('Tick at least one folder.');
            await withTakeover((takeover) => send({ t: 'addParts', groupId: g.groupId, parts: placementChoices(mode, groupFolders, picked, chosen), takeover }));
            await load();
            onClose();
          }}
        />
        <CancelButton onClose={onClose} />
      </div>
    </div>
  );
}
