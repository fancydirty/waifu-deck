import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createImageRepository } from '@/features/images/image-repository';
import type { LibraryCollectEvent } from '@/features/library/library-collect-adapter';
import {
  createLibraryCollectBackfill,
  createLibraryIngestOutcomeRecorder,
} from '@/features/library/library-collect-backfill';
import { LibraryIngestError } from '@/features/library/library-types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

async function openDatabase(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

type SavedRowOverrides = {
  downloadState?: string;
  localUri?: string | null;
  libraryError?: string | null;
  libraryErrorAttempts?: number;
  decision?: string;
};

async function savedRow(
  database: SqlDatabasePort,
  id: number,
  over: SavedRowOverrides = {},
): Promise<void> {
  const decision = over.decision ?? 'saved';
  const downloadState = over.downloadState ?? 'ready';
  const localUri = over.localUri === undefined
    ? `file:///documents/collection/${id}.jpg`
    : over.localUri;
  await database.run(
    `INSERT INTO images (
       id, provider_key, provider_item_id, remote_url, width, height, byte_size,
       extension, dominant_color, content_rating, is_nsfw, is_animated,
       tags_json, decision, presented_at, decided_at, queue_ordinal,
       decision_ordinal, local_uri, download_state, library_error,
       library_error_attempts
     ) VALUES (?, 'waifu_im', ?, ?, 10, 10, 100, '.jpg', '#aabbcc', 'safe', 0, 0,
               '[]', ?, 1, 2, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(id),
      `https://cdn.example.com/${id}.jpg`,
      decision,
      id,
      id,
      localUri,
      downloadState,
      over.libraryError ?? null,
      over.libraryErrorAttempts ?? 0,
    ],
  );
}

