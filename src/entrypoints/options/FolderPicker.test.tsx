// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalFolder } from '../../engine/app.js';
import { FolderTree, Placements, toggle } from './FolderPicker.js';
import type { TreeItem } from './folders.js';

afterEach(cleanup);

const items: TreeItem[] = [
  { id: 'bar', parent: null, title: 'Bar' },
  { id: 'work', parent: 'bar', title: 'Work' },
  { id: 'docs', parent: 'work', title: 'Docs' },
  { id: 'other', parent: null, title: 'Other', blocked: 'Synced by “Main”' },
];

function Tree({ multi, initial = [] }: { multi: boolean; initial?: string[] }) {
  const [value, setValue] = useState(initial);
  return <FolderTree items={items} multi={multi} value={value} onChange={setValue} label="Folders" />;
}

const box = (name: string) => screen.getByRole(screen.queryAllByRole('checkbox').length ? 'checkbox' : 'radio', { name: new RegExp(name) }) as HTMLInputElement;

describe('toggle', () => {
  it('drops ticks inside a newly ticked folder', () => {
    expect(toggle(items, true, ['docs'], 'bar', true)).toEqual(['bar']);
  });
  it('keeps a single pick without multi', () => {
    expect(toggle(items, false, ['bar'], 'work', true)).toEqual(['work']);
  });
});

describe('FolderTree', () => {
  it('shows subfolders of a ticked folder as included and locked', () => {
    render(<Tree multi initial={['bar']} />);
    expect(box('Work').checked).toBe(true);
    expect(box('Work').disabled).toBe(true);
  });

  it('collapses and expands a folder', () => {
    render(<Tree multi />);
    fireEvent.click(screen.getByRole('button', { name: 'Show folders in Bar' }));
    expect(screen.queryByRole('checkbox', { name: /Work/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show folders in Bar' }));
    expect(box('Work')).toBeTruthy();
  });

  it('opens the path to a preselected folder and blocks held folders', () => {
    render(<Tree multi initial={['docs']} />);
    expect(box('Docs').checked).toBe(true);
    expect(box('Other').disabled).toBe(true);
  });

  it('unticks the others when a parent is ticked', () => {
    render(<Tree multi initial={['docs']} />);
    fireEvent.click(box('Bar'));
    expect(box('Bar').checked).toBe(true);
    expect(box('Docs').disabled).toBe(true);
  });
});

describe('Placements', () => {
  const local: LocalFolder[] = [
    { id: 'L1', parentId: null, title: 'Bookmarks bar', root: 'toolbar', path: 'Bookmarks bar' },
    { id: 'L2', parentId: 'L1', title: 'Work', root: 'toolbar', path: 'Bookmarks bar / Work' },
  ] as LocalFolder[];
  const groupFolders = [
    { id: 'g-work', parent: 'root:toolbar', title: 'Work' },
    { id: 'g-new', parent: 'root:toolbar', title: 'Recipes' },
  ] as never;

  it('says where each folder goes by default', () => {
    render(<Placements mode="everything" groupFolders={groupFolders} items={[]} local={local} localTree={[]} picked={['g-work', 'g-new']} chosen={{}} onChange={() => {}} />);
    expect(screen.getByText('Goes into Bookmarks bar / Work')).toBeTruthy();
    expect(screen.getByText('A new folder is made at Bookmarks bar / Recipes')).toBeTruthy();
  });
});
