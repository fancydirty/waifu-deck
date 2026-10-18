import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryFilePort } from '@/features/library/library-file-store';
import type { LibraryProtectionRepository } from '@/features/library/library-protection-repository';
import { isDeviceTrashExpired } from '@/features/library/library-trash-deadline';

export type LibraryDeviceTrashSweepReport = Readonly<{
  deleted: number;
  refused: number;
  failed: number;
}>;

export type LibraryDeviceTrashSweep = Readonly<{
  run(accountScope: string): Promise<LibraryDeviceTrashSweepReport>;
}>;

/**
 * Time-based purge of app-private device-trash bytes after the 30-day
 * retention window. Deletes only URIs under `files.trashRootUri`; anything
 * outside that root (including durable originals) is refused and counted.
 */
export function createLibraryDeviceTrashSweep(deps: {
  database: SqlDatabasePort;
  protection: LibraryProtectionRepository;
  /** File port: exposes `trashRootUri` and `delete`. */
  files: LibraryFilePort;
  clock?: () => number;
}): LibraryDeviceTrashSweep {
  const clock = deps.clock ?? Date.now;
  return {
    async run(_accountScope) {
      const now = clock();
      const rows = await deps.database.getAll<{
        plaintext_sha256: string;
        device_trash_uri: string;
        device_trashed_at: number;
      }>(
        `SELECT plaintext_sha256, device_trash_uri, device_trashed_at
           FROM library_device_asset_state
          WHERE device_trash_uri IS NOT NULL
            AND device_trashed_at IS NOT NULL
          ORDER BY plaintext_sha256 ASC`,
      );
      let deleted = 0;
      let refused = 0;
      let failed = 0;
      for (const row of rows) {
        if (!isDeviceTrashExpired(row.device_trashed_at, now)) continue;
        const uri = row.device_trash_uri;
        if (!uri.startsWith(deps.files.trashRootUri)) {
          refused += 1;
          continue;
        }
        try {
          await deps.files.delete(uri);
          await deps.protection.setDeviceTrash(row.plaintext_sha256, null, null);
          deleted += 1;
        } catch {
          failed += 1;
        }
      }
      return { deleted, refused, failed };
    },
  };
}
