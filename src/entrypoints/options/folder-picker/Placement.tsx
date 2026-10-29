import { useSignal } from '@preact/signals';
import type { LocalFolder } from '../../../engine/app.js';
import type { GroupFolder } from '../../../engine/group.js';
import { FolderTree } from './FolderTree.js';
import { findLocal, groupHint, hintText, type TreeItem } from './treeItems.js';

export interface PlacementContext {
  mode: 'everything' | 'folder';
  groupFolders: GroupFolder[];
  items: TreeItem[];
  local: LocalFolder[];
  localTree: TreeItem[];
  chosen: Record<string, string>;
  onChange: (chosen: Record<string, string>) => void;
}

interface PlacementProps extends PlacementContext {
  id: string;
}

export function Placement({ id, mode, groupFolders, items, local, localTree, chosen, onChange }: PlacementProps) {
  const picking = useSignal(false);
  const title = items.find((i) => i.id === id)?.title ?? id;
  const hint = groupHint(mode, groupFolders, id);
  const own = chosen[id];
  const existing = own ?? findLocal(local, hint);
  const where = existing ? (local.find((f) => f.id === existing)?.path ?? hintText(local, hint)) : hintText(local, hint);
  const choose = (folderId: string | undefined) => {
    const { [id]: _, ...rest } = chosen;
    onChange(folderId ? { ...rest, [id]: folderId } : rest);
  };
  return (
    <div class="placement">
      <div class="row spread">
        <div class="stack tight">
          <b>{title}</b>
          <span class="muted small">{existing ? `Goes into ${where}` : `A new folder is made at ${where}`}</span>
        </div>
        <button type="button" class="ghost" onClick={() => (picking.value = !picking.value)}>
          {own ? 'Change' : 'Put it somewhere else'}
        </button>
      </div>
      {picking.value && (
        <div class="stack">
          <FolderTree items={localTree} multi={false} value={existing ? [existing] : []} onChange={(ids) => choose(ids[0])} label={`Where “${title}” goes`} />
          {own && (
            <button type="button" class="ghost" onClick={() => choose(undefined)}>
              Use the same place as the other browsers
            </button>
          )}
        </div>
      )}
    </div>
  );
}
