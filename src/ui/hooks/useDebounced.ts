import { useEffect } from 'preact/hooks';

/** Runs `fn` once its inputs have been still for 400 ms; its returned cleanup runs when they change again. */
export function useDebounced(fn: () => (() => void) | undefined, deps: unknown[]) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass the deps, and Biome checks them at each call site
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const t = setTimeout(() => {
      cleanup = fn();
    }, 400);
    return () => {
      clearTimeout(t);
      cleanup?.();
    };
  }, [...deps]);
}
