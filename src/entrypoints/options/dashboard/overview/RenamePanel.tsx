import { useEffect, useRef, useState } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { Field } from '../../../../ui/components/Field.js';
import { sendAndReload } from '../../../../ui/state/store.js';

interface RenamePanelProps {
  g: GroupSummary;
  onDone: () => void;
}

export function RenamePanel({ g, onDone }: RenamePanelProps) {
  const [name, setName] = useState(g.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  return (
    <div class="card stack">
      <Field label="New name" hint="Every browser in this sync shows the new name after its next sync.">
        <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} ref={input} />
      </Field>
      <div class="row">
        <Action label="Save name" kind="primary" busy="Renaming…" run={async () => {
            await sendAndReload({ t: 'rename', groupId: g.groupId, name });
            onDone();
          }} />
      </div>
    </div>
  );
}
