import { useEffect, useState } from 'preact/hooks';
import { clampCheckSeconds, MAX_CHECK_SECONDS, MIN_CHECK_SECONDS } from '../../../../core/checkTimes.js';
import type { Settings } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { plural } from '../../../../ui/lib/format.js';
import { send } from '../../../../ui/lib/messaging.js';
import { type Duration, DurationInput, toDuration, toSeconds } from './DurationInput.js';
import { Setting } from './Setting.js';
import { UnitInput } from './UnitInput.js';

type Initial = Settings & { deviceName: string };

interface SettingsFormProps {
  initial: Initial;
}

interface Fields {
  deviceName: string;
  history: string;
  percent: string;
  min: string;
  active: Duration;
  away: Duration;
}

type Check = 'active' | 'away';

const fieldsOf = (s: Initial): Fields => ({
  deviceName: s.deviceName,
  history: String(s.historyDays),
  percent: String(s.guardPercent),
  min: String(s.guardMin),
  active: toDuration(s.activeCheckSeconds),
  away: toDuration(s.awayCheckSeconds),
});

const checkSeconds = (d: Duration) => {
  const x = toSeconds(d);
  if (d.value.trim() === '' || !Number.isFinite(x) || x <= 0) throw new Error('Times between checks must be a number above 0.');
  return x;
};

const adjusted = (asked: number, got: number) =>
  asked < got ? `Raised to ${MIN_CHECK_SECONDS} seconds, the shortest this browser allows.` : asked > got ? `Lowered to ${MAX_CHECK_SECONDS / 60} minutes, the longest allowed.` : '';

const whole = (v: string, lo: number, hi: number, what: string) => {
  const x = Number(v);
  if (v.trim() === '' || !Number.isFinite(x) || x < lo || x > hi) throw new Error(`${what} must be between ${lo} and ${hi}.`);
  return Math.round(x);
};

export function SettingsForm({ initial }: SettingsFormProps) {
  const [stored, setStored] = useState(() => fieldsOf(initial));
  const [form, setForm] = useState(stored);
  const [saved, setSaved] = useState(false);
  const [notes, setNotes] = useState<Partial<Record<Check, string>>>({});
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  const edit =
    <K extends keyof Fields>(key: K) =>
    (value: Fields[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
      setSaved(false);
      if (key === 'active' || key === 'away') setNotes((n) => ({ ...n, [key]: '' }));
    };
  const changed = (Object.keys(form) as (keyof Fields)[]).filter((k) => JSON.stringify(form[k]) !== JSON.stringify(stored[k])).length;

  const save = async () => {
    const asked = { active: checkSeconds(form.active), away: checkSeconds(form.away) };
    const patch = {
      deviceName: form.deviceName.trim() || stored.deviceName,
      historyDays: whole(form.history, 0, 365, 'Days of history'),
      guardPercent: whole(form.percent, 1, 100, 'The percentage'),
      guardMin: whole(form.min, 1, 100_000, 'The number of bookmarks'),
      activeCheckSeconds: clampCheckSeconds(asked.active),
      awayCheckSeconds: clampCheckSeconds(asked.away),
    };
    await send({ t: 'updateSettings', patch });
    const next = fieldsOf({ ...initial, ...patch });
    setStored(next);
    setForm(next);
    setSaved(true);
    setNotes({ active: adjusted(asked.active, patch.activeCheckSeconds), away: adjusted(asked.away, patch.awayCheckSeconds) });
  };

  return (
    <div class="stack">
      <h3>This browser</h3>
      <div class="card flush">
        <Setting title="Name" hint="How this browser appears in your other browsers.">
          <input type="text" aria-label="Name" value={form.deviceName} onInput={(e) => edit('deviceName')(e.currentTarget.value)} />
        </Setting>
        <Setting title="History" hint="How long changes are kept so you can go back. 0 turns history off.">
          <UnitInput label="Days of history" unit="days" value={form.history} onChange={edit('history')} min={0} max={365} />
        </Setting>
        <Setting title="Big changes" hint="Syncing pauses and asks first when a change would remove, move, or edit more than this share of bookmarks, and at least this many.">
          <UnitInput label="Share of bookmarks" unit="% of bookmarks" value={form.percent} onChange={edit('percent')} min={1} max={100} />
          <UnitInput label="Number of bookmarks" unit="bookmarks" value={form.min} onChange={edit('min')} min={1} />
        </Setting>
        <Setting title="Checking while in use" hint="How often changes from other browsers are checked while you use this browser. Changes made here sync within seconds.">
          <DurationInput label="Time between checks while in use" value={form.active} onChange={edit('active')} />
          {notes.active && <span class="hint">{notes.active}</span>}
        </Setting>
        <Setting title="Checking when not in use" hint="Used once this browser has gone 10 minutes without focus, or the computer is locked or idle. Coming back checks at once.">
          <DurationInput label="Time between checks when not in use" value={form.away} onChange={edit('away')} />
          {notes.away && <span class="hint">{notes.away}</span>}
        </Setting>
        <div class="settings-footer">
          <span class={`status${saved ? ' saved' : ''}`} role="status">
            {changed ? plural(changed, 'unsaved change', 'unsaved changes') : saved ? 'Saved' : ''}
          </span>
          <Action label="Save changes" kind="primary" busy="Saving…" disabled={!changed} run={save} />
        </div>
      </div>
    </div>
  );
}
