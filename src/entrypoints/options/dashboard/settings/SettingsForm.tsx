import { useEffect, useState } from 'preact/hooks';
import type { Settings } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { plural } from '../../../../ui/lib/format.js';
import { send } from '../../../../ui/lib/messaging.js';
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
  pull: string;
}

const fieldsOf = (s: Initial): Fields => ({
  deviceName: s.deviceName,
  history: String(s.historyDays),
  percent: String(s.guardPercent),
  min: String(s.guardMin),
  pull: String(s.pullMinutes),
});

const whole = (v: string, lo: number, hi: number, what: string) => {
  const x = Number(v);
  if (v.trim() === '' || !Number.isFinite(x) || x < lo || x > hi) throw new Error(`${what} must be between ${lo} and ${hi}.`);
  return Math.round(x);
};

export function SettingsForm({ initial }: SettingsFormProps) {
  const [stored, setStored] = useState(() => fieldsOf(initial));
  const [form, setForm] = useState(stored);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);

  const edit = (key: keyof Fields) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };
  const changed = (Object.keys(form) as (keyof Fields)[]).filter((k) => form[k] !== stored[k]).length;

  const save = async () => {
    const patch = {
      deviceName: form.deviceName.trim() || stored.deviceName,
      historyDays: whole(form.history, 0, 365, 'Days of history'),
      guardPercent: whole(form.percent, 1, 100, 'The percentage'),
      guardMin: whole(form.min, 1, 100_000, 'The number of bookmarks'),
      pullMinutes: whole(form.pull, 1, 60, 'Minutes'),
    };
    await send({ t: 'updateSettings', patch });
    const next = fieldsOf({ ...initial, ...patch });
    setStored(next);
    setForm(next);
    setSaved(true);
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
        <Setting title="Checking for changes" hint="Changes made here sync within seconds. Changes from other browsers are checked this often, and when you switch windows.">
          <UnitInput label="Minutes between checks" unit="minutes" value={form.pull} onChange={edit('pull')} min={1} max={60} />
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
