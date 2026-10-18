import type { LibraryEviction } from '@/features/library/library-eviction';
import type { LibraryMirrorDown } from '@/features/library/library-mirror-down';
import type { LibraryMirrorUp } from '@/features/library/library-mirror-up';
import type { SyncRoundResult } from '@/features/library/library-sync-run-to-empty';
import type { LibraryThumbnailPass } from '@/features/library/library-thumbnail-pass';
import type { TransferPoolResult } from '@/features/library/library-transfer-pool';

const NONE: TransferPoolResult = { total: 0, done: 0, failed: 0 };

export type LibrarySyncRoundDependencies = Readonly<{
  mirrorUp: LibraryMirrorUp;
  mirrorDown: LibraryMirrorDown;
  thumbnailPass: LibraryThumbnailPass;
  eviction: LibraryEviction;
  isCloudOnly: () => Promise<boolean>;
  getAccountScope: () => Promise<string | null>;
}>;

/**
 * One sync round (K4 §4.2, board #27 S3 §5.11). Mirror-up first, best effort
 * (K1: an upload-side fault never costs the round the rest). Then by this
 * phone's mode: 本地+云端 downloads every original it is missing; 仅云端
 * fetches durable thumbnails and evicts, and never downloads an original.
 * `down` is the pool `runToEmpty` drives to empty; 仅云端 counts eviction so
 * a row kept once is retried in the same run.
 */
export function createLibrarySyncRound(
  deps: LibrarySyncRoundDependencies,
): () => Promise<SyncRoundResult> {
  return async () => {
    let up = NONE;
    try {
      up = await deps.mirrorUp.mirrorUp();
    } catch {
      // Retried next round, as before.
    }
    let cloudOnly: boolean;
    try {
      cloudOnly = await deps.isCloudOnly();
    } catch {
      // A mode we cannot read must neither download every evicted original
      // nor delete anything.
      return { up, down: NONE };
    }
    if (!cloudOnly) return { up, down: await deps.mirrorDown.mirrorDown() };
    const scope = await deps.getAccountScope();
    if (scope === null) return { up, down: NONE };
    let down = NONE;
    let passFailed = false;
    let passError: unknown;
    try {
      down = await deps.thumbnailPass.run(scope);
    } catch (error) {
      passFailed = true;
      passError = error;
    }
    try {
      const eviction = await deps.eviction.evict(scope);
      down = {
        total: down.total + eviction.evicted + eviction.kept,
        done: down.done + eviction.evicted,
        failed: down.failed + eviction.kept,
      };
    } catch {
      // Nothing a row still names was deleted; the next round retries.
    }
    if (passFailed) throw passError;
    return { up, down };
  };
}
