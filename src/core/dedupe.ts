const TRACKING = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^msclkid$/i, /^yclid$/i];

function parse(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function exactKey(url: string): string {
  const u = parse(url);
  if (!u) return url;
  const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  return `${u.protocol}//${u.host.toLowerCase()}${path === '/' ? '' : path}${u.search}`;
}

export function possibleKey(url: string): string {
  const u = parse(url);
  if (!u) return url;
  const host = u.host.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  const params = [...u.searchParams].filter(([k]) => !TRACKING.some((re) => re.test(k))).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  return `${host}${path === '/' ? '' : path}${query}`;
}

export interface DedupeItem {
  localId: string;
  title: string;
  url: string;
  path: string;
  group: string | null;
}

export interface DuplicateGroup {
  level: 'exact' | 'possible';
  key: string;
  items: DedupeItem[];
}

export function findDuplicates(items: readonly DedupeItem[]): DuplicateGroup[] {
  const out: DuplicateGroup[] = [];
  const exact = new Map<string, DedupeItem[]>();
  for (const it of items) exact.set(exactKey(it.url), [...(exact.get(exactKey(it.url)) ?? []), it]);
  const grouped = new Set<string>();
  for (const [key, list] of exact) {
    if (list.length < 2) continue;
    out.push({ level: 'exact', key, items: list });
    for (const it of list) grouped.add(it.localId);
  }
  const possible = new Map<string, DedupeItem[]>();
  for (const it of items) {
    if (grouped.has(it.localId)) continue;
    const k = possibleKey(it.url);
    possible.set(k, [...(possible.get(k) ?? []), it]);
  }
  for (const [key, list] of possible) if (list.length > 1) out.push({ level: 'possible', key, items: list });
  return out;
}
