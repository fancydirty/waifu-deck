import Constants from 'expo-constants';
import { Directory, File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as SQLite from 'expo-sqlite';

import { APP_DATABASE_NAME } from '@/db/database';
import { DATABASE_VERSION } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  BACKUP_APPLICATION_ID,
  BACKUP_FORMAT_VERSION,
  isValidBackupDigest,
  parseBackupManifest,
  restoreFileName,
  restoreImportStageFileName,
  safeBackupExtension,
  sqliteBlob,
  type BackupManifest,
} from '@/features/backup/backup-format';
import type {
  CollectionFileRepository,
  FileDeleteAllResult,
} from '@/features/collection/file-repository';
import {
  APP_DISTRIBUTION_POLICY,
  DIRECT_DISTRIBUTION_POLICY,
  STORE_DISTRIBUTION_POLICY,
} from '@/features/distribution/distribution-policy';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import type { LibraryFileStore } from '@/features/library/library-file-store';
import { LAST_ACCOUNT_SCOPE_SQL } from '@/features/library/library-local-view';
import type { LibraryCanonicalExtension } from '@/features/library/library-types';
import type { SettingsRepository } from '@/features/settings/settings-repository';
import { normalizeSettings } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';
import i18n from '@/i18n';

const PAYLOAD_DATABASE = 'app-database';
const PAYLOAD_SETTINGS = 'settings';
const SQLITE_DATABASE_NAME = 'main';
const STRICT_SAFE_IMAGE_PREDICATE =
  "is_nsfw = 0 AND content_rating = 'safe'";
// Newest on-device library original of the outer images row, including the
// N6-A1/A2 two-member association table (`library_provider_image_assets`).
// A flagged original (missing_original_since) is not on this phone for backup.
const LOCAL_LIBRARY_ORIGINAL = `SELECT b.local_original_uri FROM device_library_assets b
 WHERE b.residency = 'local-original'
   AND b.local_original_uri IS NOT NULL
   AND b.missing_original_since IS NULL
   AND (
     b.source_image_id = images.id
     OR EXISTS (
       SELECT 1 FROM sqlite_master sm
        WHERE sm.type = 'table' AND sm.name = 'library_provider_image_assets'
          AND EXISTS (
            SELECT 1 FROM library_provider_image_assets m
             WHERE m.image_id = images.id
               AND m.plaintext_sha256 = b.plaintext_sha256
          )
     )
   )
 ORDER BY b.created_at DESC, b.plaintext_sha256 ASC LIMIT 1`;

export const RESTORE_SAVED_IMAGES_SQL =
  "SELECT id, extension, local_uri, download_state FROM images WHERE decision = 'saved' ORDER BY id";
// Board #27 S1b Task 8 (spec R26): the only two columns that name a library
// file, and exactly the two the collected purge deletes.
export const RESTORED_LIBRARY_FILE_URIS_SQL =
  `SELECT local_original_uri AS uri FROM device_library_assets WHERE local_original_uri IS NOT NULL
UNION
SELECT device_trash_uri AS uri FROM library_device_asset_state WHERE device_trash_uri IS NOT NULL`;
export const RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL =
  'UPDATE device_library_assets SET local_thumbnail_uri = NULL';
export const RESTORE_CLEAR_STALE_IMPORT_ORIGINALS_SQL = `
  UPDATE device_library_assets
     SET local_original_uri = NULL,
         residency = CASE
           WHEN EXISTS (
             SELECT 1 FROM library_asset_protection p
              WHERE p.plaintext_sha256 = device_library_assets.plaintext_sha256
                AND p.account_scope = (${LAST_ACCOUNT_SCOPE_SQL})
                AND p.original_generation_id IS NOT NULL
           ) THEN 'cloud-only'
           ELSE residency
         END,
         missing_original_since = CASE
           WHEN EXISTS (
             SELECT 1 FROM library_asset_protection p
              WHERE p.plaintext_sha256 = device_library_assets.plaintext_sha256
                AND p.account_scope = (${LAST_ACCOUNT_SCOPE_SQL})
                AND p.original_generation_id IS NOT NULL
           ) THEN NULL
           WHEN residency = 'local-original' THEN COALESCE(missing_original_since, created_at)
           ELSE missing_original_since
         END
   WHERE local_original_uri IS NOT NULL
`;

let restoreNamespaceSequence = 0;

export const BACKUP_ARCHIVE_SCHEMA_SQL = `
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  CREATE TABLE backup_manifest (
    format_version INTEGER NOT NULL,
    application_id TEXT NOT NULL,
    app_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    image_count INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    total_file_bytes INTEGER NOT NULL,
    import_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE backup_payload (
    key TEXT PRIMARY KEY NOT NULL,
    text_value TEXT,
    blob_value BLOB
  );
  CREATE TABLE backup_files (
    image_id INTEGER PRIMARY KEY NOT NULL,
    extension TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    data BLOB NOT NULL
  );
  CREATE TABLE backup_import_files (
    plaintext_sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(plaintext_sha256) = 64),
    extension TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    data BLOB NOT NULL
  );
`;

type SavedFileRow = {
  id: number;
  extension: string;
  local_uri: string | null;
};

type ImportExportRow = {
  plaintext_sha256: string;
  canonical_extension: string;
  residency: string;
  local_original_uri: string | null;
  missing_original_since: number | null;
  has_cloud: number;
};

type RestoreImportRow = {
  plaintext_sha256: string;
  canonical_extension: string;
  residency: string;
  local_original_uri: string | null;
  missing_original_since: number | null;
  has_cloud: number;
  created_at: number;
};

type PayloadRow = {
  text_value: string | null;
  blob_value: unknown;
};

type ArchiveFileRow = {
  extension: string;
  byte_size: number;
  data: unknown;
};

type VersionRow = {
  user_version: number;
};

type IntegrityRow = { quick_check: string };
type ColumnRow = { name: string };
type TableRow = { name: string };

export type BackupSummary = BackupManifest & {
  missingFileCount: number;
  cloudOnlyCount: number;
};

export type RestoreSummary = BackupManifest & {
  restoredFileCount: number;
  missingFileCount: number;
  removedAdultImageCount?: number;
};

