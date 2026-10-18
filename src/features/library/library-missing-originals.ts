import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryChangeFeed } from '@/features/library/library-change-feed';
import {
  isInOriginalsDirectory,
  type LibraryFilePort,
} from '@/features/library/library-file-store';

/**
 * Spec §5.2b: the one production writer of `missing_original_since`.
 * A download or a heal that rewrites the row between the SELECT and the
 * UPDATE keeps it — the UPDATE lands only while the selected uri and
 * `updated_at` are still the row's. Originals are content-addressed, so a
 * rewrite keeps the uri and `updated_at` is the guard that matters.
 *
 * Board #27 S1a Task 7 (the gate's leg 5 rule): one `listOriginalNames()`
 * directory listing decides which candidates are present, instead of a
 * `files.exists()` stat per row. Expo's legacy `readDirectoryAsync` returns
 * entry names from one directory-level native call, so the resume pass does
 * not stat each original. Every writer of a non-NULL `local_original_uri`
 * stores the port's `resolveOriginal(name)`. A candidate the listing misses
 * inside the originals directory is probed, so a listing that comes back
 * short costs a probe, never a flag on a file the probe still finds. Out of
 * file descriptors, expo's `exists` (the port's directory guard included)
 * answers "absent" rather than failing, so the listing comes back empty; the
 * probe (`File.info()`) throws instead, which is why it is the probe. A row is
 * flagged only on a checked "absent"; a probe that throws leaves its row for
 * the next pass (Task 7 drift review and re-reviews, finding 1).
 *
 * Board #27 S1b Task 2 (spec R25): a restore brings the rows back verbatim,
 * so a backup exported under another Android user names that user's path.
 * `File.info()` throws on such a path on every pass (the permission check
 * never passes), so a probe could never flag the row. A candidate the
 * listing misses that lies outside this device's originals directory is
 * "absent" with no probe — this app can never check that path — so, once
 * flagged, mirror-down can download the original to this device's path.
 */
export function createLibraryMissingOriginals({
  database,
  files,
  changes,
  clock = Date.now,
}: Readonly<{
  database: SqlDatabasePort;
  files: Pick<LibraryFilePort, 'listOriginalNames' | 'probe' | 'originalsRootUri'>;
  changes: Pick<LibraryChangeFeed, 'emit'>;
  clock?: () => number;
}>): Readonly<{ noteMissingOriginals(): Promise<number> }> {
  return {
    async noteMissingOriginals() {
      const rows = await database.getAll<{
        plaintext_sha256: string;
        local_original_uri: string;
        updated_at: number;
      }>(
        `SELECT plaintext_sha256, local_original_uri, updated_at
           FROM device_library_assets
          WHERE residency = 'local-original' AND local_original_uri IS NOT NULL
            AND missing_original_since IS NULL
          ORDER BY plaintext_sha256`,
      );
      // Nothing to check (a cloud-only library): no directory read at all.
      if (rows.length === 0) return 0;
      let present: Set<string>;
      try {
        present = new Set(await files.listOriginalNames());
      } catch {
        // A listing that throws (a lost React context, a port error) flags
        // nothing; the next resume pass retries.
        return 0;
      }
      let flagged = 0;
      for (const row of rows) {
        const name = row.local_original_uri.slice(
          row.local_original_uri.lastIndexOf('/') + 1,
        );
        let state: 'present' | 'absent';
        const insideOriginals = isInOriginalsDirectory(
          row.local_original_uri,
          files.originalsRootUri,
        );
        if (!insideOriginals) {
          // Outside this device's originals directory (another Android
          // user's path): this app can never check it, so no probe.
          state = 'absent';
        } else if (present.has(name)) {
          continue;
        } else {
          try {
            state = await files.probe(row.local_original_uri);
          } catch {
            // No evidence either way; the next resume pass probes it again.
            continue;
          }
        }
        if (state === 'present') continue;
        const at = clock();
        const result = await database.run(
          `UPDATE device_library_assets
              SET missing_original_since = ?, updated_at = ?
            WHERE plaintext_sha256 = ? AND residency = 'local-original'
              AND local_original_uri = ? AND updated_at = ?
              AND missing_original_since IS NULL`,
          [at, at, row.plaintext_sha256, row.local_original_uri, row.updated_at],
        );
        if (result.changes > 0) {
          flagged += 1;
          changes.emit({
            kind: 'original-missing',
            plaintextSha256: row.plaintext_sha256,
          });
        }
      }
      return flagged;
    },
  };
}
