import { fromBase64, toBase64 } from './ids.js';

export const DEFAULT_ITERATIONS = 600_000;
const CHECK_TEXT = 'bsync-key-check';

export interface KeyParams {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  check: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong passphrase');
  }
}

const rawOfKey = new WeakMap<CryptoKey, Uint8Array>();

/** Keys are non-extractable; the raw bytes of a freshly derived key are kept only so a session copy can live in memory. */
export async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, material, 256));
  const key = await importRawKey(raw);
  rawOfKey.set(key, raw);
  return key;
}

export function sessionBytes(key: CryptoKey): Uint8Array | null {
  return rawOfKey.get(key) ?? null;
}

export function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBytes(key: CryptoKey, plain: Uint8Array, aad: string): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, plain as BufferSource);
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(ct)) };
}

export async function decryptBytes(key: CryptoKey, iv: string, data: string, aad: string): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) as BufferSource, additionalData: new TextEncoder().encode(aad) }, key, fromBase64(data) as BufferSource);
  return new Uint8Array(pt);
}

export async function newKeyParams(passphrase: string, iterations = DEFAULT_ITERATIONS): Promise<{ params: KeyParams; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, iterations);
  const enc = await encryptBytes(key, new TextEncoder().encode(CHECK_TEXT), 'check');
  return { key, params: { kdf: 'PBKDF2-SHA256', iterations, salt: toBase64(salt), check: `${enc.iv}.${enc.data}` } };
}

export async function unlockKey(passphrase: string, params: KeyParams): Promise<CryptoKey> {
  const key = await deriveKey(passphrase, fromBase64(params.salt), params.iterations);
  const [iv, data] = params.check.split('.');
  try {
    const pt = await decryptBytes(key, iv!, data!, 'check');
    if (new TextDecoder().decode(pt) !== CHECK_TEXT) throw new WrongPassphraseError();
  } catch {
    throw new WrongPassphraseError();
  }
  return key;
}
