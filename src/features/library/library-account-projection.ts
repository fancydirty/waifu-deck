import type { SqlDatabasePort } from '@/db/sql-port';
import { createLibraryAccountMetadataSummaryRepository } from '@/features/library/library-account-metadata-summary';
import { createLibraryRemoteStateCacheRepository } from '@/features/library/library-remote-state-cache';

/**
 * Deletes account-scoped projection, outbox, batch, protection, sync,
 * decrypted-cache, and remote-state-index rows for `accountScope`. Does **not**
 * touch `device_library_assets` or `library_device_asset_state` (device-local
 * trash URIs and export marks stay until the remove-device-data success path).
 *
 * The remote-state index belongs in the same transaction as the projection, not
 * beside it. Since K7 cut 3 the sync engine projects only the assets whose
 * remote ETag moved, so an index that outlived the projection would report
 * "nothing changed" over a library the device no longer has any rows for, and
 * nothing would ever rebuild them. Wiping both together restores the only
 * invariant that matters: an empty projection implies an empty index, so the
 * next cycle is a full pass.
 */
async function clearScopeIn(tx: SqlDatabasePort, scope: string): Promise<void> {
  await tx.run(
    'DELETE FROM library_batch_items WHERE batch_id IN (SELECT batch_id FROM library_batch_operations WHERE account_scope = ?)',
    [scope],
  );
  await tx.run(
    'DELETE FROM library_batch_operations WHERE account_scope = ?',
    [scope],
  );
  await tx.run('DELETE FROM library_outbox WHERE account_scope = ?', [scope]);
  await tx.run(
    'DELETE FROM library_asset_protection WHERE account_scope = ?',
    [scope],
  );
  await tx.run(
    'DELETE FROM library_account_assets WHERE account_scope = ?',
    [scope],
  );
  await tx.run(
    'DELETE FROM library_sync_state WHERE account_scope = ?',
    [scope],
  );
  await tx.run(
    'DELETE FROM library_cache_entries WHERE account_scope = ?',
    [scope],
  );
  // Through the repository, so this table has exactly one owner of its SQL.
  await createLibraryRemoteStateCacheRepository({ database: tx })
    .deleteAll(scope);
  await createLibraryAccountMetadataSummaryRepository({ database: tx })
    .deleteAll(scope);
}

export async function clearAccountProjection(
  database: SqlDatabasePort,
  accountScope: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    await clearScopeIn(tx, accountScope);
  });
}

/**
 * Board #27 (spec §5.4 step 5): forget every account scope this phone ever
 * used. The statements are `clearAccountProjection`'s, so the ETag index goes
 * with the projection. Device rows stay.
 */
export async function forgetEveryAccount(
  database: SqlDatabasePort,
): Promise<void> {
  await database.transaction(async (tx) => {
    const scopes = await tx.getAll<{ account_scope: string }>(
      `SELECT account_scope FROM library_account_assets
       UNION SELECT account_scope FROM library_asset_protection
       UNION SELECT account_scope FROM library_outbox
       UNION SELECT account_scope FROM library_batch_operations
       UNION SELECT account_scope FROM library_sync_state
       UNION SELECT account_scope FROM library_cache_entries
       UNION SELECT account_scope FROM library_remote_state_cache
       UNION SELECT account_scope FROM library_account_metadata_summary`,
    );
    for (const row of scopes) {
      await clearScopeIn(tx, row.account_scope);
    }
  });
}
