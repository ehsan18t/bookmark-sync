import type { ComponentChildren } from 'preact';

interface StepHeadProps {
  title: string;
  children: ComponentChildren;
}

export function StepHead({ title, children }: StepHeadProps) {
  return (
    <div class="step-head">
      <h1>{title}</h1>
      <p class="muted">{children}</p>
    </div>
  );
}
