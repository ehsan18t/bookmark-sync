// Fractional position keys (IMPLEMENTATION.md 4.4).

import { generateKeyBetween } from 'fractional-indexing';

export function keyBetween(left: string | null, right: string | null): string {
  return generateKeyBetween(left, right);
}

/**
 * Given the desired order of a folder's children and the key each one currently has (null for
 * new or moved-in children), keep the longest run of strictly increasing existing keys and give
 * every other child a new key that fits between its neighbors. Equal keys are never both kept,
 * so there is always room to generate a key between two kept neighbors.
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

/** Indices of a longest strictly increasing subsequence of the non-null keys (patience sorting). */
function longestIncreasing(keys: readonly (string | null)[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === null || k === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[tails[mid]!]! < k) lo = mid + 1;
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
