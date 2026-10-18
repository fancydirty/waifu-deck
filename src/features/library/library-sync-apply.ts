import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import {
  deriveLibraryAssetId,
  LIBRARY_ASSET_ID_PATTERN,
} from '@/features/library/library-identity';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import { parseNoteName } from '@/features/library/library-note-name';
import type { LibraryObjectCipher } from '@/features/library/library-object-crypto';
import { restoreCandidateFrom } from '@/features/library/library-restore-image';
import { resolveEnvelopeImportClassification } from '@/features/library/library-source-metadata';
import type { LibraryProjectedAsset } from '@/features/library/library-sync-types';
import type { LibraryImportClassification } from '@/features/library/library-types';
import type { ImageCandidate } from '@/features/waifu/types';

const FORMATS: readonly string[] = ['jpeg', 'png', 'webp', 'gif'];
const EXTENSIONS: readonly string[] = ['jpg', 'png', 'webp', 'gif'];
const ORIGINS: readonly string[] = ['provider', 'import'];

export type LibrarySyncApplyInput = Readonly<{
  accountScope: string;
  /** Enrolls the local digest→assetId mapping; never a `library_outbox` value. */
  deviceId: string;
  masterKey: Uint8Array;
  assets: readonly LibraryProjectedAsset[];
}>;

export type LibrarySyncApplyReport = Readonly<{
  projected: number;
  written: number;
  materialized: number;
  /** No metadata and no local digest mapping: there is nothing to forget. */
  skippedUnknownAsset: number;
  skippedIntegrity: number;
  /**
   * N6-A3 (spec §4.3): assetIds whose envelope validation or Phase 3 provider
   * rebuild failed after discovery indexed them, so the caller can invalidate
   * their index entry and keep them retryable on the next cycle.
   */
  failedAssetIds?: readonly string[];
}>;

export type LibrarySyncApplyWriter = Readonly<{
  apply(input: LibrarySyncApplyInput): Promise<LibrarySyncApplyReport>;
}>;

/**
 * C3b: rebuild the local `images` row for an asset this device never
 * collected, returning its row id. Injected rather than importing the
 * repository so this module keeps its single `SqlDatabasePort` dependency
 * and stays unit-testable. Resolves to `null` when the row could not be
 * written; rejection is tolerated at the call site.
 */
export type LibrarySyncRestoreImage = (
  candidate: ImageCandidate,
  savedAt: number,
) => Promise<number | null>;

export type LibrarySyncApplyWriterDependencies = Readonly<{
  database: SqlDatabasePort;
  cipher: LibraryObjectCipher;
  clock?: () => number;
  restoreImage?: LibrarySyncRestoreImage;
}>;

type DecodedEnvelope = Readonly<{
  assetId: string;
  sealedMeta: string;
  metadata: LibraryEncryptedMetadata;
  importClassification: LibraryImportClassification;
}>;

type Writable = Readonly<{
  asset: LibraryProjectedAsset;
  plaintextSha256: string;
  isNewEnrollment: boolean;
  decoded: DecodedEnvelope | null;
}>;

type ExistingAssetState = Readonly<{
  plaintext_sha256: string | null;
  summary_sealed_meta: string | null;
  summary_origin: string | null;
  summary_collected_at: number | null;
  summary_classification: string | null;
  protection_revision: number | null;
  protection_generation: number | null;
  protection_state: string | null;
  protection_lifecycle: string | null;
  original_generation_id: string | null;
  original_ciphertext_bytes: number | null;
  thumbnail_generation_id: string | null;
  preview_generation_id: string | null;
  applied_state_key: string | null;
  verified_at: number | null;
  device_origin: string | null;
  device_source_image_id: number | null;
  device_created_at: number | null;
  device_classification: string | null;
  device_import_deleted_at: number | null;
}>;

function isAppendStateKey(stateKey: string | null | undefined): stateKey is string {
  return typeof stateKey === 'string' && stateKey.startsWith('state/');
}

function appendNoteMutationId(stateKey: string | null | undefined): string | null {
  if (!isAppendStateKey(stateKey)) return null;
  return parseNoteName(stateKey.slice('state/'.length))?.mutationId ?? null;
}

