/** Matches Worker TRASH_RETENTION_MS. */
export const LIBRARY_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function purgeDeadlineAt(trashedAtMs: number): number {
  return trashedAtMs + LIBRARY_TRASH_RETENTION_MS;
}

export function isDeviceTrashExpired(
  deviceTrashedAtMs: number,
  nowMs: number,
): boolean {
  return nowMs >= deviceTrashedAtMs + LIBRARY_TRASH_RETENTION_MS;
}
