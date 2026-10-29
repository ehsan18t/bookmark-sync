import { Icon } from '../../../ui/components/Icon.js';
import type { Go, Step } from './steps.js';

interface BackButtonProps {
  go: Go;
  to: Step;
}

export function BackButton({ go, to }: BackButtonProps) {
  return (
    <button type="button" class="ghost" onClick={() => go(to)}>
      <Icon name="arrow-left" />
      Back
    </button>
  );
}
