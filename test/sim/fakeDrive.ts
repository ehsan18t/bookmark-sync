interface FakeFile {
  id: string;
  appProperties: Record<string, string>;
  data: Uint8Array;
}

/** The subset of the Drive v3 REST API the provider uses, as a fetch function. */
export class FakeDrive {
  files = new Map<string, FakeFile>();
  validToken = 'good';
  private counter = 0;

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (headers.get('Authorization') !== `Bearer ${this.validToken}`) return this.reply(401, { error: 'invalid token' });
    const path = url.pathname;

    if (method === 'GET' && path === '/drive/v3/files/generateIds') return this.reply(200, { ids: [`id${++this.counter}`] });
    if (method === 'GET' && path === '/drive/v3/files') {
      const pairs = [...(url.searchParams.get('q') ?? '').matchAll(/key='([^']+)' and value='((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1]!, m[2]!.replace(/\\(.)/g, '$1')]);
      const files = [...this.files.values()].filter((f) => pairs.every(([k, v]) => f.appProperties[k!] === v)).map((f) => ({ id: f.id, appProperties: f.appProperties }));
      return this.reply(200, { files });
    }
    const idMatch = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path);
    if (method === 'GET' && idMatch && url.searchParams.get('alt') === 'media') {
      const f = this.files.get(idMatch[1]!);
      return f ? new Response(f.data.slice(), { status: 200, headers: { Date: new Date().toUTCString() } }) : this.reply(404, {});
    }
    if (method === 'DELETE' && idMatch) return this.files.delete(idMatch[1]!) ? new Response(null, { status: 204 }) : this.reply(404, {});
    if ((method === 'POST' && path === '/upload/drive/v3/files') || (method === 'PATCH' && idMatch)) {
      const { meta, data } = parseMultipart(new Uint8Array(init.body as Uint8Array), headers.get('Content-Type')!);
      if (method === 'PATCH') {
        const f = this.files.get(idMatch![1]!);
        if (!f) return this.reply(404, {});
        f.data = data;
        return this.reply(200, { id: f.id });
      }
      const id = (meta.id as string | undefined) ?? `id${++this.counter}`;
      if (this.files.has(id)) return this.reply(409, { error: 'exists' });
      this.files.set(id, { id, appProperties: (meta.appProperties as Record<string, string>) ?? {}, data });
      return this.reply(200, { id });
    }
    return this.reply(400, { error: `unsupported ${method} ${path}` });
  };

  private reply(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
  }
}

function parseMultipart(body: Uint8Array, contentType: string): { meta: Record<string, unknown>; data: Uint8Array } {
  const boundary = /boundary=(.+)$/.exec(contentType)![1]!;
  const buf = Buffer.from(body);
  const sep = Buffer.from(`\r\n--${boundary}`);
  const firstHeaderEnd = buf.indexOf('\r\n\r\n') + 4;
  const metaEnd = buf.indexOf(sep, firstHeaderEnd);
  const meta = JSON.parse(buf.subarray(firstHeaderEnd, metaEnd).toString('utf8'));
  const secondHeaderEnd = buf.indexOf('\r\n\r\n', metaEnd) + 4;
  const dataEnd = buf.indexOf(Buffer.from(`\r\n--${boundary}--`), secondHeaderEnd);
  return { meta, data: new Uint8Array(buf.subarray(secondHeaderEnd, dataEnd)) };
}
