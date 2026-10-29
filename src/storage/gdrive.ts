import { settleLimited } from '../core/pool.js';
import { type CreateOnceResult, DuplicateFileError, type StorageProvider } from '../engine/ports.js';
import { ProviderAuthError, ProviderError } from './webdav.js';

/** `code` is the OAuth `error` field from Google's token endpoint, absent for Drive API rejections. */
export class GoogleAuthError extends ProviderAuthError {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

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
const PARALLEL_DOWNLOADS = 6;
/** How long a listing's file IDs are reused for reads and overwrites, so one pass looks each file up once. */
const LISTING_FRESH_MS = 5_000;
const SPARE_IDS = 10;
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/**
 * Files live flat in the hidden appDataFolder. Drive has no paths and allows duplicate names, so each
 * file carries its logical path, its folder and its group as appProperties (each under 124 bytes).
 */
export class DriveProvider implements StorageProvider {
  private lastServerDate = Date.now();
  private readonly reserved = new Map<string, string>();
  private readonly listed = new Map<string, { at: number; files: DriveFile[] }>();
  private spareIds: string[] = [];

  constructor(
    private readonly auth: DriveAuth,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  serverDate(): number {
    return this.lastServerDate;
  }

  /** `about` is readable with the drive.appdata scope, so no extra sign-in permission is needed. */
  async whoAmI(): Promise<string | null> {
    const res = await this.call('GET', `${API}/about?fields=user(emailAddress)`);
    return ((await res.json()) as { user?: { emailAddress?: string } }).user?.emailAddress ?? null;
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

  async get(path: string): Promise<Uint8Array | null> {
    const recent = this.recent(path);
    return recent ? this.readRecent(path, recent) : this.read(path, await this.query({ p: path }));
  }

  /** One listing per folder instead of one lookup per file, then several downloads at once. */
  async getMany(paths: string[]): Promise<PromiseSettledResult<Uint8Array | null>[]> {
    const known = new Map(
      paths.flatMap((p) => {
        const r = this.recent(p);
        return r ? [[p, r] as const] : [];
      }),
    );
    const dirs = [...new Set(paths.filter((p) => !known.has(p)).map(dirname))];
    const listed = new Map<string, Map<string, DriveFile[]>>();
    await Promise.all(
      dirs.map(async (d) => {
        const byPath = new Map<string, DriveFile[]>();
        for (const f of await this.query({ dir: d })) byPath.set(f.appProperties!.p!, [...(byPath.get(f.appProperties!.p!) ?? []), f]);
        listed.set(d, byPath);
      }),
    );
    return settleLimited(paths, PARALLEL_DOWNLOADS, (p) => (known.has(p) ? this.readRecent(p, known.get(p)!) : this.read(p, listed.get(dirname(p))!.get(p) ?? [])));
  }

  async copiedPaths(dir: string): Promise<string[]> {
    const counts = new Map<string, number>();
    for (const f of await this.query({ dir: dir.endsWith('/') ? dir.slice(0, -1) : dir })) counts.set(f.appProperties!.p!, (counts.get(f.appProperties!.p!) ?? 0) + 1);
    return [...counts].filter(([, n]) => n > 1).map(([p]) => p);
  }

  /** Byte-identical copies (a retried upload) count as one file; differing copies mean two writers. */
  /** A file removed since the listing reads as a fresh lookup would. */
  private async readRecent(path: string, files: DriveFile[]): Promise<Uint8Array | null> {
    try {
      return await this.read(path, files);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.status !== 404) throw e;
      this.listed.delete(path);
      return this.read(path, await this.query({ p: path }));
    }
  }

  private async read(path: string, found: DriveFile[]): Promise<Uint8Array | null> {
    const files = [...found].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    if (!files[0]) return null;
    const first = await this.download(files[0].id);
    for (const extra of files.slice(1)) {
      const data = await this.download(extra.id);
      if (data.length !== first.length || data.some((b, i) => b !== first[i])) throw new DuplicateFileError(path);
    }
    for (const extra of files.slice(1)) await this.call('DELETE', `${API}/files/${extra.id}`, undefined, [404]);
    if (files.length > 1) this.listed.set(path, { at: Date.now(), files: [files[0]] });
    return first;
  }

  async createOnce(path: string, data: Uint8Array): Promise<CreateOnceResult> {
    const [existing, id] = await Promise.all([this.query({ p: path }), this.reserved.get(path) ?? this.newId()]);
    if (existing.length) {
      if (!this.reserved.has(path)) this.spareIds.push(id);
      return { status: 'exists', existing: await Promise.all(existing.map((f) => this.download(f.id))) };
    }
    this.reserved.set(path, id);
    const res = await this.upload('POST', `${UPLOAD}/files?uploadType=multipart`, { id, name: basename(path), parents: ['appDataFolder'], appProperties: props(path) }, data, true);
    this.reserved.delete(path);
    this.listed.delete(path);
    if (res.status === 409) {
      const now = await this.query({ p: path });
      return { status: 'exists', existing: await Promise.all(now.map((f) => this.download(f.id))) };
    }
    return { status: 'created' };
  }

  async overwrite(path: string, data: Uint8Array): Promise<void> {
    const recent = this.recent(path);
    const existing = recent ?? (await this.query({ p: path }));
    if (existing[0]) {
      const res = await this.upload('PATCH', `${UPLOAD}/files/${existing[0].id}?uploadType=multipart`, {}, data, recent ? [404] : []);
      // A file another browser removed since the listing: look it up again.
      if (res.status === 404) {
        this.listed.delete(path);
        return this.overwrite(path, data);
      }
      for (const extra of existing.slice(1)) await this.call('DELETE', `${API}/files/${extra.id}`, undefined, [404]);
      if (existing.length > 1) this.listed.set(path, { at: Date.now(), files: [existing[0]] });
    } else {
      await this.upload('POST', `${UPLOAD}/files?uploadType=multipart`, { name: basename(path), parents: ['appDataFolder'], appProperties: props(path) }, data);
    }
  }

  async delete(path: string): Promise<void> {
    for (const f of await this.query({ p: path })) await this.call('DELETE', `${API}/files/${f.id}`, undefined, [404]);
    this.listed.delete(path);
  }

  /** One listing per folder instead of one lookup per file, then several deletes at once. */
  async deleteMany(paths: string[]): Promise<void> {
    const wanted = new Set(paths);
    const listed = await Promise.all([...new Set(paths.map(dirname))].map((d) => this.query({ dir: d })));
    const ids = listed
      .flat()
      .filter((f) => wanted.has(f.appProperties!.p!))
      .map((f) => f.id);
    const failed = (await settleLimited(ids, PARALLEL_DOWNLOADS, (id) => this.call('DELETE', `${API}/files/${id}`, undefined, [404]))).find((r) => r.status === 'rejected');
    for (const p of paths) this.listed.delete(p);
    if (failed) throw failed.reason;
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
    const at = Date.now();
    const byPath = new Map<string, DriveFile[]>();
    for (const f of out) byPath.set(f.appProperties!.p!, [...(byPath.get(f.appProperties!.p!) ?? []), f]);
    // A path the listing covers but no longer returns was removed.
    for (const p of this.listed.keys()) if (p === where.p || (where.dir !== undefined && dirname(p) === where.dir)) this.listed.delete(p);
    for (const [p, files] of byPath) this.listed.set(p, { at, files });
    return out;
  }

  /** Every copy of `path` from a listing in the last few seconds; null when there was none or no file was found. */
  private recent(path: string): DriveFile[] | null {
    const r = this.listed.get(path);
    return r && Date.now() - r.at < LISTING_FRESH_MS ? r.files : null;
  }

  private async newId(): Promise<string> {
    if (!this.spareIds.length) {
      const res = await this.call('GET', `${API}/files/generateIds?count=${SPARE_IDS}&space=appDataFolder`);
      this.spareIds = ((await res.json()) as { ids: string[] }).ids;
    }
    return this.spareIds.shift()!;
  }

  private async download(id: string): Promise<Uint8Array> {
    const res = await this.call('GET', `${API}/files/${id}?alt=media`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async upload(method: string, url: string, meta: object, data: Uint8Array, allowConflict: boolean | number[] = false): Promise<Response> {
    const boundary = `bsync${Math.random().toString(36).slice(2)}`;
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + data.length + tail.length);
    body.set(head, 0);
    body.set(data, head.length);
    body.set(tail, head.length + data.length);
    return this.call(method, url, { body, contentType: `multipart/related; boundary=${boundary}` }, Array.isArray(allowConflict) ? allowConflict : allowConflict ? [409] : []);
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
    if (res.status === 401 || res.status === 403) throw new GoogleAuthError(`${method} ${url}: ${res.status}`);
    throw new ProviderError(`${method} ${url}: ${res.status} ${await res.text()}`, res.status);
  }
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function props(path: string): Record<string, string> {
  const parts = path.split('/');
  const kind = path.endsWith('/group.json') ? 'group' : path.endsWith('/device.json') ? 'device' : (parts[4] ?? 'file');
  return { p: path, dir: parts.slice(0, -1).join('/'), g: parts[1] ?? '', k: kind };
}
