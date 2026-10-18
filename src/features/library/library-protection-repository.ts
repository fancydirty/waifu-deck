import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibraryDeviceAssetState,
  LibraryFailureCategory,
  LibraryLifecycle,
  LibraryObjectRole,
  LibraryProtection,
  LibraryProtectionRecord,
} from '@/features/library/library-actions-types';
import type { LibraryResidency } from '@/features/library/library-types';

export type LibraryProtectionUpsert = Readonly<{
  accountScope: string;
  assetId: string;
  plaintextSha256: string;
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
  generation: number;
  revision: number | null;
  originalGenerationId: string | null;
  originalCiphertextBytes: number | null;
  thumbnailGenerationId: string | null;
  previewGenerationId: string | null;
  verifiedAt: number | null;
  failureCategory: LibraryFailureCategory | null;
  trashedAt: number | null;
  appliedStateKey?: string | null;
}>;

/** One-shot pending → protected promotion with device verification. */
export type LibraryProtectionVerified = Readonly<{
  accountScope: string;
  assetId: string;
  plaintextSha256: string;
  lifecycle: LibraryLifecycle;
  generation: number;
  revision: number | null;
  originalGenerationId: string;
  originalCiphertextBytes: number | null;
  thumbnailGenerationId: string | null;
  previewGenerationId: string | null;
  verifiedAt: number;
  appliedStateKey?: string | null;
}>;

/** Conditional verification of a committed row read before a concurrent gap. */
export type LibraryCommittedVerification = Readonly<{
  accountScope: string;
  assetId: string;
  plaintextSha256: string;
  protection: LibraryProtection;
  lifecycle: LibraryLifecycle;
  generation: number;
  revision: number | null;
  originalGenerationId: string;
  at: number;
}>;

export type LibraryMirrorCounts = Readonly<{
  /** Local originals already uploaded to the bucket. */
  backedUp: number;
  /** Local originals that are eligible to upload, uploaded or not. */
  backedUpTotal: number;
  /** Protected assets whose original is present on this device. */
  downloaded: number;
  /** Protected assets that should end up present on this device. */
  downloadedTotal: number;
  /** Board #27 S3 (spec §5.15): protected, active assets whose original is not on this phone. */
  inCloud: number;
  /** Their plaintext bytes: what switching back to 本地+云端 downloads (spec §5.13). */
  inCloudBytes: number;
  /** Spec §5.15: uploads still to go (`backedUpTotal − backedUp`). */
  pending: number;
  /**
   * N4 cloud card 原图大小 (spec §4.2): the plaintext bytes of the whole
   * `downloadedTotal` pool, not just its not-downloaded subset. Eligibility
   * and missing-local presence deliberately do not filter it.
   */
  totalBytes: number;
}>;

