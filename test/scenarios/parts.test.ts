import { describe, expect, it } from 'vitest';
import type { PlaceHint } from '../../src/core/ids.js';
import { FAKE_ROOTS, FakeBookmarks, fakeRoots } from '../sim/fakeBookmarks.js';
import { type SimDevice, Simulator } from '../sim/simulator.js';

const JOIN = { join: { mode: 'merge' as const, ignoreDefaults: false } };

const folderIn = (bm: FakeBookmarks, parent: string, title: string) => bm.create({ parentId: parent, kind: 'folder', title, url: '' });
const bookmarkIn = (bm: FakeBookmarks, parent: string, title: string) => bm.create({ parentId: parent, kind: 'bookmark', title, url: `https://${title.replace(/\W/g, '')}.example/` });
const titlesIn = async (bm: FakeBookmarks, folder: string) => ((await bm.getSubTree(folder)).children ?? []).map((c) => c.title);
const sidOf = (d: SimDevice, localId: string) => new Map(d.engine.state.idmap).get(localId)!;

async function allBookmarksWithFavorites(seed: number) {
  const sim = new Simulator({ devices: 0, seed });
  const bmA = new FakeBookmarks('a_');
  const fav = await folderIn(bmA, FAKE_ROOTS.toolbar, 'Favorites');
  const f1 = await bookmarkIn(bmA, fav, 'f1');
  await bookmarkIn(bmA, FAKE_ROOTS.other, 'private');
  const a = await sim.addDevice('deva', async () => {}, { create: true }, 'firefox', { bookmarks: bmA });
  const bmB = new FakeBookmarks('b_');
  const mine = await folderIn(bmB, FAKE_ROOTS.other, 'Work favs');
  await bookmarkIn(bmB, mine, 'b1');
  await bookmarkIn(bmB, FAKE_ROOTS.toolbar, 'b only');
  const b = await sim.addDevice('devb', async () => {}, JOIN, 'chrome', { bookmarks: bmB, mapping: { [sidOf(a, fav)]: mine } });
  await sim.quiet();
  return { sim, a, b, bmA, bmB, fav, f1, mine };
}

