export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function relativeTime(ms: number | null, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function hlcTime(hlc: string): string {
  return new Date(Number(hlc.slice(0, 15))).toLocaleString();
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
