import type { IconName } from '../lib/icons.js';
import { Icon } from './Icon.js';

export interface RadioOption<T extends string> {
  value: T;
  title: string;
  desc: string;
  icon: IconName;
  badge?: string;
  disabled?: boolean;
}

interface RadioCardsProps<T extends string> {
  name: string;
  options: RadioOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
}

/** Radio cards for a small set of exclusive options. */
export function RadioCards<T extends string>({ name, options, value, onChange }: RadioCardsProps<T>) {
  return (
    <div class="stack">
      {options.map((o) => (
        <label key={o.value} class={`choice${o.value === value ? ' selected' : ''}${o.disabled ? ' disabled' : ''}`}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span class="tile">
            <Icon name={o.icon} class="lg" />
          </span>
          <span class="text">
            <span class="title">
              {o.title}
              {o.badge && <span class="pill accent">{o.badge}</span>}
            </span>
            <span class="desc">{o.desc}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
