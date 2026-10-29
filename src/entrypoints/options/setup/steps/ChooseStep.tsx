import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { sameNameKey } from '../../../../core/names.js';
import { Action } from '../../../../ui/components/Action.js';
import { ErrorText } from '../../../../ui/components/ErrorText.js';
import { Field } from '../../../../ui/components/Field.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { Loading } from '../../../../ui/components/Loading.js';
import { RadioCards } from '../../../../ui/components/RadioCards.js';
import { errorText } from '../../../../ui/lib/format.js';
import { send } from '../../../../ui/lib/messaging.js';
import { storageWithAccount } from '../../../../ui/lib/storageLabels.js';
import type { FoundSync, PublicAccount } from '../../../../ui/state/store.js';
import { BackButton } from '../BackButton.js';
import { StepHead } from '../StepHead.js';
import type { Go } from '../steps.js';

interface ChooseStepProps {
  account: PublicAccount;
  go: Go;
}

export function ChooseStep({ account, go }: ChooseStepProps) {
  const where = storageWithAccount(account);
  const [found, setFound] = useState<FoundSync[] | null>(null);
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (found) box.current?.querySelector<HTMLElement>('input[type=text], input[type=radio]:checked, input[type=radio]:not(:disabled)')?.focus();
  }, [found, pick]);

  useEffect(() => {
    setFound(null);
    setFailed('');
    send<FoundSync[]>({ t: 'discover', accountId: account.id }).then(
      (list) => {
        const taken = new Set(list.map((f) => sameNameKey(f.name)));
        let suggested = 'Bookmarks';
        for (let i = 2; taken.has(sameNameKey(suggested)); i++) suggested = `Bookmarks ${i}`;
        const open = list.filter((f) => !f.joined);
        setName(suggested);
        setPick(open.length === 1 ? open[0]!.groupId : open.length ? null : 'new');
        setFound(list);
      },
      (e) => setFailed(errorText(e)),
    );
  }, [account.id, attempt]);

  const start = () => {
    const value = name.trim();
    if (!value) throw new Error('Give the new sync a name.');
    const same = found!.find((f) => sameNameKey(f.name) === sameNameKey(value));
    if (same) throw new Error(`A sync called “${same.name}” is already on this storage. Join it, or pick another name.`);
    go({ id: 'create', account, name: value });
  };
  const next = async () => {
    if (!pick) throw new Error('Pick a sync to join, or start a new one.');
    if (pick === 'new') return start();
    go({ id: 'join', account, sync: found!.find((f) => f.groupId === pick)! });
  };

  const open = found?.filter((f) => !f.joined) ?? [];
  const nameField = (
    <div class="card stack">
      <Field label="Name the new sync" hint="Shown in every browser that joins. It can’t match the name of another sync here.">
        <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
    </div>
  );
  const members = (f: FoundSync) => (f.browsers === null ? null : f.browsers.length ? f.browsers.join(', ') : 'no browsers yet');

  let head = <StepHead title="Join or start a sync">{where}</StepHead>;
  let body: ComponentChildren;
  if (failed)
    body = (
      <>
        <ErrorText>{failed}</ErrorText>
        <div class="row">
          <button type="button" onClick={() => setAttempt(attempt + 1)}>
            <Icon name="refresh" />
            Try again
          </button>
        </div>
      </>
    );
  else if (!found) body = <Loading>Looking for synced bookmarks on {where}…</Loading>;
  else if (!open.length) {
    head = (
      <StepHead title="Start syncing">
        {found.length ? `Every sync on ${where} already syncs in this browser, so this starts a new one.` : `Nothing is synced on ${where} yet, so this browser starts the sync. Your other browsers join it later.`}
      </StepHead>
    );
    body = nameField;
  } else
    body = (
      <>
        <RadioCards
          name="sync"
          value={pick}
          onChange={setPick}
          options={[
            ...found.map((f) => ({
              value: f.groupId,
              title: f.name,
              icon: f.encrypted ? ('lock' as const) : ('bookmarks' as const),
              badge: f.encrypted ? 'Encrypted' : undefined,
              desc: f.joined ? 'Already syncing in this browser' : [f.mode === 'folder' ? 'Chosen folders' : 'All bookmarks', members(f)].filter(Boolean).join(' · '),
              disabled: f.joined,
            })),
            { value: 'new', title: 'Start a new sync', icon: 'plus' as const, desc: 'Keeps a separate set of bookmarks in sync, apart from the ones above.' },
          ]}
        />
        {pick === 'new' && nameField}
      </>
    );

  return (
    <div class="stack lg">
      {head}
      <div class="stack" ref={box}>
        {body}
      </div>
      <div class="footer">
        <BackButton go={go} to={{ id: 'storage' }} />
        {found && <Action label="Continue" kind="primary" size="lg" run={next} />}
      </div>
    </div>
  );
}
