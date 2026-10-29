const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export type RandomBytes = (n: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function randomId(random: RandomBytes = cryptoRandomBytes, bytes = 16): string {
  return base32(random(bytes));
}

export const ROOT_TOOLBAR = 'root:toolbar';
export const ROOT_OTHER = 'root:other';
export const ROOT_MENU = 'root:menu';
export const ROOT_GROUP = 'root:group';

export const EVERYTHING_ROOTS = [ROOT_TOOLBAR, ROOT_OTHER, ROOT_MENU] as const;

export const isRootId = (id: string): boolean => id.startsWith('root:');

export type RootType = 'toolbar' | 'other' | 'menu' | 'mobile';

/** Where a top folder sits in the browser that added it: a browser root found by type, then folder titles. */
export interface PlaceHint {
  root: RootType;
  path: string[];
}

const HINT_PREFIX = 'top:';
const ROOT_TYPES: readonly string[] = ['toolbar', 'other', 'menu', 'mobile'];

/** Tops carry their hint in the url field; folders have no url of their own. */
export function encodeHint(h: PlaceHint): string {
  return HINT_PREFIX + [h.root, ...h.path].map(encodeURIComponent).join('/');
}

export function decodeHint(url: string): PlaceHint | null {
  if (!url.startsWith(HINT_PREFIX)) return null;
  const [root, ...path] = url.slice(HINT_PREFIX.length).split('/').map(decodeURIComponent);
  return root && ROOT_TYPES.includes(root) ? { root: root as RootType, path } : null;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function derivedId(groupId: string, parentStableId: string, kind: string, title: string, url: string, occurrence: number): Promise<string> {
  const input = [groupId, parentStableId, kind, title, url, String(occurrence)].join('\u0000');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `j${base32(new Uint8Array(digest)).slice(0, 26)}`;
}
