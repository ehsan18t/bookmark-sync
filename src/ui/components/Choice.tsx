import type { IconName } from '../lib/icons.js';
import { Icon } from './Icon.js';

interface ChoiceProps {
  icon: IconName;
  title: string;
  desc: string;
  badge?: string;
  recommended?: boolean;
  onClick: () => void;
}

/** A large clickable card that leads somewhere. */
export function Choice(props: ChoiceProps) {
  return (
    <button type="button" class={`choice${props.recommended ? ' recommended' : ''}`} onClick={props.onClick}>
      <span class="tile">
        <Icon name={props.icon} class="lg" />
      </span>
      <span class="text">
        <span class="title">
          {props.title}
          {props.badge && <span class="pill accent">{props.badge}</span>}
        </span>
        <span class="desc">{props.desc}</span>
      </span>
      <Icon name="chevron-right" />
    </button>
  );
}
