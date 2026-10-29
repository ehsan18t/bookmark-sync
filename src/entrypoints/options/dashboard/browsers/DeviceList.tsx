import type { GroupSummary } from '../../../../engine/app.js';
import { Action } from '../../../../ui/components/Action.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { relativeTime } from '../../../../ui/lib/format.js';
import { devices, now, sendAndReload } from '../../../../ui/state/store.js';

interface DeviceListProps {
  g: GroupSummary;
}

export function DeviceList({ g }: DeviceListProps) {
  const list = devices.value[g.groupId];
  if (!list) return null;
  return (
    <div class="card flush">
      <ul class="list">
        {list
          .filter((d) => !d.left && !d.removed)
          .map((d) => (
            <li key={d.deviceId}>
              <Icon name="world" class="lg" />
              <div class="grow">
                <div class="row snug">
                  <b>{d.name}</b>
                  {d.self && <span class="pill accent">This browser</span>}
                </div>
                <div class="meta">{d.self ? 'Online now' : `Last synced ${relativeTime(d.lastSeen, now.value)}`}</div>
              </div>
              {!d.self && (
                <Action
                  label="Remove"
                  kind="ghost"
                  confirm={`Remove ${d.name} from this sync? Do this after uninstalling the extension there, or if you no longer use that browser.`}
                  run={() => sendAndReload({ t: 'removeDevice', groupId: g.groupId, deviceId: d.deviceId })}
                />
              )}
            </li>
          ))}
      </ul>
    </div>
  );
}
