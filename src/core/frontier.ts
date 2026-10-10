import type { DeviceInfo, Snapshot } from './codec.js';
import { hlcFloor, type Hlc } from './hlc.js';

export const DAY = 24 * 60 * 60 * 1000;

export interface FrontierInput {
  infos: ReadonlyMap<string, DeviceInfo>;
  known: ReadonlySet<string>;
  ownBound: Hlc;
  serverNow: number;
  staleAfterMs: number;
}

export function isStale(info: DeviceInfo, serverNow: number, staleAfterMs: number): boolean {
  return serverNow - info.updatedAt > staleAfterMs;
}

export function stableFrontier(input: FrontierInput): Hlc | null {
  let f = input.ownBound;
  for (const d of input.known) {
    const info = input.infos.get(d);
    if (!info) return null;
    if (isStale(info, input.serverNow, input.staleAfterMs)) continue;
    if (info.bound < f) f = info.bound;
  }
  return f;
}

export function compactionPoint(frontier: Hlc, serverNow: number, historyMs: number): Hlc {
  const cut = hlcFloor(serverNow - Math.max(historyMs, DAY));
  return frontier < cut ? frontier : cut;
}

export function snapshotComplete(snap: Snapshot, infos: ReadonlyMap<string, DeviceInfo>): boolean {
  for (const [d, info] of infos) {
    if (info.lastBatchNo === 0) continue;
    if (info.firstRetainedOpSeq > (snap.state.coverage[d] ?? 0) + 1) return false;
  }
  return true;
}
