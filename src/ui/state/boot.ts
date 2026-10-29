import { signal } from '@preact/signals';
import { errorText } from '../lib/format.js';
import { follow, load, refreshError } from './store.js';

export const ready = signal(false);
export const failure = signal('');

/** The saved snapshot draws the page at once; the fresh load only has to be waited for when nothing is saved. */
async function start() {
  if (await follow()) {
    ready.value = true;
    void load().catch((e) => (refreshError.value = errorText(e)));
  } else {
    await load();
    ready.value = true;
  }
}

export function boot(): void {
  start().catch((e) => (failure.value = errorText(e)));
}