describe('holding parts of a group', () => {
  it('a browser holding one folder of an all-bookmarks group stays in sync with it, and nothing else crosses over', async () => {
    const { sim, a, b, bmA, bmB, fav, f1, mine } = await allBookmarksWithFavorites(71);
    expect(await titlesIn(bmB, mine)).toEqual(['f1', 'b1']);
    expect(await titlesIn(bmA, fav)).toEqual(['f1', 'b1']);
    expect(await titlesIn(bmA, FAKE_ROOTS.toolbar)).toEqual(['Favorites']);
    expect(await titlesIn(bmB, FAKE_ROOTS.other)).toEqual(['Work favs']);

    await bookmarkIn(bmB, mine, 'b2');
    await bmA.update(f1, { title: 'f1 renamed' });
    await sim.quiet();
    expect(await titlesIn(bmA, fav)).toEqual(['f1 renamed', 'b1', 'b2']);
    expect(await titlesIn(bmB, mine)).toEqual(['f1 renamed', 'b1', 'b2']);

    await bmB.update(mine, { title: 'Mine' });
    await bmA.update(fav, { title: 'Faves' });
    await bmA.move(fav, { parentId: FAKE_ROOTS.other });
    await bookmarkIn(bmA, fav, 'after move');
    await sim.quiet();
    expect(bmA.node(fav).title).toBe('Faves');
    expect(bmB.node(mine).title).toBe('Mine');
    expect(await titlesIn(bmB, mine)).toEqual(['f1 renamed', 'b1', 'b2', 'after move']);
    expect(a.engine.status.state).toBe('active');
    expect(b.engine.status.state).toBe('active');
  });

  it('puts two folders of a group in different places under different names', async () => {
    const sim = new Simulator({ devices: 0, seed: 72 });
    const bmA = new FakeBookmarks('a_');
    const gameDev = await folderIn(bmA, FAKE_ROOTS.other, 'Game Dev');
    await bookmarkIn(bmA, gameDev, 'unity');
    const java = await folderIn(bmA, FAKE_ROOTS.other, 'Java');
    await bookmarkIn(bmA, java, 'jdk');
    await bookmarkIn(bmA, FAKE_ROOTS.other, 'loose');
    const a = await sim.addDevice('deva', async () => {}, { create: true }, 'firefox', { bookmarks: bmA });

    const bmB = new FakeBookmarks('b_');
    const games = await folderIn(bmB, FAKE_ROOTS.toolbar, 'Games');
    const javaNotes = await folderIn(bmB, await folderIn(bmB, FAKE_ROOTS.other, 'Work'), 'Java notes');
    await sim.addDevice('devb', async () => {}, JOIN, 'chrome', { bookmarks: bmB, mapping: { [sidOf(a, gameDev)]: games, [sidOf(a, java)]: javaNotes } });
    await sim.quiet();
    expect(await titlesIn(bmB, games)).toEqual(['unity']);
    expect(await titlesIn(bmB, javaNotes)).toEqual(['jdk']);

    await bookmarkIn(bmA, java, 'maven');
    await bookmarkIn(bmB, games, 'godot');
    await sim.quiet();
    expect(await titlesIn(bmB, javaNotes)).toEqual(['jdk', 'maven']);
    expect(await titlesIn(bmA, gameDev)).toEqual(['unity', 'godot']);
    expect(await titlesIn(bmA, FAKE_ROOTS.other)).toEqual(['Game Dev', 'Java', 'loose']);
  });

  it('lets go of a held folder deleted in another browser, keeping the copy, and pauses when nothing is left', async () => {
    const { sim, b, bmA, bmB, fav, mine } = await allBookmarksWithFavorites(73);
    await bmA.removeTree(fav);
    await sim.quiet();
    expect(await titlesIn(bmB, mine)).toEqual(['f1', 'b1']);
    expect(b.engine.status).toMatchObject({ state: 'paused', reason: 'nothing-held' });
    expect(b.engine.notices.map((n) => n.text)).toEqual([expect.stringContaining('“Work favs” was removed')]);
  });

  it('pauses a browser whose two held folders end up inside each other in the group', async () => {
    const sim = new Simulator({ devices: 0, seed: 74 });
    const bmA = new FakeBookmarks('a_');
    const x = await folderIn(bmA, FAKE_ROOTS.other, 'X');
    const y = await folderIn(bmA, FAKE_ROOTS.other, 'Y');
    const a = await sim.addDevice('deva', async () => {}, { create: true }, 'firefox', { bookmarks: bmA });
    const bmB = new FakeBookmarks('b_');
    const bx = await folderIn(bmB, FAKE_ROOTS.other, 'X here');
    const by = await folderIn(bmB, FAKE_ROOTS.toolbar, 'Y here');
    const b = await sim.addDevice('devb', async () => {}, JOIN, 'firefox', { bookmarks: bmB, mapping: { [sidOf(a, x)]: bx, [sidOf(a, y)]: by } });
    await sim.quiet();
    await bmA.move(y, { parentId: x });
    await sim.quiet();
    expect(b.engine.status).toMatchObject({ state: 'paused', reason: 'mapping-overlap' });
    expect(a.engine.status.state).toBe('active');
  });
});

