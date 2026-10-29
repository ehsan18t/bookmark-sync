import type { ComponentChildren } from 'preact';
import type { IconName } from '../lib/icons.js';
import { Icon } from './Icon.js';

interface EmptyStateProps {
  icon: IconName;
  title: string;
  text: string;
  children?: ComponentChildren;
}

export function EmptyState({ icon, title, text, children }: EmptyStateProps) {
  return (
    <div class="card empty">
      <Icon name={icon} class="xl" />
      <h3>{title}</h3>
      <p class="muted">{text}</p>
      {children}
    </div>
  );
}
