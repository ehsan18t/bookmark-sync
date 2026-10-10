// Logical paths for a group (IMPLEMENTATION.md 6.1).

export const groupHeaderPath = (g: string) => `groups/${g}/group.json`;
export const devicesDir = (g: string) => `groups/${g}/devices`;
export const deviceInfoPath = (g: string, d: string) => `groups/${g}/devices/${d}/device.json`;
export const batchPath = (g: string, d: string, batchNo: number) =>
  `groups/${g}/devices/${d}/batches/${String(batchNo).padStart(12, '0')}.json`;
export const snapshotsDir = (g: string, d: string) => `groups/${g}/devices/${d}/snapshots`;
export const markersDir = (g: string, d: string) => `groups/${g}/devices/${d}/markers`;
