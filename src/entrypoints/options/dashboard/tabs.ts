import type { IconName } from '../../../ui/lib/icons.js';

export type Tab = 'overview' | 'history' | 'browsers' | 'duplicates' | 'settings' | 'about';

export const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'browsers', label: 'Browsers', icon: 'devices' },
  { id: 'duplicates', label: 'Duplicates', icon: 'copy' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'about', label: 'About', icon: 'info-circle' },
];

export const isTab = (s: string): s is Tab => TABS.some((t) => t.id === s);