export type PreparedAppRestore = {
  summary: RestoreSummary;
  apply(): Promise<AppSettings>;
  dispose(): Promise<void>;
};

export type PreparedAppBackup = {
  summary: BackupSummary;
  uri: string;
  dispose(): Promise<void>;
};

export interface AppBackupService {
  createArchive(): Promise<PreparedAppBackup>;
  createAndShare(): Promise<BackupSummary>;
  prepareRestoreFromUri(uri: string): Promise<PreparedAppRestore>;
  pickAndPrepareRestore(): Promise<PreparedAppRestore | null>;
}

export type BackupLibraryFilesPort = Pick<LibraryFileStore, 'deleteUnnamedFiles'>
  & Partial<Pick<LibraryFileStore, 'originalUriFor'>>;

type BackupServiceInput = {
  database: SqlDatabasePort;
  settingsRepository: SettingsRepository;
  fileRepository: CollectionFileRepository;
  /** Absent: a restore leaves the library's files alone (web, bare tests). */
  libraryFiles?: BackupLibraryFilesPort;
  copyArchivedFile?: (
    archiveUri: string,
    imageId: number,
    destinationUri: string,
  ) => Promise<number>;
  copyArchivedImportFile?: (
    archiveUri: string,
    plaintextSha256: string,
    destinationUri: string,
  ) => Promise<Readonly<{ bytesWritten: number; plaintextSha256: string }>>;
  appVersion?: string;
  allowsAdultContent?: boolean;
};

const BACKUP_ARCHIVE_PREFIX = 'waifu-deck-';
const BACKUP_ARCHIVE_EXTENSION = '.waifudeck';
const RESTORE_IMPORT_PREFIX = 'restore-import-';
const BACKUP_SNAPSHOT_PREFIX = 'backup-snapshot-';
const BACKUP_SNAPSHOT_EXTENSION = '.db';
const BACKUP_ARTIFACT_SIBLING_SUFFIXES = ['', '-journal', '-wal', '-shm'] as const;

export function archiveName(createdAt: number): string {
  return `${BACKUP_ARCHIVE_PREFIX}${new Date(createdAt).toISOString().slice(0, 10)}-${createdAt}${BACKUP_ARCHIVE_EXTENSION}`;
}

export function restoreImportName(createdAt: number): string {
  return `${RESTORE_IMPORT_PREFIX}${createdAt}${BACKUP_ARCHIVE_EXTENSION}`;
}

export function backupSnapshotName(createdAt: number): string {
  return `${BACKUP_SNAPSHOT_PREFIX}${createdAt}${BACKUP_SNAPSHOT_EXTENSION}`;
}

export function asFileUri(pathOrUri: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(pathOrUri)) return pathOrUri;
  return `file://${pathOrUri.startsWith('/') ? '' : '/'}${pathOrUri}`;
}

function databaseFile(name: string): File {
  return new File(asFileUri(`${SQLite.defaultDatabaseDirectory}/${name}`));
}

function deleteDatabaseArtifacts(name: string): void {
  let firstError: unknown = null;
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      deleteIfPresent(databaseFile(`${name}${suffix}`));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== null) throw firstError;
}

