import { useSignal } from '@preact/signals';
import { cloneElement, type ComponentChildren, type VNode } from 'preact';
import { useId } from 'preact/hooks';
import { APP_NAME } from '../config.js';
import { errorText } from './dom.js';
import { icons, type IconName } from './icons.js';

/** The SVGs are bundled Tabler icons, so inserting them as markup is safe. */
export function Icon({ name, class: cls = '' }: { name: IconName; class?: string }) {
  return <span class={`icon ${cls}`.trim()} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[name] }} />;
}

export function Brand() {
  return (
    <div class="brand">
      <Icon name="bookmarks" />
      {APP_NAME}
    </div>
  );
}

type Kind = 'primary' | 'danger' | 'ghost';

/** A button that shows a spinner while `run` works and the error, if any, right under it. */
export function Action(props: { label: string; run: () => unknown; kind?: Kind; confirm?: string; icon?: IconName; busy?: string; size?: 'lg'; block?: boolean }) {
  const running = useSignal(false);
  const error = useSignal('');
  const click = async () => {
    if (props.confirm && !window.confirm(props.confirm)) return;
    running.value = true;
    error.value = '';
    try {
      await props.run();
    } catch (e) {
      error.value = errorText(e);
    } finally {
      running.value = false;
    }
  };
  return (
    <div class={`action${props.block ? ' block' : ''}`}>
      <button class={[props.kind, props.size, props.block && 'block'].filter(Boolean).join(' ')} disabled={running.value} onClick={click}>
        {running.value ? <Icon name="loader-2" class="spin" /> : props.icon && <Icon name={props.icon} />}
        {running.value ? (props.busy ?? props.label) : props.label}
      </button>
      {error.value && <ErrorText>{error.value}</ErrorText>}
    </div>
  );
}

export function ErrorText({ children }: { children: ComponentChildren }) {
  return (
    <div class="error" role="alert">
      <Icon name="alert-triangle" />
      <span>{children}</span>
    </div>
  );
}

/** A labelled control; the child gets the id and hint wiring. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: VNode<{ id?: string }> }) {
  const id = useId();
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint && (
        <span class="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function Banner({ kind = '', icon, children }: { kind?: '' | 'info' | 'danger'; icon: IconName; children: ComponentChildren }) {
  return (
    <div class={`banner ${kind}`.trim()}>
      <Icon name={icon} />
      <div class="body">{children}</div>
    </div>
  );
}

export function Pill({ kind = '', icon, spin, children }: { kind?: '' | 'ok' | 'warn' | 'accent'; icon?: IconName; spin?: boolean; children: ComponentChildren }) {
  return (
    <span class={`pill ${kind}`.trim()}>
      {icon && <Icon name={icon} class={spin ? 'spin' : ''} />}
      {children}
    </span>
  );
}

/** A large clickable card that leads somewhere. */
export function Choice(props: { icon: IconName; title: string; desc: string; badge?: string; recommended?: boolean; onClick: () => void }) {
  return (
    <button class={`choice${props.recommended ? ' recommended' : ''}`} onClick={props.onClick}>
      <span class="tile">
        <Icon name={props.icon} class="lg" />
      </span>
      <span class="text">
        <span class="title">
          {props.title}
          {props.badge && <span class="pill accent">{props.badge}</span>}
        </span>
        <span class="desc">{props.desc}</span>
      </span>
      <Icon name="chevron-right" />
    </button>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  title: string;
  desc: string;
  icon: IconName;
  badge?: string;
  disabled?: boolean;
}

/** Radio cards for a small set of exclusive options. */
export function RadioCards<T extends string>({ name, options, value, onChange }: { name: string; options: RadioOption<T>[]; value: T | null; onChange: (v: T) => void }) {
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

/** A collapsed section, styled like the rest of the "Advanced" boxes. */
export function Advanced({ summary, open, children }: { summary: string; open?: boolean; children: ComponentChildren }) {
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

export function EmptyState({ icon, title, text, children }: { icon: IconName; title: string; text: string; children?: ComponentChildren }) {
  return (
    <div class="card empty">
      <Icon name={icon} class="xl" />
      <h3>{title}</h3>
      <p class="muted">{text}</p>
      {children}
    </div>
  );
}
