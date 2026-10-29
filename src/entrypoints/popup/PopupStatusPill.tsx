import type { GroupSummary } from '../../engine/app.js';
import { Pill } from '../../ui/components/Pill.js';
import { SHORT_REASON } from '../../ui/lib/reasons.js';

interface PopupStatusPillProps {
  g: GroupSummary;
}

export function PopupStatusPill({ g }: PopupStatusPillProps) {
  const reason = g.status.state === 'paused' ? g.status.reason : null;
  if (reason === 'migration')
    return (
      <Pill kind="accent" icon="loader-2" spin>
        Switching encryption
      </Pill>
    );
  if (reason)
    return (
      <Pill kind="warn" icon="player-pause">
        {SHORT_REASON[reason] ?? 'Paused'}
      </Pill>
    );
  if (g.lastError)
    return (
      <Pill kind="warn" icon="alert-triangle">
        Retrying
      </Pill>
    );
  return (
    <Pill kind="ok" icon="circle-check">
      Up to date
    </Pill>
  );
}
