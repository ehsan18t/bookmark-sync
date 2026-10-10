import { decryptBytes, encryptBytes, type KeyParams } from './crypto.js';
import type { Hlc } from './hlc.js';
import { sha256Hex } from './ids.js';
import type { Op } from './ops.js';
import type { SerializedState } from './replay.js';

export const FORMAT = 'bsync';
export const FORMAT_MAJOR = 1;
export const FORMAT_MINOR = 0;

export type FileKind = 'group' | 'device' | 'batch' | 'snapshot' | 'marker';

interface Envelope {
  format: typeof FORMAT;
  v: number;
  minor: number;
  kind: FileKind;
  enc: null | { alg: 'A256GCM'; iv: string };
  body: unknown;
}

export interface GroupHeader {
  groupId: string;
  name: string;
  mode: 'everything' | 'folder';
  createdBy: string;
  createdAt: string;
  encryption: KeyParams | null;
}

export interface DeviceInfo {
  deviceId: string;
  name: string;
  browser: string;
  lastBatchNo: number;
  lastBatchHash: string;
  lastOpSeq: number;
  bound: Hlc;
  frontier: Hlc;
  firstRetainedBatchNo: number;
  firstRetainedOpSeq: number;
  left: boolean;
  frozenFor: string | null;
  markers: Record<string, number>;
  updatedAt: number;
}

export interface Batch {
  batchNo: number;
  prevHash: string;
  firstOpSeq: number;
  confirmed: boolean;
  ops: Op[];
}

export interface Snapshot {
  frontier: Hlc;
  state: SerializedState;
}

export interface MigrationMarker {
  migrationId: string;
  hlc: Hlc;
  encryption: KeyParams | null;
  excluded: string[];
}

export interface MigratedMarker {
  migrationId: string;
  newGroupId: string;
  coverage: Record<string, number>;
}

export interface GroupDeletedMarker {
  hlc: Hlc;
}

export interface RemovedMarker {
  devices: string[];
}

export class FormatTooNewError extends Error {
  constructor(readonly found: number) {
    super(`file format version ${found} is newer than this extension supports (${FORMAT_MAJOR})`);
  }
}

export class CorruptFileError extends Error {}

export class LockedError extends Error {
  constructor() {
    super('group is encrypted and locked');
  }
}

export interface Crypt {
  key: CryptoKey | null;
  path: string;
  /** The group is encrypted: plaintext files are refused even while locked. */
  required?: boolean;
}

export async function encode(kind: FileKind, body: unknown, crypt?: Crypt): Promise<Uint8Array> {
  if (crypt?.required && !crypt.key) throw new LockedError();
  let env: Envelope = { format: FORMAT, v: FORMAT_MAJOR, minor: FORMAT_MINOR, kind, enc: null, body };
  if (crypt?.key) {
    const enc = await encryptBytes(crypt.key, new TextEncoder().encode(JSON.stringify(body)), crypt.path);
    env = { ...env, enc: { alg: 'A256GCM', iv: enc.iv }, body: enc.data };
  }
  return new TextEncoder().encode(JSON.stringify(env));
}

export async function decode<B>(bytes: Uint8Array, kind: FileKind, crypt?: Crypt): Promise<B> {
  let env: Envelope;
  try {
    env = JSON.parse(new TextDecoder().decode(bytes)) as Envelope;
  } catch {
    throw new CorruptFileError('file is not valid JSON');
  }
  if (env.format !== FORMAT) throw new CorruptFileError('not a bsync file');
  if (typeof env.v !== 'number') throw new CorruptFileError('missing format version');
  if (env.v > FORMAT_MAJOR) throw new FormatTooNewError(env.v);
  if (env.kind !== kind) throw new CorruptFileError(`expected ${kind}, found ${env.kind}`);
  if (env.enc === null) {
    if (crypt?.key || crypt?.required) throw new CorruptFileError('unencrypted file in an encrypted group');
    return env.body as B;
  }
  if (env.enc.alg !== 'A256GCM') throw new CorruptFileError(`unknown encryption ${String(env.enc.alg)}`);
  if (!crypt?.key) throw new LockedError();
  try {
    const plain = await decryptBytes(crypt.key, env.enc.iv, env.body as string, crypt.path);
    return JSON.parse(new TextDecoder().decode(plain)) as B;
  } catch {
    throw new CorruptFileError('file could not be decrypted');
  }
}

export const hashBytes = (bytes: Uint8Array): Promise<string> => sha256Hex(bytes);

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
