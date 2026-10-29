import { randomId, toBase64 } from '../core/ids.js';
import type { CreateOnceResult, StorageProvider } from '../engine/ports.js';

export interface WebDavConfig {
  /** Base folder URL, for example https://cloud.example.com/remote.php/dav/files/me/bsync/ */
  url: string;
  username: string;
  password: string;
}

export class ProviderAuthError extends Error {}
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Entry {
  name: string;
  collection: boolean;
}

const TMP_PREFIX = '.tmp-';

export class WebDavProvider implements StorageProvider {
  private readonly base: URL;
  private readonly auth: string;
  private lastServerDate = Date.now();
  private readonly knownDirs = new Set<string>();

  constructor(
    config: WebDavConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {
    this.base = new URL(config.url.endsWith('/') ? config.url : `${config.url}/`);
    this.auth = `Basic ${toBase64(new TextEncoder().encode(`${config.username}:${config.password}`))}`;
  }

  serverDate(): number {
    return this.lastServerDate;
  }

  async listGroups(): Promise<string[]> {
    return (await this.list('groups/')).filter((e) => e.collection).map((e) => e.name);
  }

  async listDevices(group: string): Promise<string[]> {
    return (await this.list(`groups/${group}/devices/`)).filter((e) => e.collection).map((e) => e.name);
  }

  async listFiles(dir: string): Promise<string[]> {
    const d = dir.endsWith('/') ? dir : `${dir}/`;
    return (await this.list(d)).filter((e) => !e.collection && !e.name.startsWith(TMP_PREFIX)).map((e) => d + e.name);
  }

  async get(path: string): Promise<Uint8Array | null> {
    const res = await this.request('GET', path);
    if (res.status === 404) return null;
    await this.check(res, 'GET', path);
    return new Uint8Array(await res.arrayBuffer());
  }

  async createOnce(path: string, data: Uint8Array): Promise<CreateOnceResult> {
    await this.ensureParents(path);
    const tmp = `${dirname(path)}${TMP_PREFIX}${randomId(undefined, 8)}`;
    await this.check(await this.request('PUT', tmp, { body: data }), 'PUT', tmp);
    const res = await this.request('MOVE', tmp, { headers: { Destination: this.url(path).href, Overwrite: 'F' } });
    if (res.status === 201 || res.status === 204) return { status: 'created' };
    if (res.status === 412) {
      await this.delete(tmp);
      const existing = await this.get(path);
      return { status: 'exists', existing: existing ? [existing] : [] };
    }
    await this.delete(tmp);
    await this.check(res, 'MOVE', path);
    return { status: 'created' };
  }

  async overwrite(path: string, data: Uint8Array): Promise<void> {
    await this.ensureParents(path);
    await this.check(await this.request('PUT', path, { body: data }), 'PUT', path);
  }

  async delete(path: string): Promise<void> {
    const res = await this.request('DELETE', path);
    if (res.status !== 404) await this.check(res, 'DELETE', path);
  }

  private async list(dir: string): Promise<Entry[]> {
    const res = await this.request('PROPFIND', dir, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    });
    if (res.status === 404) return [];
    await this.check(res, 'PROPFIND', dir);
    return parseMultistatus(await res.text(), this.url(dir).pathname);
  }

  private async ensureParents(path: string): Promise<void> {
    const parts = path.split('/').slice(0, -1);
    for (let i = 0; i <= parts.length; i++) {
      const dir = i === 0 ? '' : `${parts.slice(0, i).join('/')}/`;
      if (this.knownDirs.has(dir)) continue;
      const res = await this.request('MKCOL', dir);
      if (res.status !== 201 && res.status !== 405 && res.status !== 301) await this.check(res, 'MKCOL', dir);
      this.knownDirs.add(dir);
    }
  }

  private url(path: string): URL {
    return new URL(path.split('/').map(encodeURIComponent).join('/'), this.base);
  }

  private async request(method: string, path: string, init: { body?: BodyInit | Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const res = await this.fetchImpl(this.url(path), {
      method,
      credentials: 'omit',
      headers: { Authorization: this.auth, ...init.headers },
      body: init.body as BodyInit | undefined,
    });
    const date = res.headers.get('Date');
    if (date && !Number.isNaN(Date.parse(date))) this.lastServerDate = Date.parse(date);
    return res;
  }

  private async check(res: Response, method: string, path: string): Promise<void> {
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) throw new ProviderAuthError(`${method} ${path}: ${res.status}`);
    throw new ProviderError(`${method} ${path}: ${res.status} ${res.statusText}`, res.status);
  }
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/** PROPFIND responses parsed without DOMParser, which MV3 service workers do not have. */
export function parseMultistatus(xml: string, requestPath: string): Entry[] {
  const out: Entry[] = [];
  const self = decodePath(requestPath).replace(/\/+$/, '');
  const responses = xml.match(/<(?:[\w-]+:)?response[\s>][\s\S]*?<\/(?:[\w-]+:)?response>/g) ?? [];
  for (const r of responses) {
    const href = /<(?:[\w-]+:)?href>([^<]*)<\/(?:[\w-]+:)?href>/.exec(r)?.[1];
    if (!href) continue;
    let path = decodeXml(href);
    if (/^https?:\/\//.test(path)) path = new URL(path).pathname;
    path = decodePath(path).replace(/\/+$/, '');
    if (path === self) continue;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const collection = /<(?:[\w-]+:)?collection\s*\/?>/.test(r);
    out.push({ name, collection });
  }
  return out;
}

function decodePath(p: string): string {
  return p
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
