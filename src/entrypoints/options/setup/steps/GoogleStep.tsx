import { Action } from '../../../../ui/components/Action.js';
import { Icon } from '../../../../ui/components/Icon.js';
import { send } from '../../../../ui/lib/messaging.js';
import { BackButton } from '../BackButton.js';
import { StepHead } from '../StepHead.js';
import { connected, type Go } from '../steps.js';

interface GoogleStepProps {
  go: Go;
}

export function GoogleStep({ go }: GoogleStepProps) {
  return (
    <div class="stack lg">
      <StepHead title="Connect Google Drive">A Google window opens. Choose your account and select Allow.</StepHead>
      <div class="card stack">
        <div class="row">
          <Icon name="shield-lock" class="lg" />
          <div class="grow">
            <b>Only its own files</b>
            <p class="muted small">The extension can only see the files it creates, kept in a hidden app folder. Your other Drive files stay private.</p>
          </div>
        </div>
      </div>
      <div class="footer">
        <BackButton go={go} to={{ id: 'storage' }} />
        <Action label="Sign in with Google" kind="primary" size="lg" icon="brand-google-drive" busy="Waiting for Google…" run={async () => connected(go, await send<string>({ t: 'addGoogle', name: 'Google Drive' }))} />
      </div>
    </div>
  );
}
