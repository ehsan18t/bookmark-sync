// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DuplicateGroup } from '../../../../core/dedupe.js';
import { send } from '../../../../ui/lib/messaging.js';
import { Duplicates } from './Duplicates.js';

vi.mock('../../../../ui/lib/messaging.js', () => ({ send: vi.fn() }));
vi.mock('../../../../ui/state/store.js', () => ({ folders: { value: [] }, now: { value: 0 } }));

afterEach(cleanup);

const item = (localId: string, group: string | null = null) => ({ localId, title: localId, url: `https://${localId}.example/`, path: 'Other', group });

const sets: DuplicateGroup[] = [
  { level: 'exact', key: 'a', items: [item('a-local'), item('a-synced', 'Main')] },
  { level: 'exact', key: 'b', items: [item('b1'), item('b2'), item('b3')] },
  { level: 'possible', key: 'c', items: [item('c1'), item('c2')] },
];

function setup() {
  const mock = vi.mocked(send);
  mock.mockReset();
  mock.mockImplementation(async (cmd) => (cmd.t === 'scanDuplicates' ? sets : cmd.t === 'localUndo' ? [] : undefined) as never);
  render(<Duplicates />);
  fireEvent.click(screen.getByRole('button', { name: 'Find duplicates' }));
  return mock;
}

const radio = (name: string, nth = 0) => screen.getAllByRole('radio', { name: new RegExp(name) })[nth] as HTMLInputElement;

describe('Duplicates', () => {
  it('keeps the synced copy of exact sets, leaves possible ones alone, and sums up what Apply removes', async () => {
    setup();
    await screen.findByText(/Removes 3 bookmarks from 2 sets · 1 set left as it is/);
    expect(radio('a-synced').checked).toBe(true);
    expect(radio('b1').checked).toBe(true);
    expect(radio('Keep all of these', 2).checked).toBe(true);
  });

  it('applies every choice in one cleanup', async () => {
    const mock = setup();
    await screen.findByText(/Removes 3 bookmarks/);
    fireEvent.click(radio('c2'));
    fireEvent.click(radio('Keep all of these', 1));
    await screen.findByText(/Removes 2 bookmarks from 2 sets · 1 set left as it is/);
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith({ t: 'applyDedupe', action: { remove: ['a-local', 'c1'] } }));
    vi.unstubAllGlobals();
  });

  it('sets every choice at once', async () => {
    setup();
    await screen.findByText(/Removes 3 bookmarks/);
    fireEvent.click(screen.getByRole('button', { name: 'Leave all as they are' }));
    await screen.findByText(/Nothing to remove · 3 sets left as they are/);
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep the synced copy everywhere' }));
    await screen.findByText(/Removes 4 bookmarks from 3 sets/);
  });
});
