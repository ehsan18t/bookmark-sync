/** Case, spacing and Unicode width don't make two sync names different. */
export const sameNameKey = (name: string) => name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
