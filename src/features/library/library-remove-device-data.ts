import type { SqlDatabasePort } from '@/db/sql-port';
import { clearAccountProjection } from '@/features/library/library-account-projection';
import type { LibraryProtection } from '@/features/library/library-actions-types';

export type RemoveDeviceDataRow = Readonly<{
  plaintextSha256: string;
  localOriginalUri: string | null;
  protection: LibraryProtection | null;
  exportedAt: number | null;
}>;

export type RemoveDeviceDataAssessment = Readonly<{
  affectedOriginals: number;
  unprotectedCount: number;
  unprotectedDigests: readonly string[];
}>;

export type RemoveDeviceDataResult =
  | { status: 'blocked'; unprotectedCount: number }
  | { status: 'removed'; deletedOriginals: number };

export function assessRemoveDeviceData(input: Readonly<{
  rows: readonly RemoveDeviceDataRow[];
}>): RemoveDeviceDataAssessment {
  const affected = input.rows.filter((r) => r.localOriginalUri !== null);
  const unprotected = affected.filter(
    (r) => r.protection !== 'protected' && r.exportedAt === null,
  );
  return {
    affectedOriginals: affected.length,
    unprotectedCount: unprotected.length,
    unprotectedDigests: unprotected.map((r) => r.plaintextSha256),
  };
}

export async function listRemoveDeviceDataRows(
  database: SqlDatabasePort,
  accountScope: string,
): Promise<readonly RemoveDeviceDataRow[]> {
  const rows = await database.getAll<{
    plaintext_sha256: string;
    local_original_uri: string | null;
    protection: string | null;
    exported_at: number | null;
  }>(
    `SELECT a.plaintext_sha256,
            a.local_original_uri,
            p.protection,
            d.exported_at
       FROM device_library_assets a
       INNER JOIN (
         SELECT plaintext_sha256 FROM library_account_assets
          WHERE account_scope = ?
         UNION
         SELECT plaintext_sha256 FROM library_asset_protection
          WHERE account_scope = ?
       ) enrolled ON enrolled.plaintext_sha256 = a.plaintext_sha256
       LEFT JOIN library_asset_protection p
         ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
       LEFT JOIN library_device_asset_state d
         ON d.plaintext_sha256 = a.plaintext_sha256
      WHERE a.local_original_uri IS NOT NULL`,
    [accountScope, accountScope, accountScope],
  );
  return rows.map((row) => ({
    plaintextSha256: row.plaintext_sha256,
    localOriginalUri: row.local_original_uri,
    protection: (row.protection as LibraryProtection | null) ?? null,
    exportedAt: row.exported_at,
  }));
}

export type RemoveAccountDataDependencies = Readonly<{
  database: SqlDatabasePort;
  accountScope: string;
  originalsRootUri: string;
  deleteOriginal(uri: string): Promise<void>;
  clearCacheScope(accountScope: string): Promise<unknown>;
  signOut(): Promise<void>;
  clock?: () => number;
}>;

/**
 * Gate + destructive path for "Remove account data from this device".
 * Never deletes when any affected original is unprotected and unexported.
 * Durable originals are deleted only when their URI sits under the originals
 * root; any other URI refuses the whole operation before any delete.
 */
export async function removeAccountDataFromThisDevice(
  deps: RemoveAccountDataDependencies,
): Promise<RemoveDeviceDataResult> {
  const rows = await listRemoveDeviceDataRows(deps.database, deps.accountScope);
  const assessment = assessRemoveDeviceData({ rows });
  if (assessment.unprotectedCount > 0) {
    return {
      status: 'blocked',
      unprotectedCount: assessment.unprotectedCount,
    };
  }

  const root = deps.originalsRootUri.endsWith('/')
    ? deps.originalsRootUri
    : `${deps.originalsRootUri}/`;
  const toDelete = rows
    .filter((row) => row.localOriginalUri !== null)
    .map((row) => row.localOriginalUri as string);

  for (const uri of toDelete) {
    if (!uri.startsWith(root) && uri !== deps.originalsRootUri) {
      throw new Error(
        'Refusing to delete a local original outside the durable originals root.',
      );
    }
  }

  for (const uri of toDelete) {
    await deps.deleteOriginal(uri);
  }

  await clearAccountProjection(deps.database, deps.accountScope);
  try {
    await deps.clearCacheScope(deps.accountScope);
  } catch {
    // Cache clear must not block remove + sign-out.
  }
  await deps.signOut();

  return { status: 'removed', deletedOriginals: toDelete.length };
}

export type MarkExportedDependencies = Readonly<{
  database: SqlDatabasePort;
  clock?: () => number;
}>;

/** Records an explicit Photos export so remove-device-data may proceed. */
export async function markExported(
  database: SqlDatabasePort,
  plaintextSha256: string,
  at: number,
): Promise<void> {
  await database.run(
    `INSERT INTO library_device_asset_state (
       plaintext_sha256, cached_roles_json, last_verified_at,
       device_trash_uri, device_trashed_at, exported_at, updated_at
     ) VALUES (?, '[]', NULL, NULL, NULL, ?, ?)
     ON CONFLICT(plaintext_sha256) DO UPDATE SET
       exported_at = excluded.exported_at,
       updated_at = excluded.updated_at`,
    [plaintextSha256, at, at],
  );
}

export async function markExportedAfterPhotosExport(
  database: SqlDatabasePort,
  plaintextSha256: string,
  at: number,
): Promise<void> {
  await markExported(database, plaintextSha256, at);
}

export type ExportUnprotectedDependencies = Readonly<{
  database: SqlDatabasePort;
  accountScope: string;
  exportToPhotos(uri: string): Promise<void>;
  clock?: () => number;
}>;

/**
 * Escape hatch: export each unprotected unexported durable original to Photos,
 * then mark `exported_at` so a later remove assessment can pass.
 */
export async function exportUnprotectedOriginals(
  deps: ExportUnprotectedDependencies,
): Promise<{ exported: number }> {
  const clock = deps.clock ?? Date.now;
  const rows = await listRemoveDeviceDataRows(deps.database, deps.accountScope);
  const assessment = assessRemoveDeviceData({ rows });
  let exported = 0;
  for (const digest of assessment.unprotectedDigests) {
    const row = rows.find((r) => r.plaintextSha256 === digest);
    const uri = row?.localOriginalUri ?? null;
    if (uri === null) continue;
    await deps.exportToPhotos(uri);
    await markExportedAfterPhotosExport(deps.database, digest, clock());
    exported += 1;
  }
  return { exported };
}
