import { useSignal } from '@preact/signals';
import { useId, useMemo } from 'preact/hooks';
import type { LocalFolder } from '../../engine/app.js';
import type { GroupFolder } from '../../engine/group.js';
import { Icon } from '../../ui/components.js';
import { findLocal, groupHint, hintText, type TreeItem } from './folders.js';

function ancestors(byId: Map<string, TreeItem>, id: string): string[] {
  const out: string[] = [];
  for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent ?? null) out.push(p);
  return out;
}

/** With `multi`, ticking a folder takes in its subfolders, so ticks below it are dropped. */
export function toggle(items: TreeItem[], multi: boolean, value: string[], id: string, on: boolean): string[] {
  if (!multi) return on ? [id] : [];
  if (!on) return value.filter((v) => v !== id);
  const byId = new Map(items.map((i) => [i.id, i]));
  return [...value.filter((v) => !ancestors(byId, v).includes(id)), id];
}

/**
 * A collapsible folder tree. With `multi`, ticking a folder includes everything inside it, so its subfolders show
 * as included and can't be ticked on their own; without it, one folder is picked.
 */
export function FolderTree({ items, multi, value, onChange, label }: { items: TreeItem[]; multi: boolean; value: string[]; onChange: (ids: string[]) => void; label: string }) {
  const name = useId();
  const { byId, kids } = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const kids = new Map<string | null, TreeItem[]>();
    for (const i of items) {
      const p = i.parent !== null && byId.has(i.parent) ? i.parent : null;
      kids.set(p, [...(kids.get(p) ?? []), i]);
    }
    return { byId, kids };
  }, [items]);
  const open = useSignal<Set<string>>(new Set([...(kids.get(null) ?? []).map((i) => i.id), ...value.flatMap((id) => ancestors(byId, id))]));
  const setOpen = (id: string, on: boolean) => {
    const next = new Set(open.value);
    if (on) next.add(id);
    else next.delete(id);
    open.value = next;
  };

  const branch = (parent: string | null, depth: number) => (
    <ul role={parent === null ? 'tree' : 'group'} aria-label={parent === null ? label : undefined}>
      {(kids.get(parent) ?? []).map((item) => {
        const children = kids.has(item.id);
        const expanded = open.value.has(item.id);
        const included = multi && ancestors(byId, item.id).some((a) => value.includes(a));
        return (
          <li key={item.id} role="treeitem" aria-expanded={children ? expanded : undefined}>
            <div class={`tree-row${item.blocked ? ' blocked' : ''}${included ? ' included' : ''}`} style={`--depth:${depth}`}>
              {children ? (
                <button type="button" class="twisty" aria-label={`Show folders in ${item.title}`} aria-expanded={expanded} onClick={() => setOpen(item.id, !expanded)}>
                  <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
                </button>
              ) : (
                <span class="twisty" />
              )}
              <label>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={name}
                  value={item.id}
                  checked={value.includes(item.id) || included}
                  disabled={!!item.blocked || included}
                  onChange={(e) => onChange(toggle(items, multi, value, item.id, e.currentTarget.checked))}
                />
                <Icon name="folder" />
                <span class="tree-title">{item.title}</span>
                {(item.blocked ?? item.note) && <span class="tree-note">{item.blocked ?? item.note}</span>}
              </label>
            </div>
            {children && expanded && branch(item.id, depth + 1)}
          </li>
        );
      })}
    </ul>
  );
  return <div class="tree">{branch(null, 0)}</div>;
}

/**
 * One row per picked group folder, saying where it goes in this browser. Each defaults to the same place
 * (created if missing) and can be pointed at any local folder instead.
 */
export function Placements(props: {
  mode: 'everything' | 'folder';
  groupFolders: GroupFolder[];
  items: TreeItem[];
  local: LocalFolder[];
  localTree: TreeItem[];
  picked: string[];
  chosen: Record<string, string>;
  onChange: (chosen: Record<string, string>) => void;
}) {
  return (
    <div class="placements stack">
      {props.picked.map((id) => (
        <Placement key={id} id={id} {...props} />
      ))}
    </div>
  );
}

function Placement({ id, mode, groupFolders, items, local, localTree, chosen, onChange }: Parameters<typeof Placements>[0] & { id: string }) {
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
        <div class="stack" style="gap:2px">
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
