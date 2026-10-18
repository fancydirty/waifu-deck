import i18n from '@/i18n';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { LibraryMirrorCounts } from '@/features/library/library-protection-repository';
import type { LibraryStorageMode } from '@/features/library/library-storage-mode';
import { deriveCloudIdentity, deriveCloudLibraryModel, type ReadValue } from '@/screens/settings/cloud-library-model';
import type { CloudLibraryData } from '@/screens/settings/use-cloud-library-data';

export const cloudCounts: LibraryMirrorCounts = {
  backedUp: 2, backedUpTotal: 2, downloaded: 2, downloadedTotal: 2,
  inCloud: 0, inCloudBytes: 0, totalBytes: 150, pending: 0,
};
export const cloudRead = <T,>(value: T, roundId: number | null = 1): ReadValue<T> => ({ state: 'read', fresh: true, roundId, value });
export const cloudUnread = <T,>(roundId: number | null = 1): ReadValue<T> => ({ state: 'unread', fresh: false, roundId });
export function cloudSnapshot(status: ByosStatus, overrides: Partial<Omit<CloudLibraryData, 'model'>> = {}): CloudLibraryData {
  const data = {
    counts: cloudUnread<LibraryMirrorCounts>(), lastSyncedAt: cloudUnread<number | null>(),
    quotaFullCount: cloudUnread<number>(), mode: cloudUnread<LibraryStorageMode>(null),
    quota: null, readRoundId: 1, viewNowMs: 1_000_000, refreshStorageMode: async () => undefined, ...overrides,
  };
  const identity = status.status === 'ready'
    ? cloudRead(deriveCloudIdentity(status.context.kind === 's3' ? status.context.credentials : status.context.binding, (key) => i18n.t(key)), null)
    : cloudUnread<null>(null);
  return { ...data, model: deriveCloudLibraryModel({ ...data, identity, byosStatus: status }) };
}
