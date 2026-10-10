import { browser } from 'wxt/browser';
import { exportRawKey, importRawKey } from '../core/crypto.js';
import { fromBase64, toBase64 } from '../core/ids.js';
import type { AppMeta, AppStore } from '../engine/app.js';
import type { GroupLocal } from '../engine/group.js';

const DB = 'bsync';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of ['groups', 'meta', 'keys']) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: T | undefined;
    const req = run(t.objectStore(store));
    if (req) req.onsuccess = () => (result = req.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export class IdbStore implements AppStore {
  private db: Promise<IDBDatabase> = open();
  private readonly memoryKeys = new Map<string, CryptoKey>();

  async load(groupId: string): Promise<GroupLocal | null> {
    return ((await tx<GroupLocal>(await this.db, 'groups', 'readonly', (s) => s.get(groupId))) as GroupLocal | undefined) ?? null;
  }

  async save(local: GroupLocal): Promise<void> {
    await tx(await this.db, 'groups', 'readwrite', (s) => void s.put(local, local.config.groupId));
  }

  async delete(groupId: string): Promise<void> {
    await tx(await this.db, 'groups', 'readwrite', (s) => void s.delete(groupId));
  }

  async loadMeta(): Promise<AppMeta | null> {
    return ((await tx<AppMeta>(await this.db, 'meta', 'readonly', (s) => s.get('meta'))) as AppMeta | undefined) ?? null;
  }

  async saveMeta(meta: AppMeta): Promise<void> {
    await tx(await this.db, 'meta', 'readwrite', (s) => void s.put(meta, 'meta'));
  }

  /** Remembered keys are stored non-extractable in IndexedDB; others live only in storage.session, which is kept in memory. */
  async getKey(groupId: string): Promise<CryptoKey | null> {
    const stored = (await tx<{ key: CryptoKey }>(await this.db, 'keys', 'readonly', (s) => s.get(groupId))) as { key: CryptoKey } | undefined;
    if (stored) return stored.key;
    if (this.memoryKeys.has(groupId)) return this.memoryKeys.get(groupId)!;
    const name = `key:${groupId}`;
    const session = (await browser.storage.session.get(name)) as Record<string, string | undefined>;
    return session[name] ? importRawKey(fromBase64(session[name]!)) : null;
  }

  async setKey(groupId: string, key: CryptoKey, persistent: boolean): Promise<void> {
    await this.deleteKey(groupId);
    if (!key.extractable) {
      if (persistent) await tx(await this.db, 'keys', 'readwrite', (s) => void s.put({ key }, groupId));
      else this.memoryKeys.set(groupId, key);
      return;
    }
    const raw = await exportRawKey(key);
    if (persistent) {
      const sealed = await importRawKey(raw);
      await tx(await this.db, 'keys', 'readwrite', (s) => void s.put({ key: sealed }, groupId));
    } else {
      await browser.storage.session.set({ [`key:${groupId}`]: toBase64(raw) });
    }
  }

  async deleteKey(groupId: string): Promise<void> {
    await tx(await this.db, 'keys', 'readwrite', (s) => void s.delete(groupId));
    this.memoryKeys.delete(groupId);
    await browser.storage.session.remove(`key:${groupId}`);
  }
}
