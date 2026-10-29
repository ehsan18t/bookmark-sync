import { browser } from 'wxt/browser';

/** Opens a page of the options tab and closes the popup. */
export const openPage = (hash: string) => async () => {
  await browser.tabs.create({ url: browser.runtime.getURL(`/options.html#${hash}`) });
  window.close();
};
