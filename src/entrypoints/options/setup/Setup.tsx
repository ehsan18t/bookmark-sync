import { useEffect, useRef, useState } from 'preact/hooks';
import { Brand } from '../../../ui/components/Brand.js';
import { Icon } from '../../../ui/components/Icon.js';
import { groups } from '../../../ui/state/store.js';
import { SetupBody } from './SetupBody.js';
import { STEP_INDEX, type Step } from './steps.js';

interface SetupProps {
  onFinish: () => void;
}

export function Setup({ onFinish }: SetupProps) {
  const [step, go] = useState<Step>({ id: 'storage' });
  const page = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focuses the first field of each new step
  useEffect(() => page.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), .choice')?.focus(), [step]);
  return (
    <div class="page stack lg" ref={page}>
      <div class="row spread">
        <Brand />
        {groups.value.length > 0 && step.id !== 'done' && (
          <button type="button" class="ghost" onClick={onFinish}>
            <Icon name="x" />
            Cancel
          </button>
        )}
      </div>
      <div class="steps" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} class={i <= STEP_INDEX[step.id] ? 'done' : ''} />
        ))}
      </div>
      <SetupBody step={step} go={go} onFinish={onFinish} />
    </div>
  );
}
