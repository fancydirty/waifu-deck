import type { SqlBindValue, SqlDatabasePort } from '@/db/sql-port';
import type {
  DeviceLibraryAsset,
  LibraryAccountAsset,
  LibraryAssetOrigin,
  LibraryCanonicalExtension,
  LibraryCollectMetadata,
  LibraryImageFormat,
  LibraryImportClassification,
  LibraryMutationKind,
  LibraryOutboxEntry,
  LibraryOutboxState,
  LibraryResidency,
} from '@/features/library/library-types';
import {
  isLibraryImportClassification,
  LibraryIngestError,
} from '@/features/library/library-types';

/** Layer A write. No account, no session, no keyed identity. */
export type LibraryLocalCommit = Readonly<{
  asset: DeviceLibraryAsset;
}>;

export type LibraryLocalCommitResult = Readonly<{
  status: 'committed' | 'duplicate';
  asset: DeviceLibraryAsset;
}>;

/**
 * Layer B write. `deviceId` is the registered device id from the SP5 session at
 * collect time; it is persisted with the mutation and never re-derived later.
 */
export type LibraryCollectCommit = Readonly<{
  accountScope: string;
  assetId: string;
  plaintextSha256: string;
  deviceId: string;
  mutationId: string;
  metadata: LibraryCollectMetadata;
  at: number;
}>;

export type LibraryCommitResult = Readonly<{
  status: 'committed' | 'duplicate';
  accountAsset: LibraryAccountAsset;
}>;

export type LibraryDigestMembershipState = Readonly<{
  asset: DeviceLibraryAsset | null;
  hasActiveImportMember: boolean;
  hasActiveProviderMember: boolean;
  hasActiveCloudIdentity: boolean;
}>;

export type LibraryReactivateImportInput = Readonly<{
  plaintextSha256: string;
  localOriginalUri: string;
  origin: LibraryAssetOrigin;
  sourceImageId: number | null;
  importClassification: LibraryImportClassification;
  createdAt: number;
  at: number;
}>;

export type LibraryCrossDeviceCollisionInput = Readonly<{
  plaintextSha256: string;
  origin: LibraryAssetOrigin;
  sourceImageId: number | null;
  importClassification: LibraryImportClassification;
  collectedAt: number;
  at: number;
}>;