export type LibraryProtectionRepository = Readonly<{
  findByAssetId(
    accountScope: string,
    assetId: string,
  ): Promise<LibraryProtectionRecord | null>;
  findByDigest(
    accountScope: string,
    plaintextSha256: string,
  ): Promise<LibraryProtectionRecord | null>;
  upsertProtection(input: LibraryProtectionUpsert): Promise<void>;
  /**
   * Atomically moves the account projection to `protected` with `verifiedAt`
   * set and records device verification. Callers must not write
   * `protected` + `verifiedAt = null` as a separate step first.
   */
  markProtectedAndVerified(input: LibraryProtectionVerified): Promise<void>;
  /**
   * Marks a resumed/adopted commit verified only if the row still matches the
   * generation this device read; a projection or local action may have changed
   * it since then, so verification is only true of that exact generation.
   */
  markCommittedVerified(input: LibraryCommittedVerification): Promise<boolean>;
  markVerified(
    accountScope: string,
    assetId: string,
    plaintextSha256: string,
    at: number,
  ): Promise<void>;
  markFailure(
    accountScope: string,
    assetId: string,
    category: LibraryFailureCategory,
  ): Promise<void>;
  setResidency(
    plaintextSha256: string,
    residency: LibraryResidency,
    localOriginalUri: string | null,
  ): Promise<void>;
  readDeviceState(
    plaintextSha256: string,
  ): Promise<LibraryDeviceAssetState | null>;
  setCachedRoles(
    plaintextSha256: string,
    roles: readonly LibraryObjectRole[],
  ): Promise<void>;
  setDeviceTrash(
    plaintextSha256: string,
    uri: string | null,
    at: number | null,
  ): Promise<void>;
  /**
   * Records an explicit Photos export so remove-device-data may treat the
   * durable original as export-cleared (`exported_at`).
   */
  markExported(plaintextSha256: string, at: number): Promise<void>;
  /**
   * C4a settings surface: the mirror's durable state as four counts, not a
   * batch snapshot. After C1/C2a nothing is user-started, so a count of rows
   * is the only honest description and it survives process restart with no
   * recovery machinery.
   *
   * `downloaded` counts assets whose original is present locally. A flagged
   * local original is not present, so it stays out of `downloaded` and in the
   * total until the re-download lands. The total also adds those still
   * cloud-only. A device-trashed asset is residency `cached` and appears in
   * neither, matching `listDownloadCandidates` — counting it would leave the
   * fraction permanently short of its total.
   */
  countMirrorState(accountScope: string): Promise<LibraryMirrorCounts>;
  /**
   * Count of rows in one failure category for an account scope. WHY: the
   * settings status line (Task 10b) needs the halted `quota_full` count
   * without re-deriving the upload/download pool eligibility rules that
   * `countMirrorState` encodes.
   */
  countFailureCategory(
    accountScope: string,
    category: LibraryFailureCategory,
  ): Promise<number>;
  listProtectCandidates(accountScope: string): Promise<readonly string[]>;
  listDownloadCandidates(accountScope: string): Promise<readonly string[]>;
  listFreeCandidates(accountScope: string): Promise<readonly string[]>;
  /** Digests currently in the account's trash, oldest-trashed first. */
  listTrashCandidates(accountScope: string): Promise<readonly string[]>;
}>;

export type LibraryProtectionRepositoryDependencies = Readonly<{
  database: SqlDatabasePort;
  clock?: () => number;
}>;

type ProtectionRow = {
  account_scope: string;
  asset_id: string;
  plaintext_sha256: string;
  lifecycle: string;
  protection: string;
  generation: number;
  revision: number | null;
  original_generation_id: string | null;
  original_ciphertext_bytes: number | null;
  thumbnail_generation_id: string | null;
  preview_generation_id: string | null;
  object_refs_revision: number | null;
  applied_state_key: string | null;
  verified_at: number | null;
  failure_category: string | null;
  trashed_at: number | null;
  updated_at: number;
};

type DeviceStateRow = {
  plaintext_sha256: string;
  cached_roles_json: string;
  last_verified_at: number | null;
  device_trash_uri: string | null;
  device_trashed_at: number | null;
  exported_at: number | null;
  updated_at: number;
};

/** Full projection columns for reads, including sweep-owned `object_refs_revision` and N6-A3 `applied_state_key`. */
const PROTECTION_COLUMNS = `
  account_scope, asset_id, plaintext_sha256, lifecycle, protection, generation,
  revision, original_generation_id, original_ciphertext_bytes,
  thumbnail_generation_id, preview_generation_id, object_refs_revision,
  applied_state_key, verified_at, failure_category, trashed_at, updated_at
`;

/**
 * Write columns for `upsertProtection` / `markProtectedAndVerified`. Excludes
 * `object_refs_revision` — only the Task 6 index sweep owns that column.
 */
const PROTECTION_WRITE_COLUMNS = `
  account_scope, asset_id, plaintext_sha256, lifecycle, protection, generation,
  revision, original_generation_id, original_ciphertext_bytes,
  thumbnail_generation_id, preview_generation_id, applied_state_key,
  verified_at, failure_category, trashed_at, updated_at
`;

const DEVICE_STATE_COLUMNS = `
  plaintext_sha256, cached_roles_json, last_verified_at, device_trash_uri,
  device_trashed_at, updated_at
`;