async function libraryAssetFor(
  database: SqlDatabasePort,
  sourceImageId: number,
  digest = String(sourceImageId).padStart(64, 'a'),
): Promise<void> {
  await database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width, height,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'provider', ?,
               'file:///library/originals/x.jpg', 'local-original', 1, 1, 1)`,
    [digest, sourceImageId],
  );
}

function recordingCollect() {
  const collected: LibraryCollectEvent[] = [];
  return {
    collect: (event: LibraryCollectEvent) => {
      collected.push(event);
    },
    ids: () => collected.map((event) => event.imageId),
    collected,
  };
}

/**
 * K6-5 C. The pass that finds the saves the library silently lost. It runs
 * from `resumePendingDownloads` and from a completed sync round — both moments
 * the app is already walking its own data — and hands each row to the same
 * six-lane ingest pool a fresh save uses. No timer, no queue of its own.
 */
describe('library collect backfill', () => {
  test('re-ingests a ready row that never became a library asset', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingCollect();
    try {
      await savedRow(database, 1);
      const backfill = createLibraryCollectBackfill({
        database,
        collect: sink.collect,
      });

      await expect(backfill.run()).resolves.toBe(1);
      expect(sink.collected).toEqual([
        { imageId: 1, localUri: 'file:///documents/collection/1.jpg' },
      ]);
    } finally {
      native.close();
    }
  });

  test('leaves rows the library already holds alone', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingCollect();
    try {
      await savedRow(database, 1);
      await savedRow(database, 2);
      await libraryAssetFor(database, 2);
      const backfill = createLibraryCollectBackfill({
        database,
        collect: sink.collect,
      });

      await expect(backfill.run()).resolves.toBe(1);
      expect(sink.ids()).toEqual([1]);
    } finally {
      native.close();
    }
  });

  test('only ready rows with a local file are re-ingestable', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingCollect();
    try {
      await savedRow(database, 1, { downloadState: 'pending', localUri: null });
      await savedRow(database, 2, { downloadState: 'mirrored', localUri: null });
      await savedRow(database, 3, { downloadState: 'failed', localUri: null });
      await savedRow(database, 4, { decision: 'dismissed', downloadState: 'none', localUri: null });
      await savedRow(database, 5);
      const backfill = createLibraryCollectBackfill({
        database,
        collect: sink.collect,
      });

      await expect(backfill.run()).resolves.toBe(1);
      expect(sink.ids()).toEqual([5]);
    } finally {
      native.close();
    }
  });

  test('retries a recoverable ingest error however often it has failed', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingCollect();
    try {
      // A copy that raced a concurrent write, an empty staged file, a storage
      // or database hiccup: nothing about the bytes says they are unusable.
      await savedRow(database, 1, { libraryError: 'unreadable_source', libraryErrorAttempts: 9 });
      await savedRow(database, 2, { libraryError: 'empty_file', libraryErrorAttempts: 4 });
      await savedRow(database, 3, { libraryError: 'storage_failed', libraryErrorAttempts: 7 });
      await savedRow(database, 4, { libraryError: 'database_failed', libraryErrorAttempts: 2 });
      const backfill = createLibraryCollectBackfill({
        database,
        collect: sink.collect,
      });

      await expect(backfill.run()).resolves.toBe(4);
      expect(sink.ids()).toEqual([1, 2, 3, 4]);
    } finally {
      native.close();
    }
  });

  test('gives a format or decode verdict a second try, and then stops', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingCollect();
    try {
      await savedRow(database, 1, { libraryError: 'unsupported_format', libraryErrorAttempts: 1 });
      await savedRow(database, 2, { libraryError: 'decode_failed', libraryErrorAttempts: 1 });
      await savedRow(database, 3, { libraryError: 'unsupported_format', libraryErrorAttempts: 2 });
      await savedRow(database, 4, { libraryError: 'decode_failed', libraryErrorAttempts: 3 });
      const backfill = createLibraryCollectBackfill({
        database,
        collect: sink.collect,
      });

      await expect(backfill.run()).resolves.toBe(2);
      expect(sink.ids()).toEqual([1, 2]);
    } finally {
      native.close();
    }
  });

  test('dispatches a ready row with no usable library row, or whose last ingest failed', async () => {
    // Board #27 S1b Task 3 (spec §5.3, §5.6): the ingest heals a row whose
    // original is flagged or not on the device, so the pass offers it. A
    // device-trashed row is never adopted, so it is not offered; a row that
    // also has a usable library row keeps its two copies instead of being
    // re-ingested on every pass and round.
    const { native, database } = await openDatabase();
    const sink = recordingCollect();
    try {
      const firstDigest = (id: number) => String(id).padStart(64, 'a');
      const secondDigest = (id: number) => String(id).padStart(64, 'b');
      const flag = (digest: string) => database.run(
        `UPDATE device_library_assets SET missing_original_since = 7
          WHERE plaintext_sha256 = ?`,
        [digest],
      );
      const withoutOriginal = (digest: string, residency: 'cloud-only' | 'cached') =>
        database.run(
          `UPDATE device_library_assets
              SET residency = ?, local_original_uri = NULL
            WHERE plaintext_sha256 = ?`,
          [residency, digest],
        );

      // 1: no library row.
      await savedRow(database, 1);
      // 2: flagged.
      await savedRow(database, 2);
      await libraryAssetFor(database, 2);
      await flag(firstDigest(2));
      // 3: cloud-only, no uri.
      await savedRow(database, 3);
      await libraryAssetFor(database, 3);
      await withoutOriginal(firstDigest(3), 'cloud-only');
      // 4: usable.
      await savedRow(database, 4);
      await libraryAssetFor(database, 4);
      // 5: device-trashed, no uri.
      await savedRow(database, 5);
      await libraryAssetFor(database, 5);
      await withoutOriginal(firstDigest(5), 'cached');
      // 6: usable, but its last ingest failed (OQ-2).
      await savedRow(database, 6, { libraryError: 'storage_failed', libraryErrorAttempts: 1 });
      await libraryAssetFor(database, 6);
      // 7: usable, and its bytes failed to decode twice (terminal).
      await savedRow(database, 7, { libraryError: 'decode_failed', libraryErrorAttempts: 2 });
      await libraryAssetFor(database, 7);
      // 8: one usable row and one flagged row.
      await savedRow(database, 8);
      await libraryAssetFor(database, 8);
      await libraryAssetFor(database, 8, secondDigest(8));
      await flag(secondDigest(8));
      // 9: one flagged row and one device-trashed row.
      await savedRow(database, 9);
      await libraryAssetFor(database, 9);
      await libraryAssetFor(database, 9, secondDigest(9));
      await flag(firstDigest(9));
      await withoutOriginal(secondDigest(9), 'cached');
      const backfill = createLibraryCollectBackfill({
        database,
        collect: sink.collect,
      });

      const dispatched = await backfill.run();
      // The ids first: a failure names the rows.
      expect(sink.ids()).toEqual([1, 2, 3, 6]);
      expect(dispatched).toBe(4);
    } finally {
      native.close();
    }
  });
});

/**
 * The write side of the same column. A `decode_failed` the ingest throws has to
 * end up on the row, or the badge has nothing to show, the detail page has
 * nothing to repair, and the pass above has nothing to reason about.
 */
describe('library ingest outcome recorder', () => {
  const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

  test('an ingest that throws is written to the row it was collecting for', async () => {
    const { native, database } = await openDatabase();
    try {
      await savedRow(database, 1);
      const recorder = createLibraryIngestOutcomeRecorder(createImageRepository(database));

      recorder.onFailure(
        { imageId: 1, localUri: 'file:///documents/collection/1.jpg' },
        new LibraryIngestError('decode_failed', 'the renderer refused it'),
      );
      await settle();

      await expect(database.getAll('SELECT library_error, library_error_attempts FROM images'))
        .resolves.toEqual([{ library_error: 'decode_failed', library_error_attempts: 1 }]);
    } finally {
      native.close();
    }
  });

  test('an error that is not an ingest verdict is recorded as a database failure', async () => {
    const { native, database } = await openDatabase();
    try {
      await savedRow(database, 1);
      const recorder = createLibraryIngestOutcomeRecorder(createImageRepository(database));

      recorder.onFailure(
        { imageId: 1, localUri: 'file:///documents/collection/1.jpg' },
        new Error('SQLITE_BUSY'),
      );
      await settle();

      await expect(database.getAll('SELECT library_error FROM images'))
        .resolves.toEqual([{ library_error: 'database_failed' }]);
    } finally {
      native.close();
    }
  });

  test('a later success clears the verdict so the badge goes away', async () => {
    const { native, database } = await openDatabase();
    try {
      await savedRow(database, 1, { libraryError: 'unreadable_source', libraryErrorAttempts: 3 });
      const recorder = createLibraryIngestOutcomeRecorder(createImageRepository(database));

      recorder.onSuccess({ imageId: 1, localUri: 'file:///documents/collection/1.jpg' });
      await settle();

      await expect(database.getAll('SELECT library_error, library_error_attempts FROM images'))
        .resolves.toEqual([{ library_error: null, library_error_attempts: 0 }]);
    } finally {
      native.close();
    }
  });

  test('a repository write that rejects cannot escape into the ingest pool', async () => {
    const recorder = createLibraryIngestOutcomeRecorder({
      recordLibraryIngestFailure: async () => {
        throw new Error('database gone');
      },
      clearLibraryIngestError: async () => {
        throw new Error('database gone');
      },
    } as never);
    const event = { imageId: 1, localUri: 'file:///documents/collection/1.jpg' };

    expect(() => recorder.onFailure(event, new Error('boom'))).not.toThrow();
    expect(() => recorder.onSuccess(event)).not.toThrow();
    await settle();
  });

  test('composes without a repository and records nothing', async () => {
    const recorder = createLibraryIngestOutcomeRecorder(undefined);
    const event = { imageId: 1, localUri: 'file:///documents/collection/1.jpg' };

    expect(() => recorder.onFailure(event, new Error('boom'))).not.toThrow();
    expect(() => recorder.onSuccess(event)).not.toThrow();
  });
});

