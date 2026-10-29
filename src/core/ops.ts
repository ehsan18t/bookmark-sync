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

type Draft<T extends OpBase> = Omit<T, keyof OpBase> & { node: string };

export type OpDraft = Draft<CreateOp> | Draft<UpdateOp> | Draft<MoveOp> | (Omit<Draft<DeleteOp>, 'seen'> & { seen?: Record<string, number> }) | Draft<UndeleteOp>;

export const refOf = (op: Op): OpRef => ({ device: op.device, opSeq: op.opSeq });

export const opKey = (op: { device: string; opSeq: number }): string => `${op.device}:${op.opSeq}`;

export function compareOps(a: Op, b: Op): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.opSeq - b.opSeq;
}