/**
 * K7 ①: failure categories after which another automatic attempt cannot
 * succeed. Such a row used to come back as a candidate on every single round:
 * re-read, re-sealed, failed the same way, and the round reported non-clean,
 * which armed an immediate retry of the whole round.
 *
 * - `integrity` — the bytes do not hash to their name; re-sending them fails
 *   identically.
 * - `unsupported_image` — protect returns this for an ineligible (oversize)
 *   original, which no retry changes.
 * - `auth_attention` — the session needs the user; `protectOnce` already
 *   short-circuits this one rather than burning battery on it.
 * - `quota_full` — board #12 (spec §4): the cloud drive is full. Only the user
 *   can clear it, so `protectOnce` short-circuits it through the same
 *   `PROTECT_SHORT_CIRCUIT` set as `auth_attention`, and every retry it would
 *   otherwise spend is a request that cannot succeed.
 *
 * `retryable_transfer` / `offline` / `local_space` / `stale_client` are
 * transient and stay in the pools. A row recovers the moment anything clears
 * `failure_category` — `markProtectedAndVerified` and the remote projection in
 * `library-sync-apply` both set it back to NULL.
 *
 * Exported because this list IS the contract: its parity test used to hand-copy
 * the same categories into a second literal, so the two could drift silently
 * whenever a new category was added on one side only. The SQL fragment below is
 * generated from this array, which makes that drift impossible.
 */
export const UPLOAD_TERMINAL_CATEGORIES: readonly LibraryFailureCategory[] = [
  'integrity',
  'unsupported_image',
  'auth_attention',
  'quota_full',
];

/** Renders a category list as the SQL `IN (...)` body the predicates take. */
const toSqlList = (
  categories: readonly LibraryFailureCategory[],
): string => categories.map((category) => `'${category}'`).join(', ');

const UPLOAD_TERMINAL = toSqlList(UPLOAD_TERMINAL_CATEGORIES);

/**
 * The download pool adds `object_missing`: there, it means the cloud original
 * blob is gone and nothing on this device can bring it back.
 *
 * The upload pool deliberately does NOT exclude `object_missing`. On that side
 * the category can also mean "this account's `collect` intent is missing",
 * which K6-3a's `reenroll` rebuilds from local state, and the K1 backfill gate
 * (`byos-assembled-upload.integration.test.ts`) pins that such a row must
 * still upload. A protect candidate whose local original is genuinely gone is
 * already excluded by the `local_original_uri` / `missing_original_since`
 * predicates below, so nothing unrecoverable survives here.
 */
export const DOWNLOAD_TERMINAL_CATEGORIES: readonly LibraryFailureCategory[] = [
  ...UPLOAD_TERMINAL_CATEGORIES,
  'object_missing',
];

const DOWNLOAD_TERMINAL = toSqlList(DOWNLOAD_TERMINAL_CATEGORIES);

const notTerminallyFailed = (terminal: string): string => `(
  p.failure_category IS NULL
  OR p.failure_category NOT IN (${terminal})
)`;

function toRecord(row: ProtectionRow): LibraryProtectionRecord {
  return {
    accountScope: row.account_scope,
    assetId: row.asset_id,
    plaintextSha256: row.plaintext_sha256,
    lifecycle: row.lifecycle as LibraryLifecycle,
    protection: row.protection as LibraryProtection,
    generation: row.generation,
    revision: row.revision,
    originalGenerationId: row.original_generation_id,
    originalCiphertextBytes: row.original_ciphertext_bytes,
    thumbnailGenerationId: row.thumbnail_generation_id,
    previewGenerationId: row.preview_generation_id,
    objectRefsRevision: row.object_refs_revision,
    appliedStateKey: row.applied_state_key ?? null,
    verifiedAt: row.verified_at,
    failureCategory: row.failure_category as LibraryFailureCategory | null,
    trashedAt: row.trashed_at,
    updatedAt: row.updated_at,
  };
}

function toDeviceState(row: DeviceStateRow): LibraryDeviceAssetState {
  return {
    plaintextSha256: row.plaintext_sha256,
    cachedRoles: JSON.parse(row.cached_roles_json) as LibraryObjectRole[],
    lastVerifiedAt: row.last_verified_at,
    deviceTrashUri: row.device_trash_uri,
    deviceTrashedAt: row.device_trashed_at,
    exportedAt: row.exported_at ?? null,
    updatedAt: row.updated_at,
  };
}

