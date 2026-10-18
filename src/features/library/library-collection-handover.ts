import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryCollectEvent } from '@/features/library/library-collect-adapter';
import type { LibraryChangeFeed } from '@/features/library/library-change-feed';
import { isInOriginalsDirectory } from '@/features/library/library-file-store';
import type { LibraryFilePort } from '@/features/library/library-file-store';
import type { LibraryIngestOutcome } from '@/features/library/library-types';

/** The collection's own files as the hand-over needs them (`CollectionFileRepository` fits). */
export type LibraryCollectionFilesPort = Readonly<{
  fileSize(uri: string): Promise<number>; // 0 when the file is absent
  deleteUri(uri: string): Promise<void>; // an absent file is success
}>;

export type LibraryCollectionHandover = Readonly<{
  /** Spec §5.5, a new save: hands `event.imageId`'s collection file to the library when rule 1 holds for the
   *  digest its ingest just produced and that digest is the image's newest library row. Never throws. */
  handOver(event: LibraryCollectEvent, outcome: LibraryIngestOutcome): Promise<boolean>;
  /** Spec §5.5, the migration: every `ready` row with exactly one library row and equal byte sizes.
   *  Single-flight; answers how many rows it handed over. */
  handOverExisting(): Promise<number>;
}>;

type HandoverCandidate = Readonly<{
  imageId: number;
  localUri: string;
  plaintextSha256: string;
  localOriginalUri: string;
  byteSize: number;
}>;

type ExistingRow = {
  image_id: number;
  local_uri: string;
  plaintext_sha256: string;
  local_original_uri: string;
  byte_size: number;
};

type DeviceRow = {
  local_original_uri: string | null;
  byte_size: number;
  residency: string;
  source_image_id: number | null;
  missing_original_since: number | null;
};

/**
 * Board #27 S1b (spec §5.5): make the library original the only local copy of a
 * saved image. Once for every existing duplicate (`handOverExisting`, the
 * migration), then for every new save (`handOver`).
 *
 * The move is a `mirrored` flip of the `images` row, then a delete of the
 * collection file — the row first, so a crash between them leaves an
 * unreferenced collection file the sweep takes, never a row that points at a
 * file that is gone. The flip is one conditional `UPDATE`: it fires only while
 * the pre-transaction stat still holds (rule 1 — the library original is on
 * disk at `byteSize`, and so is the collection file), the digest is a usable
 * `local-original` row of this image, that digest is the image's newest library
 * row (the one T5a renders), and neither a device-trash mark nor a non-active
 * projection touches it (OQ-1). The `UPDATE` has no byte guard: nothing after
 * the stat re-checks the library file. The one writer that could delete it
 * then is a concurrent ingest of the same bytes rolling back its promote
 * (spec R12; the Task 3 drift review), and that rollback never deletes an
 * original a usable device row names (`library-ingest.ts`, `discardPromoted`).
 * The stat plus that rule leave only the gap between the rollback's check and
 * its delete, which the whole hand-over would have to fit inside (accepted).
 */
