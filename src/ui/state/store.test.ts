import { describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_KEY, type Snapshot } from '../../messages.js';

const store: Record<string, unknown> = {};
const listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: { get: async (key: string) => ({ [key]: store[key] }) },
      onChanged: { addListener: (f: (typeof listeners)[number]) => listeners.push(f) },
    },
    runtime: { sendMessage: async () => undefined },
  },
}));

const { follow, groups, devices, refreshError } = await import('./store.js');

const snapshot = (name: string, at: number): Snapshot => ({
  at,
  groups: [{ groupId: 'g1', name } as Snapshot['groups'][number]],
  accounts: [],
  folders: [],
  caps: { google: false, googleBlocked: false, browser: 'Chrome' },
  devices: { g1: [] },
});

describe('follow', () => {
  it('reports when nothing is saved yet', async () => {
    expect(await follow()).toBe(false);
    expect(groups.value).toEqual([]);
  });

  it('shows the saved snapshot and each later one', async () => {
    store[SNAPSHOT_KEY] = snapshot('Main', 1);
    expect(await follow()).toBe(true);
    expect(groups.value[0]?.name).toBe('Main');
    expect(devices.value).toEqual({ g1: [] });
    for (const f of listeners) f({ [SNAPSHOT_KEY]: { newValue: snapshot('Home', 3) } }, 'local');
    expect(groups.value[0]?.name).toBe('Home');
    for (const f of listeners) f({ [SNAPSHOT_KEY]: { newValue: snapshot('Sync', 4) } }, 'session');
    expect(groups.value[0]?.name).toBe('Home');
  });

  it('never replaces a newer snapshot with an older one', async () => {
    for (const f of listeners) f({ [SNAPSHOT_KEY]: { newValue: snapshot('Old', 2) } }, 'local');
    expect(groups.value[0]?.name).toBe('Home');
  });

  it('clears a failed refresh once a newer snapshot arrives', () => {
    refreshError.value = 'The extension did not answer.';
    for (const f of listeners) f({ [SNAPSHOT_KEY]: { newValue: snapshot('Later', 5) } }, 'local');
    expect(refreshError.value).toBe('');
  });
});
