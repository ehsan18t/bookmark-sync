import { APP_NAME } from '../../../../config.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { plural } from '../../../../ui/lib/format.js';
import { storageLabel, storageWithAccount } from '../../../../ui/lib/storageLabels.js';
import { groups } from '../../../../ui/state/store.js';
import type { Step } from '../steps.js';

interface DoneStepProps {
  step: Extract<Step, { id: 'done' }>;
  onFinish: () => void;
}

export function DoneStep({ step, onFinish }: DoneStepProps) {
  const g = groups.value.find((x) => x.groupId === step.groupId);
  const name = g?.name ?? 'Bookmarks';
  return (
    <div class="stack lg center">
      <div class="done-mark">
        <Icon name="check" class="xl" />
      </div>
      <div class="step-head center">
        <h1>Your bookmarks are syncing</h1>
        <p class="muted">
          {plural(g?.bookmarks ?? 0, 'bookmark', 'bookmarks')} in “{name}”, synced with {storageLabel(step.account)}. Changes sync on their own from now on.
        </p>
      </div>
      <div class="card stack next-steps">
        <div class="row">
          <Icon name="devices" class="lg" />
          <div class="grow">
            <b>{step.joined ? 'Add more browsers the same way' : 'Next, set up your other browsers'}</b>
            <p class="muted small">
              Install {APP_NAME} in each browser and connect {storageWithAccount(step.account)}. They find “{name}” and join it.
            </p>
          </div>
        </div>
      </div>
      <button type="button" class="primary lg" onClick={onFinish}>
        Open the dashboard
      </button>
    </div>
  );
}
