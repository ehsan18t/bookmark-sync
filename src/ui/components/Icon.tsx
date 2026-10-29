import { type IconName, icons } from '../lib/icons.js';

interface IconProps {
  name: IconName;
  class?: string;
}

/** The SVGs are bundled Tabler icons, so inserting them as markup is safe. */
export function Icon({ name, class: cls = '' }: IconProps) {
  return <span class={`icon ${cls}`.trim()} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[name] }} />;
}
