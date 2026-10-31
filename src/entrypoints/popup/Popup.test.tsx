// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Popup } from './Popup.js';

vi.mock('wxt/browser', () => ({ browser: { runtime: { getManifest: () => ({ version: '1.2.3', description: 'Keeps bookmarks the same.' }) } } }));
vi.mock('../../ui/state/boot.js', () => ({ failure: { value: '' }, ready: { value: true } }));
vi.mock('../../ui/state/store.js', () => ({ groups: { value: [] }, refreshError: { value: '' }, sendAndReload: vi.fn() }));

afterEach(cleanup);

describe('popup', () => {
  it('opens About with the version and goes back to the normal view', () => {
    render(<Popup />);
    fireEvent.click(screen.getByRole('button', { name: 'About' }));
    expect(screen.getByText('Version 1.2.3')).toBeTruthy();
    expect(screen.getByText('Keeps bookmarks the same.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Sync isn’t set up yet')).toBeTruthy();
  });
});
