import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryCollectAdapter } from '@/features/library/library-collect-adapter';
import type { LibraryFileStore } from '@/features/library/library-file-store';

/** One device row of the image or import being purged. */
export type LibraryCollectedPurgeAsset = Readonly<{
  plaintextSha256: string;
  sourceImageId: number | null;
}>;

/**
 * The BYOS composition's part of the purge (spec §5.4.2 steps 3 and 6); the
 * local-only core passes only an `after` hook that announces `purged` (board
 * #27 F1). `before` runs ahead of each asset's transaction (join an upload of
 * the same bytes, evict the decrypted cache), `after` once the asset's rows
 * and files are gone.
 */
export type LibraryCollectedPurgeHooks = Readonly<{
  before?(asset: LibraryCollectedPurgeAsset): Promise<void>;
  after?(asset: LibraryCollectedPurgeAsset): void;
}>;

export type LibraryCollectedPurge = Readonly<{
  /**
   * Removes this device's library copy of a saved image that left the
   * collection (a rewind, a 收藏 delete, a 回到发现). Single-flight per id.
   */
  purgeCollectedImage(imageId: number): Promise<void>;
  /**
   * N6-A2 (spec §4.8): device-local digest-membership purge for an imported
   * image. Removes only this phone's import membership; if a surviving saved
   * provider member references the same digest, preserves the row and files
   * for that provider member. Keeps `library_account_assets`, protection
   * projection, and remote state index so sync never resurrects it. Answers
   * whether an active import membership was removed.
   */
  purgeImportedAsset(plaintextSha256: string): Promise<boolean>;
  /**
   * Crash recovery: purges every library row whose image is gone or no longer
   * `saved` — a rewind, a 收藏 delete, or a 回到发现. Answers how many images
   * it handed to the purge. #24's `dismissed` exclusion only avoided a rejected
   * `decided_at` rule and left this leftover to row 25, which is not being built.
   */
  purgeUndoneLibraryRows(): Promise<number>;
  /**
   * Board #27 (spec §5.4 step 3): this phone's library. The ingest pool
   * finishes, then the uploads the caller is settling, then one transaction
   * deletes the device rows. Files go after the commit, so a failed
   * transaction deletes none.
   */
  clearDeviceLibrary(
    settleUploads?: () => Promise<void>,
  ): Promise<{ failed: readonly string[] }>;
  /**
   * Board #27 S1b Task 8 (spec R26): resolves once every purge in flight at
   * the call has settled; a rejected purge does not reject it.
   */
  settled(): Promise<void>;
  /**
   * Board #27 S1b Task 8 (spec R26): while refused, `purgeCollectedImage`
   * resolves and `purgeUndoneLibraryRows` answers 0, at once, touching neither
   * the database nor a file; answers an idempotent release. `settled` and
   * `clearDeviceLibrary` are unaffected.
   */
  refuse(): () => void;
}>;

export type LibraryCollectedPurgeDependencies = Readonly<{
  database: SqlDatabasePort;
  files: Pick<LibraryFileStore, 'deleteOriginal' | 'deleteAllDeviceFiles'>;
  collect: Pick<LibraryCollectAdapter, 'settled' | 'drain'>;
  hooks?: LibraryCollectedPurgeHooks;
  clock?: () => number;
  /**
   * N6-A2 (spec §4.8): optional per-digest serialization gate shared with
   * `LibraryIngestService` so physical file deletion after `purgeImportedAsset`
   * cannot race a concurrent re-add of the same digest.
   */
  withDigestGate?: <T>(
    plaintextSha256: string,
    work: () => Promise<T>,
  ) => Promise<T>;
  /**
   * N6-A2 (spec §4.8): optional callback that settles any in-flight confirmed
   * import work before `purgeImportedAsset` inspects or deletes rows/files.
   */
  settleImports?: () => Promise<void>;
}>;