/**
 * N6-A3 (spec §4.3): decides whether an incoming `LibraryProjectedAsset` is
 * the winning state over the currently stored `library_asset_protection` row:
 * - On append backends (`state/<noteName>`), accepts a note with a strictly
 *   greater ULID `mutationId` even if its numeric `revision` is equal or lower,
 *   or any append note when the existing row has no append `applied_state_key`.
 *   An equal note ULID is accepted only for metadata/collision learning without
 *   advancing `updated_at` on the protection row. Older notes (`incomingId <
 *   existingId`) are rejected.
 * - On S3 CAS (`s3:<revision>` or `stateKey` omitted), keeps numeric CAS
 *   ordering (`asset.revision > existing.revision`), while allowing equal
 *   revision to learn missing summary/collision metadata on a merged collect.
 */
function evaluateStatePrecedence(
  asset: LibraryProjectedAsset,
  existing: ExistingAssetState | null,
): Readonly<{
  advanceProtection: boolean;
  allowAuthorityLearning: boolean;
}> {
  const incomingAppendId = appendNoteMutationId(asset.stateKey);
  if (incomingAppendId !== null) {
    const existingAppendId = appendNoteMutationId(existing?.applied_state_key);
    if (existing === null || existing.protection_revision === null || existingAppendId === null) {
      return { advanceProtection: true, allowAuthorityLearning: true };
    }
    if (incomingAppendId > existingAppendId) {
      return { advanceProtection: true, allowAuthorityLearning: true };
    }
    if (incomingAppendId === existingAppendId) {
      return { advanceProtection: false, allowAuthorityLearning: true };
    }
    return { advanceProtection: false, allowAuthorityLearning: false };
  }

  // S3 CAS or legacy Worker feed (numeric revision ordering)
  const existingRev = existing?.protection_revision ?? -1;
  if (asset.revision > existingRev) {
    return { advanceProtection: true, allowAuthorityLearning: true };
  }
  if (asset.revision === existingRev) {
    return { advanceProtection: false, allowAuthorityLearning: true };
  }
  return { advanceProtection: false, allowAuthorityLearning: false };
}

/**
 * The projection row and the account metadata are both attacker-reachable
 * inputs after decryption; a malformed envelope must be skipped, never coerced
 * into a row the schema would reject mid-transaction.
 *
 * N6-A1 (spec §4.3): accepts only payload versions 1, 2, or 3, validates
 * `importClassification` (missing -> `'unknown'`, present invalid -> rejected),
 * and requires the envelope's `plaintextSha256` to derive the record's
 * `assetId` under the library master key.
 */
function isMaterializable(
  metadata: LibraryEncryptedMetadata,
  expectedAssetId: string,
  masterKey: Uint8Array,
): boolean {
  const version = (metadata as { version?: unknown }).version;
  if (version !== 1 && version !== 2 && version !== 3) return false;
  if (resolveEnvelopeImportClassification(metadata) === null) return false;
  if (
    !LIBRARY_ASSET_ID_PATTERN.test(metadata.plaintextSha256)
    || !FORMATS.includes(metadata.format)
    || !EXTENSIONS.includes(metadata.canonicalExtension)
    || !ORIGINS.includes(metadata.origin)
    || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize <= 0
    || !Number.isSafeInteger(metadata.width) || metadata.width <= 0
    || !Number.isSafeInteger(metadata.height) || metadata.height <= 0
    || !Number.isSafeInteger(metadata.collectedAt)
  ) {
    return false;
  }
  try {
    return (
      deriveLibraryAssetId(masterKey, metadata.plaintextSha256) === expectedAssetId
    );
  } catch {
    return false;
  }
}

