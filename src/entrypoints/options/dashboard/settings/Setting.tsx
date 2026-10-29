import type { ComponentChildren } from 'preact';

interface SettingProps {
  title: string;
  hint: string;
  children: ComponentChildren;
}

export function Setting({ title, hint, children }: SettingProps) {
  return (
    <div class="setting">
      <div class="label">
        <b>{title}</b>
        <span class="hint">{hint}</span>
      </div>
      <div class="control">{children}</div>
    </div>
  );
}