export function createLibraryCollectionHandover(deps: Readonly<{
  database: SqlDatabasePort;
  libraryFiles: Pick<LibraryFilePort, 'size' | 'originalsRootUri'>;
  collectionFiles: LibraryCollectionFilesPort;
  changes: Pick<LibraryChangeFeed, 'emit'>;
}>): LibraryCollectionHandover {
  const { database, libraryFiles, collectionFiles, changes } = deps;

  async function commit(
    candidate: HandoverCandidate,
    { single }: { single: boolean },
  ): Promise<boolean> {
    // Rule 1, in order: the library file must be the port's own original, and
    // the stat before the transaction must see both files at `byteSize`. A
    // missing file answers 0, and `byte_size > 0` by its CHECK, so an equal
    // size is also presence.
    if (!isInOriginalsDirectory(candidate.localOriginalUri, libraryFiles.originalsRootUri)) {
      return false;
    }
    if ((await libraryFiles.size(candidate.localOriginalUri)) !== candidate.byteSize) {
      return false;
    }
    if ((await collectionFiles.fileSize(candidate.localUri)) !== candidate.byteSize) {
      return false;
    }

    const result = await database.run(
      `UPDATE images
          SET download_state = 'mirrored', local_uri = NULL,
              download_error = NULL, download_error_kind = NULL
        WHERE id = ? AND decision = 'saved' AND download_state = 'ready' AND local_uri = ?
          AND EXISTS (
            SELECT 1 FROM device_library_assets a
             WHERE a.plaintext_sha256 = ? AND a.source_image_id = ?
               AND a.residency = 'local-original' AND a.local_original_uri = ?
               AND a.missing_original_since IS NULL
               AND NOT EXISTS (SELECT 1 FROM device_library_assets n
                                WHERE n.source_image_id = a.source_image_id
                                  AND (n.created_at > a.created_at
                                       OR (n.created_at = a.created_at AND n.plaintext_sha256 < a.plaintext_sha256)))
               AND NOT EXISTS (SELECT 1 FROM library_device_asset_state dd
                                WHERE dd.plaintext_sha256 = a.plaintext_sha256 AND dd.device_trashed_at IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM library_asset_protection p
                                WHERE p.plaintext_sha256 = a.plaintext_sha256 AND p.lifecycle <> 'active'))
          AND (? = 0 OR (SELECT COUNT(*) FROM device_library_assets b WHERE b.source_image_id = ?) = 1)`,
      [
        candidate.imageId,
        candidate.localUri,
        candidate.plaintextSha256,
        candidate.imageId,
        candidate.localOriginalUri,
        single ? 1 : 0,
        candidate.imageId,
      ],
    );
    if (result.changes === 0) return false;

    // The row is `mirrored` now; the collection file is unreferenced. A failed
    // delete is fine — the next sweep removes it (T1's pin).
    try {
      await collectionFiles.deleteUri(candidate.localUri);
    } catch {
      // swallowed
    }
    try {
      changes.emit({
        kind: 'handed-over',
        imageId: candidate.imageId,
        plaintextSha256: candidate.plaintextSha256,
      });
    } catch {
      // The flip is committed; a notification failure must not undo its answer.
    }
    return true;
  }

  async function handOver(
    event: LibraryCollectEvent,
    outcome: LibraryIngestOutcome,
  ): Promise<boolean> {
    try {
      const digest = outcome.asset.plaintextSha256;
      // The ingest just hashed L, so the digest is known; read the device row
      // for its uri and size. These pre-checks only spare the stat — the
      // UPDATE's `a.source_image_id = ?` (bound to `event.imageId`) refuses the
      // same cases — so a row that is gone, not usable, or another image's
      // stops here.
      const row = await database.getFirst<DeviceRow>(
        `SELECT local_original_uri, byte_size, residency, source_image_id,
                missing_original_since
           FROM device_library_assets
          WHERE plaintext_sha256 = ?`,
        [digest],
      );
      if (
        row === null ||
        row.residency !== 'local-original' ||
        row.local_original_uri === null ||
        row.missing_original_since !== null ||
        row.source_image_id !== event.imageId
      ) {
        return false;
      }
      // The ingest produced this digest, so "exactly one" is not needed;
      // "newest" still is, and the UPDATE checks it.
      return await commit(
        {
          imageId: event.imageId,
          localUri: event.localUri,
          plaintextSha256: digest,
          localOriginalUri: row.local_original_uri,
          byteSize: row.byte_size,
        },
        { single: false },
      );
    } catch {
      return false;
    }
  }

  let inFlight: Promise<number> | null = null;

  async function runExisting(): Promise<number> {
    // The SELECT throwing rejects (T7 swallows it); a row whose commit throws
    // is skipped. No hashing (§5.5; #20: re-reading big gifs is not free), so
    // each candidate is committed with `single: true`.
    const rows = await database.getAll<ExistingRow>(
      `SELECT i.id AS image_id, i.local_uri, a.plaintext_sha256, a.local_original_uri, a.byte_size
         FROM images i
         JOIN device_library_assets a ON a.source_image_id = i.id
        WHERE i.decision = 'saved' AND i.download_state = 'ready' AND i.local_uri IS NOT NULL
          AND i.library_error IS NULL
          AND a.residency = 'local-original' AND a.local_original_uri IS NOT NULL
          AND a.missing_original_since IS NULL
          AND NOT EXISTS (SELECT 1 FROM library_device_asset_state d
                           WHERE d.plaintext_sha256 = a.plaintext_sha256 AND d.device_trashed_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM library_asset_protection p
                           WHERE p.plaintext_sha256 = a.plaintext_sha256 AND p.lifecycle <> 'active')
          AND (SELECT COUNT(*) FROM device_library_assets b WHERE b.source_image_id = i.id) = 1
        ORDER BY i.id`,
    );

    let committed = 0;
    for (const row of rows) {
      try {
        const handed = await commit(
          {
            imageId: row.image_id,
            localUri: row.local_uri,
            plaintextSha256: row.plaintext_sha256,
            localOriginalUri: row.local_original_uri,
            byteSize: row.byte_size,
          },
          { single: true },
        );
        if (handed) committed += 1;
      } catch {
        // this row is skipped; the rest still go
      }
    }
    return committed;
  }

  function handOverExisting(): Promise<number> {
    // A call while one runs returns that run's promise (single-flight).
    if (inFlight !== null) return inFlight;
    const run = runExisting().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  }

  return { handOver, handOverExisting };
}
