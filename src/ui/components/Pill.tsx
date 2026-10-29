import type { ComponentChildren } from 'preact';
import type { IconName } from '../lib/icons.js';
import { Icon } from './Icon.js';

interface PillProps {
  kind?: '' | 'ok' | 'warn' | 'accent';
  icon?: IconName;
  spin?: boolean;
  children: ComponentChildren;
}

export function Pill({ kind = '', icon, spin, children }: PillProps) {
  return (
    <span class={`pill ${kind}`.trim()}>
      {icon && <Icon name={icon} class={spin ? 'spin' : ''} />}
      {children}
    </span>
  );
}
