import { browser } from 'wxt/browser';
import { randomId } from '../core/ids.js';
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

/** Keys not remembered on this device are tagged with the browser session, kept in storage.session, and ignored after a restart. */
async function sessionId(): Promise<string> {
  const got = (await browser.storage.session.get('sessionId')) as { sessionId?: string };
  if (got.sessionId) return got.sessionId;
  const id = randomId();
  await browser.storage.session.set({ sessionId: id });
  return id;
}

export class IdbStore implements AppStore {
  private db: Promise<IDBDatabase> = open();

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

  async getKey(groupId: string): Promise<CryptoKey | null> {
    const entry = (await tx<{ key: CryptoKey; session: string }>(await this.db, 'keys', 'readonly', (s) => s.get(groupId))) as
      | { key: CryptoKey; session: string }
      | undefined;
    if (!entry) return null;
    if (entry.session !== 'persistent' && entry.session !== (await sessionId())) return null;
    return entry.key;
  }

  async setKey(groupId: string, key: CryptoKey, persistent: boolean): Promise<void> {
    const session = persistent ? 'persistent' : await sessionId();
    await tx(await this.db, 'keys', 'readwrite', (s) => void s.put({ key, session }, groupId));
  }

  async deleteKey(groupId: string): Promise<void> {
    await tx(await this.db, 'keys', 'readwrite', (s) => void s.delete(groupId));
  }
}
