import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryAssetStateRecord } from '@/features/library/library-asset-state-codec';
import {
  createLibraryRemoteStateCacheRepository,
  type LibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-a';
const OTHER = 'scope-b';

const key = (assetId: string) => `waifu-deck/assets/${assetId}/state.json`;

function record(
  assetId: string,
  over: Partial<LibraryAssetStateRecord> = {},
): LibraryAssetStateRecord {
  return {
    assetId,
    revision: over.revision ?? 1,
    generation: over.generation ?? 1,
    lifecycle: over.lifecycle ?? 'active',
    protection: over.protection ?? 'unprotected',
    lastMutationId: over.lastMutationId ?? null,
    trashedAt: over.trashedAt ?? null,
    generations: over.generations ?? {},
    ...(over.meta !== undefined ? { meta: over.meta } : {}),
  };
}

describe('LibraryRemoteStateCacheRepository', () => {
  let native: DatabaseSync;
  let database: SqlDatabasePort;
  let repository: LibraryRemoteStateCacheRepository;

  beforeEach(async () => {
    native = new DatabaseSync(':memory:');
    database = createNodeSqliteAdapter(native);
    await migrateDatabase(database);
    repository = createLibraryRemoteStateCacheRepository({ database });
  });

  afterEach(() => {
    native.close();
  });

  it('round-trips every field of a persisted record', async () => {
    const full = record('a1', {
      revision: 7,
      generation: 3,
      lifecycle: 'trash',
      protection: 'protected',
      lastMutationId: 'm-9',
      trashedAt: '2026-09-14T00:00:00.000Z',
      generations: { original: 'g-o', thumbnail: 'g-t', preview: 'g-p' },
      meta: 'sealed-envelope',
    });
    await repository.upsertMany(SCOPE, [
      { key: key('a1'), etag: '"e1"', record: full },
    ]);

    // The whole point of persisting the record, not just the ETag: a cache hit
    // must serve a record indistinguishable from one the GET would return.
    await expect(repository.getAll(SCOPE)).resolves.toEqual([
      { key: key('a1'), etag: '"e1"', record: full },
    ]);
  });

  it('upserts by key: the second write replaces the first', async () => {
    await repository.upsertMany(SCOPE, [
      { key: key('a1'), etag: '"e1"', record: record('a1') },
    ]);
    await repository.upsertMany(SCOPE, [
      { key: key('a1'), etag: '"e2"', record: record('a1', { revision: 2 }) },
    ]);

    const rows = await repository.getAll(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ etag: '"e2"' });
    expect(rows[0]!.record.revision).toBe(2);
  });

  it('reads only its own scope', async () => {
    await repository.upsertMany(SCOPE, [
      { key: key('a1'), etag: '"e1"', record: record('a1') },
    ]);
    await repository.upsertMany(OTHER, [
      { key: key('b1'), etag: '"e2"', record: record('b1') },
    ]);

    expect((await repository.getAll(SCOPE)).map((row) => row.key))
      .toEqual([key('a1')]);
    expect((await repository.getAll(OTHER)).map((row) => row.key))
      .toEqual([key('b1')]);
  });

  it('deleteMissing drops exactly the keys the listing no longer reports', async () => {
    await repository.upsertMany(SCOPE, [
      { key: key('a1'), etag: '"e1"', record: record('a1') },
      { key: key('a2'), etag: '"e2"', record: record('a2') },
      { key: key('a3'), etag: '"e3"', record: record('a3') },
    ]);

    await repository.deleteMissing(SCOPE, [key('a1'), key('a3')]);

    expect((await repository.getAll(SCOPE)).map((row) => row.key).sort())
      .toEqual([key('a1'), key('a3')]);
  });

  it('deleteMissing with an empty listing clears the scope but not its neighbours', async () => {
    await repository.upsertMany(SCOPE, [
      { key: key('a1'), etag: '"e1"', record: record('a1') },
    ]);
    await repository.upsertMany(OTHER, [
      { key: key('b1'), etag: '"e2"', record: record('b1') },
    ]);

    await repository.deleteMissing(SCOPE, []);

    await expect(repository.getAll(SCOPE)).resolves.toEqual([]);
    expect(await repository.getAll(OTHER)).toHaveLength(1);
  });

  it('deleteAll clears one scope and leaves the other intact', async () => {
    await repository.upsertMany(SCOPE, [
      { key: key('a1'), etag: '"e1"', record: record('a1') },
      { key: key('a2'), etag: '"e2"', record: record('a2') },
    ]);
    await repository.upsertMany(OTHER, [
      { key: key('b1'), etag: '"e3"', record: record('b1') },
    ]);

    await repository.deleteAll(SCOPE);

    await expect(repository.getAll(SCOPE)).resolves.toEqual([]);
    expect(await repository.getAll(OTHER)).toHaveLength(1);
  });

  it('upsertMany with no rows touches nothing', async () => {
    await expect(repository.upsertMany(SCOPE, [])).resolves.toBeUndefined();
    await expect(repository.getAll(SCOPE)).resolves.toEqual([]);
  });

  it('skips a row whose persisted record no longer decodes', async () => {
    await repository.upsertMany(SCOPE, [
      { key: key('a1'), etag: '"e1"', record: record('a1') },
    ]);
    // A row corrupted at rest must not crash startup or, worse, be served as a
    // cache hit: it is simply not returned, so the port re-GETs that key.
    await database.run(
      'UPDATE library_remote_state_cache SET record_json = ? WHERE key = ?',
      ['{not json', key('a1')],
    );

    await expect(repository.getAll(SCOPE)).resolves.toEqual([]);
  });

  it('writes a batch larger than one SQL statement can bind', async () => {
    const rows = Array.from({ length: 450 }, (_, index) => ({
      key: key(`a${index}`),
      etag: `"e${index}"`,
      record: record(`a${index}`),
    }));

    await repository.upsertMany(SCOPE, rows);

    expect(await repository.getAll(SCOPE)).toHaveLength(450);
    // The listing-diff path passes the same 450 keys back; a chunked IN clause
    // must not drop any of them.
    await repository.deleteMissing(SCOPE, rows.map((row) => row.key));
    expect(await repository.getAll(SCOPE)).toHaveLength(450);
  });
});
