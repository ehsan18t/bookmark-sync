/** The latest HLC that sorts before `hlc`: one millisecond earlier, after every op in that millisecond. */
export const justBefore = (hlc: string) => `${String(Number(hlc.slice(0, 15)) - 1).padStart(15, '0')}-999999-~`;

const KIND_TEXT: Record<string, string> = { create: 'added', update: 'edited', move: 'moved', delete: 'removed', undelete: 'restored' };

export const describeKinds = (kinds: Record<string, number>) =>
  Object.entries(kinds)
    .map(([type, n]) => `${n} ${KIND_TEXT[type] ?? type}`)
    .join(', ');
