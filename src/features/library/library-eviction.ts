import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryChangeFeed } from '@/features/library/library-change-feed';
import type { LibraryFilePort, LibraryFileStore } from '@/features/library/library-file-store';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import type { LibraryLocalThumbnails } from '@/features/library/library-local-thumbnails';
import type { LibraryFillDerivedResult } from '@/features/library/library-protect-action';
import type { LibraryRepository } from '@/features/library/library-repository';
import { runTransferPool } from '@/features/library/library-transfer-pool';
import type { LibraryCanonicalExtension } from '@/features/library/library-types';

export const LIBRARY_EVICTION_CONCURRENCY = 8;

export type LibraryEvictionResult = Readonly<{ reclaimed: number; evicted: number; kept: number }>;
export type LibraryEviction = Readonly<{
  /**
   * Board #27 S3 (spec §5.10): 仅云端's pass, run inside a round. Deletes the
   * originals a crash left behind, then evicts every committed original whose
   * image was handed over. Rejects only when a row read fails.
   */
  evict(accountScope: string): Promise<LibraryEvictionResult>;
}>;
export type LibraryEvictionDependencies = Readonly<{
  database: SqlDatabasePort;
  files: Pick<LibraryFileStore, 'originalUriFor' | 'deleteOriginal'>;
  port: Pick<LibraryFilePort, 'listOriginals'>;
  repository: Pick<LibraryRepository, 'isOriginalNamed'>;
  thumbnails: Pick<LibraryLocalThumbnails, 'ensureLocalThumbnail'>;
  fillDerived: (plaintextSha256: string) => Promise<LibraryFillDerivedResult>;
  /** Re-read per candidate: a switch back to 本地+云端 stops the pass at once. */
  isCloudOnly: () => Promise<boolean>;
  /**
   * N6-A2 / N6-A3 (spec §4.3, §4.9): optional check that the projection's
   * applied authority still matches the current discovered winner (no newer
   * winner pending/failed). Consumed by N6-A3; defaults to true.
   */
  isAuthorityCurrent?: (
    accountScope: string,
    plaintextSha256: string,
  ) => Promise<boolean>;
  changes: Pick<LibraryChangeFeed, 'emit'>;
  clock?: () => number;
  concurrency?: number;
}>;

// The conditions every evicted row meets, at the listing and again at the flip:
// a committed, verified, active original (`listFreeCandidates`), protect-eligible
// and within the 64 MiB - 96 cap (N6-A2 spec §4.9), an image that was handed over
// (no collection copy survives), no account trash or stop-protection whose
// outcome is unknown.
const CANDIDATES_SQL = `
  SELECT a.plaintext_sha256, a.local_original_uri
    FROM device_library_assets a
    JOIN library_asset_protection p
      ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
    LEFT JOIN library_device_asset_state d ON d.plaintext_sha256 = a.plaintext_sha256
   WHERE a.residency = 'local-original' AND a.local_original_uri IS NOT NULL
     AND a.missing_original_since IS NULL
     AND a.protect_eligible = 1 AND a.byte_size <= ?
     AND (
       a.origin <> 'import'
       OR a.import_deleted_at IS NULL
       OR a.source_image_id IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM library_provider_image_assets m
         JOIN images i ON i.id = m.image_id AND i.decision = 'saved'
         WHERE m.plaintext_sha256 = a.plaintext_sha256
       )
     )
     AND p.protection = 'protected' AND p.lifecycle = 'active'
     AND p.original_generation_id IS NOT NULL AND p.verified_at IS NOT NULL
     AND d.device_trashed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM images i
                      WHERE (
                        i.id = a.source_image_id
                        OR EXISTS (
                          SELECT 1 FROM library_provider_image_assets m
                           WHERE m.image_id = i.id AND m.plaintext_sha256 = a.plaintext_sha256
                        )
                      ) AND i.download_state = 'ready')
     AND NOT EXISTS (SELECT 1 FROM library_outbox o
                      WHERE o.account_scope = p.account_scope AND o.asset_id = p.asset_id
                        AND o.kind IN ('trash', 'stop-protection') AND o.state IN ('pending', 'sending'))
   ORDER BY a.created_at ASC, a.plaintext_sha256 ASC`;

