import { useState } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { NewPassphraseFields } from '../../../../ui/components/NewPassphraseFields.js';
import { send } from '../../../../ui/lib/messaging.js';
import { checkNewPassphrase } from '../../../../ui/lib/passphrase.js';
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
      checkNewPassphrase(pass, again);
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
      {!g.encrypted && <NewPassphraseFields pass={pass} again={again} onPass={setPass} onAgain={setAgain} />}
      <Action label={g.encrypted ? 'Turn off encryption' : 'Turn on encryption'} kind="primary" busy="Switching…" run={run} />
    </div>
  );
}
