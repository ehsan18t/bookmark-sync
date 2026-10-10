import { describe, expect, it } from 'vitest';
import { exactKey, findDuplicates, possibleKey } from './dedupe.js';
import { findDefaultBookmarks } from './defaults.js';
import type { LiveNode } from './reconcile.js';

describe('duplicate finder', () => {
  it.each([
    ['https://Example.com/a/', 'https://example.com/a'],
    ['https://example.com/a#section', 'https://example.com/a'],
    ['https://example.com/', 'https://example.com'],
  ])('treats %s and %s as exact duplicates', (a, b) => {
    expect(exactKey(a)).toBe(exactKey(b));
  });

  it.each([
    ['https://example.com/?q=1', 'https://example.com/?q=2'],
    ['http://example.com/a', 'https://example.com/a'],
  ])('does not treat %s and %s as exact duplicates', (a, b) => {
    expect(exactKey(a)).not.toBe(exactKey(b));
  });

  it.each([
    ['http://www.example.com/a?utm_source=x&b=2&a=1', 'https://example.com/a?a=1&b=2'],
    ['https://example.com/p?fbclid=123', 'https://example.com/p'],
  ])('treats %s and %s as possible duplicates', (a, b) => {
    expect(possibleKey(a)).toBe(possibleKey(b));
  });

  it('keeps pages that differ in a real query parameter apart', () => {
    expect(possibleKey('https://example.com/list?page=2')).not.toBe(possibleKey('https://example.com/list?page=3'));
  });

  it('groups exact duplicates first and lists looser matches separately', () => {
    const item = (localId: string, url: string) => ({ localId, url, title: localId, path: '', group: null });
    const groups = findDuplicates([
      item('1', 'https://a.example/x'),
      item('2', 'https://a.example/x/'),
      item('3', 'http://www.b.example/y?utm_medium=z'),
      item('4', 'https://b.example/y'),
      item('5', 'https://c.example/'),
      item('6', 'javascript:void(0)'),
      item('7', 'javascript:void(0)'),
    ]);
    expect(groups.map((g) => [g.level, g.items.map((i) => i.localId)])).toEqual([
      ['exact', ['1', '2']],
      ['exact', ['6', '7']],
      ['possible', ['3', '4']],
    ]);
  });
});

describe('browser default bookmarks', () => {
  const bm = (localId: string, title: string, url: string): LiveNode => ({ localId, kind: 'bookmark', title, url });
  const folder = (localId: string, title: string, children: LiveNode[]): LiveNode => ({ localId, kind: 'folder', title, url: '', children });

  it('finds the Firefox default folder and bookmark but leaves the user’s own Mozilla links alone', () => {
    const roots = [
      folder('menu', '', [
        folder('mf', 'Mozilla Firefox', [bm('h', 'Get Help', 'https://support.mozilla.org/en-US/products/firefox'), bm('a', 'About Us', 'https://www.mozilla.org/de/about/')]),
        bm('mine', 'MDN', 'https://developer.mozilla.org/'),
      ]),
      folder('toolbar', '', [bm('gs', 'Getting Started', 'https://www.mozilla.org/en-US/firefox/central/'), bm('own', 'Notes', 'https://www.mozilla.org/notes')]),
    ];
    expect(findDefaultBookmarks(roots, 'firefox').sort()).toEqual(['gs', 'mf']);
  });

  it('does not treat a user folder named like a default folder as default if it holds other links', () => {
    const roots = [folder('menu', '', [folder('mf', 'Mozilla Firefox', [bm('x', 'Mine', 'https://example.com/')])])];
    expect(findDefaultBookmarks(roots, 'firefox')).toEqual([]);
  });

  it('finds nothing for browsers that ship no default bookmarks', () => {
    const roots = [folder('bar', '', [bm('g', 'Google', 'https://www.google.com/')])];
    expect(findDefaultBookmarks(roots, 'chrome')).toEqual([]);
  });
});