export function createLibraryProtectionRepository({
  database,
  clock = Date.now,
}: LibraryProtectionRepositoryDependencies): LibraryProtectionRepository {
  const ensureDeviceState = async (
    plaintextSha256: string,
    at: number,
  ): Promise<void> => {
    await database.run(
      `INSERT INTO library_device_asset_state (${DEVICE_STATE_COLUMNS})
       VALUES (?, '[]', NULL, NULL, NULL, ?)
       ON CONFLICT(plaintext_sha256) DO NOTHING`,
      [plaintextSha256, at],
    );
  };

  return {
    async findByAssetId(accountScope, assetId) {
      const row = await database.getFirst<ProtectionRow>(
        `SELECT ${PROTECTION_COLUMNS} FROM library_asset_protection
         WHERE account_scope = ? AND asset_id = ?`,
        [accountScope, assetId],
      );
      return row === null ? null : toRecord(row);
    },

    async findByDigest(accountScope, plaintextSha256) {
      const row = await database.getFirst<ProtectionRow>(
        `SELECT ${PROTECTION_COLUMNS} FROM library_asset_protection
         WHERE account_scope = ? AND plaintext_sha256 = ?`,
        [accountScope, plaintextSha256],
      );
      return row === null ? null : toRecord(row);
    },

    async upsertProtection(input) {
      const at = clock();
      await database.run(
        `INSERT INTO library_asset_protection (${PROTECTION_WRITE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_scope, asset_id) DO UPDATE SET
           plaintext_sha256 = excluded.plaintext_sha256,
           lifecycle = excluded.lifecycle,
           protection = excluded.protection,
           generation = excluded.generation,
           revision = excluded.revision,
           original_generation_id = excluded.original_generation_id,
           original_ciphertext_bytes = excluded.original_ciphertext_bytes,
           thumbnail_generation_id = excluded.thumbnail_generation_id,
           preview_generation_id = excluded.preview_generation_id,
           applied_state_key = COALESCE(excluded.applied_state_key, library_asset_protection.applied_state_key),
           verified_at = excluded.verified_at,
           failure_category = excluded.failure_category,
           trashed_at = excluded.trashed_at,
           updated_at = excluded.updated_at`,
        [
          input.accountScope,
          input.assetId,
          input.plaintextSha256,
          input.lifecycle,
          input.protection,
          input.generation,
          input.revision,
          input.originalGenerationId,
          input.originalCiphertextBytes,
          input.thumbnailGenerationId,
          input.previewGenerationId,
          input.appliedStateKey ?? null,
          input.verifiedAt,
          input.failureCategory,
          input.trashedAt,
          at,
        ],
      );
    },

    async markProtectedAndVerified(input) {
      const at = input.verifiedAt;
      await database.transaction(async (transaction) => {
        // One UPDATE sets protection and verifiedAt together so a process stop
        // cannot leave a durable `protected` row with verifiedAt = null.
        await transaction.run(
          `INSERT INTO library_asset_protection (${PROTECTION_WRITE_COLUMNS})
           VALUES (?, ?, ?, ?, 'protected', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
           ON CONFLICT(account_scope, asset_id) DO UPDATE SET
             plaintext_sha256 = excluded.plaintext_sha256,
             lifecycle = excluded.lifecycle,
             protection = 'protected',
             generation = excluded.generation,
             revision = excluded.revision,
             original_generation_id = excluded.original_generation_id,
             original_ciphertext_bytes = excluded.original_ciphertext_bytes,
             thumbnail_generation_id = excluded.thumbnail_generation_id,
             preview_generation_id = excluded.preview_generation_id,
             applied_state_key = COALESCE(excluded.applied_state_key, library_asset_protection.applied_state_key),
             verified_at = excluded.verified_at,
             failure_category = NULL,
             trashed_at = NULL,
             updated_at = excluded.updated_at`,
          [
            input.accountScope,
            input.assetId,
            input.plaintextSha256,
            input.lifecycle,
            input.generation,
            input.revision,
            input.originalGenerationId,
            input.originalCiphertextBytes,
            input.thumbnailGenerationId,
            input.previewGenerationId,
            input.appliedStateKey ?? null,
            at,
            at,
          ],
        );
        await transaction.run(
          `INSERT INTO library_device_asset_state (${DEVICE_STATE_COLUMNS})
           VALUES (?, '[]', ?, NULL, NULL, ?)
           ON CONFLICT(plaintext_sha256) DO UPDATE SET
             last_verified_at = excluded.last_verified_at,
             updated_at = excluded.updated_at`,
          [input.plaintextSha256, at, at],
        );
      });
    },

    async markCommittedVerified(input) {
      return database.transaction(async (transaction) => {
        const result = await transaction.run(
          `UPDATE library_asset_protection
              SET protection = 'protected', verified_at = ?,
                  failure_category = NULL, trashed_at = NULL, updated_at = ?
            WHERE account_scope = ? AND asset_id = ?
              AND protection = ? AND lifecycle = ? AND generation = ?
              AND revision IS ? AND original_generation_id = ?
              AND verified_at IS NULL`,
          [
            input.at,
            input.at,
            input.accountScope,
            input.assetId,
            input.protection,
            input.lifecycle,
            input.generation,
            input.revision,
            input.originalGenerationId,
          ],
        );
        if (result.changes !== 1) return false;
        await transaction.run(
          `INSERT INTO library_device_asset_state (${DEVICE_STATE_COLUMNS})
           VALUES (?, '[]', ?, NULL, NULL, ?)
           ON CONFLICT(plaintext_sha256) DO UPDATE SET
             last_verified_at = excluded.last_verified_at,
             updated_at = excluded.updated_at`,
          [input.plaintextSha256, input.at, input.at],
        );
        return true;
      });
    },

    async markVerified(accountScope, assetId, plaintextSha256, at) {
      await database.transaction(async (transaction) => {
        await transaction.run(
          `UPDATE library_asset_protection
              SET verified_at = ?, failure_category = NULL, updated_at = ?
            WHERE account_scope = ? AND asset_id = ?`,
          [at, at, accountScope, assetId],
        );
        await transaction.run(
          `INSERT INTO library_device_asset_state (${DEVICE_STATE_COLUMNS})
           VALUES (?, '[]', ?, NULL, NULL, ?)
           ON CONFLICT(plaintext_sha256) DO UPDATE SET
             last_verified_at = excluded.last_verified_at,
             updated_at = excluded.updated_at`,
          [plaintextSha256, at, at],
        );
      });
    },

    async markFailure(accountScope, assetId, category) {
      const at = clock();
      // Protection never advances on failure, and `verified_at` is cleared so
      // no later action can treat an unverified copy as evictable.
      await database.run(
        `UPDATE library_asset_protection
            SET protection = CASE WHEN protection = 'protected'
                  THEN 'protected' ELSE 'failed' END,
                failure_category = ?, verified_at = NULL, updated_at = ?
          WHERE account_scope = ? AND asset_id = ?`,
        [category, at, accountScope, assetId],
      );
    },

    async setResidency(plaintextSha256, residency, localOriginalUri) {
      const at = clock();
      // A residency write states where the bytes are now.
      await database.run(
        `UPDATE device_library_assets
            SET residency = ?, local_original_uri = ?,
                missing_original_since = NULL, updated_at = ?
          WHERE plaintext_sha256 = ?`,
        [residency, localOriginalUri, at, plaintextSha256],
      );
    },

    async readDeviceState(plaintextSha256) {
      const row = await database.getFirst<DeviceStateRow>(
        `SELECT ${DEVICE_STATE_COLUMNS}, exported_at
           FROM library_device_asset_state
          WHERE plaintext_sha256 = ?`,
        [plaintextSha256],
      );
      return row === null ? null : toDeviceState(row);
    },

    async markExported(plaintextSha256, at) {
      await ensureDeviceState(plaintextSha256, at);
      await database.run(
        `UPDATE library_device_asset_state
            SET exported_at = ?, updated_at = ?
          WHERE plaintext_sha256 = ?`,
        [at, at, plaintextSha256],
      );
    },

    async setCachedRoles(plaintextSha256, roles) {
      const at = clock();
      await ensureDeviceState(plaintextSha256, at);
      await database.run(
        `UPDATE library_device_asset_state
            SET cached_roles_json = ?, updated_at = ?
          WHERE plaintext_sha256 = ?`,
        [JSON.stringify([...roles]), at, plaintextSha256],
      );
    },

    async setDeviceTrash(plaintextSha256, uri, trashedAt) {
      const at = clock();
      await ensureDeviceState(plaintextSha256, at);
      await database.run(
        `UPDATE library_device_asset_state
            SET device_trash_uri = ?, device_trashed_at = ?, updated_at = ?
          WHERE plaintext_sha256 = ?`,
        [uri, trashedAt, at, plaintextSha256],
      );
    },

    async listProtectCandidates(accountScope) {
      const rows = await database.getAll<{ plaintext_sha256: string }>(
        `SELECT a.plaintext_sha256 FROM device_library_assets a
           LEFT JOIN library_asset_protection p
             ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
           LEFT JOIN library_device_asset_state d
             ON d.plaintext_sha256 = a.plaintext_sha256
          WHERE a.local_original_uri IS NOT NULL
            AND a.missing_original_since IS NULL
            AND a.protect_eligible = 1
            AND a.residency = 'local-original'
            AND (d.device_trashed_at IS NULL)
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
            -- A protected projection adopted from the account still needs this
            -- device's verification stamp, and its committed original
            -- generation is the evidence trusted by the resume path.
            AND (
              (p.protection IS NULL OR p.protection <> 'protected')
              OR (p.protection = 'protected'
                  AND p.original_generation_id IS NOT NULL
                  AND p.verified_at IS NULL)
            )
            AND (p.lifecycle IS NULL OR p.lifecycle = 'active')
            AND ${notTerminallyFailed(UPLOAD_TERMINAL)}
          ORDER BY a.created_at ASC, a.plaintext_sha256 ASC`,
        [accountScope],
      );
      return rows.map((row) => row.plaintext_sha256);
    },

    async countMirrorState(accountScope) {
      // Each half repeats its own pool's WHERE clause with the "not yet done"
      // clause dropped. The upload count intentionally treats an adopted
      // protected row as already backed up even while this device's
      // verification stamp is still NULL, so that row may remain in
      // `listProtectCandidates` without increasing the settings denominator.
      // Keeping the two halves as separate queries is deliberate: the pools
      // genuinely disagree about `protect_eligible` and about whether a NULL
      // lifecycle counts, so a single shared WHERE cannot serve both without
      // silently excluding rows one pool does drain.
      //
      // Anything looser turns the settings line into a fraction the user
      // watches never finish. An asset whose original went missing keeps
      // residency 'local-original' while the upload pool skips it forever;
      // an oversize cloud-only asset carries protect_eligible = 0 while the
      // download pool fetches it anyway.
      const uploaded = await database.getFirst<{ done: number; total: number }>(
        // Mirrors the local-original upload pool, counting every protected
        // account projection as backed up (including an adopted row whose
        // local verification stamp is still NULL).
        `SELECT
           COUNT(CASE WHEN p.protection = 'protected' THEN 1 END) AS done,
           COUNT(*) AS total
         FROM device_library_assets a
         LEFT JOIN library_asset_protection p
           ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
         LEFT JOIN library_device_asset_state d
           ON d.plaintext_sha256 = a.plaintext_sha256
        WHERE a.local_original_uri IS NOT NULL
          AND a.missing_original_since IS NULL
          AND a.protect_eligible = 1
          AND a.residency = 'local-original'
          AND d.device_trashed_at IS NULL
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
          AND (p.lifecycle IS NULL OR p.lifecycle = 'active')`,
        [accountScope],
      );
      const pulled = await database.getFirst<{
        done: number;
        total: number;
        total_bytes: number;
        in_cloud_bytes: number;
      }>(
        // A flagged local original is still in this pool (it needs a
        // re-download), so it counts in `total` and not in `done`.
        // `total_bytes` sums the unchanged pool — eligibility and
        // missing-local presence must not filter it (spec §4.2 原图大小).
        `SELECT
           COUNT(CASE WHEN a.residency = 'local-original'
             AND a.missing_original_since IS NULL THEN 1 END) AS done,
           COUNT(*) AS total,
           COALESCE(SUM(a.byte_size), 0) AS total_bytes,
           COALESCE(SUM(CASE WHEN NOT (a.residency = 'local-original'
             AND a.missing_original_since IS NULL) THEN a.byte_size END), 0)
             AS in_cloud_bytes
         FROM device_library_assets a
         JOIN library_asset_protection p
           ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
        WHERE a.residency IN ('local-original', 'cloud-only')
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
          AND p.protection = 'protected'
          AND p.lifecycle = 'active'
          AND p.original_generation_id IS NOT NULL`,
        [accountScope],
      );
      const backedUp = uploaded?.done ?? 0;
      const backedUpTotal = uploaded?.total ?? 0;
      const downloaded = pulled?.done ?? 0;
      const downloadedTotal = pulled?.total ?? 0;
      return {
        backedUp,
        backedUpTotal,
        downloaded,
        downloadedTotal,
        inCloud: downloadedTotal - downloaded,
        inCloudBytes: pulled?.in_cloud_bytes ?? 0,
        pending: backedUpTotal - backedUp,
        totalBytes: pulled?.total_bytes ?? 0,
      };
    },

    async countFailureCategory(accountScope, category) {
      // A plain count over every lifecycle. Honest today because the trash
      // path nulls `failure_category` (`library-account-actions.ts`), so a
      // trashed row cannot carry a halted category unless `markFailure` (no
      // lifecycle guard) re-stamps it after the trash — keep that invariant
      // if either side changes, or the status line over-counts.
      const row = await database.getFirst<{ n: number }>(
        `SELECT COUNT(*) AS n FROM library_asset_protection
         WHERE account_scope = ? AND failure_category = ?`,
        [accountScope, category],
      );
      return row?.n ?? 0;
    },

    async listDownloadCandidates(accountScope) {
      const rows = await database.getAll<{ plaintext_sha256: string }>(
        `SELECT a.plaintext_sha256 FROM device_library_assets a
           JOIN library_asset_protection p
             ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
          WHERE (a.residency = 'cloud-only'
              OR (a.residency = 'local-original' AND a.missing_original_since IS NOT NULL))
            AND p.protection = 'protected'
            AND p.lifecycle = 'active'
            AND p.original_generation_id IS NOT NULL
            AND ${notTerminallyFailed(DOWNLOAD_TERMINAL)}
          ORDER BY a.created_at ASC, a.plaintext_sha256 ASC`,
        [accountScope],
      );
      return rows.map((row) => row.plaintext_sha256);
    },

    async listFreeCandidates(accountScope) {
      const rows = await database.getAll<{ plaintext_sha256: string }>(
        `SELECT a.plaintext_sha256 FROM device_library_assets a
           JOIN library_asset_protection p
             ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
           LEFT JOIN library_device_asset_state d
             ON d.plaintext_sha256 = a.plaintext_sha256
          WHERE a.residency = 'local-original'
            AND a.local_original_uri IS NOT NULL
            AND a.missing_original_since IS NULL
            AND p.protection = 'protected'
            AND p.lifecycle = 'active'
            AND p.original_generation_id IS NOT NULL
            AND p.verified_at IS NOT NULL
            AND d.device_trashed_at IS NULL
          ORDER BY a.created_at ASC, a.plaintext_sha256 ASC`,
        [accountScope],
      );
      return rows.map((row) => row.plaintext_sha256);
    },

    async listTrashCandidates(accountScope) {
      // Unlike the other three candidate sets, this reads
      // `library_asset_protection` directly with no join to
      // `device_library_assets`: a trashed asset's account projection is the
      // authority for "still owes a permanent-delete", independent of
      // whether any local original file remains (it may already be
      // cloud-only or device-trashed).
      const rows = await database.getAll<{ plaintext_sha256: string }>(
        `SELECT plaintext_sha256 FROM library_asset_protection
          WHERE account_scope = ? AND lifecycle = 'trash'
          ORDER BY trashed_at ASC, plaintext_sha256 ASC`,
        [accountScope],
      );
      return rows.map((row) => row.plaintext_sha256);
    },
  };
}
