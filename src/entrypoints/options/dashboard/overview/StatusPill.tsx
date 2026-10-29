import type { GroupSummary } from '../../../../engine/app.js';
import { Pill } from '../../../../ui/components/Pill.js';

interface StatusPillProps {
  g: GroupSummary;
}

export function StatusPill({ g }: StatusPillProps) {
  if (g.status.state === 'active')
    return g.lastError ? (
      <Pill kind="warn" icon="alert-triangle">
        Retrying
      </Pill>
    ) : (
      <Pill kind="ok" icon="circle-check">
        Syncing
      </Pill>
    );
  if (g.status.reason === 'migration')
    return (
      <Pill kind="accent" icon="loader-2" spin>
        Switching encryption
      </Pill>
    );
  return (
    <Pill kind="warn" icon="player-pause">
      Paused
    </Pill>
  );
}
