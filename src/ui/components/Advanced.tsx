import type { ComponentChildren } from 'preact';
import { Icon } from './Icon.js';

interface AdvancedProps {
  summary: string;
  open?: boolean;
  children: ComponentChildren;
}

/** A collapsed section, styled like the rest of the "Advanced" boxes. */
export function Advanced({ summary, open, children }: AdvancedProps) {
  return (
    <details class="advanced" open={open}>
      <summary>
        <Icon name="chevron-right" />
        {summary}
      </summary>
      <div class="stack">{children}</div>
    </details>
  );
}
