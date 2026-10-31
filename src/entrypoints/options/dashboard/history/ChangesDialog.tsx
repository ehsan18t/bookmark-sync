import { useEffect, useRef } from 'preact/hooks';
import type { ChangeDetail } from '../../../../core/changes.js';
import type { TimelineEntry } from '../../../../engine/group.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { hlcTime, plural } from '../../../../ui/lib/format.js';
import type { IconName } from '../../../../ui/lib/icons.js';
import { actionText, folderText, itemName } from './timelineText.js';

const ICON: Record<ChangeDetail['type'], IconName> = { create: 'plus', update: 'pencil', move: 'arrows-move', delete: 'trash', undelete: 'restore' };
const FIELD_TEXT = { title: 'Name', url: 'Address' };

interface ChangesDialogProps {
  entry: TimelineEntry;
  who: string;
  onClose: () => void;
}

export function ChangesDialog({ entry, who, onClose }: ChangesDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const more = entry.count - entry.changes.length;
  return (
    <dialog ref={ref} class="changes-dialog" onClose={onClose}>
      <div class="changes-head">
        <div>
          <h3>Changes from {who}</h3>
          <div class="meta">
            {entry.from === entry.to ? hlcTime(entry.to) : `${hlcTime(entry.from)} to ${hlcTime(entry.to)}`} · {plural(entry.count, 'change', 'changes')}
          </div>
        </div>
        <button type="button" class="ghost" aria-label="Close" onClick={() => ref.current?.close()}>
          <Icon name="x" />
        </button>
      </div>
      <ul class="list changes-list">
        {entry.changes.map((c, i) => (
          <li key={i}>
            <Icon name={ICON[c.type]} />
            <div class="grow">
              <div>
                <span class="change-action">{actionText(c)}</span> {itemName(c)}
                {c.kind === 'folder' && <span class="meta"> (folder{c.items !== undefined && `, ${plural(c.items, 'item', 'items')}`})</span>}
              </div>
              {c.kind === 'bookmark' && c.type !== 'update' && c.url && <div class="url">{c.url}</div>}
              {place(c) && <div class="meta">{place(c)}</div>}
              {c.edits?.map((d) => (
                <div key={d.field} class="change-edit">
                  {FIELD_TEXT[d.field]}: <del>{d.before || '(empty)'}</del> → <ins>{d.after || '(empty)'}</ins>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {more > 0 && <p class="muted changes-more">and {plural(more, 'more change', 'more changes')}</p>}
    </dialog>
  );
}

function place(c: ChangeDetail): string {
  const at = folderText(c.folder);
  if (c.type === 'move' && c.from) return `${folderText(c.from) || 'top level'} → ${at || 'top level'}`;
  if (!at) return '';
  return c.type === 'delete' ? `from ${at}` : `in ${at}`;
}
