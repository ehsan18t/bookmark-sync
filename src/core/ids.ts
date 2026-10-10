// Identifiers (IMPLEMENTATION.md 2.1).

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

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

export function randomId(random: RandomBytes = cryptoRandomBytes): string {
  return base32(random(16));
}

export const ROOT_TOOLBAR = 'root:toolbar';
export const ROOT_OTHER = 'root:other';
export const ROOT_MENU = 'root:menu';
export const ROOT_GROUP = 'root:group';

export const EVERYTHING_ROOTS = [ROOT_TOOLBAR, ROOT_OTHER, ROOT_MENU] as const;
export const FOLDER_ROOTS = [ROOT_GROUP] as const;

export function isRootId(id: string): boolean {
  return id.startsWith('root:');
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Join-time ID: identical inputs on two devices give the same node ID, so simultaneous joins merge. */
export async function derivedId(
  groupId: string,
  parentStableId: string,
  kind: string,
  title: string,
  url: string,
  occurrence: number,
): Promise<string> {
  const input = [groupId, parentStableId, kind, title, url, String(occurrence)].join('\u0000');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return 'j' + base32(new Uint8Array(digest)).slice(0, 26);
}
