import { useState } from 'preact/hooks';
import { Action } from '../../../../ui/components/Action.js';
import { send, withTakeover } from '../../../../ui/lib/messaging.js';
import { load } from '../../../../ui/state/store.js';
import { FolderTree } from '../../folder-picker/FolderTree.js';
import { useLocalItems } from '../../folder-picker/useLocalItems.js';

interface ReplaceFolderProps {
  groupId: string;
  part: string;
}

/** Picks a new local folder for a synced folder that was deleted here. */
export function ReplaceFolder({ groupId, part }: ReplaceFolderProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const items = useLocalItems(groupId);
  return (
    <div class="stack">
      <FolderTree items={items} multi={false} value={picked} onChange={setPicked} label="New folder for it" />
      <Action
        label="Use this folder"
        kind="primary"
        run={async () => {
          if (!picked[0]) throw new Error('Pick a folder.');
          await withTakeover((takeover) => send({ t: 'movePart', groupId, part, folderId: picked[0]!, takeover }));
          await load();
        }}
      />
    </div>
  );
}
