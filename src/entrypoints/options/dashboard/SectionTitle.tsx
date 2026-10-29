import type { ComponentChildren } from 'preact';

interface SectionTitleProps {
  children: ComponentChildren;
}

export function SectionTitle({ children }: SectionTitleProps) {
  return <div class="section-title">{children}</div>;
}
