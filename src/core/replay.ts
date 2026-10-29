import type { Hlc } from './hlc.js';
import { isRootId } from './ids.js';
import { compareOps, type Kind, type Op, type OpRef, opKey, refOf } from './ops.js';

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
  kind: Kind | null;
  title: Reg<string> | null;
  url: Reg<string> | null;
  placement: Placement | null;
  aliveEvents: OpRef[];
  deletes: DeleteRecord[];
}

export interface GroupState {
  nodes: Map<string, NodeState>;
  coverage: Record<string, number>;
}

export const SEED_REF: OpRef = { device: 'seed', opSeq: 0 };

export function emptyState(): GroupState {
  return { nodes: new Map(), coverage: {} };
}

function cloneNode(n: NodeState): NodeState {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title && { ...n.title },
    url: n.url && { ...n.url },
    placement: n.placement && { ...n.placement, op: { ...n.placement.op } },
    aliveEvents: n.aliveEvents.map((r) => ({ ...r })),
    deletes: n.deletes.map((d) => ({ op: { ...d.op }, hlc: d.hlc, seen: { ...d.seen } })),
  };
}

export function cloneState(s: GroupState): GroupState {
  const nodes = new Map<string, NodeState>();
  for (const [id, n] of s.nodes) nodes.set(id, cloneNode(n));
  return { nodes, coverage: { ...s.coverage } };
}

export const coveredBy = (coverage: Record<string, number>, op: { device: string; opSeq: number }): boolean => op.opSeq <= (coverage[op.device] ?? 0);

export function replay(base: GroupState, ops: readonly Op[]): GroupState {
  const s = cloneState(base);
  const seen = new Set<string>();
  for (const op of [...ops].sort(compareOps)) {
    if (coveredBy(base.coverage, op)) continue;
    const key = opKey(op);
    if (seen.has(key)) continue;
    seen.add(key);
    applyOp(s, op);
  }
  return s;
}

/** Fold ops into a new checkpoint whose coverage includes them. Ops must be complete per device prefix. */
export function compact(base: GroupState, ops: readonly Op[]): GroupState {
  const s = replay(base, ops);
  for (const op of ops) if (op.opSeq > (s.coverage[op.device] ?? 0)) s.coverage[op.device] = op.opSeq;
  return s;
}

export function applyOp(s: GroupState, op: Op): void {
  const n = s.nodes.get(op.node) ?? stub(s, op.node);
  switch (op.type) {
    case 'create': {
      // A create on an existing node only adds an alive event and fills unset registers, so
      // simultaneous joins merge and a late join cannot revert newer edits.
      n.kind ??= op.kind;
      n.title ??= { value: op.fields.title ?? '', hlc: op.hlc };
      n.url ??= { value: op.fields.url ?? '', hlc: op.hlc };
      if (!n.placement && !wouldCycle(s, op.node, op.parent)) {
        n.placement = { parent: op.parent, pos: op.pos, hlc: op.hlc, op: refOf(op) };
      }
      n.aliveEvents.push(refOf(op));
      break;
    }
    case 'undelete':
      n.kind ??= op.kind;
      n.title = writeReg(n.title, op.fields.title ?? '', op.hlc);
      n.url = writeReg(n.url, op.fields.url ?? '', op.hlc);
      setPlacement(s, n, op.parent, op.pos, op);
      n.aliveEvents.push(refOf(op));
      break;
    case 'update':
      if (op.fields.title !== undefined) n.title = writeReg(n.title, op.fields.title, op.hlc);
      if (op.fields.url !== undefined) n.url = writeReg(n.url, op.fields.url, op.hlc);
      break;
    case 'move':
      setPlacement(s, n, op.parent, op.pos, op);
      break;
    case 'delete':
      n.deletes.push({ op: refOf(op), hlc: op.hlc, seen: { ...op.seen } });
      break;
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
  if (wouldCycle(s, n.id, parent)) return;
  n.placement = { parent, pos, hlc: op.hlc, op: refOf(op) };
}

export function wouldCycle(s: GroupState, node: string, parent: string): boolean {
  let cur: string | undefined = parent;
  const guard = new Set<string>();
  while (cur !== undefined && !isRootId(cur)) {
    if (cur === node || guard.has(cur)) return true;
    guard.add(cur);
    cur = s.nodes.get(cur)?.placement?.parent;
  }
  return false;
}

export function seedState(s: GroupState, visible: ReadonlySet<string>): GroupState {
  const out = emptyState();
  for (const id of visible) {
    const n = cloneNode(s.nodes.get(id)!);
    n.aliveEvents = [{ ...SEED_REF }];
    n.deletes = [];
    if (n.placement) n.placement.op = { ...SEED_REF };
    out.nodes.set(id, n);
  }
  return out;
}

export interface SerializedState {
  nodes: NodeState[];
  coverage: Record<string, number>;
}

export function serializeState(s: GroupState): SerializedState {
  return { nodes: [...cloneState(s).nodes.values()], coverage: { ...s.coverage } };
}

export function deserializeState(d: SerializedState): GroupState {
  return cloneState({ nodes: new Map(d.nodes.map((n) => [n.id, n])), coverage: d.coverage ?? {} });
}