export type LibraryRepository = Readonly<{
  findLocalAsset(plaintextSha256: string): Promise<DeviceLibraryAsset | null>;
  listLocalAssets(): Promise<readonly DeviceLibraryAsset[]>;
  listReferencedOriginalUris(): Promise<readonly string[]>;
  /**
   * Board #27 S1b Task 6: whether a device row names `uri` as a usable local
   * original (`local-original`, unflagged) — the rows the hand-over trusts.
   * An ingest's rollback asks before deleting the file its promote created,
   * because another ingest of the same bytes may have committed such a row
   * naming that content-addressed path in the meantime. A flagged row naming
   * it is not counted: it is healed by a later ingest, not trusted.
   */
  isOriginalNamed(uri: string): Promise<boolean>;
  markOriginalMissing(plaintextSha256: string, at: number): Promise<void>;
  commitLocalAsset(input: LibraryLocalCommit): Promise<LibraryLocalCommitResult>;
  /**
   * N6-A2 (spec §4.4): records a committed provider image-to-digest association
   * in `library_provider_image_assets` when a provider ingest completes for
   * bytes that already have a `device_library_assets` row.
   */
  recordProviderImageDigest(
    imageId: number,
    plaintextSha256: string,
    at: number,
  ): Promise<void>;
  /**
   * N6-A2 (spec §4.4): reads the committed membership state for `plaintextSha256`
   * on this phone (active import member, active saved provider member, and
   * whether an active cloud identity is enrolled).
   */
  inspectDigestMembership(
    plaintextSha256: string,
    accountScope: string | null,
  ): Promise<LibraryDigestMembershipState>;
  /**
   * N6-A2 (spec §4.4): re-activates or creates a local row for an explicit
   * import re-add when no active import or provider member currently owns the
   * digest on this phone. Rechecks membership inside the transaction; returns
   * `duplicate` if an active member won first.
   */
  commitOrReactivateImportAsset(
    input: Readonly<{
      asset: DeviceLibraryAsset;
      overwriteExistingRow: boolean;
    }>,
  ): Promise<LibraryLocalCommitResult>;
  /**
   * N6-A2 (spec §4.4): applies cloud authority to a local digest row after a
   * cross-device collision (local import losing to cloud provider record, or
   * local provider save losing to cloud import record) while preserving any
   * real saved `images` member and usable local bytes.
   */
  applyCrossDeviceCollisionAuthority(
    input: LibraryCrossDeviceCollisionInput,
  ): Promise<DeviceLibraryAsset | null>;
  /**
   * Board #27 S1b Task 3 (spec §5.6): a duplicate ingest's fresh bytes become
   * the original of a row that has none it can use. `source_image_id` is
   * untouched (the first image keeps its pointer), and a device-trashed
   * (`cached`) row is never adopted. Answers the adopted row, or null when
   * no row was adopted.
   */
  adoptLocalOriginal(
    input: Readonly<{
      plaintextSha256: string;
      localOriginalUri: string;
      at: number;
    }>,
  ): Promise<DeviceLibraryAsset | null>;
  /**
   * Board #27 S2: names this device's thumbnail file on the row. Answers
   * whether a row was updated; never touches `updated_at`, which the §5.2b
   * pass uses to detect a changed original.
   */
  setLocalThumbnail(plaintextSha256: string, uri: string): Promise<boolean>;
  findAccountAsset(
    accountScope: string,
    plaintextSha256: string,
  ): Promise<LibraryAccountAsset | null>;
  listLocalAssetsMissingEnrollment(
    accountScope: string,
  ): Promise<readonly DeviceLibraryAsset[]>;
  commitCollect(input: LibraryCollectCommit): Promise<LibraryCommitResult>;
  listOutbox(accountScope: string): Promise<readonly LibraryOutboxEntry[]>;
}>;

type AssetRow = {
  plaintext_sha256: string;
  format: string;
  canonical_extension: string;
  byte_size: number;
  width: number;
  height: number;
  origin: string;
  source_image_id: number | null;
  local_original_uri: string | null;
  residency: string;
  protect_eligible: number;
  missing_original_since: number | null;
  local_thumbnail_uri: string | null;
  import_classification: string;
  import_deleted_at: number | null;
  created_at: number;
  updated_at: number;
};

type AccountAssetRow = {
  account_scope: string;
  asset_id: string;
  plaintext_sha256: string;
  device_id: string;
  enrolled_at: number;
  updated_at: number;
};

type OutboxRow = {
  mutation_id: string;
  account_scope: string;
  device_id: string;
  asset_id: string;
  kind: string;
  base_revision: number | null;
  observed_generation: number | null;
  state: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  local_metadata_json: string;
  created_at: number;
  updated_at: number;
};

const ASSET_COLUMNS = `
  plaintext_sha256, format, canonical_extension, byte_size, width, height,
  origin, source_image_id, local_original_uri, residency, protect_eligible,
  missing_original_since, created_at, updated_at, local_thumbnail_uri,
  import_classification, import_deleted_at
`;

const ACCOUNT_ASSET_COLUMNS = `
  account_scope, asset_id, plaintext_sha256, device_id, enrolled_at, updated_at
`;

const OUTBOX_COLUMNS = `
  mutation_id, account_scope, device_id, asset_id, kind, base_revision,
  observed_generation, state, attempt_count, next_attempt_at,
  last_error_code, local_metadata_json, created_at, updated_at
`;

