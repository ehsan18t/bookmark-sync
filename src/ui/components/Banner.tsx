import type { ComponentChildren } from 'preact';
import type { IconName } from '../lib/icons.js';
import { Icon } from './Icon.js';

interface BannerProps {
  kind?: '' | 'info' | 'danger';
  icon: IconName;
  children: ComponentChildren;
}

export function Banner({ kind = '', icon, children }: BannerProps) {
  return (
    <div class={`banner ${kind}`.trim()}>
      <Icon name={icon} />
      <div class="body">{children}</div>
    </div>
  );
}
