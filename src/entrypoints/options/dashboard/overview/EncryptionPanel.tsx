import { useState } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { Field } from '../../../../ui/components/Field.js';
import { send } from '../../../../ui/lib/messaging.js';
import { load } from '../../../../ui/state/store.js';

interface EncryptionPanelProps {
  g: GroupSummary;
  onDone: () => void;
}

export function EncryptionPanel({ g, onDone }: EncryptionPanelProps) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const run = async () => {
    if (!g.encrypted) {
      if (pass.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      if (pass !== again) throw new Error('The passphrases don’t match.');
    }
    await send({ t: 'setEncryption', groupId: g.groupId, passphrase: g.encrypted ? null : pass });
    await load();
    onDone();
  };
  return (
    <div class="card stack">
      <p class="muted">
        {g.encrypted
          ? 'Your bookmarks will be stored without encryption. Every browser moves over by itself, and nothing is lost.'
          : 'Your bookmarks will be stored encrypted. Every browser needs the passphrase, and it can’t be recovered if you lose it.'}
      </p>
      {!g.encrypted && (
        <div class="fields-2">
          <Field label="Passphrase">
            <input type="password" autocomplete="new-password" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
          </Field>
          <Field label="Repeat passphrase">
            <input type="password" autocomplete="new-password" value={again} onInput={(e) => setAgain(e.currentTarget.value)} />
          </Field>
        </div>
      )}
      <Action label={g.encrypted ? 'Turn off encryption' : 'Turn on encryption'} kind="primary" busy="Switching…" run={run} />
    </div>
  );
}
