import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibraryFailureCategory,
  LibraryLifecycle,
  LibraryProtection,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import { purgeDeadlineAt } from '@/features/library/library-trash-deadline';
import {
  isLibraryImportClassification,
  type LibraryAssetOrigin,
  type LibraryImageFormat,
  type LibraryImportClassification,
  type LibraryResidency,
} from '@/features/library/library-types';

export type LibraryEntry = Readonly<{
  plaintextSha256: string;
  /** Bridge to the accepted `images` grid row, when this asset came from one. */
  sourceImageId: number | null;
  /** N6-A1 (spec §4.3): 'provider' | 'import'. */
  origin?: LibraryAssetOrigin;
  /** N6-A1 (spec §4.3): 'safe' | 'adult' | 'unknown'. */
  importClassification?: LibraryImportClassification;
  /** N6-A1/A2 (spec §4.4): set when import membership was deleted on this phone while a surviving provider member keeps the row. */
  importDeletedAt?: number | null;
  /**
   * N6-B1 (spec §4.4, §4.5): true when this digest has an active import
   * membership on this phone (`origin === 'import' && importDeletedAt === null`),
   * even if `sourceImageId` is also resolved from `library_provider_image_assets`
   * in the two-member case.
   */
  hasImportMembership?: boolean;
  /**
   * N6-B1 (spec §4.4, §4.5): all saved provider `images.id` values associated
   * with this digest (`a.source_image_id` plus `library_provider_image_assets`),
   * newest first, so `entriesByImageId` and `buildCollectionItems` recognize
   * every saved provider member even when multiple provider saves share a
   * digest with an import.
   */
  associatedProviderImageIds?: readonly number[];
  format: LibraryImageFormat;
  /** Plaintext size of the original; board #16 caps gif animation on it. */
  byteSize: number;
  width: number;
  height: number;
  residency: LibraryResidency;
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
  failureCategory: LibraryFailureCategory | null;
  hasLocalOriginal: boolean;
  /**
   * This asset's local original, set only when `hasLocalOriginal`; grid and
   * viewer render it without a resolve (spec §5.7).
   */
  localOriginalUri: string | null;
  /** Cloud original generation, null when the account never committed one. */
  originalGenerationId: string | null;
  createdAt: number;
}>;

export type TrashLibraryEntry = LibraryEntry & Readonly<{
  trashedAt: number;
  purgeDeadlineAt: number;
}>;

export type LibraryViewModel = Readonly<{
  /** Active, non-device-trashed entries, newest first. */
  listEntries(): Promise<readonly LibraryEntry[]>;
  findEntry(plaintextSha256: string): Promise<LibraryEntry | null>;
  /** Account-trash rows only (lifecycle=trash, non-null trashed_at); never purged. */
  listTrashEntries(): Promise<readonly TrashLibraryEntry[]>;
}>;

export type LibraryViewModelDependencies = Readonly<{
  database: SqlDatabasePort;
  session: LibrarySessionPort;
}>;

export type LibraryEntryRow = {
  plaintext_sha256: string;
  source_image_id: number | null;
  provider_image_ids_csv?: string | null;
  origin?: string;
  import_classification?: string;
  import_deleted_at?: number | null;
  format: string;
  byte_size: number;
  width: number;
  height: number;
  residency: string;
  local_original_uri: string | null;
  missing_original_since: number | null;
  lifecycle: string | null;
  protection: string | null;
  failure_category: string | null;
  original_generation_id: string | null;
  created_at: number;
};

type TrashEntryRow = LibraryEntryRow & {
  trashed_at: number;
};

/** First bound parameter is the account scope the protection join uses. */
export const LIBRARY_ENTRY_SELECT = `
  SELECT a.plaintext_sha256,
         COALESCE(
           a.source_image_id,
           (SELECT m.image_id
              FROM library_provider_image_assets m
              JOIN images i ON i.id = m.image_id AND i.decision = 'saved'
             WHERE m.plaintext_sha256 = a.plaintext_sha256
             ORDER BY m.updated_at DESC, m.image_id DESC
             LIMIT 1)
         ) AS source_image_id,
         (SELECT group_concat(m.image_id, ',')
            FROM (
              SELECT m2.image_id
                FROM library_provider_image_assets m2
                JOIN images i ON i.id = m2.image_id AND i.decision = 'saved'
               WHERE m2.plaintext_sha256 = a.plaintext_sha256
               ORDER BY m2.updated_at DESC, m2.image_id DESC
            ) m
         ) AS provider_image_ids_csv,
         a.origin, a.import_classification, a.import_deleted_at,
         a.format, a.byte_size, a.width, a.height,
         a.residency, a.local_original_uri, a.missing_original_since,
         p.lifecycle, p.protection, p.failure_category, p.original_generation_id,
         a.created_at
    FROM device_library_assets a
    LEFT JOIN library_asset_protection p
      ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
    LEFT JOIN library_device_asset_state d
      ON d.plaintext_sha256 = a.plaintext_sha256
   WHERE (p.lifecycle IS NULL OR p.lifecycle = 'active')
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
`;

