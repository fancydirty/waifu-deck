import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  createLibrarySyncCursorStore,
  zeroedLibrarySyncCursor,
} from '@/features/library/library-sync-cursors';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-A';

async function migrated(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

describe('library sync watermark store', () => {
  it('reads an unknown scope as a never-synced watermark', async () => {
    const { native, database } = await migrated();
    const cursors = createLibrarySyncCursorStore({ database, clock: () => 42 });

    await expect(cursors.read(SCOPE)).resolves.toEqual(
      zeroedLibrarySyncCursor(SCOPE),
    );
    await expect(cursors.read(SCOPE)).resolves.toMatchObject({
      lastSyncedAt: null,
      updatedAt: 0,
    });
    native.close();
  });

  it('inserts the watermark on a first-ever completed cycle', async () => {
    const { native, database } = await migrated();
    const cursors = createLibrarySyncCursorStore({ database, clock: () => 42 });

    // The retired `write()` was the only path that ever inserted a row. An
    // UPDATE-only `markSynced` would touch zero rows here and the watermark
    // would never persist, so a device could never tell it had synced.
    await cursors.markSynced(SCOPE);

    await expect(cursors.read(SCOPE)).resolves.toEqual({
      accountScope: SCOPE,
      lastSyncedAt: 42,
      updatedAt: 42,
    });
    native.close();
  });

  it('advances the watermark on every later cycle', async () => {
    const { native, database } = await migrated();
    let now = 100;
    const cursors = createLibrarySyncCursorStore({
      database,
      clock: () => (now += 1),
    });

    await cursors.markSynced(SCOPE);
    await cursors.markSynced(SCOPE);

    await expect(cursors.read(SCOPE)).resolves.toMatchObject({
      lastSyncedAt: 102,
      updatedAt: 102,
    });
    await expect(
      database.getAll('SELECT account_scope FROM library_sync_state'),
    ).resolves.toEqual([{ account_scope: SCOPE }]);
    native.close();
  });

  it('keeps one row per scope and never crosses scopes', async () => {
    const { native, database } = await migrated();
    const cursors = createLibrarySyncCursorStore({ database, clock: () => 7 });

    await cursors.markSynced(SCOPE);

    await expect(cursors.read('scope-B')).resolves.toEqual(
      zeroedLibrarySyncCursor('scope-B'),
    );
    native.close();
  });

  it('leaves the retired cursor columns at their dead defaults', async () => {
    const { native, database } = await migrated();
    const cursors = createLibrarySyncCursorStore({ database, clock: () => 9 });

    await cursors.markSynced(SCOPE);

    // Decision #19: the columns survive physically so no migration is needed
    // for a pure subtraction, but nothing writes or reads them any more.
    await expect(database.getFirst(
      `SELECT change_cursor, min_base_cursor, latest_revision, resync_pending
         FROM library_sync_state WHERE account_scope = ?`,
      [SCOPE],
    )).resolves.toEqual({
      change_cursor: 0,
      min_base_cursor: 0,
      latest_revision: 0,
      resync_pending: 0,
    });
    native.close();
  });
});
