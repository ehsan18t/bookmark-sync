import { useEffect, useState } from 'preact/hooks';
import { errorText } from '../lib/format.js';

/** Loads data for a component, showing its error in place of the content. */
export function useLoad<T>(fetch: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    fetch().then(
      (d) => live && (setData(d), setError('')),
      (e) => live && setError(errorText(e)),
    );
    return () => (live = false);
  }, [...deps, round]);
  return { data, error, reload: () => setRound((r) => r + 1) };
}
