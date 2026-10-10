import { browser } from 'wxt/browser';
import type { Account } from '../engine/app.js';
import { PermissionMissingError, type StorageProvider } from '../engine/ports.js';
import { DriveProvider } from '../storage/gdrive.js';
import { WebDavProvider } from '../storage/webdav.js';
import { driveAuth } from './auth.js';
import type { Engine } from './bookmarksPort.js';

export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/*`;
}

export function providerFactory(engine: Engine) {
  return (account: Account, onTokens: (a: Account) => Promise<void>): StorageProvider => {
    if (account.type === 'gdrive') return new DriveProvider(driveAuth(engine, account, onTokens));
    const inner = new WebDavProvider({ url: account.url, username: account.username, password: account.password });
    const pattern = originPattern(account.url);
    const guarded = async <T>(f: () => Promise<T>) => {
      if (!(await browser.permissions.contains({ origins: [pattern] }))) throw new PermissionMissingError(`access to ${pattern} was not granted`);
      return f();
    };
    return {
      listGroups: () => guarded(() => inner.listGroups()),
      listDevices: (g) => guarded(() => inner.listDevices(g)),
      get: (p) => guarded(() => inner.get(p)),
      createOnce: (p, d) => guarded(() => inner.createOnce(p, d)),
      overwrite: (p, d) => guarded(() => inner.overwrite(p, d)),
      delete: (p) => guarded(() => inner.delete(p)),
      listFiles: (d) => guarded(() => inner.listFiles(d)),
      serverDate: () => inner.serverDate(),
    };
  };
}
