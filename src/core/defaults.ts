import type { LiveNode } from './reconcile.js';

export type BrowserFamily = 'chrome' | 'edge' | 'brave' | 'vivaldi' | 'opera' | 'firefox';

interface Rule {
  folders: string[];
  hosts: string[];
  titles: string[];
}

const RULES: Record<BrowserFamily, Rule> = {
  firefox: {
    folders: ['Mozilla Firefox'],
    hosts: ['www.mozilla.org', 'mozilla.org', 'support.mozilla.org', 'addons.mozilla.org'],
    titles: ['Getting Started', 'Get Help', 'Customize Firefox', 'Get Involved', 'About Us', 'Help and Tutorials'],
  },
  vivaldi: {
    folders: ['Vivaldi'],
    hosts: ['vivaldi.com', 'vivaldi.net', 'help.vivaldi.com', 'forum.vivaldi.net', 'themes.vivaldi.net'],
    titles: [],
  },
  edge: { folders: [], hosts: [], titles: [] },
  chrome: { folders: [], hosts: [], titles: [] },
  brave: { folders: [], hosts: [], titles: [] },
  opera: { folders: [], hosts: [], titles: [] },
};

function host(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function bookmarksIn(n: LiveNode): LiveNode[] {
  return (n.children ?? []).flatMap((c) => (c.kind === 'folder' ? bookmarksIn(c) : c.kind === 'bookmark' ? [c] : []));
}

export function findDefaultBookmarks(roots: readonly LiveNode[], family: BrowserFamily): string[] {
  const rule = RULES[family];
  const ownHost = (u: string) => {
    const h = host(u);
    return h !== null && rule.hosts.some((x) => h === x || h.endsWith('.' + x));
  };
  const out: string[] = [];
  const visit = (n: LiveNode) => {
    for (const c of n.children ?? []) {
      if (c.kind === 'folder') {
        const inside = bookmarksIn(c);
        if (rule.folders.includes(c.title) && inside.length > 0 && inside.every((b) => ownHost(b.url))) {
          out.push(c.localId);
          continue;
        }
        visit(c);
      } else if (c.kind === 'bookmark' && ownHost(c.url) && rule.titles.includes(c.title)) {
        out.push(c.localId);
      }
    }
  };
  for (const r of roots) visit(r);
  return out;
}
