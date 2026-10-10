export const groupsDir = 'groups';
export const groupHeaderPath = (g: string) => `groups/${g}/group.json`;
export const deviceDir = (g: string, d: string) => `groups/${g}/devices/${d}`;
export const deviceInfoPath = (g: string, d: string) => `${deviceDir(g, d)}/device.json`;
export const batchesDir = (g: string, d: string) => `${deviceDir(g, d)}/batches`;
export const batchPath = (g: string, d: string, batchNo: number) => `${batchesDir(g, d)}/${String(batchNo).padStart(12, '0')}.json`;
export const snapshotsDir = (g: string, d: string) => `${deviceDir(g, d)}/snapshots`;
export const snapshotPath = (g: string, d: string, id: string) => `${snapshotsDir(g, d)}/${id}.json`;
export const markerPath = (g: string, d: string, name: MarkerName) => `${deviceDir(g, d)}/markers/${name}.json`;

export type MarkerName = 'migration' | 'migrated' | 'group-deleted' | 'removed';
