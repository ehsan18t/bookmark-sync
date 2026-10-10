// Change records (IMPLEMENTATION.md 3.1).

import type { Hlc } from './hlc.js';

export type Kind = 'bookmark' | 'folder' | 'separator';

export interface Fields {
  title?: string;
  url?: string;
}

export interface OpRef {
  device: string;
  opSeq: number;
}

/** A deleted subtree, kept on delete ops for history display. Never used for merging. */
export interface SubtreeSnapshot {
  id: string;
  kind: Kind;
  title: string;
  url: string;
  children: SubtreeSnapshot[];
}

interface OpBase {
  device: string;
  opSeq: number;
  hlc: Hlc;
  node: string;
}

export interface CreateOp extends OpBase {
  type: 'create';
  kind: Kind;
  parent: string;
  pos: string;
  fields: Fields;
}

export interface UpdateOp extends OpBase {
  type: 'update';
  fields: Fields;
  before: Fields;
}

export interface MoveOp extends OpBase {
  type: 'move';
  parent: string;
  pos: string;
  before: { parent: string; pos: string };
}

export interface DeleteOp extends OpBase {
  type: 'delete';
  seen: Record<string, number>;
  before: SubtreeSnapshot;
}

export interface UndeleteOp extends OpBase {
  type: 'undelete';
  kind: Kind;
  parent: string;
  pos: string;
  fields: Fields;
}

export type Op = CreateOp | UpdateOp | MoveOp | DeleteOp | UndeleteOp;

/** An op before the engine stamps it with device, opSeq, hlc and (for deletes) seen. */
export type OpDraft =
  | Omit<CreateOp, keyof OpBase | 'node'> & { node: string }
  | Omit<UpdateOp, keyof OpBase | 'node'> & { node: string }
  | Omit<MoveOp, keyof OpBase | 'node'> & { node: string }
  | Omit<DeleteOp, keyof OpBase | 'node' | 'seen'> & { node: string }
  | Omit<UndeleteOp, keyof OpBase | 'node'> & { node: string };

export const refOf = (op: Op): OpRef => ({ device: op.device, opSeq: op.opSeq });

export const opKey = (op: { device: string; opSeq: number }): string => `${op.device}:${op.opSeq}`;

/** Total order used by the replay fold: HLC, then op identity for exact duplicates. */
export function compareOps(a: Op, b: Op): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.opSeq - b.opSeq;
}
