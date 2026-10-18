import type {
  LibraryFileStore,
  LibraryTempFile,
} from '@/features/library/library-file-store';
import type { LibraryIngestService } from '@/features/library/library-ingest';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import type { LibraryPickerPort } from '@/features/library/library-picker';
import type {
  LibraryImportClassification,
  LibraryIngestErrorCode,
} from '@/features/library/library-types';
import { LibraryIngestError } from '@/features/library/library-types';

export type LibraryImportRejection = Readonly<{
  code: LibraryIngestErrorCode;
}>;

export type LibraryImportSummary = Readonly<{
  selected: number;
  ingested: number;
  duplicates: number;
  /**
   * Items that are durably local but not yet in the account layer, because no
   * account is available or Layer B failed. Import still succeeded.
   */
  notEnrolled: number;
  /**
   * N6-A2 (spec §4.4 / §4.11): count of re-added imports whose authoritative
   * cloud library classification differed from the batch's chosen `safe | adult`.
   * Zero for active duplicates, first-collect races, or matching classification.
   */
  retainedClassificationCount?: number;
  rejected: readonly LibraryImportRejection[];
}>;

export type LibraryConfirmedImportInput = Readonly<{
  uris: readonly string[];
  classification: Exclude<LibraryImportClassification, 'unknown'>;
  /**
   * When true, `uris` are already picker-owned cache files that can be adopted
   * and cleaned directly without an extra pre-copy (`adoptTempUri`); when false
   * (default), `acquireFromUri` copies each URI with a pre-copy byte-cap check.
   */
  adoptPickerCacheUris?: boolean;
  onProgress?: (progress: Readonly<{ completed: number; total: number }>) => void;
}>;

export type LibraryImportService = Readonly<{
  importFromPicker(input?: {
    selectionLimit?: number;
    classification?: Exclude<LibraryImportClassification, 'unknown'>;
  }): Promise<LibraryImportSummary>;
  importConfirmedFiles(
    input: LibraryConfirmedImportInput,
  ): Promise<LibraryImportSummary>;
  /**
   * N6-A2 (spec §4.2): resolves once all admitted confirmed imports have
   * settled.
   */
  settled(): Promise<void>;
  /**
   * N6-A2 (spec §4.2): while refused (backup/restore/reset), new confirmed
   * imports are refused before any DB write and any picker cache files passed
   * in with `adoptPickerCacheUris: true` are cleaned up.
   */
  refuse(): () => void;
}>;

export type LibraryImportDependencies = Readonly<{
  picker: LibraryPickerPort;
  files: LibraryFileStore;
  ingest: LibraryIngestService;
  maxProtectablePlaintextBytes?: number;
}>;

function rejectionCode(error: unknown): LibraryIngestErrorCode {
  return error instanceof LibraryIngestError ? error.code : 'storage_failed';
}

