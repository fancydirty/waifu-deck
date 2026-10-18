import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryLifecycle } from '@/features/library/library-actions-types';
import type { LibraryFileStore } from '@/features/library/library-file-store';
import type { LibraryProtectionRepository } from '@/features/library/library-protection-repository';
import type {
  LibrarySyncFileAction,
  LibrarySyncReconcileReport,
} from '@/features/library/library-sync-types';
import type { LibraryCanonicalExtension } from '@/features/library/library-types';

export type LibrarySyncReconcileCandidate = Readonly<{
  plaintextSha256: string;
  lifecycle: LibraryLifecycle;
  localOriginalUri: string | null;
  deviceTrashUri: string | null;
}>;

export type LibrarySyncReconciler = Readonly<{
  /** Runs only after the account projection for this scope is durable. */
  reconcile(accountScope: string): Promise<LibrarySyncReconcileReport>;
}>;

export type LibrarySyncReconcilerDependencies = Readonly<{
  database: SqlDatabasePort;
  protection: LibraryProtectionRepository;
  files: LibraryFileStore;
  clock?: () => number;
}>;

type CandidateRow = {
  plaintext_sha256: string;
  canonical_extension: string;
  lifecycle: string;
  local_original_uri: string | null;
  device_trash_uri: string | null;
};

/**
 * Design § Trash, Restore, And Permanent Deletion, applied symmetrically on
 * every synchronized device. `trash` moves — regardless of protection, because
 * the asset must leave the normal library everywhere and a move is strictly
 * safer than the removal the design merely permits. `purge` deletes only
 * device-trash bytes. Nothing here ever deletes a durable local original.
 */
export function planLibrarySyncFileAction(
  candidate: LibrarySyncReconcileCandidate,
): LibrarySyncFileAction | null {
  if (
    candidate.lifecycle === 'trash'
    && candidate.deviceTrashUri === null
    && candidate.localOriginalUri !== null
  ) {
    return {
      kind: 'move-to-device-trash',
      plaintextSha256: candidate.plaintextSha256,
      fromUri: candidate.localOriginalUri,
    };
  }
  if (candidate.lifecycle === 'active' && candidate.deviceTrashUri !== null) {
    return {
      kind: 'restore-from-device-trash',
      plaintextSha256: candidate.plaintextSha256,
      fromUri: candidate.deviceTrashUri,
    };
  }
  if (candidate.lifecycle === 'purged' && candidate.deviceTrashUri !== null) {
    return {
      kind: 'delete-device-trash',
      plaintextSha256: candidate.plaintextSha256,
      uri: candidate.deviceTrashUri,
    };
  }
  return null;
}

export function createLibrarySyncReconciler({
  database,
  protection,
  files,
  clock = Date.now,
}: LibrarySyncReconcilerDependencies): LibrarySyncReconciler {
  return {
    async reconcile(accountScope) {
      const rows = await database.getAll<CandidateRow>(
        `SELECT p.plaintext_sha256, a.canonical_extension, p.lifecycle,
                a.local_original_uri, d.device_trash_uri
           FROM library_asset_protection p
           JOIN device_library_assets a
             ON a.plaintext_sha256 = p.plaintext_sha256
           LEFT JOIN library_device_asset_state d
             ON d.plaintext_sha256 = p.plaintext_sha256
          WHERE p.account_scope = ?
            AND (
              (p.lifecycle = 'trash'
                AND a.local_original_uri IS NOT NULL
                AND d.device_trash_uri IS NULL)
              OR (p.lifecycle = 'active' AND d.device_trash_uri IS NOT NULL)
              OR (p.lifecycle = 'purged' AND d.device_trash_uri IS NOT NULL)
            )
          ORDER BY p.asset_id ASC`,
        [accountScope],
      );

      let movedToDeviceTrash = 0;
      let restoredFromDeviceTrash = 0;
      let purgedDeviceTrash = 0;
      let refused = 0;
      let failed = 0;

      for (const row of rows) {
        const extension = row.canonical_extension as LibraryCanonicalExtension;
        const action = planLibrarySyncFileAction({
          plaintextSha256: row.plaintext_sha256,
          lifecycle: row.lifecycle as LibraryLifecycle,
          localOriginalUri: row.local_original_uri,
          deviceTrashUri: row.device_trash_uri,
        });
        if (action === null) continue;

        try {
          if (action.kind === 'move-to-device-trash') {
            const trashUri = await files.moveOriginalToDeviceTrash(
              action.fromUri,
              action.plaintextSha256,
              extension,
            );
            await protection.setDeviceTrash(
              action.plaintextSha256,
              trashUri,
              clock(),
            );
            await protection.setResidency(
              action.plaintextSha256,
              'cached',
              null,
            );
            movedToDeviceTrash += 1;
            continue;
          }

          if (action.kind === 'restore-from-device-trash') {
            const uri = await files.restoreOriginalFromDeviceTrash(
              action.fromUri,
              action.plaintextSha256,
              extension,
            );
            await protection.setResidency(
              action.plaintextSha256,
              'local-original',
              uri,
            );
            await protection.setDeviceTrash(action.plaintextSha256, null, null);
            restoredFromDeviceTrash += 1;
            continue;
          }

          // Invariant 3. The only bytes SP8 may delete are device-trash bytes.
          // A target that is, or resolves to, the durable original is refused
          // and nothing is deleted.
          const durableUri = files.originalUriFor(
            action.plaintextSha256,
            extension,
          );
          if (
            action.uri === durableUri
            || action.uri === row.local_original_uri
          ) {
            refused += 1;
            continue;
          }
          await files.deleteOriginal(action.uri);
          await protection.setDeviceTrash(action.plaintextSha256, null, null);
          purgedDeviceTrash += 1;
        } catch {
          // A storage failure leaves the sidecar and the row exactly as they
          // were, so the next cycle retries the same safe action.
          failed += 1;
        }
      }

      return {
        movedToDeviceTrash,
        restoredFromDeviceTrash,
        purgedDeviceTrash,
        refused,
        failed,
      };
    },
  };
}
