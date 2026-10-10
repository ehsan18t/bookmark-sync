// File envelope and bodies at the provider (IMPLEMENTATION.md 6.2 and 6.3).
// Encryption is added in milestone M7; until then `enc` is always null.

import type { Hlc } from './hlc.js';
import { sha256Hex } from './ids.js';
import type { Op } from './ops.js';
import type { SerializedState } from './replay.js';

export const FORMAT = 'bsync';
export const FORMAT_MAJOR = 1;
export const FORMAT_MINOR = 0;

export type FileKind = 'group' | 'device' | 'batch' | 'snapshot' | 'marker';

export interface Envelope<B> {
  format: typeof FORMAT;
  v: number;
  minor: number;
  kind: FileKind;
  enc: null;
  body: B;
}

export interface GroupHeader {
  groupId: string;
  name: string;
  mode: 'everything' | 'folder';
  createdBy: string;
  createdAt: string;
  encryption: null;
}

export interface DeviceInfo {
  deviceId: string;
  name: string;
  browser: string;
  lastBatchNo: number;
  lastBatchHash: string;
  lastOpSeq: number;
  bound: Hlc;
  firstRetainedOpSeq: number;
  left: boolean;
  frozenFor: string | null;
  updatedAt: string;
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
  coverage: Record<string, number>;
  state: SerializedState;
}

export class FormatTooNewError extends Error {
  constructor(readonly found: number) {
    super(`file format version ${found} is newer than this extension supports (${FORMAT_MAJOR})`);
  }
}

export class CorruptFileError extends Error {}

export function encode<B>(kind: FileKind, body: B): Uint8Array {
  const env: Envelope<B> = { format: FORMAT, v: FORMAT_MAJOR, minor: FORMAT_MINOR, kind, enc: null, body };
  return new TextEncoder().encode(JSON.stringify(env));
}

export function decode<B>(bytes: Uint8Array, kind: FileKind): B {
  let env: Envelope<B>;
  try {
    env = JSON.parse(new TextDecoder().decode(bytes)) as Envelope<B>;
  } catch {
    throw new CorruptFileError('file is not valid JSON');
  }
  if (env.format !== FORMAT) throw new CorruptFileError('not a bsync file');
  if (typeof env.v !== 'number') throw new CorruptFileError('missing format version');
  if (env.v > FORMAT_MAJOR) throw new FormatTooNewError(env.v);
  if (env.kind !== kind) throw new CorruptFileError(`expected ${kind}, found ${env.kind}`);
  if (env.enc !== null) throw new CorruptFileError('encrypted files are not supported yet');
  return env.body;
}

export const hashBytes = (bytes: Uint8Array): Promise<string> => sha256Hex(bytes);

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
