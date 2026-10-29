import { useEffect } from 'preact/hooks';

/** Runs `fn` once its inputs have been still for 400 ms; its returned cleanup runs when they change again. */
export function useDebounced(fn: () => void | (() => void), deps: unknown[]) {
  useEffect(() => {
    let cleanup: void | (() => void);
    const t = setTimeout(() => (cleanup = fn()), 400);
    return () => (clearTimeout(t), cleanup?.());
  }, deps);
}