function toAsset(row: AssetRow): DeviceLibraryAsset {
  return {
    plaintextSha256: row.plaintext_sha256,
    format: row.format as LibraryImageFormat,
    canonicalExtension: row.canonical_extension as LibraryCanonicalExtension,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    origin: row.origin as LibraryAssetOrigin,
    sourceImageId: row.source_image_id,
    localOriginalUri: row.local_original_uri,
    residency: row.residency as LibraryResidency,
    protectEligible: row.protect_eligible === 1,
    missingOriginalSince: row.missing_original_since,
    localThumbnailUri: row.local_thumbnail_uri,
    importClassification: isLibraryImportClassification(row.import_classification)
      ? row.import_classification
      : ('unknown' as LibraryImportClassification),
    importDeletedAt: row.import_deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAccountAsset(row: AccountAssetRow): LibraryAccountAsset {
  return {
    accountScope: row.account_scope,
    assetId: row.asset_id,
    plaintextSha256: row.plaintext_sha256,
    deviceId: row.device_id,
    enrolledAt: row.enrolled_at,
    updatedAt: row.updated_at,
  };
}

function toOutboxEntry(row: OutboxRow): LibraryOutboxEntry {
  return {
    mutationId: row.mutation_id,
    accountScope: row.account_scope,
    deviceId: row.device_id,
    assetId: row.asset_id,
    kind: row.kind as LibraryMutationKind,
    baseRevision: row.base_revision,
    observedGeneration: row.observed_generation,
    state: row.state as LibraryOutboxState,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    localMetadata: JSON.parse(row.local_metadata_json) as LibraryCollectMetadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function databaseError(error: unknown): LibraryIngestError {
  if (error instanceof LibraryIngestError) return error;
  return new LibraryIngestError(
    'database_failed',
    'The library database could not be updated.',
    { cause: error },
  );
}

function assetParams(asset: DeviceLibraryAsset): SqlBindValue[] {
  return [
    asset.plaintextSha256,
    asset.format,
    asset.canonicalExtension,
    asset.byteSize,
    asset.width,
    asset.height,
    asset.origin,
    asset.sourceImageId,
    asset.localOriginalUri,
    asset.residency,
    asset.protectEligible ? 1 : 0,
    asset.missingOriginalSince,
    asset.createdAt,
    asset.updatedAt,
    asset.localThumbnailUri,
    asset.importClassification ?? 'unknown',
    asset.importDeletedAt ?? null,
  ];
}

export function createLibraryRepository(
  database: SqlDatabasePort,
): LibraryRepository {
  const findLocalIn = async (
    port: SqlDatabasePort,
    plaintextSha256: string,
  ): Promise<DeviceLibraryAsset | null> => {
    const row = await port.getFirst<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM device_library_assets
       WHERE plaintext_sha256 = ?`,
      [plaintextSha256],
    );
    return row === null ? null : toAsset(row);
  };

  const findAccountIn = async (
    port: SqlDatabasePort,
    accountScope: string,
    plaintextSha256: string,
  ): Promise<LibraryAccountAsset | null> => {
    const row = await port.getFirst<AccountAssetRow>(
      `SELECT ${ACCOUNT_ASSET_COLUMNS} FROM library_account_assets
       WHERE account_scope = ? AND plaintext_sha256 = ?`,
      [accountScope, plaintextSha256],
    );
    return row === null ? null : toAccountAsset(row);
  };

  return {
    async findLocalAsset(plaintextSha256) {
      try {
        return await findLocalIn(database, plaintextSha256);
      } catch (error) {
        throw databaseError(error);
      }
    },

    async listLocalAssets() {
      try {
        const rows = await database.getAll<AssetRow>(
          `SELECT ${ASSET_COLUMNS} FROM device_library_assets
           ORDER BY created_at DESC, plaintext_sha256 ASC`,
        );
        return rows.map(toAsset);
      } catch (error) {
        throw databaseError(error);
      }
    },

    async isOriginalNamed(uri) {
      try {
        const row = await database.getFirst<{ named: number }>(
          `SELECT 1 AS named FROM device_library_assets
            WHERE local_original_uri = ? AND residency = 'local-original'
              AND missing_original_since IS NULL
            LIMIT 1`,
          [uri],
        );
        return row !== null;
      } catch (error) {
        throw databaseError(error);
      }
    },
    async listReferencedOriginalUris() {
      try {
        const rows = await database.getAll<{ local_original_uri: string }>(
          `SELECT local_original_uri FROM device_library_assets
           WHERE local_original_uri IS NOT NULL
           ORDER BY local_original_uri ASC`,
        );
        return rows.map((row) => row.local_original_uri);
      } catch (error) {
        throw databaseError(error);
      }
    },

    async markOriginalMissing(plaintextSha256, at) {
      try {
        await database.run(
          `UPDATE device_library_assets
           SET missing_original_since = ?, updated_at = ?
           WHERE plaintext_sha256 = ? AND missing_original_since IS NULL`,
          [at, at, plaintextSha256],
        );
      } catch (error) {
        throw databaseError(error);
      }
    },

    async commitLocalAsset({ asset }) {
      try {
        return await database.transaction(async (transaction) => {
          const existing = await findLocalIn(
            transaction,
            asset.plaintextSha256,
          );
          if (existing !== null) {
            if (asset.sourceImageId !== null) {
              await transaction.run(
                `INSERT OR REPLACE INTO library_provider_image_assets (
                   image_id, plaintext_sha256, updated_at
                 ) VALUES (?, ?, ?)`,
                [asset.sourceImageId, asset.plaintextSha256, asset.updatedAt],
              );
            }
            return { status: 'duplicate' as const, asset: existing };
          }
          await transaction.run(
            `INSERT INTO device_library_assets (${ASSET_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            assetParams(asset),
          );
          if (asset.sourceImageId !== null) {
            await transaction.run(
              `INSERT OR REPLACE INTO library_provider_image_assets (
                 image_id, plaintext_sha256, updated_at
               ) VALUES (?, ?, ?)`,
              [asset.sourceImageId, asset.plaintextSha256, asset.updatedAt],
            );
          }
          const committed: DeviceLibraryAsset = {
            ...asset,
            importClassification: asset.importClassification ?? 'unknown',
            importDeletedAt: asset.importDeletedAt ?? null,
          };
          return { status: 'committed' as const, asset: committed };
        });
      } catch (error) {
        throw databaseError(error);
      }
    },

    async recordProviderImageDigest(imageId, plaintextSha256, at) {
      try {
        await database.run(
          `INSERT OR REPLACE INTO library_provider_image_assets (
             image_id, plaintext_sha256, updated_at
           ) VALUES (?, ?, ?)`,
          [imageId, plaintextSha256, at],
        );
      } catch (error) {
        throw databaseError(error);
      }
    },

    async inspectDigestMembership(plaintextSha256, accountScope) {
      try {
        const asset = await findLocalIn(database, plaintextSha256);
        const deviceTrash = await database.getFirst<{ trashed: number }>(
          `SELECT 1 AS trashed FROM library_device_asset_state
            WHERE plaintext_sha256 = ? AND device_trashed_at IS NOT NULL
            LIMIT 1`,
          [plaintextSha256],
        );
        const protectionTrash = accountScope === null
          ? null
          : await database.getFirst<{ non_active: number }>(
            `SELECT 1 AS non_active FROM library_asset_protection
              WHERE account_scope = ? AND plaintext_sha256 = ?
                AND lifecycle <> 'active'
              LIMIT 1`,
            [accountScope, plaintextSha256],
          );
        const isDeviceActive =
          asset !== null
          && deviceTrash === null
          && protectionTrash === null;
        const hasActiveImportMember =
          isDeviceActive
          && asset.origin === 'import'
          && (asset.importDeletedAt ?? null) === null;
        const providerRow = await database.getFirst<{ active_provider: number }>(
          `SELECT 1 AS active_provider
             FROM images i
            WHERE i.decision = 'saved'
              AND (
                EXISTS (
                  SELECT 1 FROM device_library_assets a
                   WHERE a.plaintext_sha256 = ? AND a.source_image_id = i.id
                )
                OR EXISTS (
                  SELECT 1 FROM library_provider_image_assets m
                   WHERE m.plaintext_sha256 = ? AND m.image_id = i.id
                )
              )
            LIMIT 1`,
          [plaintextSha256, plaintextSha256],
        );
        const hasActiveProviderMember = providerRow !== null;

        let hasActiveCloudIdentity = false;
        if (accountScope !== null) {
          const cloudRow = await database.getFirst<{ active_cloud: number }>(
            `SELECT 1 AS active_cloud
               FROM library_account_assets aa
               LEFT JOIN library_asset_protection p
                 ON p.account_scope = aa.account_scope AND p.asset_id = aa.asset_id
              WHERE aa.account_scope = ? AND aa.plaintext_sha256 = ?
                AND (p.lifecycle IS NULL OR p.lifecycle = 'active')
              LIMIT 1`,
            [accountScope, plaintextSha256],
          );
          hasActiveCloudIdentity = cloudRow !== null;
        } else {
          const anyCloudRow = await database.getFirst<{ active_cloud: number }>(
            `SELECT 1 AS active_cloud
               FROM library_account_assets aa
               LEFT JOIN library_asset_protection p
                 ON p.account_scope = aa.account_scope AND p.asset_id = aa.asset_id
              WHERE aa.plaintext_sha256 = ?
                AND (p.lifecycle IS NULL OR p.lifecycle = 'active')
              LIMIT 1`,
            [plaintextSha256],
          );
          hasActiveCloudIdentity = anyCloudRow !== null;
        }

        return {
          asset,
          hasActiveImportMember,
          hasActiveProviderMember,
          hasActiveCloudIdentity,
        };
      } catch (error) {
        throw databaseError(error);
      }
    },

    async commitOrReactivateImportAsset({ asset, overwriteExistingRow }) {
      try {
        return await database.transaction(async (transaction) => {
          const existing = await findLocalIn(
            transaction,
            asset.plaintextSha256,
          );
          const providerRow = await transaction.getFirst<{ active_provider: number }>(
            `SELECT 1 AS active_provider
               FROM images i
              WHERE i.decision = 'saved'
                AND (
                  EXISTS (
                    SELECT 1 FROM device_library_assets a
                     WHERE a.plaintext_sha256 = ? AND a.source_image_id = i.id
                  )
                  OR EXISTS (
                    SELECT 1 FROM library_provider_image_assets m
                     WHERE m.plaintext_sha256 = ? AND m.image_id = i.id
                  )
                )
              LIMIT 1`,
            [asset.plaintextSha256, asset.plaintextSha256],
          );
          const deviceTrash = await transaction.getFirst<{ trashed: number }>(
            `SELECT 1 AS trashed FROM library_device_asset_state
              WHERE plaintext_sha256 = ? AND device_trashed_at IS NOT NULL
              LIMIT 1`,
            [asset.plaintextSha256],
          );
          const activeImport =
            existing !== null
            && deviceTrash === null
            && existing.origin === 'import'
            && (existing.importDeletedAt ?? null) === null;
          if (activeImport || providerRow !== null) {
            if (existing !== null) {
              return { status: 'duplicate' as const, asset: existing };
            }
          }
          if (existing !== null && !overwriteExistingRow) {
            return { status: 'duplicate' as const, asset: existing };
          }
          if (existing !== null && overwriteExistingRow) {
            await transaction.run(
              `UPDATE device_library_assets
                  SET origin = ?,
                      source_image_id = ?,
                      local_original_uri = ?,
                      residency = 'local-original',
                      protect_eligible = ?,
                      missing_original_since = NULL,
                      import_classification = ?,
                      import_deleted_at = NULL,
                      created_at = ?,
                      updated_at = ?
                WHERE plaintext_sha256 = ?`,
              [
                asset.origin,
                asset.sourceImageId,
                asset.localOriginalUri,
                asset.protectEligible ? 1 : 0,
                asset.importClassification ?? 'unknown',
                asset.createdAt,
                asset.updatedAt,
                asset.plaintextSha256,
              ],
            );
            await transaction.run(
              `DELETE FROM library_device_asset_state WHERE plaintext_sha256 = ?`,
              [asset.plaintextSha256],
            );
            if (asset.sourceImageId !== null) {
              await transaction.run(
                `INSERT OR REPLACE INTO library_provider_image_assets (
                   image_id, plaintext_sha256, updated_at
                 ) VALUES (?, ?, ?)`,
                [asset.sourceImageId, asset.plaintextSha256, asset.updatedAt],
              );
            }
            const updated = await findLocalIn(transaction, asset.plaintextSha256);
            return {
              status: 'committed' as const,
              asset: updated ?? {
                ...asset,
                importClassification: asset.importClassification ?? 'unknown',
                importDeletedAt: null,
              },
            };
          }
          await transaction.run(
            `INSERT INTO device_library_assets (${ASSET_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            assetParams(asset),
          );
          if (asset.sourceImageId !== null) {
            await transaction.run(
              `INSERT OR REPLACE INTO library_provider_image_assets (
                 image_id, plaintext_sha256, updated_at
               ) VALUES (?, ?, ?)`,
              [asset.sourceImageId, asset.plaintextSha256, asset.updatedAt],
            );
          }
          const committed: DeviceLibraryAsset = {
            ...asset,
            importClassification: asset.importClassification ?? 'unknown',
            importDeletedAt: asset.importDeletedAt ?? null,
          };
          return { status: 'committed' as const, asset: committed };
        });
      } catch (error) {
        throw databaseError(error);
      }
    },

    async applyCrossDeviceCollisionAuthority({
      plaintextSha256,
      origin,
      sourceImageId,
      importClassification,
      collectedAt,
      at,
    }) {
      try {
        return await database.transaction(async (transaction) => {
          const existing = await findLocalIn(transaction, plaintextSha256);
          if (existing === null) return null;
          if (origin === 'provider') {
            // Local import loses to cloud provider record: the picture becomes
            // the provider save with cloud source/rating and original time; its
            // import membership ends.
            const linkedImageId = sourceImageId ?? existing.sourceImageId;
            await transaction.run(
              `UPDATE device_library_assets
                  SET origin = 'provider',
                      source_image_id = ?,
                      import_classification = 'unknown',
                      created_at = ?,
                      updated_at = ?
                WHERE plaintext_sha256 = ?`,
              [linkedImageId, collectedAt, at, plaintextSha256],
            );
            if (linkedImageId !== null) {
              await transaction.run(
                `INSERT OR REPLACE INTO library_provider_image_assets (
                   image_id, plaintext_sha256, updated_at
                 ) VALUES (?, ?, ?)`,
                [linkedImageId, plaintextSha256, at],
              );
            }
          } else {
            // Local provider save loses to cloud import record: the digest row
            // takes the import's classification and original time, with no
            // provider source attached to the import (`source_image_id = NULL`),
            // while this phone retains its own saved `images` member in
            // `library_provider_image_assets`.
            if (existing.sourceImageId !== null) {
              await transaction.run(
                `INSERT OR REPLACE INTO library_provider_image_assets (
                   image_id, plaintext_sha256, updated_at
                 ) VALUES (?, ?, ?)`,
                [existing.sourceImageId, plaintextSha256, at],
              );
            }
            await transaction.run(
              `UPDATE device_library_assets
                  SET origin = 'import',
                      source_image_id = NULL,
                      import_classification = ?,
                      created_at = ?,
                      updated_at = ?
                WHERE plaintext_sha256 = ?`,
              [importClassification, collectedAt, at, plaintextSha256],
            );
          }
          return await findLocalIn(transaction, plaintextSha256);
        });
      } catch (error) {
        throw databaseError(error);
      }
    },

    async adoptLocalOriginal({ plaintextSha256, localOriginalUri, at }) {
      try {
        return await database.transaction(async (transaction) => {
          const result = await transaction.run(
            `UPDATE device_library_assets
                SET local_original_uri = ?, residency = 'local-original',
                    missing_original_since = NULL, updated_at = ?
              WHERE plaintext_sha256 = ? AND residency <> 'cached'`,
            [localOriginalUri, at, plaintextSha256],
          );
          if (result.changes !== 1) return null;
          return await findLocalIn(transaction, plaintextSha256);
        });
      } catch (error) {
        throw databaseError(error);
      }
    },

    async setLocalThumbnail(plaintextSha256, uri) {
      try {
        const result = await database.run(
          'UPDATE device_library_assets SET local_thumbnail_uri = ? WHERE plaintext_sha256 = ?',
          [uri, plaintextSha256],
        );
        return result.changes === 1;
      } catch (error) {
        throw databaseError(error);
      }
    },

    async findAccountAsset(accountScope, plaintextSha256) {
      try {
        return await findAccountIn(database, accountScope, plaintextSha256);
      } catch (error) {
        throw databaseError(error);
      }
    },

    async listLocalAssetsMissingEnrollment(accountScope) {
      try {
        const rows = await database.getAll<AssetRow>(
          `SELECT ${ASSET_COLUMNS} FROM device_library_assets
           WHERE plaintext_sha256 NOT IN (
             SELECT plaintext_sha256 FROM library_account_assets
             WHERE account_scope = ?
           )
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
           ORDER BY created_at ASC, plaintext_sha256 ASC`,
          [accountScope],
        );
        return rows.map(toAsset);
      } catch (error) {
        throw databaseError(error);
      }
    },

    async commitCollect({
      accountScope,
      assetId,
      plaintextSha256,
      deviceId,
      mutationId,
      metadata,
      at,
    }) {
      try {
        return await database.transaction(async (transaction) => {
          const existing = await findAccountIn(
            transaction,
            accountScope,
            plaintextSha256,
          );
          if (existing !== null) {
            // K6-3a: enrolled, but is the intent still there? A `collect`
            // intent is what lets `library-protect-action.ts` create the asset
            // remotely; without it `ensureCollected` records the terminal
            // `object_missing` and the image is re-read, re-sealed and
            // re-failed every round forever. Restoring it is the repair, and
            // it belongs here because this transaction owns both halves. The
            // enrolment row is deliberately left alone: it records when and by
            // which device the asset really entered the account.
            const intent = await transaction.getFirst<{ mutation_id: string }>(
              `SELECT mutation_id FROM library_outbox
                WHERE account_scope = ? AND asset_id = ? AND kind = 'collect'`,
              [accountScope, existing.assetId],
            );
            if (intent === null) {
              await transaction.run(
                `INSERT INTO library_outbox (${OUTBOX_COLUMNS}, encrypted_payload)
                 VALUES (?, ?, ?, ?, 'collect', NULL, NULL, 'pending', 0, NULL,
                   NULL, ?, ?, ?, NULL)`,
                [
                  mutationId,
                  accountScope,
                  existing.deviceId,
                  existing.assetId,
                  JSON.stringify(metadata),
                  at,
                  at,
                ],
              );
            }
            return { status: 'duplicate' as const, accountAsset: existing };
          }

          const accountAsset: LibraryAccountAsset = {
            accountScope,
            assetId,
            plaintextSha256,
            deviceId,
            enrolledAt: at,
            updatedAt: at,
          };
          await transaction.run(
            `INSERT INTO library_account_assets (${ACCOUNT_ASSET_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?)`,
            [accountScope, assetId, plaintextSha256, deviceId, at, at],
          );
          await transaction.run(
            `INSERT INTO library_outbox (${OUTBOX_COLUMNS}, encrypted_payload)
             VALUES (?, ?, ?, ?, 'collect', NULL, NULL, 'pending', 0, NULL,
               NULL, ?, ?, ?, NULL)`,
            [
              mutationId,
              accountScope,
              deviceId,
              assetId,
              JSON.stringify(metadata),
              at,
              at,
            ],
          );
          return { status: 'committed' as const, accountAsset };
        });
      } catch (error) {
        throw databaseError(error);
      }
    },

    async listOutbox(accountScope) {
      try {
        const rows = await database.getAll<OutboxRow>(
          `SELECT ${OUTBOX_COLUMNS} FROM library_outbox
           WHERE account_scope = ?
           ORDER BY created_at ASC, mutation_id ASC`,
          [accountScope],
        );
        return rows.map(toOutboxEntry);
      } catch (error) {
        throw databaseError(error);
      }
    },
  };
}
