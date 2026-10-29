import { useSignal } from '@preact/signals';
import { errorText } from '../lib/format.js';
import type { IconName } from '../lib/icons.js';
import { ErrorText } from './ErrorText.js';
import { Icon } from './Icon.js';

interface ActionProps {
  label: string;
  run: () => unknown;
  kind?: 'primary' | 'danger' | 'ghost';
  confirm?: string;
  icon?: IconName;
  busy?: string;
  size?: 'lg';
  block?: boolean;
}

/** A button that shows a spinner while `run` works and the error, if any, right under it. */
export function Action(props: ActionProps) {
  const running = useSignal(false);
  const error = useSignal('');
  const click = async () => {
    if (props.confirm && !window.confirm(props.confirm)) return;
    running.value = true;
    error.value = '';
    try {
      await props.run();
    } catch (e) {
      error.value = errorText(e);
    } finally {
      running.value = false;
    }
  };
  return (
    <div class={`action${props.block ? ' block' : ''}`}>
      <button type="button" class={[props.kind, props.size, props.block && 'block'].filter(Boolean).join(' ')} disabled={running.value} onClick={click}>
        {running.value ? <Icon name="loader-2" class="spin" /> : props.icon && <Icon name={props.icon} />}
        {running.value ? (props.busy ?? props.label) : props.label}
      </button>
      {error.value && <ErrorText>{error.value}</ErrorText>}
    </div>
  );
}
