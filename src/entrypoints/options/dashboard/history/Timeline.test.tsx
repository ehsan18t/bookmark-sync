// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupSummary } from '../../../../engine/app.js';
import type { TimelineEntry } from '../../../../engine/group.js';
import { send } from '../../../../ui/lib/messaging.js';
import { Timeline } from './Timeline.js';

vi.mock('../../../../ui/lib/messaging.js', () => ({ send: vi.fn() }));
vi.mock('../../../../ui/state/store.js', () => ({ devices: { value: { g: [{ deviceId: 'b', name: 'Brave on Windows', browser: 'brave', self: false }] } }, load: vi.fn() }));

afterEach(cleanup);

const at = (n: number) => `${String(n).padStart(15, '0')}-000000-b`;

const entries: TimelineEntry[] = [
  {
    device: 'b',
    from: at(2_000),
    to: at(2_000),
    count: 1,
    kinds: { update: 1 },
    via: 'browser-sync',
    changes: [
      {
        type: 'update',
        at: at(2_000),
        kind: 'bookmark',
        title: 'MDN',
        url: 'https://mdn.example/',
        folder: ['root:toolbar', 'Dev'],
        edits: [{ field: 'title', before: 'MDN Web Docs', after: 'MDN' }],
      },
    ],
  },
  {
    device: 'b',
    from: at(1_000),
    to: at(1_010),
    count: 2,
    kinds: { create: 1, move: 1 },
    via: 'user',
    changes: [
      { type: 'create', at: at(1_000), kind: 'bookmark', title: 'Rust book', url: 'https://rust.example/', folder: ['root:toolbar', 'Dev'] },
      { type: 'move', at: at(1_010), kind: 'bookmark', title: 'News', url: 'https://news.example/', folder: ['root:toolbar'], from: ['root:other', 'Old'] },
    ],
  },
];

describe('history', () => {
  it('names a single change and lists every change of a row in a dialog', async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    vi.mocked(send).mockImplementation(async () => entries as never);
    render(<Timeline g={{ groupId: 'g', lastSyncAt: 1, restorePoints: [], oldestRestorable: at(0) } as unknown as GroupSummary} />);
    await waitFor(() => screen.getByText('Brave on Windows · via Brave Sync or an import · edited “MDN”'));
    expect(screen.getByText('Brave on Windows · by you · 1 added, 1 moved')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'View changes' })[1]!);
    await waitFor(() => screen.getByText('Changes from Brave on Windows'));
    expect(screen.getByText('Made in Brave on Windows by you, or by another extension installed there.')).toBeTruthy();
    expect(screen.getByText('in Bookmarks bar / Dev')).toBeTruthy();
    expect(screen.getByText('Other bookmarks / Old → Bookmarks bar')).toBeTruthy();
  });
});