describe('folder groups with several tops', () => {
  async function twoTops(seed: number) {
    const sim = new Simulator({ devices: 0, seed });
    const bmA = new FakeBookmarks('a_');
    const gameDev = await folderIn(bmA, FAKE_ROOTS.other, 'Game Dev');
    await bookmarkIn(bmA, gameDev, 'unity');
    await bookmarkIn(bmA, FAKE_ROOTS.toolbar, 'on the bar');
    await bookmarkIn(bmA, FAKE_ROOTS.other, 'not synced');
    const tops = [
      { id: 'top1', title: 'Game Dev', hint: { root: 'other', path: ['Game Dev'] } as PlaceHint },
      { id: 'top2', title: 'toolbar', hint: { root: 'toolbar', path: [] } as PlaceHint },
    ];
    const a = await sim.addDevice('deva', async () => {}, { create: true, tops }, 'firefox', {
      bookmarks: bmA,
      mode: 'folder',
      mapping: { top1: gameDev, top2: FAKE_ROOTS.toolbar },
      followTops: true,
    });
    const bmB = new FakeBookmarks('b_');
    await bookmarkIn(bmB, FAKE_ROOTS.toolbar, 'b bar');
    const roots = fakeRoots(bmB);
    const mapping = { top1: await roots.resolve(tops[0]!.hint, true), top2: await roots.resolve(tops[1]!.hint, true) };
    const b = await sim.addDevice('devb', async () => {}, JOIN, 'chrome', { bookmarks: bmB, mode: 'folder', mapping, followTops: true });
    await sim.quiet();
    return { sim, a, b, bmA, bmB, gameDev, gameDevB: mapping.top1 };
  }

  it('places each top at the same path, creating it when missing, and matches browser roots by type', async () => {
    const { bmA, bmB, gameDevB } = await twoTops(81);
    expect(await titlesIn(bmB, FAKE_ROOTS.other)).toEqual(['Game Dev']);
    expect(await titlesIn(bmB, gameDevB)).toEqual(['unity']);
    expect(await titlesIn(bmB, FAKE_ROOTS.toolbar)).toEqual(['on the bar', 'b bar']);
    expect(await titlesIn(bmA, FAKE_ROOTS.toolbar)).toEqual(['on the bar', 'b bar']);
    expect(await titlesIn(bmA, FAKE_ROOTS.other)).toEqual(['Game Dev', 'not synced']);
  });

  it('follows tops added in another browser and keeps copies of tops removed for everyone', async () => {
    const { sim, a, b, bmA, bmB, gameDev, gameDevB } = await twoTops(82);
    const recipes = await folderIn(bmA, FAKE_ROOTS.other, 'Recipes');
    await bookmarkIn(bmA, recipes, 'soup');
    const ownRecipes = await folderIn(bmB, FAKE_ROOTS.other, 'Recipes');
    await bookmarkIn(bmB, ownRecipes, 'secret');
    const menuA = await folderIn(bmA, FAKE_ROOTS.other, 'Menu of A');
    await a.engine.addTops([
      { id: 'top3', title: 'Recipes', hint: { root: 'other', path: ['Recipes'] }, localId: recipes },
      { id: 'top4', title: 'Menu of A', hint: { root: 'menu', path: [] }, localId: menuA },
    ]);
    await sim.quiet();
    const recipesB = b.engine.state.config.mapping.top3!;
    expect(recipesB).not.toBe(ownRecipes);
    expect(bmB.node(recipesB)).toMatchObject({ title: 'Recipes', parent: FAKE_ROOTS.other });
    expect(await titlesIn(bmB, recipesB)).toEqual(['soup']);
    expect(await titlesIn(bmA, recipes)).toEqual(['soup']);
    expect(bmB.node(b.engine.state.config.mapping.top4!)).toMatchObject({ title: 'Menu of A', parent: FAKE_ROOTS.menu });
    expect(b.engine.notices.map((n) => n.text)).toEqual([expect.stringContaining('“Recipes” was added'), expect.stringContaining('“Menu of A” was added')]);

    await b.engine.removePart('top1', true);
    await sim.quiet();
    expect(a.engine.state.config.mapping.top1).toBeUndefined();
    expect(await titlesIn(bmA, gameDev)).toEqual(['unity']);
    await bookmarkIn(bmA, gameDev, 'unreal');
    await sim.quiet();
    expect(await titlesIn(bmB, gameDevB)).toEqual(['unity']);

    await b.engine.removePart('top3', false);
    await bookmarkIn(bmA, recipes, 'stew');
    await sim.quiet();
    expect(await titlesIn(bmB, recipesB)).toEqual(['soup']);
    expect(b.engine.state.config.mapping.top3).toBeUndefined();
    expect(a.engine.status.state).toBe('active');
    expect(b.engine.status.state).toBe('active');
  });
});