export function createLibrarySyncApplyWriter({
  database,
  cipher,
  clock = Date.now,
  restoreImage,
}: LibrarySyncApplyWriterDependencies): LibrarySyncApplyWriter {
  return {
    async apply(input) {
      if (input.assets.length === 0) {
        return {
          projected: 0,
          written: 0,
          materialized: 0,
          skippedUnknownAsset: 0,
          skippedIntegrity: 0,
          failedAssetIds: [],
        };
      }

      // Phase 1 runs outside the transaction on purpose: async crypto must
      // never execute while a SQLite write transaction is open.
      const known = new Map<
        string,
        {
          plaintextSha256: string;
          sealedMeta: string | null;
          needsProviderRestore: boolean;
        }
      >();
      const knownRows = await database.getAll<{
        asset_id: string;
        plaintext_sha256: string;
        sealed_meta: string | null;
        summary_origin: string | null;
        device_origin: string | null;
        device_source_image_id: number | null;
        device_import_deleted_at: number | null;
      }>(
        `SELECT aa.asset_id,
                aa.plaintext_sha256,
                s.sealed_meta,
                s.origin AS summary_origin,
                d.origin AS device_origin,
                d.source_image_id AS device_source_image_id,
                d.import_deleted_at AS device_import_deleted_at
           FROM library_account_assets aa
           LEFT JOIN library_account_metadata_summary s
             ON s.account_scope = aa.account_scope AND s.asset_id = aa.asset_id
           LEFT JOIN device_library_assets d
             ON d.plaintext_sha256 = aa.plaintext_sha256
          WHERE aa.account_scope = ?`,
        [input.accountScope],
      );
      for (const row of knownRows) {
        known.set(row.asset_id, {
          plaintextSha256: row.plaintext_sha256,
          sealedMeta: row.sealed_meta,
          needsProviderRestore:
            restoreImage !== undefined
            && (row.summary_origin === 'provider' || row.device_origin === 'provider')
            && row.device_source_image_id === null
            && row.device_import_deleted_at === null,
        });
      }

      const writable: Writable[] = [];
      const failedAssetIdSet = new Set<string>();
      let materializedCount = 0;
      let skippedIntegrity = 0;
      let skippedUnknownAsset = 0;

      for (const asset of input.assets) {
        const mapped = known.get(asset.assetId);
        if (mapped !== undefined) {
          // Known mapping: open and validate the envelope only when we have
          // never learned its summary, its sealed metadata string changed, or a
          // provider row's Phase 3 `restoreImage` still needs to run (N6-A3
          // spec §4.3, §8.1: unchanged record avoids openMetadata).
          let decoded: DecodedEnvelope | null = null;
          if (
            asset.encryptedMetadata !== null
            && (
              mapped.sealedMeta !== asset.encryptedMetadata
              || mapped.needsProviderRestore
            )
          ) {
            let metadata: LibraryEncryptedMetadata;
            try {
              metadata = await cipher.openMetadata({
                masterKey: input.masterKey,
                assetId: asset.assetId,
                sealed: asset.encryptedMetadata,
              });
            } catch {
              skippedIntegrity += 1;
              failedAssetIdSet.add(asset.assetId);
              continue;
            }
            if (
              !isMaterializable(metadata, asset.assetId, input.masterKey)
              || metadata.plaintextSha256 !== mapped.plaintextSha256
            ) {
              skippedIntegrity += 1;
              failedAssetIdSet.add(asset.assetId);
              continue;
            }
            decoded = {
              assetId: asset.assetId,
              sealedMeta: asset.encryptedMetadata,
              metadata,
              importClassification:
                resolveEnvelopeImportClassification(metadata)!,
            };
          }
          writable.push({
            asset,
            plaintextSha256: mapped.plaintextSha256,
            isNewEnrollment: false,
            decoded,
          });
          continue;
        }

        if (asset.encryptedMetadata === null) {
          // A purge row for an asset this device never held, or any other row
          // with no way to learn its digest. Nothing to forget, nothing to do.
          skippedUnknownAsset += 1;
          continue;
        }
        let metadata: LibraryEncryptedMetadata;
        try {
          metadata = await cipher.openMetadata({
            masterKey: input.masterKey,
            assetId: asset.assetId,
            sealed: asset.encryptedMetadata,
          });
        } catch {
          skippedIntegrity += 1;
          failedAssetIdSet.add(asset.assetId);
          continue;
        }
        if (!isMaterializable(metadata, asset.assetId, input.masterKey)) {
          skippedIntegrity += 1;
          failedAssetIdSet.add(asset.assetId);
          continue;
        }
        const importClassification =
          resolveEnvelopeImportClassification(metadata)!;
        const decoded: DecodedEnvelope = {
          assetId: asset.assetId,
          sealedMeta: asset.encryptedMetadata,
          metadata,
          importClassification,
        };
        materializedCount += 1;
        writable.push({
          asset,
          plaintextSha256: metadata.plaintextSha256,
          isNewEnrollment: true,
          decoded,
        });
      }

      const at = clock();
      const pendingProviderRestores: {
        assetId: string;
        metadata: LibraryEncryptedMetadata;
      }[] = [];

      await database.transaction(async (transaction) => {
        for (const item of writable) {
          const { asset, plaintextSha256, isNewEnrollment, decoded } = item;

          const existing = await transaction.getFirst<ExistingAssetState>(
            `SELECT
               aa.plaintext_sha256 AS plaintext_sha256,
               s.sealed_meta AS summary_sealed_meta,
               s.origin AS summary_origin,
               s.collected_at AS summary_collected_at,
               s.import_classification AS summary_classification,
               p.revision AS protection_revision,
               p.generation AS protection_generation,
               p.protection AS protection_state,
               p.lifecycle AS protection_lifecycle,
               p.original_generation_id AS original_generation_id,
               p.original_ciphertext_bytes AS original_ciphertext_bytes,
               p.thumbnail_generation_id AS thumbnail_generation_id,
               p.preview_generation_id AS preview_generation_id,
               p.applied_state_key AS applied_state_key,
               p.verified_at AS verified_at,
               d.origin AS device_origin,
               d.source_image_id AS device_source_image_id,
               d.created_at AS device_created_at,
               d.import_classification AS device_classification,
               d.import_deleted_at AS device_import_deleted_at
             FROM (SELECT ? AS scope, ? AS aid, ? AS sha) q
             LEFT JOIN library_account_assets aa
               ON aa.account_scope = q.scope AND aa.asset_id = q.aid
             LEFT JOIN library_account_metadata_summary s
               ON s.account_scope = q.scope AND s.asset_id = q.aid
             LEFT JOIN library_asset_protection p
               ON p.account_scope = q.scope AND p.asset_id = q.aid
             LEFT JOIN device_library_assets d
               ON d.plaintext_sha256 = q.sha`,
            [input.accountScope, asset.assetId, plaintextSha256],
          );

          const precedence = evaluateStatePrecedence(asset, existing);

          if (isNewEnrollment && decoded !== null) {
            const { metadata, importClassification } = decoded;
            await transaction.run(
              `INSERT INTO device_library_assets (
                 plaintext_sha256, format, canonical_extension, byte_size, width,
                 height, origin, source_image_id, local_original_uri, residency,
                 protect_eligible, missing_original_since, import_classification,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'cloud-only', ?, NULL,
                 ?, ?, ?)
               ON CONFLICT(plaintext_sha256) DO NOTHING`,
              [
                metadata.plaintextSha256,
                metadata.format,
                metadata.canonicalExtension,
                metadata.byteSize,
                metadata.width,
                metadata.height,
                metadata.origin,
                metadata.byteSize <= LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES
                  ? 1
                  : 0,
                importClassification,
                metadata.collectedAt,
                at,
              ],
            );
            await transaction.run(
              `INSERT INTO library_account_assets (
                 account_scope, asset_id, plaintext_sha256, device_id,
                 enrolled_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_scope, asset_id) DO NOTHING`,
              [
                input.accountScope,
                asset.assetId,
                metadata.plaintextSha256,
                input.deviceId,
                at,
                at,
              ],
            );
          }

          if (decoded !== null && precedence.allowAuthorityLearning) {
            const { metadata, importClassification, sealedMeta } = decoded;
            const summaryStateKey =
              asset.stateKey ?? `s3:${asset.revision}`;
            const sourceJson =
              metadata.origin === 'provider' && metadata.source !== undefined
                ? JSON.stringify(metadata.source)
                : null;
            await transaction.run(
              `INSERT INTO library_account_metadata_summary (
                 account_scope, asset_id, plaintext_sha256, origin, collected_at,
                 import_classification, source_json, state_key, sealed_meta, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_scope, asset_id) DO UPDATE SET
                 plaintext_sha256 = excluded.plaintext_sha256,
                 origin = excluded.origin,
                 collected_at = excluded.collected_at,
                 import_classification = excluded.import_classification,
                 source_json = excluded.source_json,
                 state_key = excluded.state_key,
                 sealed_meta = excluded.sealed_meta,
                 updated_at = excluded.updated_at`,
              [
                input.accountScope,
                asset.assetId,
                metadata.plaintextSha256,
                metadata.origin,
                metadata.collectedAt,
                importClassification,
                sourceJson,
                summaryStateKey,
                sealedMeta,
                at,
              ],
            );

            // Apply §4.4 authority to a present device row without resurrecting
            // a device-deleted membership (an absent device row stays absent,
            // and a non-null `import_deleted_at` stays non-null).
            const presentRow = await transaction.getFirst<{
              origin: string;
              source_image_id: number | null;
              import_classification: string;
              import_deleted_at: number | null;
              created_at: number;
            }>(
              `SELECT origin, source_image_id, import_classification,
                      import_deleted_at, created_at
                 FROM device_library_assets
                WHERE plaintext_sha256 = ?`,
              [metadata.plaintextSha256],
            );

            if (presentRow !== null) {
              if (metadata.origin === 'provider') {
                // Cloud authority is provider: if this phone held an import (or
                // differing time/classification), converge the digest row to
                // provider origin and original collectedAt.
                if (
                  presentRow.origin !== 'provider'
                  || presentRow.created_at !== metadata.collectedAt
                  || presentRow.import_classification !== 'unknown'
                ) {
                  await transaction.run(
                    `UPDATE device_library_assets
                        SET origin = 'provider',
                            import_classification = 'unknown',
                            created_at = ?,
                            updated_at = ?
                      WHERE plaintext_sha256 = ?`,
                    [metadata.collectedAt, at, metadata.plaintextSha256],
                  );
                }
                if (
                  presentRow.source_image_id === null
                  && presentRow.import_deleted_at === null
                ) {
                  pendingProviderRestores.push({
                    assetId: asset.assetId,
                    metadata,
                  });
                }
              } else {
                // Cloud authority is import: if this phone held a provider save,
                // retain its own saved `images` row in `library_provider_image_assets`
                // while switching `device_library_assets` to `origin = 'import'`
                // and `source_image_id = NULL`, with the winning import's
                // classification and `collectedAt` (§4.4).
                if (presentRow.source_image_id !== null) {
                  await transaction.run(
                    `INSERT OR REPLACE INTO library_provider_image_assets (
                       image_id, plaintext_sha256, updated_at
                     ) VALUES (?, ?, ?)`,
                    [
                      presentRow.source_image_id,
                      metadata.plaintextSha256,
                      at,
                    ],
                  );
                }
                if (
                  presentRow.origin !== 'import'
                  || presentRow.source_image_id !== null
                  || presentRow.import_classification !== importClassification
                  || presentRow.created_at !== metadata.collectedAt
                ) {
                  await transaction.run(
                    `UPDATE device_library_assets
                        SET origin = 'import',
                            source_image_id = NULL,
                            import_classification = ?,
                            created_at = ?,
                            updated_at = ?
                      WHERE plaintext_sha256 = ?`,
                    [
                      importClassification,
                      metadata.collectedAt,
                      at,
                      metadata.plaintextSha256,
                    ],
                  );
                }
              }
            }
          } else if (
            isNewEnrollment
            && decoded !== null
            && decoded.metadata.origin === 'provider'
          ) {
            pendingProviderRestores.push({
              assetId: asset.assetId,
              metadata: decoded.metadata,
            });
          }

          // Also if a previously materialized provider row still has
          // `source_image_id IS NULL` (from a prior failed Phase 3 rebuild),
          // queue its Phase 3 retry using the envelope decoded in Phase 1.
          if (
            decoded !== null
            && decoded.metadata.origin === 'provider'
            && existing?.device_origin === 'provider'
            && existing.device_source_image_id === null
            && existing.device_import_deleted_at === null
          ) {
            pendingProviderRestores.push({
              assetId: asset.assetId,
              metadata: decoded.metadata,
            });
          }

          if (!precedence.advanceProtection) {
            continue;
          }

          // Whole-winning-state reference and verification rules:
          // - When `asset.stateKey` is present (a real BYOS S3 or append state
          //   snapshot), the snapshot's generation references are authoritative:
          //   absent references clear old references instead of keeping a
          //   losing note's refs via NULL-preservation.
          // - When `asset.stateKey` is absent (legacy Worker change-feed rows in
          //   unit tests, which carry no object ids), keep the existing
          //   NULL-preservation behavior so feed rows do not erase refs.
          const isWholeStateSnapshot =
            typeof asset.stateKey === 'string' && asset.stateKey.length > 0;
          const protectedNow = asset.protection === 'protected';

          const nextOriginalGen = !protectedNow
            ? null
            : isWholeStateSnapshot
              ? asset.originalGenerationId
              : (asset.originalGenerationId ?? existing?.original_generation_id ?? null);
          const nextOriginalBytes = !protectedNow
            ? null
            : asset.originalCiphertextBytes !== null
              ? asset.originalCiphertextBytes
              : nextOriginalGen !== null
                && nextOriginalGen === existing?.original_generation_id
                ? (existing?.original_ciphertext_bytes ?? null)
                : null;
          const nextThumbGen = !protectedNow
            ? null
            : isWholeStateSnapshot
              ? asset.thumbnailGenerationId
              : (asset.thumbnailGenerationId ?? existing?.thumbnail_generation_id ?? null);
          const nextPreviewGen = !protectedNow
            ? null
            : isWholeStateSnapshot
              ? asset.previewGenerationId
              : (asset.previewGenerationId ?? existing?.preview_generation_id ?? null);

          // Verification survives ONLY when the winning state is `protected` and
          // its `(plaintext_sha256, generation, original_generation_id)` match
          // the previously verified row (spec §4.3).
          const keepVerifiedAt =
            protectedNow
            && existing !== null
            && existing.verified_at !== null
            && existing.plaintext_sha256 === plaintextSha256
            && existing.protection_generation === asset.generation
            && nextOriginalGen !== null
            && existing.original_generation_id === nextOriginalGen
              ? existing.verified_at
              : null;

          const nextAppliedStateKey =
            asset.stateKey ?? existing?.applied_state_key ?? null;

          await transaction.run(
            `INSERT INTO library_asset_protection (
               account_scope, asset_id, plaintext_sha256, lifecycle, protection,
               generation, revision, original_generation_id,
               original_ciphertext_bytes, thumbnail_generation_id,
               preview_generation_id, applied_state_key, verified_at,
               failure_category, trashed_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
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
               applied_state_key = excluded.applied_state_key,
               verified_at = excluded.verified_at,
               failure_category = NULL,
               trashed_at = excluded.trashed_at,
               updated_at = excluded.updated_at`,
            [
              input.accountScope,
              asset.assetId,
              plaintextSha256,
              asset.lifecycle,
              asset.protection,
              asset.generation,
              asset.revision,
              nextOriginalGen,
              nextOriginalBytes,
              nextThumbGen,
              nextPreviewGen,
              nextAppliedStateKey,
              keepVerifiedAt,
              asset.trashedAtMs,
              at,
            ],
          );
        }
      });

      // Phase 3 runs after the write transaction commits, for the same reason
      // Phase 1 runs before it opens: the rebuild port is bound to
      // `imageRepository.saveMirroredCandidate` (K2), which opens its own transaction on
      // this same serialized port.
      if (restoreImage !== undefined) {
        const seenDigests = new Set<string>();
        for (const { assetId, metadata } of pendingProviderRestores) {
          if (seenDigests.has(metadata.plaintextSha256)) continue;
          seenDigests.add(metadata.plaintextSha256);
          const restore = restoreCandidateFrom(metadata);
          if (restore === null) continue;
          const existing = await database.getFirst<{
            origin: string;
            source_image_id: number | null;
          }>(
            `SELECT origin, source_image_id FROM device_library_assets
              WHERE plaintext_sha256 = ?`,
            [metadata.plaintextSha256],
          );
          if (
            existing === null
            || existing.origin !== 'provider'
            || existing.source_image_id !== null
          ) {
            continue;
          }
          try {
            const imageId = await restoreImage(
              restore.candidate,
              restore.savedAt,
            );
            if (imageId === null) {
              failedAssetIdSet.add(assetId);
              continue;
            }
            const linked = await database.run(
              `UPDATE device_library_assets
                 SET source_image_id = ?, updated_at = ?
               WHERE plaintext_sha256 = ? AND source_image_id IS NULL`,
              [imageId, at, metadata.plaintextSha256],
            );
            if (linked.changes > 0) {
              await database.run(
                `INSERT OR REPLACE INTO library_provider_image_assets (
                   image_id, plaintext_sha256, updated_at
                 ) VALUES (?, ?, ?)`,
                [imageId, metadata.plaintextSha256, at],
              );
            }
          } catch {
            // The mirror row is the durable artifact. A rebuild failure leaves
            // the pointer NULL, so the asset stays visible on the cloud-only
            // tile path and the next cycle retries it.
            failedAssetIdSet.add(assetId);
          }
        }
      }

      return {
        projected: input.assets.length,
        written: writable.length,
        materialized: materializedCount,
        skippedUnknownAsset,
        skippedIntegrity,
        ...(failedAssetIdSet.size > 0
          ? { failedAssetIds: [...failedAssetIdSet] }
          : {}),
      };
    },
  };
}
