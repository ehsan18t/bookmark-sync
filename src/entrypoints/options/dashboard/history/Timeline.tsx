import { useSignal } from '@preact/signals';
import { useMemo } from 'preact/hooks';
import type { GroupSummary } from '../../../../engine/app.js';
import type { TimelineEntry } from '../../../../engine/group.js';
import { Action } from '../../../../ui/components/Action.js';
import { EmptyState } from '../../../../ui/components/EmptyState.js';
import { ErrorText } from '../../../../ui/components/ErrorText.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { Loading } from '../../../../ui/components/Loading.js';
import { useLoad } from '../../../../ui/hooks/useLoad.js';
import { hlcTime } from '../../../../ui/lib/format.js';
import { send } from '../../../../ui/lib/messaging.js';
import { devices, load } from '../../../../ui/state/store.js';
import { ChangesDialog } from './ChangesDialog.js';
import { sourceText } from './changeSources.js';
import { describeEntry, justBefore } from './timelineText.js';

interface TimelineProps {
  g: GroupSummary;
}

export function Timeline({ g }: TimelineProps) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetches after each sync
  const r = useLoad(() => send<TimelineEntry[]>({ t: 'timeline', groupId: g.groupId }), [g.groupId, g.lastSyncAt]);
  const list = devices.value[g.groupId];
  const open = useSignal<TimelineEntry | null>(null);
  const byId = useMemo(() => new Map((list ?? []).map((v) => [v.deviceId, v])), [list]);
  if (r.error) return <ErrorText>{r.error}</ErrorText>;
  if (!r.data) return <Loading>Loading history…</Loading>;
  const entries = r.data;
  const who = (d: string) => {
    const x = byId.get(d);
    return x ? (x.self ? 'This browser' : x.name) : 'A removed browser';
  };
  const source = (e: TimelineEntry) => {
    const x = byId.get(e.device);
    return sourceText(e.via, x?.browser, x ? (x.self ? 'this browser' : x.name) : 'a removed browser');
  };
  const restoreTo = async (hlc: string) => {
    const p = await send<{ restored: number; removed: number; changed: number }>({ t: 'previewRestore', groupId: g.groupId, hlc });
    if (
      !window.confirm(
        `Go back to how bookmarks were at ${hlcTime(hlc)}?\n\n${p.restored} come back, ${p.removed} are removed, and ${p.changed} change. Every browser follows, and you can undo this from the history.`,
      )
    )
      return;
    await send({ t: 'restore', groupId: g.groupId, hlc });
    await load();
  };
  return (
    <div class="stack lg">
      {g.restorePoints.length > 0 && (
        <div class="stack">
          <h3>Saved points</h3>
          <div class="card flush">
            <ul class="list">
              {g.restorePoints.map((p) => (
                <li key={p.hlc}>
                  <Icon name="clock" />
                  <div class="grow">
                    <div>{p.label}</div>
                    <div class="meta">{hlcTime(p.hlc)}</div>
                  </div>
                  <Action label="Go back to this" run={() => restoreTo(p.hlc)} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div class="stack">
        <h3>Recent changes</h3>
        {entries.length ? (
          <div class="card flush">
            <ul class="list">
              {entries.map((e) => (
                <li key={e.from}>
                  <div class="grow">
                    <div>
                      {who(e.device)} · {source(e) && `${source(e)!.label} · `}
                      {describeEntry(e)}
                    </div>
                    <div class="meta">{hlcTime(e.to)}</div>
                  </div>
                  {e.changes.length > 0 && <Action label="View changes" kind="ghost" run={() => (open.value = e)} />}
                  {e.from > g.oldestRestorable && <Action label="Undo from here" kind="ghost" run={() => restoreTo(justBefore(e.from))} />}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState icon="history" title="No changes yet" text="Changes from every browser show up here, so you can go back to an earlier point." />
        )}
      </div>
      {open.value && <ChangesDialog entry={open.value} who={byId.get(open.value.device)?.self ? 'this browser' : who(open.value.device)} source={source(open.value)} onClose={() => (open.value = null)} />}
    </div>
  );
}
