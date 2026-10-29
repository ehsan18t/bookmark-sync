import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { Target } from '../../../../engine/app.js';
import type { GroupFolder, JoinPreview } from '../../../../engine/group.js';
import { Action } from '../../../../ui/components/Action.js';
import { Advanced } from '../../../../ui/components/Advanced.js';
import { Banner } from '../../../../ui/components/Banner.js';
import { ErrorText } from '../../../../ui/components/ErrorText.js';
import { Field } from '../../../../ui/components/Field.js';
import { RadioCards } from '../../../../ui/components/RadioCards.js';
import { useDebounced } from '../../../../ui/hooks/useDebounced.js';
import { errorText } from '../../../../ui/lib/format.js';
import { send, withTakeover } from '../../../../ui/lib/messaging.js';
import { type FoundSync, folders, groups, load, type PublicAccount } from '../../../../ui/state/store.js';
import { FolderTree } from '../../folder-picker/FolderTree.js';
import { Placements } from '../../folder-picker/Placements.js';
import { groupItems, localItems, placementChoices } from '../../folder-picker/treeItems.js';
import { BackButton } from '../BackButton.js';
import { previewText } from '../joinPreview.js';
import { StepHead } from '../StepHead.js';
import type { Go } from '../steps.js';

interface JoinStepProps {
  account: PublicAccount;
  sync: FoundSync;
  go: Go;
}

