import type { ComponentChildren } from 'preact';
import { Icon } from './Icon.js';

interface ErrorTextProps {
  children: ComponentChildren;
}

export function ErrorText({ children }: ErrorTextProps) {
  return (
    <div class="error" role="alert">
      <Icon name="alert-triangle" />
      <span>{children}</span>
    </div>
  );
}
