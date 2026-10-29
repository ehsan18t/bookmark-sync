import { useState } from 'preact/hooks';
import type { Target } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { Advanced } from '../../../../ui/components/Advanced.js';
import { NewPassphraseFields } from '../../../../ui/components/NewPassphraseFields.js';
import { RadioCards } from '../../../../ui/components/RadioCards.js';
import { send } from '../../../../ui/lib/messaging.js';
import { checkNewPassphrase } from '../../../../ui/lib/passphrase.js';
import { storageWithAccount } from '../../../../ui/lib/storageLabels.js';
import { load, type PublicAccount } from '../../../../ui/state/store.js';
import { FolderTree } from '../../folder-picker/FolderTree.js';
import { useLocalItems } from '../../folder-picker/useLocalItems.js';
import { BackButton } from '../BackButton.js';
import { StepHead } from '../StepHead.js';
import type { Go } from '../steps.js';

interface CreateStepProps {
  account: PublicAccount;
  name: string;
  go: Go;
}

export function CreateStep({ account, name, go }: CreateStepProps) {
  const [mode, setMode] = useState<'everything' | 'folder'>('everything');
  const [picked, setPicked] = useState<string[]>([]);
  const [defaults, setDefaults] = useState(true);
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const localTree = useLocalItems();
  const start = async () => {
    if (encrypt) {
      checkNewPassphrase(pass, again);
    }
    if (mode === 'folder' && !picked.length) throw new Error('Tick at least one folder to sync.');
    const target: Target = mode === 'folder' ? { kind: 'folders', folderIds: picked } : { kind: 'whole' };
    const groupId = await send<string>({ t: 'create', input: { accountId: account.id, name, mode, target, passphrase: encrypt ? pass : undefined, ignoreDefaults: defaults } });
    await load();
    go({ id: 'done', account, groupId, joined: false });
  };
  return (
    <div class="stack lg">
      <StepHead title="What should sync?">
        Starting “{name}” on {storageWithAccount(account)}.
      </StepHead>
      <RadioCards
        name="what"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'everything', title: 'All bookmarks', desc: 'The bookmarks bar, other bookmarks, and every folder in them.', icon: 'bookmarks', badge: 'Recommended' },
          { value: 'folder', title: 'Choose folders', desc: 'Only the folders you tick. Good for sharing some bookmarks between browsers.', icon: 'folders' },
        ]}
      />
      {mode === 'folder' && (
        <div class="stack">
          <h3>Folders to sync</h3>
          <p class="muted small">
            Tick as many as you like. A ticked folder syncs with everything inside it. Other browsers can put each one wherever they want. A folder another sync uses can be ticked too: changes in it
            then reach both syncs.
          </p>
          <FolderTree items={localTree} multi value={picked} onChange={setPicked} label="Folders to sync" />
        </div>
      )}
      <label class="check">
        <input type="checkbox" checked={defaults} onChange={(e) => setDefaults(e.currentTarget.checked)} />
        <span>
          Leave out the sample bookmarks the browser came with
          <div class="hint">So every browser doesn’t add its own copies.</div>
        </span>
      </label>
      <Advanced summary="Advanced">
        <label class="check">
          <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.currentTarget.checked)} />
          <span>
            Encrypt with a passphrase
            <div class="hint">The storage only sees scrambled data. Every browser needs the passphrase, and it can’t be recovered if you lose it.</div>
          </span>
        </label>
        {encrypt && <NewPassphraseFields pass={pass} again={again} onPass={setPass} onAgain={setAgain} hint="At least 8 characters." />}
      </Advanced>
      <div class="footer">
        <BackButton go={go} to={{ id: 'choose', account }} />
        <Action label="Start syncing" kind="primary" size="lg" busy="Uploading your bookmarks…" run={start} />
      </div>
    </div>
  );
}