const SELECT_TRASH_ENTRIES = `
  SELECT a.plaintext_sha256, a.source_image_id, a.origin, a.import_classification,
         a.import_deleted_at,
         a.format, a.byte_size, a.width, a.height,
         a.residency, a.local_original_uri, a.missing_original_since,
         p.lifecycle, p.protection, p.failure_category, p.original_generation_id,
         a.created_at, p.trashed_at
    FROM library_asset_protection p
    JOIN device_library_assets a
      ON a.plaintext_sha256 = p.plaintext_sha256
   WHERE p.account_scope = ?
     AND p.lifecycle = 'trash'
     AND p.trashed_at IS NOT NULL
`;

function parseAssociatedProviderImageIds(
  sourceImageId: number | null,
  csv: string | null | undefined,
): readonly number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  if (typeof sourceImageId === 'number' && Number.isFinite(sourceImageId)) {
    seen.add(sourceImageId);
    out.push(sourceImageId);
  }
  if (typeof csv === 'string' && csv.length > 0) {
    for (const part of csv.split(',')) {
      const parsed = Number.parseInt(part, 10);
      if (Number.isFinite(parsed) && !seen.has(parsed)) {
        seen.add(parsed);
        out.push(parsed);
      }
    }
  }
  return out;
}

export function toLibraryEntry(row: LibraryEntryRow): LibraryEntry {
  const hasLocalOriginal = row.local_original_uri !== null
    && row.missing_original_since === null
    && row.residency === 'local-original';
  const protection = row.protection as LibraryProtection | null;
  const failureCategory = row.failure_category as LibraryFailureCategory | null;
  const origin: LibraryAssetOrigin =
    row.origin === 'provider'
      ? 'provider'
      : row.origin === 'import'
        ? 'import'
        : row.source_image_id !== null
          ? 'provider'
          : 'import';
  const importDeletedAt = row.import_deleted_at ?? null;
  const hasImportMembership = origin === 'import' && importDeletedAt === null;
  const importClassification: LibraryImportClassification =
    isLibraryImportClassification(row.import_classification)
      ? row.import_classification
      : 'unknown';
  const associatedProviderImageIds = parseAssociatedProviderImageIds(
    row.source_image_id,
    row.provider_image_ids_csv,
  );
  return {
    plaintextSha256: row.plaintext_sha256,
    sourceImageId: row.source_image_id,
    origin,
    importClassification,
    importDeletedAt,
    hasImportMembership,
    associatedProviderImageIds,
    format: row.format as LibraryImageFormat,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    residency: row.residency as LibraryResidency,
    lifecycle: (row.lifecycle ?? 'active') as LibraryLifecycle,
    protection: protection ?? 'unprotected',
    failureCategory,
    hasLocalOriginal,
    localOriginalUri: hasLocalOriginal ? row.local_original_uri : null,
    originalGenerationId: row.original_generation_id,
    createdAt: row.created_at,
  };
}

function toTrashEntry(row: TrashEntryRow): TrashLibraryEntry {
  return {
    ...toLibraryEntry(row),
    trashedAt: row.trashed_at,
    purgeDeadlineAt: purgeDeadlineAt(row.trashed_at),
  };
}

/** Active rows for one scope, newest first. `scope` null matches no projection. */
export async function readLibraryEntries(
  database: SqlDatabasePort,
  scope: string | null,
): Promise<readonly LibraryEntry[]> {
  const rows = await database.getAll<LibraryEntryRow>(
    `${LIBRARY_ENTRY_SELECT}
     ORDER BY a.created_at DESC, a.plaintext_sha256 ASC`,
    [scope],
  );
  return rows.map(toLibraryEntry);
}

/** One active row in that scope, or null when the filters exclude it. */
export async function readLibraryEntry(
  database: SqlDatabasePort,
  scope: string | null,
  plaintextSha256: string,
): Promise<LibraryEntry | null> {
  const row = await database.getFirst<LibraryEntryRow>(
    `${LIBRARY_ENTRY_SELECT} AND a.plaintext_sha256 = ?`,
    [scope, plaintextSha256],
  );
  return row === null ? null : toLibraryEntry(row);
}

export function createLibraryViewModel({
  database,
  session,
}: LibraryViewModelDependencies): LibraryViewModel {
  return {
    async listEntries() {
      const context = await session.current();
      if (context === null) return [];
      return readLibraryEntries(database, context.accountScope);
    },

    async findEntry(plaintextSha256) {
      const context = await session.current();
      if (context === null) return null;
      return readLibraryEntry(database, context.accountScope, plaintextSha256);
    },

    async listTrashEntries() {
      const context = await session.current();
      if (context === null) return [];
      const rows = await database.getAll<TrashEntryRow>(
        `${SELECT_TRASH_ENTRIES}
         ORDER BY p.trashed_at ASC, a.plaintext_sha256 ASC`,
        [context.accountScope],
      );
      return rows.map(toTrashEntry);
    },
  };
}
