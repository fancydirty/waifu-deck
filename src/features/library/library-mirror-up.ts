import { runTransferPool, type TransferPoolResult } from '@/features/library/library-transfer-pool';
import type { LibraryActionResult } from '@/features/library/library-actions-types';

/**
 * Parallelism ceiling for the mirror's automatic uploads. A memory/fd bound,
 * NOT a rate limit and with no delay (owner mirror ruling 2026-09-09: no
 * throttling). Server-side 429/503 backoff is still honored inside protect's
 * transport path.
 */
export const LIBRARY_MIRROR_UPLOAD_CONCURRENCY = 8;

export type LibraryMirrorUpDependencies = Readonly<{
  /**
   * Enrol every local asset the account has not yet seen, writing its `collect`
   * intent. MUST run before listing/protecting: protect's `ensureCollected`
   * only READS the collect intent (it never creates one), so an un-enrolled
   * asset would fail `object_missing`. Idempotent — already-enrolled assets are
   * a no-op.
   */
  enrollMissing: () => Promise<unknown>;
  getAccountScope: () => Promise<string | null>;
  listProtectCandidates: (accountScope: string) => Promise<readonly string[]>;
  protect: (plaintextSha256: string) => Promise<LibraryActionResult>;
  concurrency?: number;
}>;

export type LibraryMirrorUp = Readonly<{
  /** Enrol missing assets, then upload every not-yet-protected local original in parallel. */
  mirrorUp: () => Promise<TransferPoolResult>;
}>;

export function createLibraryMirrorUp({
  enrollMissing,
  getAccountScope,
  listProtectCandidates,
  protect,
  concurrency = LIBRARY_MIRROR_UPLOAD_CONCURRENCY,
}: LibraryMirrorUpDependencies): LibraryMirrorUp {
  return {
    async mirrorUp() {
      await enrollMissing();
      const scope = await getAccountScope();
      if (scope === null) return { total: 0, done: 0, failed: 0 };
      const candidates = await listProtectCandidates(scope);
      return runTransferPool(
        candidates,
        async (digest) => {
          const result = await protect(digest);
          // Success is applied (uploaded) or noop (already satisfied). Anything
          // else — blocked/offline/queued — is a lane failure so the pool counts
          // it; the asset stays a candidate and the next cycle retries it.
          if (result.status !== 'applied' && result.status !== 'noop') {
            throw new Error(`protect ${result.status}`);
          }
        },
        { concurrency },
      );
    },
  };
}
