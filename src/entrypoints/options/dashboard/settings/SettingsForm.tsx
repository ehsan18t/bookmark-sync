import { useState } from 'preact/hooks';
import type { Settings } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { send } from '../../../../ui/lib/messaging.js';
import { NumberInput } from './NumberInput.js';
import { Setting } from './Setting.js';

interface SettingsFormProps {
  initial: Settings & { deviceName: string };
}

export function SettingsForm({ initial }: SettingsFormProps) {
  const [deviceName, setDeviceName] = useState(initial.deviceName);
  const [history, setHistory] = useState(String(initial.historyDays));
  const [percent, setPercent] = useState(String(initial.guardPercent));
  const [min, setMin] = useState(String(initial.guardMin));
  const [pull, setPull] = useState(String(initial.pullMinutes));
  const [saved, setSaved] = useState(false);
  const save = async () => {
    const n = (v: string, lo: number, hi: number, what: string) => {
      const x = Number(v);
      if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${what} must be between ${lo} and ${hi}.`);
      return Math.round(x);
    };
    await send({
      t: 'updateSettings',
      patch: {
        deviceName: deviceName.trim() || initial.deviceName,
        historyDays: n(history, 0, 365, 'Days of history'),
        guardPercent: n(percent, 1, 100, 'The percentage'),
        guardMin: n(min, 1, 100_000, 'The number of bookmarks'),
        pullMinutes: n(pull, 1, 60, 'Minutes'),
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  return (
    <div class="stack">
      <h3>This browser</h3>
      <div class="card flush">
        <Setting title="Name" hint="How this browser appears in your other browsers.">
          <input type="text" value={deviceName} onInput={(e) => setDeviceName(e.currentTarget.value)} />
        </Setting>
        <Setting title="History" hint="How long changes are kept so you can go back. 0 turns history off.">
          <span class="inline-num">
            Keep <NumberInput value={history} onChange={setHistory} min={0} max={365} /> days
          </span>
        </Setting>
        <Setting title="Big changes" hint="Syncing pauses and asks first when a change would remove, move, or edit at least this much.">
          <div class="stack snug">
            <span class="inline-num">
              More than <NumberInput value={percent} onChange={setPercent} min={1} max={100} /> % of bookmarks
            </span>
            <span class="inline-num">
              and at least <NumberInput value={min} onChange={setMin} min={1} /> bookmarks
            </span>
          </div>
        </Setting>
        <Setting title="Checking for changes" hint="Changes made here sync within seconds. Changes from other browsers are checked this often, and when you switch windows.">
          <span class="inline-num">
            Every <NumberInput value={pull} onChange={setPull} min={1} max={60} /> minutes
          </span>
        </Setting>
      </div>
      <div class="row">
        <Action label="Save changes" kind="primary" run={save} />
        <span class="pill ok" role="status">
          {saved ? 'Saved' : ''}
        </span>
      </div>
    </div>
  );
}