function deleteIfPresent(file: File): void {
  if (file.exists) file.delete();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const backupArtifactBasePatterns = [
  `${escapeRegExp(BACKUP_ARCHIVE_PREFIX)}\\d{4}-\\d{2}-\\d{2}-\\d+${escapeRegExp(BACKUP_ARCHIVE_EXTENSION)}`,
  `${escapeRegExp(RESTORE_IMPORT_PREFIX)}\\d+${escapeRegExp(BACKUP_ARCHIVE_EXTENSION)}`,
  `${escapeRegExp(BACKUP_SNAPSHOT_PREFIX)}\\d+${escapeRegExp(BACKUP_SNAPSHOT_EXTENSION)}`,
];
const backupArtifactSiblingPattern = BACKUP_ARTIFACT_SIBLING_SUFFIXES
  .filter((suffix) => suffix.length > 0)
  .map(escapeRegExp)
  .join('|');
const BACKUP_ARTIFACT_NAME = new RegExp(
  `^(?:${backupArtifactBasePatterns.join('|')})(?:${backupArtifactSiblingPattern})?$`,
  'u',
);

function deleteIssue(error: unknown) {
  return {
    code: 'delete_failed' as const,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Deletes only backup/export/restore leftovers in SQLite's database directory. */
export async function sweepBackupArtifacts(): Promise<FileDeleteAllResult> {
  const deleted: string[] = [];
  const failed: FileDeleteAllResult['failed'] = [];
  const directory = new Directory(asFileUri(SQLite.defaultDatabaseDirectory));
  let entries: (Directory | File)[];
  try {
    entries = directory.list();
  } catch (error) {
    return {
      deleted,
      failed: [{ uri: directory.uri, error: deleteIssue(error) }],
    };
  }

  for (const entry of entries) {
    if (!(entry instanceof File) || !BACKUP_ARTIFACT_NAME.test(entry.name)) continue;
    try {
      if (!entry.exists) continue;
      entry.delete();
      deleted.push(entry.uri);
    } catch (error) {
      failed.push({ uri: entry.uri, error: deleteIssue(error) });
    }
  }
  return { deleted, failed };
}

async function closeQuietly(database: SQLite.SQLiteDatabase | null): Promise<void> {
  await database?.closeAsync().catch(() => undefined);
}

/**
 * Spec R26: after a committed restore, deletes the originals and device-trash
 * files no restored row names. The names come from the file the reload opens.
 * Never rejects: the restore has committed and nothing may roll it back.
 */
async function deleteUnnamedLibraryFiles(
  libraryFiles: Pick<LibraryFileStore, 'deleteUnnamedFiles'>,
): Promise<void> {
  let restored: SQLite.SQLiteDatabase | null = null;
  try {
    restored = await SQLite.openDatabaseAsync(APP_DATABASE_NAME, {
      useNewConnection: true,
    });
    const rows = await restored.getAllAsync<{ uri: string }>(
      RESTORED_LIBRARY_FILE_URIS_SQL,
    );
    await closeQuietly(restored);
    restored = null;
    await libraryFiles.deleteUnnamedFiles(rows.map((row) => row.uri));
  } catch {
    // Left on disk; 删除全部应用数据 clears it.
  } finally {
    await closeQuietly(restored);
  }
}

async function assertHealthyDatabase(database: SQLite.SQLiteDatabase): Promise<void> {
  const integrity = await database.getFirstAsync<IntegrityRow>(
    'PRAGMA quick_check',
  );
  if (integrity?.quick_check !== 'ok') throw new Error('Backup database is damaged.');
}

async function safeImagePredicateFor(
  database: Pick<SQLite.SQLiteDatabase, 'getAllAsync'>,
): Promise<string> {
  const columns = await database.getAllAsync<ColumnRow>(
    'PRAGMA table_info(images)',
  );
  return columns.some(({ name }) => name === 'content_rating')
    ? STRICT_SAFE_IMAGE_PREDICATE
    : 'is_nsfw = 0';
}

async function replaceAppDatabase(
  sourceDatabase: SQLite.SQLiteDatabase,
): Promise<void> {
  const destination = await SQLite.openDatabaseAsync(APP_DATABASE_NAME, {
    useNewConnection: true,
  });
  try {
    await SQLite.backupDatabaseAsync({
      sourceDatabase,
      sourceDatabaseName: SQLITE_DATABASE_NAME,
      destDatabase: destination,
      destDatabaseName: SQLITE_DATABASE_NAME,
    });
  } finally {
    await destination.closeAsync();
  }
}

type QuerySource = {
  getFirst<T>(query: string, params?: readonly never[]): Promise<T | null>;
  getAll<T>(query: string, params?: readonly never[]): Promise<T[]>;
};

function querySourceFromSqlite(db: SQLite.SQLiteDatabase): QuerySource {
  return {
    getFirst: <T>(query: string, params?: readonly never[]) => (
      params === undefined
        ? db.getFirstAsync<T>(query)
        : db.getFirstAsync<T>(query, params as unknown as SQLite.SQLiteBindParams)
    ),
    getAll: <T>(query: string, params?: readonly never[]) => (
      params === undefined
        ? db.getAllAsync<T>(query)
        : db.getAllAsync<T>(query, params as unknown as SQLite.SQLiteBindParams)
    ),
  };
}

async function hasTable(source: QuerySource, tableName: string): Promise<boolean> {
  try {
    const columns = await source.getAll<ColumnRow>(
      `PRAGMA table_info(${tableName})`,
    );
    return columns.length > 0;
  } catch {
    return false;
  }
}

async function ensureRestoredImportColumns(
  restoredDatabase: SQLite.SQLiteDatabase,
  libraryColumns: readonly ColumnRow[],
): Promise<boolean> {
  if (libraryColumns.length === 0) return false;
  const names = new Set(libraryColumns.map(({ name }) => name));
  if (!names.has('import_classification')) {
    await restoredDatabase.runAsync(
      `ALTER TABLE device_library_assets
         ADD COLUMN import_classification TEXT NOT NULL DEFAULT 'unknown'`,
    );
  }
  if (!names.has('import_deleted_at')) {
    await restoredDatabase.runAsync(
      'ALTER TABLE device_library_assets ADD COLUMN import_deleted_at INTEGER',
    );
  }
  return true;
}

function restoredFile(
  repository: CollectionFileRepository,
  namespace: string,
  manifest: BackupManifest,
  image: Pick<SavedFileRow, 'id' | 'extension'>,
): File {
  const normalPath = new File(repository.pathFor(image));
  normalPath.parentDirectory.create({ idempotent: true, intermediates: true });
  return new File(
    normalPath.parentDirectory,
    `${namespace}-${restoreFileName(manifest.createdAt, image.id, image.extension)}`,
  );
}

function restoredImportStageFile(
  repository: CollectionFileRepository,
  namespace: string,
  manifest: BackupManifest,
  plaintextSha256: string,
  extension: string,
): File {
  const anchor = new File(repository.pathFor({ id: 0, extension: 'jpg' }));
  anchor.parentDirectory.create({ idempotent: true, intermediates: true });
  return new File(
    anchor.parentDirectory,
    restoreImportStageFileName(namespace, manifest.createdAt, plaintextSha256, extension),
  );
}

function canonicalLibraryExtension(extension: string): LibraryCanonicalExtension {
  const normalized = safeBackupExtension(extension);
  if (normalized === 'png' || normalized === 'webp' || normalized === 'gif') {
    return normalized;
  }
  return 'jpg';
}

function resolveImportOriginalUri(
  libraryFiles: BackupLibraryFilesPort | undefined,
  repository: CollectionFileRepository,
  plaintextSha256: string,
  extension: string,
): string {
  const canonicalExt = canonicalLibraryExtension(extension);
  if (typeof libraryFiles?.originalUriFor === 'function') {
    return libraryFiles.originalUriFor(plaintextSha256, canonicalExt);
  }
  const anchor = new File(repository.pathFor({ id: 0, extension: canonicalExt }));
  const parentUri = anchor.parentDirectory.uri.replace(/\/$/u, '');
  const rootUri = parentUri.endsWith('/collection')
    ? `${parentUri.slice(0, -'/collection'.length)}/library/originals`
    : `${parentUri}/library-originals`;
  return `${rootUri}/${plaintextSha256}.${canonicalExt}`;
}

function nextRestoreNamespace(): string {
  restoreNamespaceSequence += 1;
  return `restore-stage-${Date.now().toString(36)}-${restoreNamespaceSequence.toString(36)}`;
}

async function createArchiveSchema(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(BACKUP_ARCHIVE_SCHEMA_SQL);
}

type StagedImportAdoption = {
  plaintextSha256: string;
  stageFile: File;
  finalFile: File;
};

type RollbackOriginalBackup = {
  finalFile: File;
  backupFile: File;
};

export function createAppBackupService({
  database,
  settingsRepository,
  fileRepository,
  libraryFiles,
  copyArchivedFile,
  copyArchivedImportFile,
  appVersion = Constants.expoConfig?.version ?? '1.0.0',
  allowsAdultContent = APP_DISTRIBUTION_POLICY.allowsAdultContent,
}: BackupServiceInput): AppBackupService {
  const distributionPolicy = allowsAdultContent
    ? DIRECT_DISTRIBUTION_POLICY
    : STORE_DISTRIBUTION_POLICY;

  async function createArchive(): Promise<PreparedAppBackup> {
    const createdAt = Date.now();
    const name = archiveName(createdAt);
    let archive: SQLite.SQLiteDatabase | null = null;
    const archiveFile = databaseFile(name);
    deleteIfPresent(archiveFile);

    let source: SQLite.SQLiteDatabase | null = null;
    let snapshot: SQLite.SQLiteDatabase | null = null;
    const snapshotName = backupSnapshotName(createdAt);
    let completed = false;
    let stage = 'opening the app database';
    try {
      source = await SQLite.openDatabaseAsync(APP_DATABASE_NAME, {
        useNewConnection: true,
      });
      stage = 'creating a portable app database snapshot';
      deleteDatabaseArtifacts(snapshotName);
      snapshot = await SQLite.openDatabaseAsync(snapshotName);
      await SQLite.backupDatabaseAsync({
        sourceDatabase: source,
        sourceDatabaseName: SQLITE_DATABASE_NAME,
        destDatabase: snapshot,
        destDatabaseName: SQLITE_DATABASE_NAME,
      });

      const snapshotSource = querySourceFromSqlite(snapshot);
      const snapshotHasImages = await hasTable(snapshotSource, 'images');
      const snapshotHasLibrary = await hasTable(snapshotSource, 'device_library_assets');

      if (!allowsAdultContent) {
        await snapshot.runAsync(
          `DELETE FROM images WHERE NOT (${STRICT_SAFE_IMAGE_PREDICATE})`,
        );
        if (snapshotHasLibrary) {
          await snapshot.runAsync(
            `DELETE FROM device_library_assets
              WHERE origin = 'import' AND import_classification <> 'safe'`,
          );
        }
      }
      await snapshot.execAsync('PRAGMA journal_mode = DELETE; VACUUM;');
      const databaseBytes = await snapshot.serializeAsync();

      // N6-D (spec §4.10): read counts and file records from the coordinated
      // snapshot when it is a real SQLite database; fall back to `database` in
      // unit-test harnesses whose snapshot double carries no tables.
      const reader: QuerySource = snapshotHasImages ? snapshotSource : database;
      const hasLibraryTable = snapshotHasImages
        ? snapshotHasLibrary
        : await hasTable(database, 'device_library_assets');

      stage = 'reading settings and collection records';
      const settings = await settingsRepository.load();
      const portableSettings = normalizeSettings(settings, distributionPolicy);
      const visible = allowsAdultContent ? '1 = 1' : STRICT_SAFE_IMAGE_PREDICATE;
      const imageCountRow = await reader.getFirst<{ count: number }>(
        `SELECT COUNT(*) AS count FROM images
         WHERE ${visible}`,
      );
      // §5.3: count a saved row when it could carry an archive file. A mirrored
      // row can, once its library original is on this phone and not flagged.
      const savedImageCountRow = await reader.getFirst<{ count: number }>(
        `SELECT COUNT(*) AS count FROM images
         WHERE ${visible} AND decision = 'saved'
           AND (download_state <> 'mirrored' OR (${LOCAL_LIBRARY_ORIGINAL}) IS NOT NULL)`,
      );
      const savedFiles = await reader.getAll<SavedFileRow>(`
        SELECT id, extension, local_uri FROM images
         WHERE ${visible} AND decision = 'saved' AND download_state = 'ready' AND local_uri IS NOT NULL
        UNION ALL
        SELECT id, extension, (${LOCAL_LIBRARY_ORIGINAL}) AS local_uri FROM images
         WHERE ${visible} AND decision = 'saved' AND download_state = 'mirrored'
           AND (${LOCAL_LIBRARY_ORIGINAL}) IS NOT NULL
        ORDER BY id
      `);
      // Board #27 S4 (spec §5.3, O3): the mirrored rows the branch above leaves
      // out (no unflagged local original, a flagged one or no library row at
      // all), and of those the ones whose original the last cloud library
      // holds. The rest are missing, so every saved image is accounted for.
      const omittedRow = await reader.getFirst<{ omitted: number; cloud: number }>(
        `SELECT COUNT(*) AS omitted,
                COALESCE(SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM device_library_assets b
                    JOIN library_asset_protection p
                      ON p.plaintext_sha256 = b.plaintext_sha256
                   WHERE (
                     b.source_image_id = images.id
                     OR EXISTS (
                       SELECT 1 FROM sqlite_master sm
                        WHERE sm.type = 'table' AND sm.name = 'library_provider_image_assets'
                          AND EXISTS (
                            SELECT 1 FROM library_provider_image_assets m
                             WHERE m.image_id = images.id
                               AND m.plaintext_sha256 = b.plaintext_sha256
                          )
                     )
                   )
                     AND p.account_scope = (${LAST_ACCOUNT_SCOPE_SQL})
                     AND p.original_generation_id IS NOT NULL
                ) THEN 1 ELSE 0 END), 0) AS cloud
           FROM images
          WHERE ${visible} AND decision = 'saved' AND download_state = 'mirrored'
            AND (${LOCAL_LIBRARY_ORIGINAL}) IS NULL`,
      );

      let importRows: ImportExportRow[] = [];
      if (hasLibraryTable) {
        const importVisible = allowsAdultContent
          ? '1 = 1'
          : "a.import_classification = 'safe'";
        importRows = await reader.getAll<ImportExportRow>(`
          SELECT a.plaintext_sha256,
                 a.canonical_extension,
                 a.residency,
                 a.local_original_uri,
                 a.missing_original_since,
                 CASE WHEN EXISTS (
                   SELECT 1 FROM library_asset_protection p
                    WHERE p.plaintext_sha256 = a.plaintext_sha256
                      AND p.account_scope = (${LAST_ACCOUNT_SCOPE_SQL})
                      AND p.original_generation_id IS NOT NULL
                 ) THEN 1 ELSE 0 END AS has_cloud
            FROM device_library_assets a
            LEFT JOIN library_device_asset_state d
              ON d.plaintext_sha256 = a.plaintext_sha256
            LEFT JOIN library_asset_protection lp
              ON lp.plaintext_sha256 = a.plaintext_sha256
             AND lp.account_scope = (${LAST_ACCOUNT_SCOPE_SQL})
           WHERE a.origin = 'import'
             AND a.import_deleted_at IS NULL
             AND d.device_trashed_at IS NULL
             AND (lp.lifecycle IS NULL OR lp.lifecycle = 'active')
             AND (${importVisible})
           ORDER BY a.created_at DESC, a.plaintext_sha256 ASC
        `);
      }

      await closeQuietly(snapshot);
      snapshot = null;
      deleteDatabaseArtifacts(snapshotName);

      stage = 'creating the backup archive';
      archive = await SQLite.openDatabaseAsync(name);
      await createArchiveSchema(archive);
      const archiveDb = archive;
      await archive.runAsync(
        'INSERT INTO backup_payload (key, blob_value) VALUES (?, ?)',
        [PAYLOAD_DATABASE, databaseBytes],
      );
      await archive.runAsync(
        'INSERT INTO backup_payload (key, text_value) VALUES (?, ?)',
        [PAYLOAD_SETTINGS, JSON.stringify(portableSettings)],
      );

      let providerFileCount = 0;
      let importFileCount = 0;
      let totalFileBytes = 0;
      let importMissingFileCount = 0;
      let importCloudOnlyCount = 0;

      // K7 ㉛ + N6-D: one transaction packs both provider saved files and
      // active import originals (`backup_import_files`).
      await archiveDb.withTransactionAsync(async () => {
        for (const image of savedFiles) {
          stage = `packing collection image ${image.id}`;
          if (image.local_uri === null) continue;
          const file = new File(image.local_uri);
          if (!file.exists) continue;
          const bytes = await file.bytes();
          await archiveDb.runAsync(
            `INSERT INTO backup_files (image_id, extension, byte_size, data)
             VALUES (?, ?, ?, ?)`,
            [image.id, safeBackupExtension(image.extension), bytes.byteLength, bytes],
          );
          providerFileCount += 1;
          totalFileBytes += bytes.byteLength;
        }

        for (const imp of importRows) {
          stage = `packing imported image ${imp.plaintext_sha256}`;
          const canPackLocal = imp.residency === 'local-original'
            && imp.local_original_uri !== null
            && imp.missing_original_since === null;
          if (!canPackLocal) {
            if (imp.has_cloud === 1) {
              importCloudOnlyCount += 1;
            } else {
              importMissingFileCount += 1;
            }
            continue;
          }
          const file = new File(imp.local_original_uri!);
          if (!file.exists) {
            if (imp.has_cloud === 1) {
              importCloudOnlyCount += 1;
            } else {
              importMissingFileCount += 1;
            }
            continue;
          }
          const bytes = await file.bytes();
          if (bytes.byteLength <= 0) {
            if (imp.has_cloud === 1) {
              importCloudOnlyCount += 1;
            } else {
              importMissingFileCount += 1;
            }
            continue;
          }
          await archiveDb.runAsync(
            `INSERT INTO backup_import_files (plaintext_sha256, extension, byte_size, data)
             VALUES (?, ?, ?, ?)`,
            [
              imp.plaintext_sha256,
              safeBackupExtension(imp.canonical_extension),
              bytes.byteLength,
              bytes,
            ],
          );
          importFileCount += 1;
          totalFileBytes += bytes.byteLength;
        }
      });

      const fileCount = providerFileCount + importFileCount;
      const importCount = importRows.length;
      const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        applicationId: BACKUP_APPLICATION_ID,
        appVersion,
        createdAt,
        imageCount: imageCountRow?.count ?? 0,
        fileCount,
        totalFileBytes,
        importCount,
      };
      await archive.runAsync(
        `INSERT INTO backup_manifest (
           format_version, application_id, app_version, created_at,
           image_count, file_count, total_file_bytes, import_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          manifest.formatVersion,
          manifest.applicationId,
          manifest.appVersion,
          manifest.createdAt,
          manifest.imageCount,
          manifest.fileCount,
          manifest.totalFileBytes,
          manifest.importCount ?? 0,
        ],
      );
      stage = 'closing the backup archive';
      await closeQuietly(archive);
      archive = null;

      const providerMissing = Math.max(
        0,
        (savedImageCountRow?.count ?? savedFiles.length) - providerFileCount,
      ) + ((omittedRow?.omitted ?? 0) - (omittedRow?.cloud ?? 0));
      const summary: BackupSummary = {
        ...manifest,
        missingFileCount: providerMissing + importMissingFileCount,
        cloudOnlyCount: (omittedRow?.cloud ?? 0) + importCloudOnlyCount,
      };
      completed = true;
      let disposed = false;
      return {
        summary,
        uri: archiveFile.uri,
        async dispose() {
          if (disposed) return;
          deleteIfPresent(archiveFile);
          disposed = true;
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Backup failed while ${stage}: ${detail}`);
    } finally {
      await closeQuietly(archive);
      await closeQuietly(snapshot);
      await closeQuietly(source);
      deleteDatabaseArtifacts(snapshotName);
      if (!completed) {
        deleteIfPresent(archiveFile);
        deleteIfPresent(databaseFile(`${name}-journal`));
      }
    }
  }

  async function prepareRestoreFromFile(
    sourceFile: Pick<File, 'copy'>,
  ): Promise<PreparedAppRestore> {
      if (!allowsAdultContent) {
        throw new Error(
          'Full backup restore is unavailable in the Store distribution.',
        );
      }

      const importedName = restoreImportName(Date.now());
      const importedFile = databaseFile(importedName);
      deleteIfPresent(importedFile);

      let archive: SQLite.SQLiteDatabase | null = null;
      let restoredDatabase: SQLite.SQLiteDatabase | null = null;
      const stagedFiles: File[] = [];
      const stagedImports: StagedImportAdoption[] = [];
      const restoreNamespace = nextRestoreNamespace();
      let stage = 'copying the selected backup';
      try {
        await sourceFile.copy(importedFile, { overwrite: true });
        stage = 'opening the selected backup';
        archive = await SQLite.openDatabaseAsync(importedName);
        stage = 'reading the backup manifest';
        const manifest = parseBackupManifest(
          await archive.getFirstAsync(`SELECT * FROM backup_manifest LIMIT 1`),
        );
        stage = 'checking the backup archive';
        // K7 ㉜ + N6-D: compare the archive's row count against manifest.fileCount.
        // For v2 archives, manifest.fileCount is the combined count across
        // `backup_files` and `backup_import_files`.
        const storedProviderFiles = await archive.getFirstAsync<{ count: number }>(
          'SELECT COUNT(*) AS count FROM backup_files',
        );
        let hasImportFilesTable = false;
        let storedImportCount = 0;
        if (manifest.formatVersion >= 2) {
          const tableRow = await archive.getFirstAsync<TableRow>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_import_files'",
          );
          if (tableRow !== null) {
            hasImportFilesTable = true;
            const storedImports = await archive.getFirstAsync<{ count: number }>(
              'SELECT COUNT(*) AS count FROM backup_import_files',
            );
            storedImportCount = storedImports?.count ?? 0;
          } else {
            const probeCount = await archive
              .getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM backup_import_files')
              .catch(() => null);
            if (probeCount !== null && typeof probeCount.count === 'number') {
              hasImportFilesTable = true;
              storedImportCount = probeCount.count;
            }
          }
        }
        const totalStoredFiles = (storedProviderFiles?.count ?? 0) + storedImportCount;
        if (totalStoredFiles !== manifest.fileCount) {
          throw new Error(
            `Backup archive is incomplete (${totalStoredFiles} of ${manifest.fileCount} images).`,
          );
        }
        stage = 'reading backup settings';
        const settingsPayload = await archive.getFirstAsync<PayloadRow>(
          'SELECT text_value, blob_value FROM backup_payload WHERE key = ?',
          [PAYLOAD_SETTINGS],
        );
        if (settingsPayload?.text_value === null || settingsPayload === null) {
          throw new Error('Backup settings are missing.');
        }
        const restoredSettings = normalizeSettings(
          JSON.parse(settingsPayload.text_value),
          distributionPolicy,
        );
        stage = 'reading the app database snapshot';
        const databasePayload = await archive.getFirstAsync<PayloadRow>(
          'SELECT text_value, blob_value FROM backup_payload WHERE key = ?',
          [PAYLOAD_DATABASE],
        );
        const databaseBytes = sqliteBlob(databasePayload?.blob_value, 'database');
        stage = 'opening the app database snapshot';
        restoredDatabase = await SQLite.deserializeDatabaseAsync(databaseBytes);
        stage = 'checking the app database snapshot';
        await assertHealthyDatabase(restoredDatabase);
        stage = 'reading the app database version';
        const databaseVersion = await restoredDatabase.getFirstAsync<VersionRow>(
          'PRAGMA user_version',
        );
        if (
          !Number.isInteger(databaseVersion?.user_version)
          || databaseVersion!.user_version < 1
          || databaseVersion!.user_version > DATABASE_VERSION
        ) {
          throw new Error('Backup database version is not supported.');
        }

        let removedAdultImageCount = 0;
        if (!allowsAdultContent) {
          stage = 'removing adult content unsupported by this distribution';
          const safeImagePredicate = await safeImagePredicateFor(restoredDatabase);
          const adultCount = await restoredDatabase.getFirstAsync<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM images
             WHERE NOT (${safeImagePredicate})`,
          );
          removedAdultImageCount = adultCount?.count ?? 0;
          await restoredDatabase.runAsync(
            `DELETE FROM images WHERE NOT (${safeImagePredicate})`,
          );
        }

        // Board #27 S2 (spec §5.9, R25): thumbnails are never restored.
        stage = 'clearing local thumbnail records';
        const libraryColumns = await restoredDatabase.getAllAsync<ColumnRow>(
          'PRAGMA table_info(device_library_assets)',
        );
        if (libraryColumns.some(({ name }) => name === 'local_thumbnail_uri')) {
          await restoredDatabase.runAsync(RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL);
        }

        const hasDeviceLibraryAssets = await ensureRestoredImportColumns(
          restoredDatabase,
          libraryColumns,
        );
        if (
          hasDeviceLibraryAssets
          && libraryColumns.some(({ name }) => name === 'local_original_uri')
        ) {
          // N6-D (spec §5): clear stale/foreign local_original_uri values from
          // the snapshot before restoring archived files, so another device's
          // path is never trusted or reported restored.
          await restoredDatabase.runAsync(RESTORE_CLEAR_STALE_IMPORT_ORIGINALS_SQL);
        }

        stage = 'reading saved image records';
        // §5.3: an archived file, mirrored rows included, is restored as a
        // ready collection file. With no archived file, a mirrored row keeps
        // its state — its original was not archived (cloud-only, or gone from
        // the phone); the library view resolves it. Any other row with no file
        // is backup_file_missing.
        const savedImages = await restoredDatabase.getAllAsync<
          SavedFileRow & { download_state: string }
        >(RESTORE_SAVED_IMAGES_SQL);
        let restoredProviderFileCount = 0;
        let keptMirrored = 0;
        for (const image of savedImages) {
          stage = `restoring collection image ${image.id}`;
          const archivedFile = await archive.getFirstAsync<ArchiveFileRow>(
            `SELECT extension, byte_size${copyArchivedFile === undefined ? ', data' : ''}
             FROM backup_files
             WHERE image_id = ?`,
            [image.id],
          );
          if (archivedFile === null) {
            if (image.download_state === 'mirrored') {
              keptMirrored += 1;
              continue;
            }
            // Board #5: a missing backup file is a backup problem, not a dead
            // source, so record 'transient' — the sweep then gives the source
            // one more attempt instead of skipping it as permanently gone.
            await restoredDatabase.runAsync(
              `UPDATE images
               SET local_uri = NULL,
                   download_state = 'failed',
                   download_error = 'backup_file_missing',
                   download_error_kind = 'transient'
               WHERE id = ?`,
              [image.id],
            );
            continue;
          }

          let bytes: Uint8Array | undefined;
          if (copyArchivedFile === undefined) {
            bytes = sqliteBlob(archivedFile.data, `image ${image.id}`);
            if (bytes.byteLength !== archivedFile.byte_size) {
              throw new Error(`Backup image ${image.id} is incomplete.`);
            }
          }
          const destination = restoredFile(fileRepository, restoreNamespace, manifest, {
            id: image.id,
            extension: archivedFile.extension,
          });
          if (destination.exists) {
            throw new Error(`Restore staging path already exists for image ${image.id}.`);
          }
          stagedFiles.push(destination);
          destination.create({ overwrite: true, intermediates: true });
          if (copyArchivedFile === undefined) {
            destination.write(bytes!);
          } else if (archivedFile.byte_size !== 0) {
            const written = await copyArchivedFile(
              importedFile.uri,
              image.id,
              destination.uri,
            );
            if (written !== archivedFile.byte_size) {
              throw new Error(`Backup image ${image.id} is incomplete.`);
            }
          }
          restoredProviderFileCount += 1;
          // Board #5 §4 invariant: any write that clears download_error must
          // also clear download_error_kind, so no stale kind survives the
          // ready transition.
          await restoredDatabase.runAsync(
            `UPDATE images
             SET local_uri = ?,
                 download_state = 'ready',
                 download_error = NULL,
                 download_error_kind = NULL
             WHERE id = ?`,
            [destination.uri, image.id],
          );
        }

        let restoredImportFileCount = 0;
        let missingImportFileCount = 0;
        if (manifest.formatVersion >= 2 && hasDeviceLibraryAssets) {
          stage = 'reading imported image records';
          let importRecords: RestoreImportRow[] = [];
          try {
            importRecords = await restoredDatabase.getAllAsync<RestoreImportRow>(`
              SELECT a.plaintext_sha256,
                     a.canonical_extension,
                     a.residency,
                     a.local_original_uri,
                     a.missing_original_since,
                     a.created_at,
                     CASE WHEN EXISTS (
                       SELECT 1 FROM library_asset_protection p
                        WHERE p.plaintext_sha256 = a.plaintext_sha256
                          AND p.account_scope = (${LAST_ACCOUNT_SCOPE_SQL})
                          AND p.original_generation_id IS NOT NULL
                     ) THEN 1 ELSE 0 END AS has_cloud
                FROM device_library_assets a
                LEFT JOIN library_device_asset_state d
                  ON d.plaintext_sha256 = a.plaintext_sha256
                LEFT JOIN library_asset_protection lp
                  ON lp.plaintext_sha256 = a.plaintext_sha256
                 AND lp.account_scope = (${LAST_ACCOUNT_SCOPE_SQL})
               WHERE a.origin = 'import'
                 AND a.import_deleted_at IS NULL
                 AND d.device_trashed_at IS NULL
                 AND (lp.lifecycle IS NULL OR lp.lifecycle = 'active')
               ORDER BY a.created_at DESC, a.plaintext_sha256 ASC
            `);
          } catch {
            importRecords = [];
          }

          for (const imp of importRecords) {
            const digest = imp.plaintext_sha256;
            stage = `restoring imported image ${digest}`;
            if (!isValidBackupDigest(digest)) {
              throw new Error(`Backup import digest is invalid: ${String(digest)}.`);
            }
            const archivedImport = hasImportFilesTable
              ? await archive.getFirstAsync<ArchiveFileRow>(
                `SELECT extension, byte_size${copyArchivedImportFile === undefined ? ', data' : ''}
                 FROM backup_import_files
                 WHERE plaintext_sha256 = ?`,
                [digest],
              )
              : null;

            if (archivedImport === null) {
              if (imp.has_cloud === 1) {
                await restoredDatabase.runAsync(
                  `UPDATE device_library_assets
                      SET local_original_uri = NULL,
                          residency = 'cloud-only',
                          missing_original_since = NULL
                    WHERE plaintext_sha256 = ?`,
                  [digest],
                );
              } else {
                missingImportFileCount += 1;
                await restoredDatabase.runAsync(
                  `UPDATE device_library_assets
                      SET local_original_uri = NULL,
                          missing_original_since = COALESCE(missing_original_since, ?)
                    WHERE plaintext_sha256 = ?`,
                  [imp.created_at, digest],
                );
              }
              continue;
            }

            if (
              !Number.isInteger(archivedImport.byte_size)
              || archivedImport.byte_size <= 0
            ) {
              throw new Error(`Backup imported image ${digest} is incomplete.`);
            }

            let bytes: Uint8Array | undefined;
            if (copyArchivedImportFile === undefined) {
              bytes = sqliteBlob(archivedImport.data, `import ${digest}`);
              if (bytes.byteLength !== archivedImport.byte_size) {
                throw new Error(`Backup imported image ${digest} is incomplete.`);
              }
              const computedDigest = sha256PlaintextHex(bytes);
              if (computedDigest !== digest) {
                throw new Error(
                  `Backup imported image ${digest} failed integrity verification.`,
                );
              }
            }

            const stageFile = restoredImportStageFile(
              fileRepository,
              restoreNamespace,
              manifest,
              digest,
              archivedImport.extension,
            );
            if (stageFile.exists) {
              throw new Error(
                `Restore staging path already exists for imported image ${digest}.`,
              );
            }
            stagedFiles.push(stageFile);
            stageFile.create({ overwrite: true, intermediates: true });

            if (copyArchivedImportFile === undefined) {
              stageFile.write(bytes!);
            } else {
              const result = await copyArchivedImportFile(
                importedFile.uri,
                digest,
                stageFile.uri,
              );
              if (result.bytesWritten !== archivedImport.byte_size) {
                throw new Error(`Backup imported image ${digest} is incomplete.`);
              }
              if (result.plaintextSha256 !== digest) {
                throw new Error(
                  `Backup imported image ${digest} failed integrity verification.`,
                );
              }
            }

            const finalOriginalUri = resolveImportOriginalUri(
              libraryFiles,
              fileRepository,
              digest,
              imp.canonical_extension || archivedImport.extension,
            );
            stagedImports.push({
              plaintextSha256: digest,
              stageFile,
              finalFile: new File(finalOriginalUri),
            });
            restoredImportFileCount += 1;

            await restoredDatabase.runAsync(
              `UPDATE device_library_assets
                  SET local_original_uri = ?,
                      residency = 'local-original',
                      missing_original_since = NULL
                WHERE plaintext_sha256 = ?`,
              [finalOriginalUri, digest],
            );
          }
        }

        const providerMissingCount =
          savedImages.length - restoredProviderFileCount - keptMirrored;
        const summary: RestoreSummary = {
          ...manifest,
          restoredFileCount: restoredProviderFileCount + restoredImportFileCount,
          missingFileCount: providerMissingCount + missingImportFileCount,
          removedAdultImageCount,
        };

        await archive.closeAsync();
        archive = null;
        deleteIfPresent(importedFile);

        let applied = false;
        let disposed = false;
        const dispose = async () => {
          if (disposed) return;
          disposed = true;
          await closeQuietly(restoredDatabase);
          restoredDatabase = null;
          if (!applied) {
            for (const file of stagedFiles) deleteIfPresent(file);
          } else {
            // Ensure any leftover stage files for imports are gone.
            for (const item of stagedImports) deleteIfPresent(item.stageFile);
          }
          deleteIfPresent(importedFile);
        };

        return {
          summary,
          async apply() {
            if (disposed || restoredDatabase === null) {
              throw new Error('Prepared backup has already been disposed.');
            }
            let originalDatabaseBytes: Uint8Array | null = null;
            let originalSettings: AppSettings | null = null;
            let replacementStarted = false;
            const rollbackOriginals: RollbackOriginalBackup[] = [];
            const adoptedFinalFiles: File[] = [];
            try {
              originalSettings = await settingsRepository.load();
              const currentDatabase = await SQLite.openDatabaseAsync(APP_DATABASE_NAME, {
                useNewConnection: true,
              });
              try {
                originalDatabaseBytes = await currentDatabase.serializeAsync();
              } finally {
                await currentDatabase.closeAsync();
              }
              replacementStarted = true;
              await replaceAppDatabase(restoredDatabase);
              await settingsRepository.save(restoredSettings);

              // N6-D (spec §4.10, §5): promote staged import originals into
              // `originals/<sha256>.<ext>` only inside `apply()`, preserving any
              // pre-existing live file of the same digest for rollback if an
              // adoption step fails.
              for (const item of stagedImports) {
                item.finalFile.parentDirectory.create({
                  idempotent: true,
                  intermediates: true,
                });
                if (item.finalFile.exists) {
                  const backupFile = new File(
                    item.stageFile.parentDirectory,
                    `${restoreNamespace}-rollback-orig-${item.plaintextSha256}`,
                  );
                  deleteIfPresent(backupFile);
                  await item.finalFile.copy(backupFile);
                  rollbackOriginals.push({
                    finalFile: item.finalFile,
                    backupFile,
                  });
                } else {
                  adoptedFinalFiles.push(item.finalFile);
                }
                await item.stageFile.copy(item.finalFile);
                deleteIfPresent(item.stageFile);
              }

              applied = true;
              for (const backup of rollbackOriginals) {
                deleteIfPresent(backup.backupFile);
              }

              const stagedProviderUris = stagedFiles
                .filter((file) => !stagedImports.some((imp) => imp.stageFile.uri === file.uri))
                .map((file) => file.uri);
              await fileRepository.reconcile(stagedProviderUris).catch(() => undefined);
              if (libraryFiles !== undefined) {
                await deleteUnnamedLibraryFiles(libraryFiles);
              }
              return restoredSettings;
            } catch (error) {
              for (const created of adoptedFinalFiles) {
                try {
                  deleteIfPresent(created);
                } catch {
                  // Best-effort rollback cleanup.
                }
              }
              for (const backup of rollbackOriginals) {
                try {
                  if (backup.backupFile.exists) {
                    await backup.backupFile.copy(backup.finalFile);
                    deleteIfPresent(backup.backupFile);
                  }
                } catch {
                  // Best-effort rollback restoration.
                }
              }
              if (
                !replacementStarted
                || originalDatabaseBytes === null
                || originalSettings === null
              ) {
                throw error;
              }
              const originalDatabase = await SQLite.deserializeDatabaseAsync(
                originalDatabaseBytes,
              );
              try {
                await replaceAppDatabase(originalDatabase);
                await settingsRepository.save(originalSettings);
              } finally {
                await originalDatabase.closeAsync();
              }
              throw error;
            } finally {
              await dispose();
            }
          },
          dispose,
        };
      } catch (error) {
        await closeQuietly(archive);
        await closeQuietly(restoredDatabase);
        for (const file of stagedFiles) deleteIfPresent(file);
        deleteIfPresent(importedFile);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Restore failed while ${stage}: ${detail}`);
      }
  }

  return {
    createArchive,

    async createAndShare() {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('File sharing is unavailable on this device.');
      }
      const prepared = await createArchive();
      try {
        await Sharing.shareAsync(prepared.uri, {
          dialogTitle: i18n.t('settings.backup.shareTitle'),
          mimeType: 'application/octet-stream',
        });
        return prepared.summary;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Backup failed while opening the Android share sheet: ${detail}`,
        );
      } finally {
        await prepared.dispose();
      }
    },

    async prepareRestoreFromUri(uri: string) {
      return prepareRestoreFromFile(new File(uri));
    },

    async pickAndPrepareRestore() {
      if (!allowsAdultContent) {
        throw new Error(
          'Full backup restore is unavailable in the Store distribution.',
        );
      }
      const selection = await File.pickFileAsync({
        mimeTypes: '*/*',
        multipleFiles: false,
      });
      if (selection.canceled) return null;
      return prepareRestoreFromFile(selection.result);
    },
  };
}
