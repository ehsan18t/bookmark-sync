import type { OpVia } from '../../../../core/ops.js';

const SYNC_NAME: Record<string, string> = {
  chrome: 'Chrome sync',
  edge: 'Edge sync',
  brave: 'Brave Sync',
  vivaldi: 'Vivaldi Sync',
  opera: 'Opera sync',
  firefox: 'Firefox Sync',
};

export interface SourceText {
  label: string;
  explain: string;
}

/** `place` names the browser that made the change, as it reads inside a sentence. */
export function sourceText(via: OpVia | undefined, browser: string | undefined, place: string): SourceText | null {
  const sync = (browser && SYNC_NAME[browser]) ?? 'the browser’s own sync';
  switch (via) {
    case 'user':
      return { label: 'by you', explain: `Made in ${place} by you, or by another extension installed there.` };
    case 'browser-sync':
      return {
        label: `via ${sync} or an import`,
        explain: `${sync.charAt(0).toUpperCase()}${sync.slice(1)} brought these changes into ${place}, or they came from a bookmark import. The extension then shared them with your other browsers.`,
      };
    case 'later':
      return {
        label: 'found on a later check',
        explain:
          'These changed while the extension wasn’t running, for example while the browser was closed, so it can’t tell what made them. They were picked up on the next check and shared with your other browsers.',
      };
    case 'undo':
      return { label: 'undo or restore', explain: 'Made by going back to an earlier point in History. You can undo this the same way.' };
    case 'join':
      return { label: 'joining the sync', explain: `Made when ${place} joined the sync and its bookmarks were merged with the others.` };
    case 'dedupe':
      return { label: 'duplicate cleanup', explain: `Made from the Duplicates tab in ${place}.` };
    case 'repair':
      return { label: 'duplicate repair', explain: 'The extension removed extra copies that arrived both through the browser’s own sync and through the extension.' };
    case 'folders':
      return { label: 'synced folder changes', explain: `Made when a synced folder was added or removed in ${place}.` };
    case 'bridge':
      return { label: 'from another sync', explain: `Brought in by another sync that shares a folder with this one in ${place}.` };
    default:
      return null;
  }
}