export function createLibraryImportService({
  picker,
  files,
  ingest,
  maxProtectablePlaintextBytes = LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES,
}: LibraryImportDependencies): LibraryImportService {
  const activeBatches = new Set<Promise<unknown>>();
  let refusals = 0;

  const trackBatch = <T>(promise: Promise<T>): Promise<T> => {
    activeBatches.add(promise);
    return promise.finally(() => {
      activeBatches.delete(promise);
    });
  };

  const cleanupAdoptedUris = async (uris: readonly string[]): Promise<void> => {
    const seen = new Set<string>();
    const deletePickerUri = files.deletePickerCacheUri ?? files.deleteOriginal;
    for (const uri of uris) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      try {
        await deletePickerUri.call(files, uri);
      } catch {
        // Best-effort cleanup of picker cache files.
      }
    }
  };

  const runConfirmedFiles = async ({
    uris,
    classification,
    adoptPickerCacheUris = false,
    onProgress,
  }: LibraryConfirmedImportInput): Promise<LibraryImportSummary> => {
    if (uris.length === 0) {
      return {
        selected: 0,
        ingested: 0,
        duplicates: 0,
        notEnrolled: 0,
        retainedClassificationCount: 0,
        rejected: [],
      };
    }

    if (refusals > 0) {
      if (adoptPickerCacheUris) {
        await cleanupAdoptedUris(uris);
      }
      return {
        selected: uris.length,
        ingested: 0,
        duplicates: 0,
        notEnrolled: 0,
        retainedClassificationCount: 0,
        rejected: uris.map(() => ({ code: 'storage_failed' as const })),
      };
    }

    const rejected: LibraryImportRejection[] = [];
    let ingested = 0;
    let duplicates = 0;
    let notEnrolled = 0;
    let retainedClassificationCount = 0;
    const total = uris.length;

    for (let index = 0; index < uris.length; index += 1) {
      const uri = uris[index]!;
      if (refusals > 0) {
        if (adoptPickerCacheUris) {
          await cleanupAdoptedUris(uris.slice(index));
        }
        for (let r = index; r < uris.length; r += 1) {
          rejected.push({ code: 'storage_failed' });
          onProgress?.({ completed: r + 1, total });
        }
        break;
      }

      let temp: LibraryTempFile | null = null;
      try {
        temp = adoptPickerCacheUris && typeof files.adoptTempUri === 'function'
          ? await files.adoptTempUri(uri, {
            maxBytes: maxProtectablePlaintextBytes,
          })
          : await files.acquireFromUri(uri, {
            maxBytes: maxProtectablePlaintextBytes,
          });
        const outcome = await ingest.ingestTempFile({
          temp,
          origin: 'import',
          sourceImageId: null,
          importClassification: classification,
          strictImportDuplicate: true,
        });
        if (outcome.status === 'ingested') {
          ingested += 1;
          if (outcome.retainedLibraryClassification === true) {
            retainedClassificationCount += 1;
          }
        } else {
          duplicates += 1;
        }
        if (
          outcome.enrollment.status === 'skipped'
          || outcome.enrollment.status === 'failed'
        ) {
          notEnrolled += 1;
        }
      } catch (error) {
        if (temp !== null) {
          await temp.discard().catch(() => undefined);
        } else if (adoptPickerCacheUris) {
          const deletePickerUri = files.deletePickerCacheUri ?? files.deleteOriginal;
          await deletePickerUri.call(files, uri).catch(() => undefined);
        }
        rejected.push({ code: rejectionCode(error) });
      }
      onProgress?.({ completed: index + 1, total });
    }

    return {
      selected: total,
      ingested,
      duplicates,
      notEnrolled,
      retainedClassificationCount,
      rejected,
    };
  };

  return {
    async importFromPicker(input = {}) {
      if (refusals > 0) {
        return {
          selected: 0,
          ingested: 0,
          duplicates: 0,
          notEnrolled: 0,
          rejected: [],
        };
      }
      const picked = await picker.pickImages(input);
      if (picked.length === 0) {
        return {
          selected: 0,
          ingested: 0,
          duplicates: 0,
          notEnrolled: 0,
          rejected: [],
        };
      }

      return await trackBatch((async () => {
        const rejected: LibraryImportRejection[] = [];
        const staged: LibraryTempFile[] = [];

        // Copy every selection first: a picker URI is a temporary grant and may
        // be revoked as soon as the picker closes.
        for (const item of picked) {
          try {
            staged.push(
              await files.acquireFromUri(item.uri, {
                maxBytes: maxProtectablePlaintextBytes,
              }),
            );
          } catch (error) {
            rejected.push({ code: rejectionCode(error) });
          }
        }

        let ingested = 0;
        let duplicates = 0;
        let notEnrolled = 0;
        let retainedClassificationCount = 0;
        const classification = input.classification ?? 'safe';
        for (const temp of staged) {
          try {
            const outcome = await ingest.ingestTempFile({
              temp,
              origin: 'import',
              sourceImageId: null,
              importClassification: classification,
              strictImportDuplicate: true,
            });
            if (outcome.status === 'ingested') {
              ingested += 1;
              if (outcome.retainedLibraryClassification === true) {
                retainedClassificationCount += 1;
              }
            } else {
              duplicates += 1;
            }
            if (
              outcome.enrollment.status === 'skipped'
              || outcome.enrollment.status === 'failed'
            ) {
              notEnrolled += 1;
            }
          } catch (error) {
            rejected.push({ code: rejectionCode(error) });
          }
        }

        return {
          selected: picked.length,
          ingested,
          duplicates,
          notEnrolled,
          ...(retainedClassificationCount > 0
            ? { retainedClassificationCount }
            : {}),
          rejected,
        };
      })());
    },

    importConfirmedFiles(input) {
      return trackBatch(runConfirmedFiles(input));
    },

    async settled() {
      await Promise.allSettled([...activeBatches]);
    },

    refuse() {
      refusals += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refusals -= 1;
      };
    },
  };
}