// Finding 6: one statement re-checks the candidate and flips it; the file is
// deleted only after this commits. binds: now, sha, uri, maxBytes, scope
const FLIP_SQL = `
  UPDATE device_library_assets
     SET residency = 'cloud-only', local_original_uri = NULL,
         missing_original_since = NULL, updated_at = ?
   WHERE plaintext_sha256 = ?
     AND residency = 'local-original' AND local_original_uri = ?
     AND missing_original_since IS NULL AND local_thumbnail_uri IS NOT NULL
     AND protect_eligible = 1 AND byte_size <= ?
     AND (
       origin <> 'import'
       OR import_deleted_at IS NULL
       OR source_image_id IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM library_provider_image_assets m
         JOIN images i ON i.id = m.image_id AND i.decision = 'saved'
         WHERE m.plaintext_sha256 = device_library_assets.plaintext_sha256
       )
     )
     AND EXISTS (SELECT 1 FROM library_asset_protection p
                  WHERE p.account_scope = ?
                    AND p.plaintext_sha256 = device_library_assets.plaintext_sha256
                    AND p.protection = 'protected' AND p.lifecycle = 'active'
                    AND p.original_generation_id IS NOT NULL AND p.verified_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM library_outbox o
                                     WHERE o.account_scope = p.account_scope
                                       AND o.asset_id = p.asset_id
                                       AND o.kind IN ('trash', 'stop-protection')
                                       AND o.state IN ('pending', 'sending')))
     AND NOT EXISTS (SELECT 1 FROM library_device_asset_state d
                      WHERE d.plaintext_sha256 = device_library_assets.plaintext_sha256
                        AND d.device_trashed_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM images i
                      WHERE (
                        i.id = device_library_assets.source_image_id
                        OR EXISTS (
                          SELECT 1 FROM library_provider_image_assets m
                           WHERE m.image_id = i.id
                             AND m.plaintext_sha256 = device_library_assets.plaintext_sha256
                        )
                      ) AND i.download_state = 'ready')`;

const nameOf = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1);

export function createLibraryEviction({
  database, files, port, repository, thumbnails, fillDerived, isCloudOnly,
  isAuthorityCurrent = async () => true,
  changes,
  clock = Date.now, concurrency = LIBRARY_EVICTION_CONCURRENCY,
}: LibraryEvictionDependencies): LibraryEviction {
  /** Spec §5.10: an original a crash left between a flip and its delete. */
  const reclaimOrphans = async (): Promise<number> => {
    let listed: string[];
    try {
      listed = await port.listOriginals();
    } catch {
      return 0;
    }
    if (listed.length === 0) return 0;
    const present = new Set(listed.map(nameOf));
    const rows = await database.getAll<{
      plaintext_sha256: string;
      canonical_extension: LibraryCanonicalExtension;
    }>(`SELECT plaintext_sha256, canonical_extension FROM device_library_assets
         WHERE residency = 'cloud-only'`);
    let reclaimed = 0;
    for (const row of rows) {
      const uri = files.originalUriFor(row.plaintext_sha256, row.canonical_extension);
      if (!present.has(nameOf(uri))) continue;
      try {
        // A heal may have adopted it since the SELECT: then a row names it.
        if (await repository.isOriginalNamed(uri)) continue;
        await files.deleteOriginal(uri);
        reclaimed += 1;
      } catch {
        // The next pass tries again.
      }
    }
    return reclaimed;
  };

  const evictOne = async (scope: string, sha: string, uri: string): Promise<boolean> => {
    try {
      if (!(await isCloudOnly())) return false;
      if (!(await isAuthorityCurrent(scope, sha))) return false;
      if ((await fillDerived(sha)).status === 'retry') return false;
      if ((await thumbnails.ensureLocalThumbnail(sha)).status !== 'ensured') return false;
      // A switch back to 本地+云端 or a stale authority during the work above wins.
      if (!(await isCloudOnly())) return false;
      if (!(await isAuthorityCurrent(scope, sha))) return false;
      const flipped = await database.run(FLIP_SQL, [
        clock(),
        sha,
        uri,
        LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES,
        scope,
      ]);
      if (flipped.changes !== 1) return false;
    } catch {
      return false;
    }
    try {
      if (!(await repository.isOriginalNamed(uri))) await files.deleteOriginal(uri);
    } catch {
      // The next pass's reclaim deletes it.
    }
    changes.emit({ kind: 'freed', plaintextSha256: sha });
    return true;
  };

  return {
    async evict(accountScope) {
      const reclaimed = await reclaimOrphans();
      const candidates = await database.getAll<{
        plaintext_sha256: string;
        local_original_uri: string;
      }>(CANDIDATES_SQL, [
        accountScope,
        LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES,
      ]);
      let evicted = 0;
      let kept = 0;
      await runTransferPool(candidates, async (row) => {
        if (await evictOne(accountScope, row.plaintext_sha256, row.local_original_uri)) evicted += 1;
        else kept += 1;
      }, { concurrency });
      return { reclaimed, evicted, kept };
    },
  };
}
