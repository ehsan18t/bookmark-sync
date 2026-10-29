import type { Go, Step } from './steps.js';
import { ChooseStep } from './steps/ChooseStep.js';
import { CreateStep } from './steps/CreateStep.js';
import { DoneStep } from './steps/DoneStep.js';
import { GoogleStep } from './steps/GoogleStep.js';
import { JoinStep } from './steps/JoinStep.js';
import { ServerStep } from './steps/ServerStep.js';
import { StorageStep } from './steps/StorageStep.js';

interface SetupBodyProps {
  step: Step;
  go: Go;
  onFinish: () => void;
}

export function SetupBody({ step, go, onFinish }: SetupBodyProps) {
  switch (step.id) {
    case 'storage':
      return <StorageStep go={go} />;
    case 'google':
      return <GoogleStep go={go} />;
    case 'server':
      return <ServerStep go={go} />;
    case 'choose':
      return <ChooseStep key={step.account.id} account={step.account} go={go} />;
    case 'create':
      return <CreateStep account={step.account} name={step.name} go={go} />;
    case 'join':
      return <JoinStep account={step.account} sync={step.sync} go={go} />;
    case 'done':
      return <DoneStep step={step} onFinish={onFinish} />;
  }
}
