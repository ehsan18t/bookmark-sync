import { generateKeyBetween } from 'fractional-indexing';

export const keyBetween = (left: string | null, right: string | null): string => generateKeyBetween(left, right);

/**
 * Keys for children in their desired order, given each child's current key (null if new or moved
 * in). Keeps the longest strictly increasing run of existing keys; equal keys are never both kept,
 * so there is always room between two kept neighbors.
 */
export function assignKeys(current: readonly (string | null)[]): string[] {
  const keep = longestIncreasing(current);
  const out: string[] = new Array(current.length);
  let left: string | null = null;
  for (let i = 0; i < current.length; i++) {
    if (keep.has(i)) {
      out[i] = current[i]!;
    } else {
      let right: string | null = null;
      for (let j = i + 1; j < current.length; j++) {
        if (keep.has(j)) {
          right = current[j]!;
          break;
        }
      }
      out[i] = keyBetween(left, right);
    }
    left = out[i]!;
  }
  return out;
}

export function longestIncreasing<T>(values: readonly (T | null)[], less: (a: T, b: T) => boolean = (a, b) => a < b): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (less(values[tails[mid]!]!, v)) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let cur = tails.length ? tails[tails.length - 1]! : -1;
  while (cur !== -1) {
    keep.add(cur);
    cur = prev[cur]!;
  }
  return keep;
}
