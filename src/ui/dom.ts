import { browser } from 'wxt/browser';
import type { Command, Reply } from '../messages.js';
import { icon, type IconName } from './icons.js';

export async function send<T>(cmd: Command): Promise<T> {
  const reply = (await browser.runtime.sendMessage(cmd)) as Reply<T> | undefined;
  if (!reply) throw new Error('The extension did not answer. Try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | number | ((e: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function relativeTime(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function hlcTime(hlc: string): string {
  return new Date(Number(hlc.slice(0, 15))).toLocaleString();
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Kind = 'primary' | 'danger' | 'ghost' | '';

/** A button that shows a spinner while its action runs and the error, if any, right under it. */
export function action(
  label: string,
  run: () => Promise<unknown>,
  opts: { kind?: Kind; confirm?: string; icon?: IconName; busy?: string; size?: 'lg'; block?: boolean } = {},
) {
  const error = h('div', { class: 'error', role: 'alert' });
  const content = () => [opts.icon ? icon(opts.icon) : null, label].filter(Boolean) as (Node | string)[];
  const button = h('button', { class: [opts.kind ?? '', opts.size ?? '', opts.block ? 'block' : ''].join(' ').trim() }, ...content());
  button.addEventListener('click', async () => {
    if (opts.confirm && !window.confirm(opts.confirm)) return;
    button.disabled = true;
    button.replaceChildren(icon('loader-2', 'spin'), opts.busy ?? label);
    error.replaceChildren();
    try {
      await run();
    } catch (e) {
      error.replaceChildren(icon('alert-triangle'), h('span', {}, errorText(e)));
    } finally {
      button.disabled = false;
      button.replaceChildren(...content());
    }
  });
  return h('div', { class: `action${opts.block ? ' block' : ''}` }, button, error);
}

let fieldSeq = 0;

export function field(label: string, control: HTMLElement, hint?: string) {
  const id = control.id || `f${++fieldSeq}`;
  control.id = id;
  const hintEl = hint ? h('span', { class: 'hint', id: `${id}-hint` }, hint) : null;
  if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hintEl);
}

export function brand() {
  return h('div', { class: 'brand' }, icon('bookmarks'), 'Bookmark sync');
}
