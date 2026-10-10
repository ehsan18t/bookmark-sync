// Replay engine (IMPLEMENTATION.md 3.2 and 4.1): a left fold over ops in HLC order.

import type { Hlc } from './hlc.js';
import { isRootId } from './ids.js';
import { compareOps, opKey, refOf, type Kind, type Op, type OpRef } from './ops.js';

export interface Reg<T> {
  value: T;
  hlc: Hlc;
}

export interface Placement {
  parent: string;
  pos: string;
  hlc: Hlc;
  op: OpRef;
}

export interface DeleteRecord {
  op: OpRef;
  hlc: Hlc;
  seen: Record<string, number>;
}

export interface NodeState {
  id: string;
  /** null for a stub: a node an op referred to before its create was read. */
  kind: Kind | null;
  title: Reg<string> | null;
  url: Reg<string> | null;
  placement: Placement | null;
  aliveEvents: OpRef[];
  deletes: DeleteRecord[];
}

export interface GroupState {
  nodes: Map<string, NodeState>;
  /** Keys of every op folded into this state, so redelivery is harmless. */
  applied: Set<string>;
}

export function emptyState(): GroupState {
  return { nodes: new Map(), applied: new Set() };
}

export function cloneState(s: GroupState): GroupState {
  const nodes = new Map<string, NodeState>();
  for (const [id, n] of s.nodes) {
    nodes.set(id, {
      id: n.id,
      kind: n.kind,
      title: n.title && { ...n.title },
      url: n.url && { ...n.url },
      placement: n.placement && { ...n.placement, op: { ...n.placement.op } },
      aliveEvents: n.aliveEvents.map((r) => ({ ...r })),
      deletes: n.deletes.map((d) => ({ op: { ...d.op }, hlc: d.hlc, seen: { ...d.seen } })),
    });
  }
  return { nodes, applied: new Set(s.applied) };
}

export function replay(base: GroupState, ops: readonly Op[]): GroupState {
  const s = cloneState(base);
  for (const op of [...ops].sort(compareOps)) applyOp(s, op);
  return s;
}

export function applyOp(s: GroupState, op: Op): void {
  const key = opKey(op);
  if (s.applied.has(key)) return;
  s.applied.add(key);
  const n = s.nodes.get(op.node) ?? stub(s, op.node);

  switch (op.type) {
    case 'create': {
      // A create on an existing node only adds an alive event and fills registers never set.
      // This merges simultaneous joins and stops a late join from reverting newer edits.
      n.kind ??= op.kind;
      n.title ??= { value: op.fields.title ?? '', hlc: op.hlc };
      n.url ??= { value: op.fields.url ?? '', hlc: op.hlc };
      if (!n.placement && !wouldCycle(s, op.node, op.parent)) {
        n.placement = { parent: op.parent, pos: op.pos, hlc: op.hlc, op: refOf(op) };
      }
      n.aliveEvents.push(refOf(op));
      break;
    }
    case 'undelete': {
      n.kind ??= op.kind;
      n.title = writeReg(n.title, op.fields.title ?? '', op.hlc);
      n.url = writeReg(n.url, op.fields.url ?? '', op.hlc);
      setPlacement(s, n, op.parent, op.pos, op);
      n.aliveEvents.push(refOf(op));
      break;
    }
    case 'update': {
      if (op.fields.title !== undefined) n.title = writeReg(n.title, op.fields.title, op.hlc);
      if (op.fields.url !== undefined) n.url = writeReg(n.url, op.fields.url, op.hlc);
      break;
    }
    case 'move': {
      setPlacement(s, n, op.parent, op.pos, op);
      break;
    }
    case 'delete': {
      n.deletes.push({ op: refOf(op), hlc: op.hlc, seen: { ...op.seen } });
      break;
    }
  }
}

function stub(s: GroupState, id: string): NodeState {
  const n: NodeState = { id, kind: null, title: null, url: null, placement: null, aliveEvents: [], deletes: [] };
  s.nodes.set(id, n);
  return n;
}

function writeReg<T>(reg: Reg<T> | null, value: T, hlc: Hlc): Reg<T> {
  return reg === null || hlc > reg.hlc ? { value, hlc } : reg;
}

function setPlacement(s: GroupState, n: NodeState, parent: string, pos: string, op: Op): void {
  if (n.placement && op.hlc <= n.placement.hlc) return;
  if (wouldCycle(s, n.id, parent)) return; // a skipped move changes nothing
  n.placement = { parent, pos, hlc: op.hlc, op: refOf(op) };
}

/** True if placing `node` under `parent` would make `node` its own ancestor. Walks hidden nodes too. */
export function wouldCycle(s: GroupState, node: string, parent: string): boolean {
  let cur: string | undefined = parent;
  const guard = new Set<string>();
  while (cur !== undefined && !isRootId(cur)) {
    if (cur === node) return true;
    if (guard.has(cur)) return true; // cannot happen while placements stay acyclic; fail safe
    guard.add(cur);
    cur = s.nodes.get(cur)?.placement?.parent;
  }
  return false;
}

// Serialization for snapshots and local persistence.

export interface SerializedState {
  nodes: NodeState[];
  applied: string[];
}

export function serializeState(s: GroupState): SerializedState {
  return { nodes: [...cloneState(s).nodes.values()], applied: [...s.applied] };
}

export function deserializeState(d: SerializedState): GroupState {
  const s: GroupState = { nodes: new Map(d.nodes.map((n) => [n.id, n])), applied: new Set(d.applied) };
  return cloneState(s);
}
