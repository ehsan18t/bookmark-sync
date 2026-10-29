import { Action } from '../../../ui/components/Action.js';
import { Brand } from '../../../ui/components/Brand.js';
import { Icon } from '../../../ui/components/Icon.js';
import { sendAndReload } from '../../../ui/state/store.js';
import { Browsers } from './browsers/Browsers.js';
import { Duplicates } from './duplicates/Duplicates.js';
import { History } from './history/History.js';
import { Overview } from './overview/Overview.js';
import { SettingsTab } from './settings/SettingsTab.js';
import { TABS, type Tab } from './tabs.js';

const PANELS = { overview: Overview, history: History, browsers: Browsers, duplicates: Duplicates, settings: SettingsTab };

interface DashboardProps {
  tab: Tab;
}

export function Dashboard({ tab }: DashboardProps) {
  const Panel = PANELS[tab];
  return (
    <div class="page wide">
      <div class="topbar">
        <Brand />
        <Action label="Sync now" icon="refresh" busy="Syncing…" run={() => sendAndReload({ t: 'syncNow' })} />
      </div>
      <nav aria-label="Dashboard">
        <div class="tabs" role="tablist">
          {TABS.map((t) => (
            <button type="button" key={t.id} role="tab" aria-selected={t.id === tab} onClick={() => (location.hash = t.id)}>
              <Icon name={t.icon} />
              {t.label}
            </button>
          ))}
        </div>
      </nav>
      <div class="stack lg">
        <Panel />
      </div>
    </div>
  );
}
