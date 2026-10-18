import { runTransferPool, type TransferPoolResult } from '@/features/library/library-transfer-pool';
import type { LibraryActionResult } from '@/features/library/library-actions-types';

/**
 * Parallelism ceiling for the mirror's automatic downloads. This bounds
 * memory/file descriptors; it is NOT a rate limit and the pool adds no delay
 * (owner mirror ruling 2026-09-09: no throttling). Server-side 429/503 backoff
 * is still honored inside the transport/download path.
 */
export const LIBRARY_MIRROR_DOWNLOAD_CONCURRENCY = 8;

export type LibraryMirrorDownDependencies = Readonly<{
  getAccountScope: () => Promise<string | null>;
  listDownloadCandidates: (accountScope: string) => Promise<readonly string[]>;
  download: (plaintextSha256: string) => Promise<LibraryActionResult>;
  concurrency?: number;
}>;

export type LibraryMirrorDown = Readonly<{
  /**
   * List every original this device is missing (cloud-only, or a local original
   * the resume pass flagged as gone) and download them in parallel.
   */
  mirrorDown: () => Promise<TransferPoolResult>;
}>;

export function createLibraryMirrorDown({
  getAccountScope,
  listDownloadCandidates,
  download,
  concurrency = LIBRARY_MIRROR_DOWNLOAD_CONCURRENCY,
}: LibraryMirrorDownDependencies): LibraryMirrorDown {
  return {
    async mirrorDown() {
      const scope = await getAccountScope();
      if (scope === null) return { total: 0, done: 0, failed: 0 };
      const candidates = await listDownloadCandidates(scope);
      return runTransferPool(
        candidates,
        async (digest) => {
          const result = await download(digest);
          // A download that did not apply is a lane failure so the pool counts
          // it; the asset stays a candidate and the next cycle retries it.
          if (result.status !== 'applied' && result.status !== 'noop') {
            throw new Error(`download ${result.status}`);
          }
        },
        { concurrency },
      );
    },
  };
}
