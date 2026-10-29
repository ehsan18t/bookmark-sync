import type { ComponentChildren } from 'preact';
import { Icon } from './Icon.js';

interface LoadingProps {
  children: ComponentChildren;
}

export function Loading({ children }: LoadingProps) {
  return (
    <div class="row muted">
      <Icon name="loader-2" class="spin" />
      {children}
    </div>
  );
}