type PurgedFiles = Readonly<{
  local_original_uri: string | null;
  device_trash_uri: string | null;
  local_thumbnail_uri: string | null;
}>;

/**
 * Board #24 stage 1 (spec §5.4.2): the library's local phase of a rewound save,
 * a 收藏 delete, or a 回到发现. #24's `dismissed` exclusion only avoided a
 * rejected `decided_at` rule and left this leftover to row 25, which is not
 * being built.
 *
 * The owner's ruling is that rewinding a save removes it completely. Stage 1
 * removes it from this device: the collection files go first (the collection
 * service's `revertPendingSave`), then this. The cloud copy is row 25's, and
 * what this purge deliberately keeps is exactly what stops sync from bringing
 * the image back (§5.4.3):
 *
 * - the `library_account_assets` row keeps the remote asset "known", so a sync
 *   round only updates its projection and never re-materialises a device row
 *   or re-saves the `images` row through `restoreImage`;
 * - the projection and any `sending` intent stay with the cloud copy.
 *
 * What goes, per device row of the image: the `device_library_assets` and
 * `library_device_asset_state` rows, the non-`sending` `collect`/`protect`
 * intents (with the device row gone they could never be sealed or would be
 * retried for ever; a later re-save re-creates the `collect` intent through
 * the K6-3a repair in `commitCollect`), the projection's `failure_category`,
 * and then the original and any device-trash copy.
 *
 * The rows go in one transaction that first re-checks the image: if it is
 * `saved` again — a Search save, a sweep repair or a mirror restore — that
 * save owns the asset now and nothing is deleted. Files go only after the
 * commit, so an aborted purge never deletes a saved image's file; one that
 * fails to delete stays on disk unreferenced until 删除全部应用数据 clears the
 * library files (`reconcileStorage` has no production caller, spec R6).
 *
 * Collateral, documented in §5.4.3: device rows are keyed by digest and a
 * duplicate ingest keeps the first `source_image_id`, so a still-saved image
 * with the same bytes loses its library copy too. The K6-5 C backfill offers
 * it back, and `onCollectionResumed` runs it right after the recovery rule.
 */
