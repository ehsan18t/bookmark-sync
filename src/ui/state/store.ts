import { batch, signal } from '@preact/signals';
import { browser } from 'wxt/browser';
import type { FoundGroup, GroupSummary, LocalFolder } from '../../engine/app.js';
import { SNAPSHOT_KEY, type Capabilities, type PublicAccount, type Snapshot } from '../../messages.js';
import { send } from '../lib/messaging.js';

export type { Capabilities, PublicAccount };
export type Folder = LocalFolder;
export type FoundSync = FoundGroup;

export const groups = signal<GroupSummary[]>([]);
export const accounts = signal<PublicAccount[]>([]);
export const folders = signal<Folder[]>([]);
export const caps = signal<Capabilities>({ google: false, googleBlocked: false, browser: 'this browser' });
export const devices = signal<Snapshot['devices']>({});

let shownAt = 0;
/** Why the last refresh failed, while the page still shows the saved snapshot. Cleared by the next snapshot. */
export const refreshError = signal('');

function apply(s: Snapshot) {
  if (s.at < shownAt) return;
  shownAt = s.at;
  batch(() => {
    refreshError.value = '';
    groups.value = s.groups;
    accounts.value = s.accounts;
    folders.value = s.folders;
    caps.value = s.caps;
    devices.value = s.devices;
  });
}

/** Shows the snapshot the background saved, and every later one. False when none is saved yet. */
export async function follow(): Promise<boolean> {
  browser.storage.onChanged.addListener((changes, area) => {
    const next = changes[SNAPSHOT_KEY]?.newValue as Snapshot | undefined;
    if (area === 'local' && next) apply(next);
  });
  const saved = (await browser.storage.local.get(SNAPSHOT_KEY))[SNAPSHOT_KEY] as Snapshot | undefined;
  if (saved) apply(saved);
  return !!saved;
}

/** Asks the background for a fresh snapshot; it waits behind a running sync. */
export async function load() {
  apply(await send<Snapshot>({ t: 'snapshot' }));
}

/** Ticks so relative times like "2 min ago" stay current. */
export const now = signal(Date.now());
setInterval(() => (now.value = Date.now()), 30_000);
