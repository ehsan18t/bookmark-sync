import { DuplicateFileError, type CreateOnceResult, type StorageProvider } from '../engine/ports.js';
import { ProviderAuthError, ProviderError } from './webdav.js';

export interface DriveAuth {
  token(): Promise<string>;
  /** Called after a 401; returns a fresh token or throws if sign-in is needed again. */
  refresh(): Promise<string>;
}

interface DriveFile {
  id: string;
  appProperties?: Record<string, string>;
}

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/**
 * Files live flat in the hidden appDataFolder. Drive has no paths and allows duplicate names, so each
 * file carries its logical path, its folder and its group as appProperties (each under 124 bytes).
 */
export class DriveProvider implements StorageProvider {
  private lastServerDate = Date.now();
  private readonly reserved = new Map<string, string>();

  constructor(
    private readonly auth: DriveAuth,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  serverDate(): number {
    return this.lastServerDate;
  }

  async listGroups(): Promise<string[]> {
    return (await this.query({ k: 'group' })).map((f) => f.appProperties!.g!).sort();
  }

  async listDevices(group: string): Promise<string[]> {
    const files = await this.query({ g: group, k: 'device' });
    return [...new Set(files.map((f) => f.appProperties!.p!.split('/')[3]!))].sort();
  }

  async listFiles(dir: string): Promise<string[]> {
    const d = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    return [...new Set((await this.query({ dir: d })).map((f) => f.appProperties!.p!))].sort();
  }

  /** Byte-identical copies (a retried upload) count as one file; differing copies mean two writers. */
  async get(path: string): Promise<Uint8Array | null> {
    const files = (await this.query({ p: path })).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    if (!files[0]) return null;
    const first = await this.download(files[0].id);
    for (const extra of files.slice(1)) {
      const data = await this.download(extra.id);
      if (data.length !== first.length || data.some((b, i) => b !== first[i])) throw new DuplicateFileError(path);
    }
    for (const extra of files.slice(1)) await this.call('DELETE', `${API}/files/${extra.id}`, undefined, [404]);
    return first;
  }

  async createOnce(path: string, data: Uint8Array): Promise<CreateOnceResult> {
    const existing = await this.query({ p: path });
    if (existing.length) return { status: 'exists', existing: await Promise.all(existing.map((f) => this.download(f.id))) };
    let id = this.reserved.get(path);
    if (!id) {
      const res = await this.call('GET', `${API}/files/generateIds?count=1&space=appDataFolder`);
      id = ((await res.json()) as { ids: string[] }).ids[0]!;
      this.reserved.set(path, id);
    }
    const res = await this.upload('POST', `${UPLOAD}/files?uploadType=multipart`, { id, name: basename(path), parents: ['appDataFolder'], appProperties: props(path) }, data, true);
    this.reserved.delete(path);
    if (res.status === 409) {
      const now = await this.query({ p: path });
      return { status: 'exists', existing: await Promise.all(now.map((f) => this.download(f.id))) };
    }
    return { status: 'created' };
  }

  async overwrite(path: string, data: Uint8Array): Promise<void> {
    const existing = await this.query({ p: path });
    if (existing[0]) {
      await this.upload('PATCH', `${UPLOAD}/files/${existing[0].id}?uploadType=multipart`, {}, data);
      for (const extra of existing.slice(1)) await this.call('DELETE', `${API}/files/${extra.id}`);
    } else {
      await this.upload('POST', `${UPLOAD}/files?uploadType=multipart`, { name: basename(path), parents: ['appDataFolder'], appProperties: props(path) }, data);
    }
  }

  async delete(path: string): Promise<void> {
    for (const f of await this.query({ p: path })) await this.call('DELETE', `${API}/files/${f.id}`, undefined, [404]);
  }

  private async query(where: Record<string, string>): Promise<DriveFile[]> {
    const q = Object.entries(where)
      .map(([k, v]) => `appProperties has { key='${k}' and value='${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' }`)
      .join(' and ');
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ spaces: 'appDataFolder', q: `${q} and trashed = false`, fields: 'nextPageToken,files(id,appProperties)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.call('GET', `${API}/files?${params}`);
      const body = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
      out.push(...body.files);
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  private async download(id: string): Promise<Uint8Array> {
    const res = await this.call('GET', `${API}/files/${id}?alt=media`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async upload(method: string, url: string, meta: object, data: Uint8Array, allowConflict = false): Promise<Response> {
    const boundary = 'bsync' + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + data.length + tail.length);
    body.set(head, 0);
    body.set(data, head.length);
    body.set(tail, head.length + data.length);
    return this.call(method, url, { body, contentType: `multipart/related; boundary=${boundary}` }, allowConflict ? [409] : []);
  }

  private async call(method: string, url: string, init?: { body: Uint8Array; contentType: string }, okStatuses: number[] = [], retried = false): Promise<Response> {
    const token = retried ? await this.auth.refresh() : await this.auth.token();
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(init ? { 'Content-Type': init.contentType } : {}) },
      body: init?.body as BodyInit | undefined,
    });
    const date = res.headers.get('Date');
    if (date && !Number.isNaN(Date.parse(date))) this.lastServerDate = Date.parse(date);
    if (res.ok || okStatuses.includes(res.status)) return res;
    if (res.status === 401 && !retried) return this.call(method, url, init, okStatuses, true);
    if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`${method} ${url}: ${res.status}`);
    throw new ProviderError(`${method} ${url}: ${res.status} ${await res.text()}`, res.status);
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function props(path: string): Record<string, string> {
  const parts = path.split('/');
  const kind = path.endsWith('/group.json') ? 'group' : path.endsWith('/device.json') ? 'device' : parts[4] ?? 'file';
  return { p: path, dir: parts.slice(0, -1).join('/'), g: parts[1] ?? '', k: kind };
}
