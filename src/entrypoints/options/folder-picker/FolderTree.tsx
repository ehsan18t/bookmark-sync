import { useId, useMemo, useState } from 'preact/hooks';
import { Icon } from '../../../ui/components/Icon.js';
import type { TreeItem } from './treeItems.js';
import { ancestors, toggle } from './treeSelection.js';

interface FolderTreeProps {
  items: TreeItem[];
  multi: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
}

/**
 * A collapsible folder tree. With `multi`, ticking a folder includes everything inside it, so its subfolders show
 * as included and can't be ticked on their own; without it, one folder is picked.
 */
export function FolderTree({ items, multi, value, onChange, label }: FolderTreeProps) {
  const name = useId();
  const { byId, kids } = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const kids = new Map<string | null, TreeItem[]>();
    for (const i of items) {
      const p = i.parent !== null && byId.has(i.parent) ? i.parent : null;
      const list = kids.get(p);
      if (list) list.push(i);
      else kids.set(p, [i]);
    }
    return { byId, kids };
  }, [items]);
  const picked = useMemo(() => new Set(value), [value]);
  const [open, setOpenIds] = useState(() => new Set([...(kids.get(null) ?? []).map((i) => i.id), ...value.flatMap((id) => ancestors(byId, id))]));
  const setOpen = (id: string, on: boolean) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const branch = (parent: string | null, depth: number) => (
    <ul role={parent === null ? 'tree' : 'group'} aria-label={parent === null ? label : undefined}>
      {(kids.get(parent) ?? []).map((item) => {
        const children = kids.has(item.id);
        const expanded = open.has(item.id);
        const included = multi && ancestors(byId, item.id).some((a) => picked.has(a));
        return (
          // biome-ignore lint/a11y/useFocusableInteractive: keyboard focus goes to the twisty and the checkbox inside the row
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
                  checked={picked.has(item.id) || included}
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