export function JoinStep({ account, sync, go }: JoinStepProps) {
  const isFolder = sync.mode === 'folder';
  const [how, setHow] = useState<'merge' | 'replace'>('merge');
  const [defaults, setDefaults] = useState(true);
  const [into, setInto] = useState(false);
  const [intoFolder, setIntoFolder] = useState<string[]>([]);
  const [pass, setPass] = useState('');
  const [remember, setRemember] = useState(true);
  const [group, setGroup] = useState<{ mode: 'everything' | 'folder'; folders: GroupFolder[] } | null>(null);
  const [groupError, setGroupError] = useState('');
  const [ticked, setTicked] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState('');

  const items = useMemo(() => (group ? groupItems(group.mode, group.folders, folders.value) : []), [group]);
  const tops = useMemo(() => items.filter((i) => i.parent === null).map((i) => i.id), [items]);
  const wholeTicked = tops.length > 0 && ticked.length === tops.length && tops.every((t) => ticked.includes(t));

  useDebounced(() => {
    if (sync.encrypted && !pass) return;
    let live = true;
    send<{ mode: 'everything' | 'folder'; folders: GroupFolder[] }>({ t: 'groupFolders', accountId: account.id, groupId: sync.groupId, passphrase: sync.encrypted ? pass : undefined }).then(
      (g) => {
        if (!live) return;
        const top = groupItems(g.mode, g.folders, folders.value)
          .filter((i) => i.parent === null)
          .map((i) => i.id);
        setGroup(g);
        setGroupError('');
        setTicked(top);
        setChosen({});
      },
      (e) => live && setGroupError(errorText(e)),
    );
    return () => (live = false);
  }, [pass]);

  const target = (): Target | null => {
    if (!group || !ticked.length) return null;
    if (group.mode === 'everything' && wholeTicked && !Object.keys(chosen).length) return into ? { kind: 'everything-into', folderId: intoFolder[0] ?? '' } : { kind: 'whole' };
    return { kind: 'parts', parts: placementChoices(group.mode, group.folders, ticked, chosen), followTops: isFolder && wholeTicked };
  };
  const input = (t: Target) => ({ accountId: account.id, groupId: sync.groupId, target: t, mode: how, ignoreDefaults: defaults, passphrase: sync.encrypted ? pass : undefined, rememberKey: remember });

  useDebounced(() => {
    let live = true;
    const t = target();
    if (sync.encrypted && !pass) setPreview('Enter the passphrase to see what will change.');
    else if (!t) setPreview(group ? 'Tick at least one folder to sync here.' : 'Reading the folders in this sync…');
    else if (t.kind === 'everything-into' && !t.folderId) setPreview('Pick the folder to keep the synced bookmarks in.');
    else {
      setPreview('Checking what will change…');
      send<JoinPreview>({ t: 'previewJoin', input: input(t) }).then(
        (p) => live && setPreview(previewText(p)),
        (e) => live && setPreview(errorText(e)),
      );
    }
    return () => (live = false);
  }, [group, ticked, chosen, how, defaults, into, intoFolder, pass]);

  const join = async () => {
    if (sync.encrypted && !pass) throw new Error('Enter the passphrase for this sync.');
    const t = target();
    if (!t) throw new Error('Tick at least one folder to sync here.');
    if (t.kind === 'everything-into' && !t.folderId) throw new Error('Pick the folder to keep the synced bookmarks in.');
    await withTakeover((takeover) => send({ t: 'join', input: { ...input(t), takeover } }));
    await load();
    go({ id: 'done', account, groupId: sync.groupId, joined: true });
  };

  let what: ComponentChildren;
  if (groupError) what = <ErrorText>{groupError}</ErrorText>;
  else if (!group) what = <p class="muted">{sync.encrypted && !pass ? 'Enter the passphrase to see the folders in this sync.' : 'Reading the folders in this sync…'}</p>;
  else
    what = (
      <>
        <p class="muted small">Everything is ticked. Untick what this browser doesn’t need, or tick single folders deeper down.</p>
        <FolderTree items={items} multi value={ticked} onChange={(ids) => (setTicked(ids), setChosen(Object.fromEntries(Object.entries(chosen).filter(([k]) => ids.includes(k)))))} label="Folders to sync in this browser" />
        <h3>Where each folder goes here</h3>
        <Placements mode={group.mode} groupFolders={group.folders} items={items} local={folders.value} localTree={localItems(folders.value, groups.value)} picked={ticked} chosen={chosen} onChange={setChosen} />
      </>
    );

  return (
    <div class="stack lg">
      <StepHead title={`Join “${sync.name}”`}>{isFolder ? 'This sync keeps some folders the same in every browser.' : 'This sync keeps bookmarks the same in every browser.'}</StepHead>
      {sync.encrypted && (
        <div class="card stack">
          <Field label="Passphrase" hint="The passphrase chosen when this sync was started.">
            <input type="password" autocomplete="current-password" value={pass} onInput={(e) => setPass(e.currentTarget.value)} />
          </Field>
          <label class="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
            Remember it in this browser
          </label>
        </div>
      )}
      <div class="stack">
        <h3>What should sync in this browser?</h3>
        <div class="stack">{what}</div>
      </div>
      <div class="stack">
        <h3>What about the bookmarks already here?</h3>
        <RadioCards
          name="how"
          value={how}
          onChange={setHow}
          options={[
            { value: 'merge', title: 'Combine', desc: 'Keeps the bookmarks in this browser and adds the synced ones. Bookmarks that match are kept once.', icon: 'git-merge', badge: 'Recommended' },
            { value: 'replace', title: 'Replace', desc: 'Swaps this browser’s bookmarks for the synced ones. You can undo this later.', icon: 'replace' },
          ]}
        />
      </div>
      <label class="check">
        <input type="checkbox" checked={defaults} onChange={(e) => setDefaults(e.currentTarget.checked)} />
        <span>Leave out the sample bookmarks this browser came with</span>
      </label>
      {!isFolder && wholeTicked && (
        <Advanced summary="Advanced">
          <label class="check">
            <input type="checkbox" checked={into} onChange={(e) => setInto(e.currentTarget.checked)} />
            <span>
              Keep the synced bookmarks inside one folder
              <div class="hint">Instead of the bookmarks bar and other bookmarks. Only when everything is ticked.</div>
            </span>
          </label>
          {into && <FolderTree items={localItems(folders.value, groups.value)} multi={false} value={intoFolder} onChange={setIntoFolder} label="Folder for the synced bookmarks" />}
        </Advanced>
      )}
      <Banner kind="info" icon="info-circle">
        {preview || 'Checking what will change…'}
      </Banner>
      <div class="footer">
        <BackButton go={go} to={{ id: 'choose', account }} />
        <Action label="Join and sync" kind="primary" size="lg" busy="Syncing your bookmarks…" run={join} />
      </div>
    </div>
  );
}