export function createLibraryCollectedPurge({
  database,
  files,
  collect,
  hooks = {},
  clock = Date.now,
  withDigestGate = async (_sha, work) => work(),
  settleImports = async () => undefined,
}: LibraryCollectedPurgeDependencies): LibraryCollectedPurge {
  const inFlight = new Map<number, Promise<void>>();
  const inFlightImports = new Map<string, Promise<boolean>>();
  let refusals = 0;

  /**
   * Step 4 for provider image purge.
   * - Returns `null` when the image is saved again (abort purge).
   * - Returns `{ filesToDelete: [], rehomed: true }` when a surviving active
   *   import or another saved provider member still uses `plaintextSha256`,
   *   having updated the row so the surviving member keeps its usable bytes.
   * - Returns `{ filesToDelete: [...], rehomed: false }` when no member
   *   survives and the device row was removed.
   */
  const removeRows = (
    imageId: number,
    plaintextSha256: string,
  ): Promise<Readonly<{ filesToDelete: readonly (string | null)[]; rehomed: boolean }> | null> =>
    database.transaction(async (transaction) => {
      const image = await transaction.getFirst<{ decision: string }>(
        'SELECT decision FROM images WHERE id = ?',
        [imageId],
      );
      if (image?.decision === 'saved') return null;

      await transaction.run(
        'DELETE FROM library_provider_image_assets WHERE image_id = ?',
        [imageId],
      );

      const assetRow = await transaction.getFirst<{
        origin: string;
        source_image_id: number | null;
        import_deleted_at: number | null;
        local_original_uri: string | null;
        local_thumbnail_uri: string | null;
      }>(
        `SELECT origin, source_image_id, import_deleted_at,
                local_original_uri, local_thumbnail_uri
           FROM device_library_assets
          WHERE plaintext_sha256 = ?`,
        [plaintextSha256],
      );
      if (assetRow === null) {
        return { filesToDelete: [], rehomed: false };
      }

      const deviceTrash = await transaction.getFirst<{
        device_trashed_at: number | null;
        device_trash_uri: string | null;
      }>(
        `SELECT device_trashed_at, device_trash_uri
           FROM library_device_asset_state
          WHERE plaintext_sha256 = ?`,
        [plaintextSha256],
      );

      const survivingImport =
        assetRow.origin === 'import'
        && assetRow.import_deleted_at === null
        && (deviceTrash?.device_trashed_at ?? null) === null;

      if (survivingImport) {
        if (assetRow.source_image_id === imageId) {
          await transaction.run(
            `UPDATE device_library_assets
                SET source_image_id = NULL
              WHERE plaintext_sha256 = ?`,
            [plaintextSha256],
          );
        }
        return { filesToDelete: [], rehomed: true };
      }

      await transaction.run(
        'DELETE FROM device_library_assets WHERE plaintext_sha256 = ?',
        [plaintextSha256],
      );
      await transaction.run(
        'DELETE FROM library_device_asset_state WHERE plaintext_sha256 = ?',
        [plaintextSha256],
      );
      await transaction.run(
        `DELETE FROM library_outbox
          WHERE state <> 'sending'
            AND kind IN ('collect', 'protect')
            AND asset_id IN (
              SELECT asset_id FROM library_account_assets
               WHERE plaintext_sha256 = ?
            )`,
        [plaintextSha256],
      );
      await transaction.run(
        `UPDATE library_asset_protection SET failure_category = NULL
          WHERE plaintext_sha256 = ?`,
        [plaintextSha256],
      );
      return {
        filesToDelete: [
          assetRow.local_original_uri,
          deviceTrash?.device_trash_uri ?? null,
          assetRow.local_thumbnail_uri,
        ],
        rehomed: false,
      };
    });

  const purgeOnce = async (imageId: number): Promise<void> => {
    // Step 1: an ingest already running for this image commits first, and is
    // purged below with the rest.
    await collect.settled(imageId);
    // Step 2: every row owned by this image (`source_image_id = ?`). A late
    // provider attached to an import-owned row only has a mapping in
    // `library_provider_image_assets`; if `rows` is empty, clean up that
    // association without touching the import's row or hooks.
    const rows = await database.getAll<{ plaintext_sha256: string }>(
      `SELECT plaintext_sha256 FROM device_library_assets
        WHERE source_image_id = ?
        ORDER BY plaintext_sha256`,
      [imageId],
    );
    if (rows.length === 0) {
      const assocRows = await database.getAll<{ plaintext_sha256: string }>(
        `SELECT plaintext_sha256 FROM library_provider_image_assets
          WHERE image_id = ?
          ORDER BY plaintext_sha256`,
        [imageId],
      );
      for (const assoc of assocRows) {
        await withDigestGate(assoc.plaintext_sha256, async () => {
          await database.run(
            `DELETE FROM library_provider_image_assets
              WHERE image_id = ?
                AND plaintext_sha256 = ?
                AND NOT EXISTS (
                  SELECT 1 FROM images i WHERE i.id = ? AND i.decision = 'saved'
                )`,
            [imageId, assoc.plaintext_sha256, imageId],
          );
        });
      }
      return;
    }
    for (const row of rows) {
      const asset: LibraryCollectedPurgeAsset = {
        plaintextSha256: row.plaintext_sha256,
        sourceImageId: imageId,
      };
      // Step 3.
      await hooks.before?.(asset);
      const shouldAbort = await withDigestGate(asset.plaintextSha256, async () => {
        const removed = await removeRows(imageId, asset.plaintextSha256);
        // Saved again: the new save owns every row of the image.
        if (removed === null) return true;
        // Step 5: files after the rows, only when no surviving member uses them.
        for (const uri of removed.filesToDelete) {
          if (uri === null) continue;
          try {
            await files.deleteOriginal(uri);
          } catch {
            // Left unreferenced; 删除全部应用数据 clears it (spec R6).
          }
        }
        // Step 6.
        hooks.after?.(asset);
        return false;
      });
      if (shouldAbort) return;
    }
  };

  const removeImportMembership = (
    plaintextSha256: string,
  ): Promise<Readonly<{
    removed: boolean;
    filesToDelete: readonly (string | null)[];
  }>> =>
    database.transaction(async (transaction) => {
      const assetRow = await transaction.getFirst<{
        origin: string;
        source_image_id: number | null;
        import_deleted_at: number | null;
        local_original_uri: string | null;
        local_thumbnail_uri: string | null;
      }>(
        `SELECT origin, source_image_id, import_deleted_at,
                local_original_uri, local_thumbnail_uri
           FROM device_library_assets
          WHERE plaintext_sha256 = ?`,
        [plaintextSha256],
      );
      if (
        assetRow === null
        || assetRow.origin !== 'import'
        || assetRow.import_deleted_at !== null
      ) {
        return { removed: false, filesToDelete: [] };
      }

      const deviceTrash = await transaction.getFirst<{
        device_trash_uri: string | null;
      }>(
        `SELECT device_trash_uri
           FROM library_device_asset_state
          WHERE plaintext_sha256 = ?`,
        [plaintextSha256],
      );

      const survivingProvider = await transaction.getFirst<{
        id: number;
        download_state: string;
      }>(
        `SELECT i.id AS id, i.download_state AS download_state
           FROM images i
          WHERE i.decision = 'saved'
            AND (
              i.id = ?
              OR EXISTS (
                SELECT 1 FROM library_provider_image_assets m
                 WHERE m.image_id = i.id AND m.plaintext_sha256 = ?
              )
            )
          ORDER BY i.decided_at DESC, i.id DESC
          LIMIT 1`,
        [assetRow.source_image_id, plaintextSha256],
      );

      if (survivingProvider !== null) {
        const at = clock();
        // Suppress import membership on this phone (`import_deleted_at = at`).
        // If the surviving provider is already `mirrored` (e.g., it was the
        // original owner before cloud import convergence cleared
        // `source_image_id`), keep the digest row and its bytes alive and link
        // `source_image_id` back to that provider so it never loses its only
        // local copy. If the surviving provider has its own `ready` collection
        // file, the import's private digest copy can be removed while keeping
        // the provider's committed digest association in
        // `library_provider_image_assets` (§4.8: "A provider with its own ready
        // collection file may retain that file and committed digest association
        // while the import's private digest copy is removed").
        if (survivingProvider.download_state !== 'ready') {
          await transaction.run(
            `UPDATE device_library_assets
                SET import_deleted_at = ?,
                    source_image_id = COALESCE(source_image_id, ?),
                    updated_at = ?
              WHERE plaintext_sha256 = ?`,
            [at, survivingProvider.id, at, plaintextSha256],
          );
          return { removed: true, filesToDelete: [] };
        }
      }

      await transaction.run(
        'DELETE FROM device_library_assets WHERE plaintext_sha256 = ?',
        [plaintextSha256],
      );
      await transaction.run(
        'DELETE FROM library_device_asset_state WHERE plaintext_sha256 = ?',
        [plaintextSha256],
      );
      await transaction.run(
        `DELETE FROM library_outbox
          WHERE state <> 'sending'
            AND kind IN ('collect', 'protect')
            AND asset_id IN (
              SELECT asset_id FROM library_account_assets
               WHERE plaintext_sha256 = ?
            )`,
        [plaintextSha256],
      );
      await transaction.run(
        `UPDATE library_asset_protection SET failure_category = NULL
          WHERE plaintext_sha256 = ?`,
        [plaintextSha256],
      );
      return {
        removed: true,
        filesToDelete: [
          assetRow.local_original_uri,
          deviceTrash?.device_trash_uri ?? null,
          assetRow.local_thumbnail_uri,
        ],
      };
    });

  const purgeImportOnce = async (plaintextSha256: string): Promise<boolean> => {
    const asset: LibraryCollectedPurgeAsset = {
      plaintextSha256,
      sourceImageId: null,
    };
    await settleImports();
    await hooks.before?.(asset);
    return await withDigestGate(plaintextSha256, async () => {
      const result = await removeImportMembership(plaintextSha256);
      if (!result.removed) return false;
      for (const uri of result.filesToDelete) {
        if (uri === null) continue;
        try {
          await files.deleteOriginal(uri);
        } catch {
          // Left unreferenced; 删除全部应用数据 clears it (spec R6).
        }
      }
      hooks.after?.(asset);
      return true;
    });
  };

  const purgeCollectedImage = (imageId: number): Promise<void> => {
    if (refusals > 0) return Promise.resolve();
    const existing = inFlight.get(imageId);
    if (existing !== undefined) return existing;
    const run = purgeOnce(imageId).finally(() => {
      inFlight.delete(imageId);
    });
    inFlight.set(imageId, run);
    return run;
  };

  const purgeImportedAsset = (plaintextSha256: string): Promise<boolean> => {
    if (refusals > 0) return Promise.resolve(false);
    const existing = inFlightImports.get(plaintextSha256);
    if (existing !== undefined) return existing;
    const run = purgeImportOnce(plaintextSha256).finally(() => {
      inFlightImports.delete(plaintextSha256);
    });
    inFlightImports.set(plaintextSha256, run);
    return run;
  };

  return {
    purgeCollectedImage,
    purgeImportedAsset,

    async settled() {
      await Promise.allSettled([
        ...inFlight.values(),
        ...inFlightImports.values(),
      ]);
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

    async clearDeviceLibrary(settleUploads = async () => {}) {
      await collect.drain();
      await settleUploads();
      await database.transaction(async (transaction) => {
        await transaction.run('DELETE FROM library_provider_image_assets');
        await transaction.run('DELETE FROM device_library_assets');
        await transaction.run('DELETE FROM library_device_asset_state');
        await transaction.run(
          `DELETE FROM library_outbox
            WHERE state <> 'sending' AND kind IN ('collect', 'protect')`,
        );
        await transaction.run('DELETE FROM library_cache_entries');
        await transaction.run(
          'UPDATE library_asset_protection SET failure_category = NULL',
        );
      });
      const failed = await files.deleteAllDeviceFiles();
      return { failed };
    },

    /**
     * Spec §5.4. A rewind, a 收藏 delete, or a 回到发现 whose local phase never
     * ran (the app was killed) leaves a library row whose image is gone or no
     * longer `saved`. #24's `dismissed` exclusion only avoided a rejected
     * `decided_at` rule and left this leftover to row 25, which is not being
     * built. Saved rows stay, and so does a row with no source image (an
     * import).
     */
    async purgeUndoneLibraryRows() {
      if (refusals > 0) return 0;
      const rows = await database.getAll<{ id: number }>(
        `SELECT DISTINCT id FROM (
           SELECT a.source_image_id AS id
             FROM device_library_assets a
             LEFT JOIN images i ON i.id = a.source_image_id
            WHERE a.source_image_id IS NOT NULL
              AND (i.id IS NULL OR i.decision <> 'saved')
           UNION
           SELECT m.image_id AS id
             FROM library_provider_image_assets m
             LEFT JOIN images i ON i.id = m.image_id
            WHERE i.id IS NULL OR i.decision <> 'saved'
         ) ORDER BY id`,
      );
      for (const { id } of rows) {
        try {
          await purgeCollectedImage(id);
        } catch {
          // Left for the next resume sweep; the other images still go now.
        }
      }
      return rows.length;
    },
  };
}
