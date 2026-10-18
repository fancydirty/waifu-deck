import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryRestorableSource } from '@/features/library/library-actions-types';
import {
  isLibraryImportClassification,
  type LibraryAssetOrigin,
  type LibraryImportClassification,
} from '@/features/library/library-types';

export type LibraryAccountMetadataSummaryRow = Readonly<{
  accountScope: string;
  assetId: string;
  plaintextSha256: string;
  origin: LibraryAssetOrigin;
  collectedAt: number;
  importClassification: LibraryImportClassification;
  source: LibraryRestorableSource | null;
  stateKey: string;
  sealedMeta: string;
  updatedAt: number;
}>;

export type LibraryAccountMetadataSummaryUpsert = Readonly<{
  accountScope: string;
  assetId: string;
  plaintextSha256: string;
  origin: LibraryAssetOrigin;
  collectedAt: number;
  importClassification: LibraryImportClassification;
  source: LibraryRestorableSource | null;
  stateKey: string;
  sealedMeta: string;
  updatedAt?: number;
}>;

export type LibraryAccountMetadataSummaryRepository = Readonly<{
  findByAssetId(
    accountScope: string,
    assetId: string,
  ): Promise<LibraryAccountMetadataSummaryRow | null>;
  findByDigest(
    accountScope: string,
    plaintextSha256: string,
  ): Promise<LibraryAccountMetadataSummaryRow | null>;
  upsert(input: LibraryAccountMetadataSummaryUpsert): Promise<void>;
  listMissingSummaryAssetIds(accountScope: string): Promise<readonly string[]>;
  deleteAll(accountScope: string): Promise<void>;
}>;

export type LibraryAccountMetadataSummaryDependencies = Readonly<{
  database: SqlDatabasePort;
  clock?: () => number;
}>;

type RawSummaryRow = {
  account_scope: string;
  asset_id: string;
  plaintext_sha256: string;
  origin: string;
  collected_at: number;
  import_classification: string;
  source_json: string | null;
  state_key: string;
  sealed_meta: string;
  updated_at: number;
};

const SUMMARY_COLUMNS = `
  account_scope, asset_id, plaintext_sha256, origin, collected_at,
  import_classification, source_json, state_key, sealed_meta, updated_at
`;

function parseSourceJson(raw: string | null): LibraryRestorableSource | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as LibraryRestorableSource;
  } catch {
    return null;
  }
}

function toSummaryRow(row: RawSummaryRow): LibraryAccountMetadataSummaryRow {
  return {
    accountScope: row.account_scope,
    assetId: row.asset_id,
    plaintextSha256: row.plaintext_sha256,
    origin: row.origin === 'provider' ? 'provider' : 'import',
    collectedAt: row.collected_at,
    importClassification: isLibraryImportClassification(
      row.import_classification,
    )
      ? row.import_classification
      : 'unknown',
    source: parseSourceJson(row.source_json),
    stateKey: row.state_key,
    sealedMeta: row.sealed_meta,
    updatedAt: row.updated_at,
  };
}

export function createLibraryAccountMetadataSummaryRepository({
  database,
  clock = Date.now,
}: LibraryAccountMetadataSummaryDependencies): LibraryAccountMetadataSummaryRepository {
  return {
    async findByAssetId(accountScope, assetId) {
      const row = await database.getFirst<RawSummaryRow>(
        `SELECT ${SUMMARY_COLUMNS}
           FROM library_account_metadata_summary
          WHERE account_scope = ? AND asset_id = ?`,
        [accountScope, assetId],
      );
      return row === null ? null : toSummaryRow(row);
    },

    async findByDigest(accountScope, plaintextSha256) {
      const row = await database.getFirst<RawSummaryRow>(
        `SELECT ${SUMMARY_COLUMNS}
           FROM library_account_metadata_summary
          WHERE account_scope = ? AND plaintext_sha256 = ?
          ORDER BY updated_at DESC, asset_id ASC
          LIMIT 1`,
        [accountScope, plaintextSha256],
      );
      return row === null ? null : toSummaryRow(row);
    },

    async upsert(input) {
      const at = input.updatedAt ?? clock();
      const sourceJson =
        input.origin === 'provider' && input.source !== null
          ? JSON.stringify(input.source)
          : null;
      await database.run(
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
          input.assetId,
          input.plaintextSha256,
          input.origin,
          input.collectedAt,
          input.importClassification,
          sourceJson,
          input.stateKey,
          input.sealedMeta,
          at,
        ],
      );
    },

    async listMissingSummaryAssetIds(accountScope) {
      const rows = await database.getAll<{ asset_id: string }>(
        `SELECT aa.asset_id
           FROM library_account_assets aa
          WHERE aa.account_scope = ?
            AND NOT EXISTS (
              SELECT 1 FROM library_account_metadata_summary s
               WHERE s.account_scope = aa.account_scope
                 AND s.asset_id = aa.asset_id
            )
          ORDER BY aa.asset_id ASC`,
        [accountScope],
      );
      return rows.map((row) => row.asset_id);
    },

    async deleteAll(accountScope) {
      await database.run(
        'DELETE FROM library_account_metadata_summary WHERE account_scope = ?',
        [accountScope],
      );
    },
  };
}
