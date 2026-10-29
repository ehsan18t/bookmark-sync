import { signal } from '@preact/signals';
import { groups } from '../../ui/state/store.js';
import { isTab } from './dashboard/tabs.js';

export const hash = signal(location.hash.slice(1));
/** Setup keeps the page until it finishes, even once its own reload shows a sync. */
export const inSetup = signal(false);

export const finishSetup = () => {
  inSetup.value = false;
  location.hash = 'overview';
};

export function followHash(): void {
  window.addEventListener('hashchange', () => {
    hash.value = location.hash.slice(1);
    if (isTab(hash.value) && groups.value.length) inSetup.value = false;
  });
}
