import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlBindValue, SqlDatabasePort } from '@/db/sql-port';
import {
  createImageRepository,
  type ImageRepository,
} from '@/features/images/image-repository';
import type { ImageCandidate, ImageProviderKey, WaifuImage } from '@/features/waifu/types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const candidate: WaifuImage = {
  id: 101,
  providerKey: 'waifu_im',
  providerItemId: '101',
  canonicalSourceKey: 'url:https://example.com/art/101',
  perceptualHash: null,
  md5: null,
  remoteUrl: 'https://cdn.example.com/101.webp',
  sourceUrl: 'https://example.com/art/101',
  artistName: 'Example Artist',
  artistUrl: 'https://example.com/artist',
  width: 1200,
  height: 1800,
  byteSize: 456_789,
  extension: '.webp',
  dominantColor: '#aabbcc',
  isNsfw: false,
  isAnimated: false,
  tags: [' Waifu ', 'SOLO', 'solo'],
};

const DANBOORU_MD5 = 'd5c7f0aa3b4e1926c0f9a7b28d3e415f';
const MIRROR_MD5 = '0b1a2c3d4e5f60718293a4b5c6d7e8f9';

function candidateWithId(id: number): WaifuImage {
  return {
    ...candidate,
    id,
    providerItemId: String(id),
    canonicalSourceKey: `url:https://example.com/art/${id}`,
    remoteUrl: `https://cdn.example.com/${id}.webp`,
    sourceUrl: `https://example.com/art/${id}`,
  };
}

function candidateWithoutId(id: number): ImageCandidate {
  const { id: _id, ...result } = candidateWithId(id);
  return result;
}

async function openRepository() {
  const nativeDatabase = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(nativeDatabase);
  await migrateDatabase(database);
  return {
    nativeDatabase,
    database,
    repository: createImageRepository(database),
  };
}

async function createVersionOneSchema(database: SqlDatabasePort): Promise<void> {
  await database.exec(`
    CREATE TABLE images (
      id INTEGER PRIMARY KEY NOT NULL,
      remote_url TEXT NOT NULL,
      source_url TEXT,
      artist_name TEXT,
      artist_url TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      byte_size INTEGER NOT NULL,
      extension TEXT NOT NULL,
      dominant_color TEXT NOT NULL,
      is_nsfw INTEGER NOT NULL CHECK (is_nsfw IN (0, 1)),
      is_animated INTEGER NOT NULL CHECK (is_animated IN (0, 1)),
      tags_json TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('queued', 'active', 'dismissed', 'saved')),
      presented_at INTEGER,
      decided_at INTEGER,
      local_uri TEXT,
      download_state TEXT NOT NULL CHECK (download_state IN ('none', 'pending', 'ready', 'failed')),
      download_error TEXT
    );
    CREATE INDEX images_decision_decided_at
      ON images(decision, decided_at DESC);
    CREATE INDEX images_download_state
      ON images(download_state);
    PRAGMA user_version = 1;
  `);
}

async function createVersionFourSchema(database: SqlDatabasePort): Promise<void> {
  await database.exec(`
    CREATE TABLE images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_key TEXT NOT NULL CHECK (provider_key IN ('waifu_im', 'nekos_api')),
      provider_item_id TEXT NOT NULL,
      canonical_source_key TEXT,
      perceptual_hash TEXT,
      remote_url TEXT NOT NULL,
      source_url TEXT,
      artist_name TEXT,
      artist_url TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      byte_size INTEGER NOT NULL,
      extension TEXT NOT NULL,
      dominant_color TEXT NOT NULL,
      is_nsfw INTEGER NOT NULL CHECK (is_nsfw IN (0, 1)),
      is_animated INTEGER NOT NULL CHECK (is_animated IN (0, 1)),
      tags_json TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('queued', 'active', 'dismissed', 'saved')),
      presented_at INTEGER,
      decided_at INTEGER,
      queue_ordinal INTEGER NOT NULL,
      decision_ordinal INTEGER,
      local_uri TEXT,
      download_state TEXT NOT NULL CHECK (download_state IN ('none', 'pending', 'ready', 'failed')),
      download_error TEXT
    );
    PRAGMA user_version = 4;
  `);
}

type LegacyImageState = {
  id: number;
  decision: 'queued' | 'active' | 'dismissed' | 'saved';
  presentedAt: number | null;
  decidedAt: number | null;
  downloadState?: 'none' | 'pending';
};

async function insertLegacyImage(
  database: SqlDatabasePort,
  state: LegacyImageState,
): Promise<void> {
  await database.run(
    `INSERT INTO images (
      id, remote_url, width, height, byte_size, extension, dominant_color,
      is_nsfw, is_animated, tags_json, decision, presented_at, decided_at,
      download_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      state.id,
      `https://cdn.example.com/${state.id}.webp`,
      1,
      1,
      1,
      '.webp',
      '#000000',
      0,
      0,
      '[]',
      state.decision,
      state.presentedAt,
      state.decidedAt,
      state.downloadState ?? 'none',
    ],
  );
}

async function imageIndexNames(database: SqlDatabasePort): Promise<{ name: string }[]> {
  return database.getAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'images_%' ORDER BY name",
  );
}

describe('image repository migration and restore', () => {
  test('migrates a fresh database idempotently', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      await migrateDatabase(database);
      await migrateDatabase(database);

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
      await expect(
        database.getFirst<{ foreign_keys: number }>('PRAGMA foreign_keys'),
      ).resolves.toEqual({ foreign_keys: 1 });
      await expect(
        imageIndexNames(database),
      ).resolves.toEqual([
        { name: 'images_canonical_source_key' },
        { name: 'images_decision_decided_at' },
        { name: 'images_decision_ordinal' },
        { name: 'images_download_state' },
        { name: 'images_md5' },
        { name: 'images_one_active' },
        { name: 'images_perceptual_hash' },
        { name: 'images_provider_identity' },
        { name: 'images_queue_ordinal' },
        { name: 'images_taste_recorded_at' },
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('upgrades version 4 without changing saved files and accepts Danbooru', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      await createVersionFourSchema(database);
      await database.run(
        `INSERT INTO images (
          id, provider_key, provider_item_id, canonical_source_key,
          remote_url, width, height, byte_size, extension, dominant_color,
          is_nsfw, is_animated, tags_json, decision, presented_at, decided_at,
          queue_ordinal, decision_ordinal, local_uri, download_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          77,
          'nekos_api',
          'legacy-77',
          'pixiv:77',
          'https://cdn.example.com/legacy.webp',
          1200,
          1800,
          100,
          '.webp',
          '#aabbcc',
          0,
          0,
          '["waifu"]',
          'saved',
          10,
          20,
          1,
          1,
          'file:///collection/legacy-77.webp',
          'ready',
        ],
      );

      await migrateDatabase(database);
      const repository = createImageRepository(database);

      await expect(repository.getById(77)).resolves.toMatchObject({
        id: 77,
        providerKey: 'nekos_api',
        providerItemId: 'legacy-77',
        localUri: 'file:///collection/legacy-77.webp',
        downloadState: 'ready',
      });
      const { id: _id, ...danbooruCandidate } = candidateWithId(202);
      await expect(repository.insertCandidates([{
        ...danbooruCandidate,
        providerKey: 'danbooru',
        providerItemId: 'danbooru-202',
      }])).resolves.toMatchObject({ inserted: 1 });
      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
    } finally {
      nativeDatabase.close();
    }
  });

  test('upgrades version 5 by refilling only the transient queue', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      await migrateDatabase(database);
      const repository = createImageRepository(database);
      await repository.insertCandidates([
        candidateWithId(101),
        candidateWithId(102),
        candidateWithId(103),
      ]);
      await repository.activateNext(10);
      await repository.decide(101, 'saved', 20);
      await repository.activateNext(30);
      await database.exec('PRAGMA user_version = 5;');

      await migrateDatabase(database);

      await expect(repository.restoreDeck()).resolves.toMatchObject({
        active: { id: 102, decision: 'active' },
        queued: [],
      });
      await expect(repository.listCollection()).resolves.toMatchObject([
        { id: 101, decision: 'saved' },
      ]);
      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
    } finally {
      nativeDatabase.close();
    }
  });

  test('upgrades version 1 through version 3 and repairs duplicate active rows', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      await createVersionOneSchema(database);
      await insertLegacyImage(database, {
        id: 10,
        decision: 'active',
        presentedAt: 10,
        decidedAt: null,
      });
      await insertLegacyImage(database, {
        id: 20,
        decision: 'active',
        presentedAt: 20,
        decidedAt: null,
      });
      await insertLegacyImage(database, {
        id: 30,
        decision: 'dismissed',
        presentedAt: 5,
        decidedAt: 30,
      });
      await insertLegacyImage(database, {
        id: 40,
        decision: 'saved',
        presentedAt: 6,
        decidedAt: 30,
        downloadState: 'pending',
      });
      await database.run('UPDATE images SET source_url = ? WHERE id = ?', [
        'https://www.pixiv.net/en/artworks/4040',
        40,
      ]);

      await migrateDatabase(database);
      await migrateDatabase(database);

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
      await expect(
        database.getAll<{
          id: number;
          decision: string;
          presented_at: number | null;
          queue_ordinal: number;
          decision_ordinal: number | null;
        }>(
          `SELECT id, decision, presented_at, queue_ordinal, decision_ordinal
           FROM images ORDER BY id`,
        ),
      ).resolves.toEqual([
        {
          id: 20,
          decision: 'active',
          presented_at: 20,
          queue_ordinal: 2,
          decision_ordinal: null,
        },
        {
          id: 30,
          decision: 'dismissed',
          presented_at: 5,
          queue_ordinal: 3,
          decision_ordinal: 1,
        },
        {
          id: 40,
          decision: 'saved',
          presented_at: 6,
          queue_ordinal: 4,
          decision_ordinal: 2,
        },
      ]);
      await expect(database.getFirst<{
        id: number;
        provider_key: string;
        provider_item_id: string;
        canonical_source_key: string;
      }>(
        `SELECT id, provider_key, provider_item_id, canonical_source_key
         FROM images WHERE id = ?`,
        [40],
      )).resolves.toEqual({
        id: 40,
        provider_key: 'waifu_im',
        provider_item_id: '40',
        canonical_source_key: 'pixiv:4040',
      });
      await expect(imageIndexNames(database)).resolves.toEqual([
        { name: 'images_canonical_source_key' },
        { name: 'images_decision_decided_at' },
        { name: 'images_decision_ordinal' },
        { name: 'images_download_state' },
        { name: 'images_md5' },
        { name: 'images_one_active' },
        { name: 'images_perceptual_hash' },
        { name: 'images_provider_identity' },
        { name: 'images_queue_ordinal' },
        { name: 'images_taste_recorded_at' },
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('upgrades version 2 through version 3 without changing queue order', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      await createVersionOneSchema(database);
      await database.exec(`
        ALTER TABLE images ADD COLUMN queue_ordinal INTEGER;
        CREATE INDEX images_queue_ordinal ON images(queue_ordinal);
        CREATE UNIQUE INDEX images_one_active
          ON images((1)) WHERE decision = 'active';
        PRAGMA user_version = 2;
      `);
      await insertLegacyImage(database, {
        id: 90,
        decision: 'saved',
        presentedAt: 1,
        decidedAt: 100,
        downloadState: 'pending',
      });
      await insertLegacyImage(database, {
        id: 10,
        decision: 'dismissed',
        presentedAt: 2,
        decidedAt: 100,
      });
      await database.run('UPDATE images SET queue_ordinal = ? WHERE id = ?', [8, 90]);
      await database.run('UPDATE images SET queue_ordinal = ? WHERE id = ?', [7, 10]);

      await migrateDatabase(database);
      await migrateDatabase(database);

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
      await expect(
        database.getAll<{
          id: number;
          queue_ordinal: number;
          decision_ordinal: number;
        }>(
          'SELECT id, queue_ordinal, decision_ordinal FROM images ORDER BY decision_ordinal',
        ),
      ).resolves.toEqual([
        { id: 10, queue_ordinal: 7, decision_ordinal: 1 },
        { id: 90, queue_ordinal: 8, decision_ordinal: 2 },
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('rolls back a version 1 upgrade when execution fails after ALTER TABLE', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);
    let queueColumnAdded = false;
    let failureInjected = false;

    function failAfterQueueAlter(port: SqlDatabasePort): SqlDatabasePort {
      return {
        async exec(source) {
          await port.exec(source);
          if (queueColumnAdded && !failureInjected) {
            failureInjected = true;
            throw new Error('injected migration failure after ALTER');
          }
          if (source.includes('ALTER TABLE images ADD COLUMN queue_ordinal')) {
            queueColumnAdded = true;
          }
        },
        run: (source, params) => port.run(source, params),
        getFirst: <T>(source: string, params?: readonly SqlBindValue[]) =>
          port.getFirst<T>(source, params),
        getAll: <T>(source: string, params?: readonly SqlBindValue[]) =>
          port.getAll<T>(source, params),
        transaction: (task) =>
          port.transaction((transaction) => task(failAfterQueueAlter(transaction))),
      };
    }

    try {
      await createVersionOneSchema(database);
      await insertLegacyImage(database, {
        id: 10,
        decision: 'active',
        presentedAt: 10,
        decidedAt: null,
      });
      await insertLegacyImage(database, {
        id: 20,
        decision: 'active',
        presentedAt: 20,
        decidedAt: null,
      });

      await expect(migrateDatabase(failAfterQueueAlter(database))).rejects.toThrow(
        'injected migration failure after ALTER',
      );

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: 1 });
      await expect(
        database.getAll<{ name: string }>('PRAGMA table_info(images)'),
      ).resolves.not.toContainEqual(expect.objectContaining({ name: 'queue_ordinal' }));
      await expect(
        database.getAll<{ name: string }>('PRAGMA table_info(images)'),
      ).resolves.not.toContainEqual(
        expect.objectContaining({ name: 'decision_ordinal' }),
      );
      await expect(imageIndexNames(database)).resolves.toEqual([
        { name: 'images_decision_decided_at' },
        { name: 'images_download_state' },
      ]);
      await expect(
        database.getAll<{ id: number; decision: string; presented_at: number }>(
          'SELECT id, decision, presented_at FROM images ORDER BY id',
        ),
      ).resolves.toEqual([
        { id: 10, decision: 'active', presented_at: 10 },
        { id: 20, decision: 'active', presented_at: 20 },
      ]);

      await migrateDatabase(database);
      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
    } finally {
      nativeDatabase.close();
    }
  });

  test('deduplicates candidates and restores durable insertion order', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      await migrateDatabase(database);
      const repository = createImageRepository(database);

      await repository.insertCandidates([
        candidateWithId(90),
        candidateWithId(10),
        candidateWithId(50),
        candidateWithId(90),
      ]);

      const beforeActivation = await repository.restoreDeck();
      expect(beforeActivation.active).toBeNull();
      expect(beforeActivation.queued.map(({ id }) => id)).toEqual([90, 10, 50]);

      const active = await repository.activateNext(1_720_000_000_000);
      expect(active).toMatchObject({
        id: 90,
        decision: 'active',
        presentedAt: 1_720_000_000_000,
        isNsfw: false,
        isAnimated: false,
        tags: ['solo', 'waifu'],
      });

      const reconstructed = createImageRepository(database);
      await expect(reconstructed.restoreDeck()).resolves.toEqual({
        active,
        queued: beforeActivation.queued.slice(1),
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('scopes provider IDs and deduplicates shared source identities', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const waifu = candidateWithId(990);
      waifu.canonicalSourceKey = null;
      const { id: _waifuLocalId, ...waifuCandidate } = waifu;
      const nekosCandidate = {
        ...waifuCandidate,
        providerKey: 'nekos_api' as const,
        providerItemId: waifuCandidate.providerItemId,
        remoteUrl: 'https://cdn.example.com/nekos/990.webp',
      };
      await expect(repository.insertCandidates([waifuCandidate, nekosCandidate]))
        .resolves.toMatchObject({
          inserted: 2,
          byProvider: { waifu_im: 1, nekos_api: 1 },
        });

      const duplicateSource = {
        ...nekosCandidate,
        providerItemId: 'different-provider-id',
        canonicalSourceKey: 'pixiv:123',
      };
      const sameSourceFromWaifu = {
        ...waifuCandidate,
        providerItemId: 'different-waifu-id',
        canonicalSourceKey: 'pixiv:123',
        contentRating: 'explicit' as const,
        nativeRating: 'e',
        isNsfw: true,
      };
      await expect(repository.insertCandidates([duplicateSource, sameSourceFromWaifu]))
        .resolves.toMatchObject({ inserted: 1 });
      await expect(repository.restoreDeck()).resolves.toMatchObject({
        queued: expect.arrayContaining([
          expect.objectContaining({
            canonicalSourceKey: 'pixiv:123',
            contentRating: 'explicit',
            isNsfw: true,
          }),
        ]),
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('enforces at most one active row in the database', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(111), candidateWithId(112)]);
      await database.run(
        "UPDATE images SET decision = 'active', presented_at = ? WHERE id = ?",
        [10, 111],
      );
      await expect(
        database.run(
          "UPDATE images SET decision = 'active', presented_at = ? WHERE id = ?",
          [20, 112],
        ),
      ).rejects.toThrow();
    } finally {
      nativeDatabase.close();
    }
  });

  test('restores active and queued rows through one transaction snapshot', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(121), candidateWithId(122)]);
      await repository.activateNext(10);
      const snapshotOnlyDatabase: SqlDatabasePort = {
        ...database,
        getFirst: async () => {
          throw new Error('restore read escaped transaction snapshot');
        },
        getAll: async () => {
          throw new Error('restore read escaped transaction snapshot');
        },
      };
      const snapshotRepository = createImageRepository(snapshotOnlyDatabase);

      await expect(snapshotRepository.restoreDeck()).resolves.toMatchObject({
        active: { id: 121 },
        queued: [{ id: 122 }],
      });
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('image repository transitions', () => {
  test('R8.16-B: a decision enqueued mid-insert commits between chunk transactions, not after the batch', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const base = createNodeSqliteAdapter(nativeDatabase);

    // Transaction-begin log: the FIFO enqueue order of every transaction.
    // This is the discriminating observable — under the old single-transaction
    // implementation the scenario yields exactly [batchTx, decisionTx]; under
    // chunked transactions a decision enqueued during chunk 1 lands BEFORE
    // chunk 2's transaction.
    const enqueueOrder: string[] = [];
    let postMigrateTxScheduled: (() => void) | null = null;
    const postMigrateTxPromise = new Promise<void>((resolve) => {
      postMigrateTxScheduled = resolve;
    });

    const database: SqlDatabasePort = {
      exec: (source: string) => base.exec(source),
      run: (source: string, params?: readonly SqlBindValue[]) =>
        base.run(source, params),
      getFirst: <T,>(source: string, params?: readonly SqlBindValue[]) =>
        base.getFirst<T>(source, params),
      getAll: <T,>(source: string, params?: readonly SqlBindValue[]) =>
        base.getAll<T>(source, params),
      transaction: (task) => {
        enqueueOrder.push(`tx-${enqueueOrder.length}`);
        postMigrateTxScheduled?.();
        postMigrateTxScheduled = null;
        return base.transaction(task);
      },
    };

    try {
      await migrateDatabase(database);
      const migrateTxCount = enqueueOrder.length;
      const repository = createImageRepository(database);

      const batch: ImageCandidate[] = Array.from({ length: 64 }, (_, index) =>
        candidateWithoutId(2_200 + index));

      const insertPromise = repository.insertCandidates(batch);
      // Wait until the insert's FIRST chunk transaction has been scheduled
      // on the FIFO (it is now the in-flight entry), THEN enqueue the
      // decision — the moment a user swipe lands during a refill insert.
      // Chunk 2 is not yet enqueued: its enqueue happens only after chunk 1
      // resolves, so the decision lands BETWEEN the two chunk transactions.
      await postMigrateTxPromise;
      const decisionPromise = repository.activateNext(50);

      const insertResult = await insertPromise;
      await decisionPromise;
      expect(insertResult.inserted).toBe(64);

      const scenarioOrder = enqueueOrder.slice(migrateTxCount);
      // [chunk1, decision, chunk2] — three transactions. The old single-
      // transaction implementation would produce [batchTx, decision] (two),
      // with the decision strictly after the whole insert; this length
      // assertion alone discriminates chunking from the old shape.
      expect(scenarioOrder.length).toBe(3);

      const deck = await repository.restoreDeck();
      expect(deck.active?.presentedAt).toBe(50);
      expect(deck.queued.length).toBe(63);
    } finally {
      nativeDatabase.close();
    }
  }, 20_000);

  test('R8.16-B: a bulk refill insert commits in bounded chunks without breaking order or dedup', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      await migrateDatabase(database);
      const repository = createImageRepository(database);

      // 80 candidates — crosses the 32-row chunk boundary twice. The batch
      // interleaves two providers and plants duplicate identities so both the
      // ordinal continuity and the dedup UPDATE paths run across chunks.
      const batch: ImageCandidate[] = [];
      for (let index = 0; index < 80; index += 1) {
        const providerKey: ImageProviderKey = index % 2 === 0 ? 'waifu_im' : 'safebooru';
        batch.push({
          ...candidateWithoutId(1_000 + index),
          providerKey,
          // duplicates planted inside the same chunk and across chunk borders
          ...(index === 33 ? { providerItemId: '1000', providerKey: 'waifu_im' } : {}),
          ...(index === 70 ? { providerItemId: '1001', providerKey: 'safebooru' } : {}),
        });
      }

      const result = await repository.insertCandidates(batch);

      // Dedup held: the two planted duplicates did not insert.
      expect(result.inserted).toBe(78);
      expect(result.byProvider.waifu_im).toBe(39);
      expect(result.byProvider.safebooru).toBe(39);

      // Ordinal semantics across chunks match the single-transaction behavior:
      // strictly ascending (a suppressed duplicate intentionally leaves a
      // gap — the survivor re-seat consumes those slots), never a collision,
      // and never a chunk-boundary reset back to a lower value.
      const deck = await repository.restoreDeck();
      expect(deck.queued.length).toBe(78);
      const ordinals = deck.queued.map((image) => image.queueOrdinal);
      expect(new Set(ordinals).size).toBe(ordinals.length);
      for (let index = 1; index < ordinals.length; index += 1) {
        expect(ordinals[index]).toBeGreaterThan(ordinals[index - 1]);
      }
      // The gaps are exactly the two suppressed duplicates, no more.
      const span = ordinals[ordinals.length - 1] - ordinals[0] + 1;
      expect(span).toBe(80);
    } finally {
      nativeDatabase.close();
    }
  });



  test('saves a new search candidate directly with durable decision order', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const first = await repository.saveCandidate(candidateWithoutId(191), 100);
      const second = await repository.saveCandidate(candidateWithoutId(192), 100);

      expect(first).toMatchObject({
        providerItemId: '191',
        decision: 'saved',
        presentedAt: 100,
        decidedAt: 100,
        decisionOrdinal: 1,
        downloadState: 'pending',
        localUri: null,
        tags: ['solo', 'waifu'],
      });
      expect(second).toMatchObject({
        providerItemId: '192',
        decisionOrdinal: 2,
      });
      await expect(repository.listCollection()).resolves.toMatchObject([
        { id: second.id, decisionOrdinal: 2 },
        { id: first.id, decisionOrdinal: 1 },
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('maps safebooru and yandere rows instead of failing closed on provider_key', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const safebooru = await repository.saveCandidate({
        ...candidateWithoutId(801),
        providerKey: 'safebooru',
        providerItemId: 'sb-801',
      }, 110);
      const yandere = await repository.saveCandidate({
        ...candidateWithoutId(802),
        providerKey: 'yandere',
        providerItemId: 'yd-802',
      }, 120);

      expect(safebooru.providerKey).toBe('safebooru');
      expect(yandere.providerKey).toBe('yandere');
      await expect(repository.listCollection()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ providerKey: 'safebooru', providerItemId: 'sb-801' }),
          expect.objectContaining({ providerKey: 'yandere', providerItemId: 'yd-802' }),
        ]),
      );
    } finally {
      nativeDatabase.close();
    }
  });

  test.each(['queued', 'active', 'dismissed'] as const)(
    'converts an existing %s candidate to saved and pending',
    async (historicalDecision) => {
      const { nativeDatabase, repository } = await openRepository();

      try {
        await repository.insertCandidates([candidateWithId(193)]);
        if (historicalDecision !== 'queued') {
          await repository.activateNext(10);
        }
        if (historicalDecision === 'dismissed') {
          await repository.decide(193, 'dismissed', 20);
        }

        const saved = await repository.saveCandidate(
          {
            ...candidateWithoutId(193),
            remoteUrl: 'https://cdn.example.com/193-new.webp',
            artistName: 'Updated Artist',
          },
          30,
        );

        expect(saved).toMatchObject({
          id: 193,
          decision: 'saved',
          decidedAt: 30,
          downloadState: 'pending',
          localUri: null,
          downloadError: null,
          remoteUrl: 'https://cdn.example.com/193-new.webp',
          artistName: 'Updated Artist',
        });
        expect(saved.decisionOrdinal).toBe(
          historicalDecision === 'dismissed' ? 2 : 1,
        );
      } finally {
        nativeDatabase.close();
      }
    },
  );

  test('preserves ready local file metadata while supplementing missing identity and source data', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([
        {
          ...candidateWithId(194),
          sourceUrl: null,
          artistName: null,
          artistUrl: null,
        },
      ]);
      await repository.activateNext(10);
      await repository.decide(194, 'saved', 20);
      await repository.markDownloadReady(194, 'file:///collection/194.webp');

      const saved = await repository.saveCandidate(
        {
          ...candidateWithoutId(294),
          providerKey: 'nekos_api',
          providerItemId: 'nekos-294',
          canonicalSourceKey: candidateWithId(194).canonicalSourceKey,
          perceptualHash: 'hash-194',
          remoteUrl: 'https://cdn.example.com/194-refreshed.jpg',
          sourceUrl: 'https://example.com/art/194',
          artistName: 'Recovered Artist',
          artistUrl: 'https://example.com/recovered-artist',
          width: 2400,
          height: 3600,
          byteSize: 999_999,
          extension: '.jpg',
          dominantColor: '#112233',
          isAnimated: true,
          tags: ['Updated'],
        },
        999,
      );

      expect(saved).toMatchObject({
        id: 194,
        decidedAt: 20,
        decisionOrdinal: 1,
        downloadState: 'ready',
        localUri: 'file:///collection/194.webp',
        providerKey: 'waifu_im',
        providerItemId: '194',
        canonicalSourceKey: candidateWithId(194).canonicalSourceKey,
        perceptualHash: 'hash-194',
        remoteUrl: 'https://cdn.example.com/194.webp',
        sourceUrl: 'https://example.com/art/194',
        artistName: 'Recovered Artist',
        artistUrl: 'https://example.com/recovered-artist',
        width: 1200,
        height: 1800,
        byteSize: 456_789,
        extension: '.webp',
        dominantColor: '#aabbcc',
        isAnimated: false,
        tags: ['solo', 'waifu'],
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a completed download backfills a zero byte_size', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const saved = await repository.saveCandidate(
        { ...candidateWithoutId(195), byteSize: 0 },
        20,
      );

      await expect(
        repository.markDownloadReady(saved.id, 'file:///collection/195.webp', undefined, 12_345),
      ).resolves.toBe(true);
      await expect(repository.getById(saved.id)).resolves.toMatchObject({
        downloadState: 'ready',
        byteSize: 12_345,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a known byte_size is kept', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const saved = await repository.saveCandidate(candidateWithoutId(196), 20);

      await expect(
        repository.markDownloadReady(saved.id, 'file:///collection/196.webp', undefined, 99_999),
      ).resolves.toBe(true);
      await expect(repository.getById(saved.id)).resolves.toMatchObject({
        downloadState: 'ready',
        byteSize: candidate.byteSize,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('moves a failed saved candidate back to pending without reordering it', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const original = await repository.saveCandidate(candidateWithoutId(195), 20);
      await repository.markDownloadFailed(original.id, 'offline');

      await expect(
        repository.saveCandidate(candidateWithoutId(195), 999),
      ).resolves.toMatchObject({
        id: original.id,
        decidedAt: 20,
        decisionOrdinal: 1,
        downloadState: 'pending',
        localUri: null,
        downloadError: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test.each(['canonical-source', 'perceptual-hash', 'md5'] as const)(
    'deduplicates a cross-provider save by %s',
    async (identityKind) => {
      const { nativeDatabase, database, repository } = await openRepository();

      try {
        const original = {
          ...candidateWithId(196),
          canonicalSourceKey:
            identityKind === 'canonical-source' ? 'pixiv:4242' : null,
          perceptualHash: identityKind === 'perceptual-hash' ? 'hash-4242' : null,
          md5: identityKind === 'md5' ? DANBOORU_MD5 : null,
        };
        await repository.insertCandidates([original]);
        await repository.activateNext(10);
        await repository.decide(196, 'dismissed', 20);

        const duplicate: ImageCandidate = {
          ...candidateWithoutId(296),
          providerKey: 'nekos_api',
          providerItemId: 'nekos-296',
          canonicalSourceKey: original.canonicalSourceKey,
          perceptualHash: original.perceptualHash,
          md5: original.md5,
        };
        const saved = await repository.saveCandidate(duplicate, 30);

        expect(saved).toMatchObject({
          id: 196,
          providerKey: 'waifu_im',
          providerItemId: '196',
          decision: 'saved',
          downloadState: 'pending',
        });
        await expect(
          database.getFirst<{ count: number }>('SELECT COUNT(*) AS count FROM images'),
        ).resolves.toEqual({ count: 1 });
      } finally {
        nativeDatabase.close();
      }
    },
  );

  test('rejects stale download completion after a pending cross-source metadata merge', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const originalCandidate = {
      ...candidateWithoutId(197),
      canonicalSourceKey: 'pixiv:pending-197',
    };
    const replacementCandidate: ImageCandidate = {
      ...candidateWithoutId(297),
      providerKey: 'nekos_api',
      providerItemId: 'nekos-297',
      canonicalSourceKey: originalCandidate.canonicalSourceKey,
      remoteUrl: 'https://cdn.example.com/297.jpg',
      extension: '.jpg',
    };

    try {
      const original = await repository.saveCandidate(originalCandidate, 10);
      const replacement = await repository.saveCandidate(replacementCandidate, 20);

      expect(replacement).toMatchObject({
        id: original.id,
        remoteUrl: replacementCandidate.remoteUrl,
        extension: '.jpg',
        downloadState: 'pending',
      });
      await expect(repository.markDownloadReady(
        original.id,
        'file:///collection/stale.webp',
        {
          remoteUrl: originalCandidate.remoteUrl,
          extension: originalCandidate.extension,
        },
      )).resolves.toBe(false);
      await expect(repository.markDownloadFailed(
        original.id,
        'stale_failure',
        {
          remoteUrl: originalCandidate.remoteUrl,
          extension: originalCandidate.extension,
        },
      )).resolves.toBe(false);
      await expect(repository.getById(original.id)).resolves.toMatchObject({
        remoteUrl: replacementCandidate.remoteUrl,
        extension: '.jpg',
        downloadState: 'pending',
        localUri: null,
        downloadError: null,
      });
      await expect(repository.markDownloadReady(
        original.id,
        'file:///collection/current.jpg',
        {
          remoteUrl: replacementCandidate.remoteUrl,
          extension: replacementCandidate.extension,
        },
      )).resolves.toBe(true);
    } finally {
      nativeDatabase.close();
    }
  });

  test.each(['canonical-source', 'perceptual-hash', 'md5'] as const)(
    'keeps a cross-provider NSFW conflict conservative by %s',
    async (identityKind) => {
      const { nativeDatabase, repository } = await openRepository();

      try {
        const original = {
          ...candidateWithId(198),
          canonicalSourceKey:
            identityKind === 'canonical-source' ? 'pixiv:nsfw-198' : null,
          perceptualHash:
            identityKind === 'perceptual-hash' ? 'hash-nsfw-198' : null,
          md5: identityKind === 'md5' ? DANBOORU_MD5 : null,
          isNsfw: true,
        };
        await repository.insertCandidates([original]);
        await repository.activateNext(10);
        await repository.decide(198, 'dismissed', 20);

        const safeDuplicate: ImageCandidate = {
          ...candidateWithoutId(298),
          providerKey: 'nekos_api',
          providerItemId: 'nekos-safe-298',
          canonicalSourceKey: original.canonicalSourceKey,
          perceptualHash: original.perceptualHash,
          md5: original.md5,
          isNsfw: false,
        };

        await expect(repository.saveCandidate(safeDuplicate, 30)).resolves.toMatchObject({
          id: 198,
          decision: 'saved',
          isNsfw: true,
        });
      } finally {
        nativeDatabase.close();
      }
    },
  );

  test('atomically rejects a candidate whose identities bridge multiple rows', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      const providerMatch = {
        ...candidateWithId(198),
        canonicalSourceKey: 'pixiv:provider-row',
        perceptualHash: 'hash-provider-row',
      };
      const sourceMatch = {
        ...candidateWithId(199),
        providerKey: 'nekos_api' as const,
        providerItemId: 'nekos-source-row',
        canonicalSourceKey: 'pixiv:bridge-source',
        perceptualHash: 'hash-source-row',
      };
      const hashMatch = {
        ...candidateWithId(200),
        providerKey: 'danbooru' as const,
        providerItemId: 'danbooru-hash-row',
        canonicalSourceKey: 'pixiv:hash-row',
        perceptualHash: 'hash-bridge',
      };
      await expect(
        repository.insertCandidates([providerMatch, sourceMatch, hashMatch]),
      ).resolves.toMatchObject({ inserted: 3 });
      const before = await database.getAll<Record<string, unknown>>(
        'SELECT * FROM images ORDER BY id',
      );

      await expect(
        repository.saveCandidate(
          {
            ...candidateWithoutId(999),
            providerKey: providerMatch.providerKey,
            providerItemId: providerMatch.providerItemId,
            canonicalSourceKey: sourceMatch.canonicalSourceKey,
            perceptualHash: hashMatch.perceptualHash,
            remoteUrl: 'https://cdn.example.com/bridge.webp',
            isNsfw: true,
          },
          999,
        ),
      ).rejects.toThrow('Candidate identity matches multiple image rows');
      await expect(
        database.getAll<Record<string, unknown>>('SELECT * FROM images ORDER BY id'),
      ).resolves.toEqual(before);
    } finally {
      nativeDatabase.close();
    }
  });

  test('serializes concurrent duplicate saves into one collection row', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      const waifuCandidate = {
        ...candidateWithoutId(197),
        canonicalSourceKey: 'pixiv:concurrent-197',
      };
      const nekosCandidate: ImageCandidate = {
        ...waifuCandidate,
        providerKey: 'nekos_api',
        providerItemId: 'nekos-concurrent-197',
        remoteUrl: 'https://cdn.example.com/nekos/concurrent-197.webp',
      };
      const saved = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          repository.saveCandidate(
            index % 2 === 0 ? waifuCandidate : nekosCandidate,
            100 + index,
          ),
        ),
      );

      expect(new Set(saved.map(({ id }) => id))).toEqual(new Set([saved[0].id]));
      expect(saved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            decidedAt: 100,
            decisionOrdinal: 1,
            downloadState: 'pending',
          }),
        ]),
      );
      await expect(
        database.getFirst<{ count: number }>('SELECT COUNT(*) AS count FROM images'),
      ).resolves.toEqual({ count: 1 });
    } finally {
      nativeDatabase.close();
    }
  });

  test('orders saved records newest first and completes pending downloads conditionally', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(201), candidateWithId(202)]);
      await repository.activateNext(10);
      await expect(repository.decide(201, 'saved', 100)).resolves.toMatchObject({
        id: 201,
        decision: 'saved',
        decidedAt: 100,
        decisionOrdinal: 1,
        downloadState: 'pending',
      });
      await repository.activateNext(20);
      await repository.decide(202, 'saved', 200);

      await expect(repository.listCollection()).resolves.toMatchObject([
        { id: 202, downloadState: 'pending' },
        { id: 201, downloadState: 'pending' },
      ]);

      await expect(repository.markDownloadFailed(201, 'network')).resolves.toBe(true);
      await expect(repository.getById(201)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'failed',
        downloadError: 'network',
      });

      await expect(repository.decide(201, 'saved', 300)).resolves.toMatchObject({
        decidedAt: 100,
        decisionOrdinal: 1,
        downloadState: 'pending',
        downloadError: null,
      });
      await expect(repository.listCollection()).resolves.toMatchObject([
        { id: 202, decidedAt: 200 },
        { id: 201, decidedAt: 100 },
      ]);
      await expect(
        repository.markDownloadReady(201, 'file:///collection/201.webp'),
      ).resolves.toBe(true);
      await expect(repository.markDownloadFailed(201, 'late-failure')).resolves.toBe(false);
      await expect(
        repository.markDownloadReady(201, 'file:///collection/late.webp'),
      ).resolves.toBe(false);
      await expect(repository.getById(201)).resolves.toMatchObject({
        downloadState: 'ready',
        downloadError: null,
        localUri: 'file:///collection/201.webp',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('promotes a queued decision card and moves the stranded active row to the queue end', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([1, 2, 3, 4].map((id) => candidateWithId(id)));
      await repository.activateNext(10);

      await expect(repository.promoteForDecision(3, 20)).resolves.toMatchObject({
        id: 3,
        decision: 'active',
        presentedAt: 20,
      });
      await expect(repository.restoreDeck()).resolves.toMatchObject({
        active: { id: 3 },
        queued: [{ id: 2 }, { id: 4 }, { id: 1 }],
      });
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'queued',
        presentedAt: null,
        queueOrdinal: 5,
      });

      await expect(repository.promoteForDecision(1, 30)).resolves.toMatchObject({
        id: 1,
        decision: 'active',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('does not promote a card that is no longer queued', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(1), candidateWithId(2)]);
      await repository.activateNext(10);
      await repository.decide(1, 'dismissed', 20);
      const before = await database.getAll('SELECT * FROM images ORDER BY id');

      await expect(repository.promoteForDecision(1, 30)).resolves.toBeNull();
      await expect(database.getAll('SELECT * FROM images ORDER BY id')).resolves.toEqual(before);
    } finally {
      nativeDatabase.close();
    }
  });

  test('promoting an already active card is a no-op success', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([1, 2, 3].map((id) => candidateWithId(id)));
      await repository.activateNext(10);
      const before = await database.getAll(
        'SELECT id, decision, presented_at, queue_ordinal FROM images ORDER BY id',
      );

      await expect(repository.promoteForDecision(1, 20)).resolves.toMatchObject({
        id: 1,
        decision: 'active',
        presentedAt: 10,
      });
      await expect(database.getAll(
        'SELECT id, decision, presented_at, queue_ordinal FROM images ORDER BY id',
      )).resolves.toEqual(before);
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: rewind works although a later Search save holds a higher ordinal', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.insertCandidates([candidateWithId(351), candidateWithId(352)]);
      await repository.activateNext(10);
      await repository.decide(351, 'dismissed', 20);             // Discover swipe (ordinal 1)
      await repository.activateNext(30);                          // 352 active
      await repository.saveCandidate(candidateWithId(360), 40);   // Search save: ordinal 2, the global latest
      await expect(repository.rewindDecision(351, { decision: 'dismissed', decidedAt: 20 }))
        .resolves.toMatchObject({ id: 351, decision: 'dismissed' });   // returns the PRE-rewind row
      await expect(repository.restoreDeck()).resolves.toMatchObject({
        active: { id: 351, decision: 'active', decidedAt: null, decisionOrdinal: null },
        queued: [{ id: 352, presentedAt: null }],                 // demoted exactly as today
      });
      await expect(repository.listCollection()).resolves.toEqual([
        expect.objectContaining({ providerItemId: '360', decision: 'saved' }),
      ]);
    } finally { nativeDatabase.close(); }
  });

  test('row24: two rewinds put the rewound cards back in order, each demoted card at the queue front', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.insertCandidates([
        candidateWithId(351),
        candidateWithId(352),
        candidateWithId(353),
      ]);
      await repository.activateNext(10);
      await repository.decide(351, 'dismissed', 20);
      await repository.activateNext(30);
      await repository.decide(352, 'saved', 40);
      await repository.activateNext(50);                          // 353 active, nothing queued

      await expect(repository.rewindDecision(352, { decision: 'saved', decidedAt: 40 }))
        .resolves.toMatchObject({ id: 352, decision: 'saved', decidedAt: 40 });
      await expect(repository.rewindDecision(351, { decision: 'dismissed', decidedAt: 20 }))
        .resolves.toMatchObject({ id: 351, decision: 'dismissed', decidedAt: 20 });

      // COALESCE(MIN(queued), 0) - 1: 353 took -1 from an empty queue, then 352
      // took -2 in front of it.
      await expect(repository.restoreDeck()).resolves.toMatchObject({
        active: { id: 351, decision: 'active', presentedAt: 10 },
        queued: [
          { id: 352, decision: 'queued', presentedAt: null, queueOrdinal: -2 },
          { id: 353, decision: 'queued', presentedAt: null, queueOrdinal: -1 },
        ],
      });
      await expect(repository.listCollection()).resolves.toEqual([]);
    } finally { nativeDatabase.close(); }
  });

  test('row24: a rewind whose decision no longer matches returns null and changes no row', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      await repository.insertCandidates([
        candidateWithId(371),
        candidateWithId(372),
        candidateWithId(373),
      ]);
      await repository.activateNext(10);
      await repository.decide(371, 'saved', 20);
      await repository.activateNext(30);
      await repository.deleteFromCollection(371);                 // 收藏 delete: now dismissed
      const before = await database.getAll('SELECT * FROM images ORDER BY id');

      await expect(repository.rewindDecision(371, { decision: 'saved', decidedAt: 20 }))
        .resolves.toBeNull();
      await expect(database.getAll('SELECT * FROM images ORDER BY id'))
        .resolves.toEqual(before);
    } finally { nativeDatabase.close(); }
  });

  test('row24: a rewind whose decided_at no longer matches (re-saved later) returns null and changes no row', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      await repository.insertCandidates([candidateWithId(381), candidateWithId(382)]);
      await repository.activateNext(10);
      await repository.decide(381, 'saved', 40);
      await repository.activateNext(50);
      await repository.deleteFromCollection(381);
      await repository.saveCandidate(candidateWithId(381), 90);   // the same identity, saved again
      const before = await database.getAll('SELECT * FROM images ORDER BY id');

      await expect(repository.rewindDecision(381, { decision: 'saved', decidedAt: 40 }))
        .resolves.toBeNull();
      await expect(database.getAll('SELECT * FROM images ORDER BY id'))
        .resolves.toEqual(before);
      await expect(repository.getById(381)).resolves.toMatchObject({
        decision: 'saved',
        decidedAt: 90,
      });
    } finally { nativeDatabase.close(); }
  });

  test('row24: a rewound save carries no download or library state, and a late completion is refused', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      await repository.insertCandidates([candidateWithId(391), candidateWithId(392)]);
      await repository.activateNext(10);
      await repository.decide(391, 'saved', 20);
      await repository.markDownloadReady(391, 'file:///collection/391.webp');
      await repository.recordLibraryIngestFailure(391, 'LIBRARY_INGEST_FAILED');
      await repository.recordLibraryIngestFailure(391, 'LIBRARY_INGEST_FAILED');
      await repository.activateNext(30);
      await repository.decide(392, 'saved', 40);
      await repository.markDownloadFailed(392, 'http_404', undefined, 'source_gone');

      await expect(repository.rewindDecision(392, { decision: 'saved', decidedAt: 40 }))
        .resolves.toMatchObject({ id: 392, downloadState: 'failed', downloadErrorKind: 'source_gone' });
      await expect(repository.rewindDecision(391, { decision: 'saved', decidedAt: 20 }))
        .resolves.toMatchObject({ id: 391, downloadState: 'ready', libraryError: 'LIBRARY_INGEST_FAILED' });

      const cleared = {
        decidedAt: null,
        decisionOrdinal: null,
        downloadState: 'none',
        localUri: null,
        downloadError: null,
        downloadErrorKind: null,
        libraryError: null,
      };
      await expect(repository.getById(391)).resolves.toMatchObject({
        ...cleared,
        decision: 'active',
        presentedAt: 10,
      });
      await expect(repository.getById(392)).resolves.toMatchObject({
        ...cleared,
        decision: 'queued',
        presentedAt: null,
      });
      await expect(database.getAll(
        `SELECT id, taste_signal, taste_recorded_at, library_error_attempts
         FROM images WHERE id IN (391, 392) ORDER BY id`,
      )).resolves.toEqual([
        { id: 391, taste_signal: null, taste_recorded_at: null, library_error_attempts: 0 },
        { id: 392, taste_signal: null, taste_recorded_at: null, library_error_attempts: 0 },
      ]);

      await expect(
        repository.markDownloadReady(391, 'file:///collection/late.webp'),
      ).resolves.toBe(false);
      await expect(repository.markDownloadFailed(391, 'late-failure')).resolves.toBe(false);
      await expect(
        repository.markDownloadReady(392, 'file:///collection/late.webp'),
      ).resolves.toBe(false);
    } finally { nativeDatabase.close(); }
  });

  test('uses decision order rather than image ID when timestamps are equal', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(900), candidateWithId(100)]);
      await repository.activateNext(10);
      await repository.decide(900, 'saved', 100);
      await repository.activateNext(20);
      await repository.decide(100, 'saved', 100);

      await expect(repository.listCollection()).resolves.toMatchObject([
        { id: 100, decisionOrdinal: 2 },
        { id: 900, decisionOrdinal: 1 },
      ]);

      await repository.markDownloadFailed(100, 'offline');
      await expect(repository.decide(100, 'saved', 500)).resolves.toMatchObject({
        decidedAt: 100,
        decisionOrdinal: 2,
      });
      await expect(repository.listCollection()).resolves.toMatchObject([
        { id: 100, decisionOrdinal: 2 },
        { id: 900, decisionOrdinal: 1 },
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('re-deciding an already-decided image reports the durable row rather than null', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(940), candidateWithId(941)]);
      await repository.activateNext(10);

      // A retried save of a row already saved (download still pending) must not
      // report "nothing happened" — the write is durable, so the caller has to
      // be able to advance the deck instead of deadlocking on a false failure.
      await expect(repository.decide(940, 'saved', 100)).resolves.toMatchObject({
        id: 940,
        decision: 'saved',
      });
      await expect(repository.decide(940, 'saved', 500)).resolves.toMatchObject({
        id: 940,
        decision: 'saved',
        decidedAt: 100,
        decisionOrdinal: 1,
      });

      await repository.activateNext(20);
      await expect(repository.decide(941, 'dismissed', 200)).resolves.toMatchObject({
        id: 941,
        decision: 'dismissed',
      });
      await expect(repository.decide(941, 'dismissed', 600)).resolves.toMatchObject({
        id: 941,
        decision: 'dismissed',
        decidedAt: 200,
        decisionOrdinal: 2,
      });

      // A genuinely unknown image is still null — absence is not idempotency.
      await expect(repository.decide(9999, 'saved', 700)).resolves.toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: decisions made in the same millisecond are each rewound by their own id', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([
        candidateWithId(900),
        candidateWithId(100),
        candidateWithId(500),
      ]);
      await repository.activateNext(10);
      await repository.decide(900, 'dismissed', 100);
      await repository.activateNext(20);
      await repository.decide(100, 'dismissed', 100);
      await repository.activateNext(30);

      await expect(repository.rewindDecision(100, { decision: 'dismissed', decidedAt: 100 }))
        .resolves.toMatchObject({ id: 100, decision: 'dismissed' });
      await expect(repository.rewindDecision(900, { decision: 'dismissed', decidedAt: 100 }))
        .resolves.toMatchObject({ id: 900, decision: 'dismissed' });
      await expect(repository.restoreDeck()).resolves.toMatchObject({
        active: { id: 900 },
        queued: [{ id: 100 }, { id: 500 }],
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test.each([
    { operation: 'ready', value: '' },
    { operation: 'ready', value: '   ' },
    { operation: 'failed', value: '' },
    { operation: 'failed', value: '   ' },
  ] as const)('rejects empty $operation download metadata', async ({ operation, value }) => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(325)]);
      await repository.activateNext(10);
      await repository.decide(325, 'saved', 20);

      const changed =
        operation === 'ready'
          ? await repository.markDownloadReady(325, value)
          : await repository.markDownloadFailed(325, value);
      expect(changed).toBe(false);
      await expect(repository.getById(325)).resolves.toMatchObject({
        downloadState: 'pending',
        localUri: null,
        downloadError: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('rejects negative and fractional transition timestamps', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(326)]);
      await expect(repository.activateNext(-1)).rejects.toThrow('presentedAt');
      await expect(repository.activateNext(1.5)).rejects.toThrow('presentedAt');
      await expect(repository.getById(326)).resolves.toMatchObject({
        decision: 'queued',
      });

      await repository.activateNext(1);
      await expect(repository.decide(326, 'saved', -1)).rejects.toThrow('decidedAt');
      await expect(repository.decide(326, 'saved', 1.5)).rejects.toThrow('decidedAt');
      await expect(repository.getById(326)).resolves.toMatchObject({
        decision: 'active',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: the repository rewinds a matching decision that is not the most recent one (inverted rule)', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([
        candidateWithId(351),
        candidateWithId(352),
        candidateWithId(353),
      ]);
      await repository.activateNext(10);
      await repository.decide(351, 'dismissed', 20);
      await repository.activateNext(30);
      await repository.decide(352, 'saved', 40);
      await repository.activateNext(50);

      // The LIFO order belongs to the service's history now; the repository
      // only checks that the row still holds the decision being rewound.
      await expect(repository.rewindDecision(351, { decision: 'dismissed', decidedAt: 20 }))
        .resolves.toMatchObject({ id: 351, decision: 'dismissed' });
      await expect(repository.getById(351)).resolves.toMatchObject({
        decision: 'active',
      });
      await expect(repository.getById(352)).resolves.toMatchObject({
        decision: 'saved',
        decidedAt: 40,
      });
      await expect(repository.restoreDeck()).resolves.toMatchObject({
        active: { id: 351 },
        queued: [{ id: 353 }],
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('collection deletion retains dismissed history and blocks reinsertion', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const image = candidateWithId(401);
      await repository.insertCandidates([image]);
      await repository.activateNext(10);
      await repository.decide(image.id, 'saved', 20);

      await expect(repository.deleteFromCollection(image.id)).resolves.toMatchObject({
        id: image.id,
        decision: 'dismissed',
        downloadState: 'none',
        localUri: null,
      });
      await expect(repository.insertCandidates([image])).resolves.toMatchObject({ inserted: 0 });
      await expect(repository.getById(image.id)).resolves.toMatchObject({
        decision: 'dismissed',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('return to discovery deletes the durable row and permits reinsertion', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const image = candidateWithId(501);
      await repository.insertCandidates([image]);
      await repository.activateNext(10);
      await repository.decide(image.id, 'saved', 20);

      await expect(repository.returnToDiscovery(image.id)).resolves.toMatchObject({
        id: image.id,
        decision: 'saved',
      });
      await expect(repository.getById(image.id)).resolves.toBeNull();
      await expect(repository.insertCandidates([image])).resolves.toMatchObject({ inserted: 1 });
      await expect(repository.getById(image.id)).resolves.toMatchObject({
        decision: 'queued',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('return to discovery refuses to delete dismissed rows', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const image = candidateWithId(551);
      await repository.insertCandidates([image]);
      await repository.activateNext(10);
      await repository.decide(image.id, 'dismissed', 20);

      await expect(repository.returnToDiscovery(image.id)).resolves.toBeNull();
      await expect(repository.getById(image.id)).resolves.toMatchObject({
        decision: 'dismissed',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('reset modes preserve saved rows and differ in discovery scope', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([
        candidateWithId(601),
        candidateWithId(602),
        candidateWithId(603),
        candidateWithId(604),
      ]);
      await repository.activateNext(10);
      await repository.decide(601, 'saved', 20);
      await repository.activateNext(30);
      await repository.decide(602, 'dismissed', 40);
      await repository.activateNext(50);

      await expect(repository.resetDismissedHistory()).resolves.toBe(1);
      await expect(repository.getById(601)).resolves.toMatchObject({ decision: 'saved' });
      await expect(repository.getById(602)).resolves.toBeNull();
      await expect(repository.getById(603)).resolves.toMatchObject({ decision: 'active' });
      await expect(repository.getById(604)).resolves.toMatchObject({ decision: 'queued' });

      await expect(repository.resetDiscoveryHistory()).resolves.toBe(2);
      await expect(repository.getById(601)).resolves.toMatchObject({ decision: 'saved' });
      await expect(repository.getById(603)).resolves.toBeNull();
      await expect(repository.getById(604)).resolves.toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });

  test('caps recent handled IDs at 100 in newest-first order', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const candidates = Array.from({ length: 105 }, (_, index) =>
        candidateWithId(1_000 + index),
      );
      await repository.insertCandidates(candidates);
      for (let index = 0; index < candidates.length; index += 1) {
        const active = await repository.activateNext(index);
        await repository.decide(active!.id, 'dismissed', index);
      }

      const recent = await repository.recentHandledIds(500);
      expect(recent).toHaveLength(100);
      expect(recent[0]).toBe(1_104);
      expect(recent[99]).toBe(1_005);
      await expect(repository.recentHandledIdentities(2)).resolves.toEqual([
        { providerKey: 'waifu_im', providerItemId: '1104' },
        { providerKey: 'waifu_im', providerItemId: '1103' },
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('restores persisted active, queued, and collection state after reconstruction', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([
        candidateWithId(701),
        candidateWithId(702),
        candidateWithId(703),
      ]);
      await repository.activateNext(10);
      await repository.decide(701, 'saved', 20);
      await repository.activateNext(30);
      await repository.markDownloadFailed(701, 'offline');

      const reconstructed = createImageRepository(database);
      await expect(reconstructed.restoreDeck()).resolves.toMatchObject({
        active: { id: 702, decision: 'active' },
        queued: [{ id: 703, decision: 'queued' }],
      });
      await expect(reconstructed.listCollection()).resolves.toMatchObject([
        { id: 701, decision: 'saved', downloadState: 'failed' },
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('normalizes valid stored tag JSON and repairs malformed JSON', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(801)]);
      await database.run('UPDATE images SET tags_json = ? WHERE id = ?', [
        '[" Foo ", 4, "foo", "BAR"]',
        801,
      ]);
      await expect(repository.getById(801)).resolves.toMatchObject({
        tags: ['bar', 'foo'],
      });

      await database.run('UPDATE images SET tags_json = ? WHERE id = ?', [
        '{not-json',
        801,
      ]);
      await expect(repository.getById(801)).resolves.toMatchObject({ tags: [] });
    } finally {
      nativeDatabase.close();
    }
  });

  test.each([
    {
      id: 851,
      decision: 'queued',
      decidedAt: null,
      downloadState: 'ready',
      localUri: 'file:///invalid.webp',
    },
    {
      id: 852,
      decision: 'saved',
      decidedAt: 1,
      downloadState: 'none',
      localUri: null,
    },
    {
      id: 853,
      decision: 'saved',
      decidedAt: 1,
      downloadState: 'ready',
      localUri: null,
    },
  ])(
    'rejects invalid stored cross-column state for image $id',
    async ({ id, decision, decidedAt, downloadState, localUri }) => {
      const { nativeDatabase, database, repository } = await openRepository();

      try {
        await repository.insertCandidates([candidateWithId(id)]);
        await database.run(
          `UPDATE images
           SET decision = ?, decided_at = ?, download_state = ?, local_uri = ?
           WHERE id = ?`,
          [decision, decidedAt, downloadState, localUri, id],
        );

        await expect(repository.getById(id)).rejects.toThrow('Invalid images state');
      } finally {
        nativeDatabase.close();
      }
    },
  );

  test.each([
    {
      label: 'negative presented timestamp',
      update:
        "decision = 'active', presented_at = ?, decided_at = NULL, decision_ordinal = NULL",
      value: -1,
      error: 'Invalid images.presented_at',
    },
    {
      label: 'fractional presented timestamp',
      update:
        "decision = 'active', presented_at = ?, decided_at = NULL, decision_ordinal = NULL",
      value: 1.5,
      error: 'Invalid images.presented_at',
    },
    {
      label: 'negative decided timestamp',
      update:
        "decision = 'dismissed', presented_at = 1, decided_at = ?, decision_ordinal = 1",
      value: -1,
      error: 'Invalid images.decided_at',
    },
    {
      label: 'fractional decided timestamp',
      update:
        "decision = 'dismissed', presented_at = 1, decided_at = ?, decision_ordinal = 1",
      value: 1.5,
      error: 'Invalid images.decided_at',
    },
    {
      label: 'fractional queue ordinal',
      update: 'queue_ordinal = ?',
      value: 1.5,
      error: 'Invalid images.queue_ordinal',
    },
    {
      label: 'non-positive decision ordinal',
      update:
        "decision = 'dismissed', presented_at = 1, decided_at = 1, decision_ordinal = ?",
      value: 0,
      error: 'Invalid images.decision_ordinal',
    },
    {
      label: 'fractional decision ordinal',
      update:
        "decision = 'dismissed', presented_at = 1, decided_at = 1, decision_ordinal = ?",
      value: 1.5,
      error: 'Invalid images.decision_ordinal',
    },
  ])('rejects stored $label', async ({ update, value, error }) => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(875)]);
      await database.run(`UPDATE images SET ${update} WHERE id = ?`, [value, 875]);

      await expect(repository.getById(875)).rejects.toThrow(error);
    } finally {
      nativeDatabase.close();
    }
  });

  test('delete all removes saved and discovery rows', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(901), candidateWithId(902)]);
      await repository.activateNext(10);
      await repository.decide(901, 'saved', 20);

      await expect(repository.deleteAll()).resolves.toBe(2);
      await expect(repository.getById(901)).resolves.toBeNull();
      await expect(repository.getById(902)).resolves.toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });

  test('marks saved ready or failed files missing and keeps the record repairable', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(910)]);
      await repository.activateNext(10);
      await repository.decide(910, 'saved', 20);
      await repository.markDownloadReady(910, 'file:///collection/910.webp');

      await expect(repository.markFileMissing(910, 'file_missing')).resolves.toBe(true);
      await expect(repository.getById(910)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'failed',
        localUri: null,
        downloadError: 'file_missing',
      });

      await expect(repository.markFileMissing(910, 'still_missing')).resolves.toBe(true);
      await expect(repository.getById(910)).resolves.toMatchObject({
        downloadState: 'failed',
        localUri: null,
        downloadError: 'still_missing',
      });
      await expect(repository.markFileMissing(910, '')).resolves.toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('refuses to mark a pending file missing', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidateWithId(911)]);
      await repository.activateNext(10);
      await repository.decide(911, 'saved', 20);

      await expect(repository.markFileMissing(911, 'file_missing')).resolves.toBe(false);
      await expect(repository.getById(911)).resolves.toMatchObject({
        downloadState: 'pending',
        localUri: null,
        downloadError: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('deletes only queued candidates and preserves the result across reconstruction', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([
        candidateWithId(920),
        candidateWithId(921),
        candidateWithId(922),
        candidateWithId(923),
      ]);
      await repository.activateNext(10);
      await repository.decide(920, 'dismissed', 20);
      await repository.activateNext(30);
      await repository.decide(921, 'saved', 40);
      await repository.activateNext(50);

      await expect(repository.deleteQueuedCandidates()).resolves.toBe(1);
      await expect(repository.restoreDeck()).resolves.toMatchObject({
        active: { id: 922 },
        queued: [],
      });
      await expect(repository.getById(920)).resolves.toMatchObject({ decision: 'dismissed' });
      await expect(repository.getById(921)).resolves.toMatchObject({ decision: 'saved' });

      const reconstructed = createImageRepository(database);
      await expect(reconstructed.restoreDeck()).resolves.toMatchObject({
        active: { id: 922 },
        queued: [],
      });
      await expect(reconstructed.getById(923)).resolves.toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('cross-source suppression of a dismissed image', () => {
  const SHARED_SOURCE_KEY = 'pixiv:123456';

  /**
   * Seeds the situation G2b exists to fix: the user has already swiped left
   * on a danbooru post. The row carries both cross-source identities -- the
   * shared pixiv source key (signal A) and the booru's byte-exact md5
   * (signal B) -- and no perceptual hash, so any suppression proved below
   * comes from one of those two arms and not from the pre-existing hash arm.
   */
  async function seedDismissedDanbooruPost(
    repository: ImageRepository,
  ): Promise<void> {
    await repository.insertCandidates([{
      ...candidateWithId(1_101),
      providerKey: 'danbooru',
      providerItemId: 'danbooru-1101',
      canonicalSourceKey: SHARED_SOURCE_KEY,
      perceptualHash: null,
      md5: DANBOORU_MD5,
    }]);
    await repository.activateNext(10);
    await repository.decide(1_101, 'dismissed', 20);
  }

  test('signal A: a shared canonical source key blocks a different provider re-offer', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await seedDismissedDanbooruPost(repository);

      // Same artwork on e621: different provider identity and a differently
      // encoded file (different md5), but the same pixiv source.
      await expect(repository.insertCandidates([{
        ...candidateWithoutId(1_102),
        providerKey: 'e621',
        providerItemId: 'e621-1102',
        canonicalSourceKey: SHARED_SOURCE_KEY,
        perceptualHash: null,
        md5: MIRROR_MD5,
        remoteUrl: 'https://static1.e621.net/data/mirror-1102.png',
      }])).resolves.toMatchObject({ inserted: 0 });

      await expect(database.getAll('SELECT id FROM images')).resolves.toEqual([
        { id: 1_101 },
      ]);
      await expect(repository.restoreDeck()).resolves.toEqual({
        active: null,
        queued: [],
      });
      await expect(repository.getById(1_101)).resolves.toMatchObject({
        decision: 'dismissed',
        decidedAt: 20,
        md5: DANBOORU_MD5,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('signal B: a shared md5 blocks a re-offer with no shared source identity', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await seedDismissedDanbooruPost(repository);

      // The same bytes on e621, but the mirror lists no pixiv source, so the
      // only identity in common is the md5.
      await expect(repository.insertCandidates([{
        ...candidateWithoutId(1_103),
        providerKey: 'e621',
        providerItemId: 'e621-1103',
        canonicalSourceKey: 'e621:998877',
        perceptualHash: null,
        md5: DANBOORU_MD5,
        remoteUrl: 'https://static1.e621.net/data/mirror-1103.png',
      }])).resolves.toMatchObject({ inserted: 0 });

      await expect(database.getAll('SELECT id FROM images')).resolves.toEqual([
        { id: 1_101 },
      ]);
      await expect(repository.restoreDeck()).resolves.toEqual({
        active: null,
        queued: [],
      });
      await expect(repository.getById(1_101)).resolves.toMatchObject({
        decision: 'dismissed',
        decidedAt: 20,
        canonicalSourceKey: SHARED_SOURCE_KEY,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('negative control: a different file by the same artist still reaches the queue', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await seedDismissedDanbooruPost(repository);

      // Same artist, same dimensions, same tags -- everything the gate must
      // NOT treat as identity. Every real identity differs.
      await expect(repository.insertCandidates([{
        ...candidateWithoutId(1_104),
        providerKey: 'e621',
        providerItemId: 'e621-1104',
        canonicalSourceKey: 'pixiv:654321',
        perceptualHash: null,
        md5: MIRROR_MD5,
        remoteUrl: 'https://static1.e621.net/data/other-1104.png',
      }])).resolves.toMatchObject({ inserted: 1 });

      const deck = await repository.restoreDeck();
      expect(deck.queued).toHaveLength(1);
      expect(deck.queued[0]).toMatchObject({
        providerKey: 'e621',
        providerItemId: 'e621-1104',
        canonicalSourceKey: 'pixiv:654321',
        md5: MIRROR_MD5,
        decision: 'queued',
        artistName: candidate.artistName,
        width: candidate.width,
        height: candidate.height,
      });
      await expect(repository.getById(1_101)).resolves.toMatchObject({
        decision: 'dismissed',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('backfills md5 onto an older row matched by canonical source key', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      // A row stored before md5 existed (or from a provider that never
      // published one): the digest column is null.
      await repository.insertCandidates([{
        ...candidateWithId(1_105),
        providerKey: 'waifu_im',
        providerItemId: 'waifu-1105',
        canonicalSourceKey: SHARED_SOURCE_KEY,
        perceptualHash: null,
        md5: null,
      }]);
      await repository.activateNext(10);
      await repository.decide(1_105, 'dismissed', 20);
      await expect(repository.getById(1_105)).resolves.toMatchObject({ md5: null });

      // Re-seen from danbooru, which does publish the digest. The row is
      // adopted rather than duplicated, and COALESCE fills the digest in.
      const saved = await repository.saveCandidate({
        ...candidateWithoutId(1_106),
        providerKey: 'danbooru',
        providerItemId: 'danbooru-1106',
        canonicalSourceKey: SHARED_SOURCE_KEY,
        perceptualHash: null,
        md5: DANBOORU_MD5,
      }, 30);

      expect(saved).toMatchObject({ id: 1_105, md5: DANBOORU_MD5 });
      await expect(
        database.getFirst<{ count: number }>('SELECT COUNT(*) AS count FROM images'),
      ).resolves.toEqual({ count: 1 });

      // The backfill is what makes the next md5-only re-offer suppressible.
      await expect(repository.insertCandidates([{
        ...candidateWithoutId(1_107),
        providerKey: 'e621',
        providerItemId: 'e621-1107',
        canonicalSourceKey: 'e621:112233',
        perceptualHash: null,
        md5: DANBOORU_MD5,
      }])).resolves.toMatchObject({ inserted: 0 });
    } finally {
      nativeDatabase.close();
    }
  });

  test.each(['pending', 'ready'] as const)(
    'backfills md5 onto an existing %s saved row without disturbing its file',
    async (downloadState) => {
      const { nativeDatabase, repository } = await openRepository();

      try {
        const original = await repository.saveCandidate({
          ...candidateWithoutId(1_108),
          providerKey: 'waifu_im',
          providerItemId: 'waifu-1108',
          canonicalSourceKey: SHARED_SOURCE_KEY,
          perceptualHash: null,
          md5: null,
        }, 10);
        expect(original).toMatchObject({ md5: null, downloadState: 'pending' });
        if (downloadState === 'ready') {
          await repository.markDownloadReady(
            original.id,
            'file:///collection/1108.webp',
          );
        }

        const rediscovered = await repository.saveCandidate({
          ...candidateWithoutId(1_109),
          providerKey: 'danbooru',
          providerItemId: 'danbooru-1109',
          canonicalSourceKey: SHARED_SOURCE_KEY,
          perceptualHash: null,
          md5: DANBOORU_MD5,
        }, 20);

        expect(rediscovered).toMatchObject({
          id: original.id,
          md5: DANBOORU_MD5,
          decision: 'saved',
          downloadState,
          localUri: downloadState === 'ready'
            ? 'file:///collection/1108.webp'
            : null,
        });
      } finally {
        nativeDatabase.close();
      }
    },
  );
});

describe('discovery-time identity backfill (G3a task3)', () => {
  const SOURCE_KEY = 'pixiv:998877';

  test('backfills md5 onto a dismissed row matched by canonical source key during discovery', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      // A row discovered before md5 existed for it: the digest column is null.
      await repository.insertCandidates([{
        ...candidateWithId(1_201),
        providerKey: 'waifu_im',
        providerItemId: 'waifu-1201',
        canonicalSourceKey: SOURCE_KEY,
        perceptualHash: null,
        md5: null,
      }]);
      await repository.activateNext(10);
      await repository.decide(1_201, 'dismissed', 20);
      await expect(repository.getById(1_201)).resolves.toMatchObject({ md5: null });

      // Re-seen from danbooru during discovery (insertCandidates), which does
      // publish the digest. The duplicate hit inserts nothing new -- it
      // COALESCEs the digest onto the existing dismissed row instead.
      await expect(repository.insertCandidates([{
        ...candidateWithoutId(1_202),
        providerKey: 'danbooru',
        providerItemId: 'danbooru-1202',
        canonicalSourceKey: SOURCE_KEY,
        perceptualHash: null,
        md5: DANBOORU_MD5,
      }])).resolves.toMatchObject({ inserted: 0 });

      await expect(database.getAll('SELECT id FROM images')).resolves.toEqual([
        { id: 1_201 },
      ]);
      await expect(repository.getById(1_201)).resolves.toMatchObject({
        md5: DANBOORU_MD5,
        canonicalSourceKey: SOURCE_KEY,
        decision: 'dismissed',
        decidedAt: 20,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('does not overwrite an existing non-null md5 on a discovery-time duplicate hit', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const EXISTING_MD5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const OFFERED_MD5 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    try {
      await repository.insertCandidates([{
        ...candidateWithId(1_203),
        providerKey: 'waifu_im',
        providerItemId: 'waifu-1203',
        canonicalSourceKey: SOURCE_KEY,
        perceptualHash: null,
        md5: EXISTING_MD5,
      }]);

      await expect(repository.insertCandidates([{
        ...candidateWithoutId(1_204),
        providerKey: 'danbooru',
        providerItemId: 'danbooru-1204',
        canonicalSourceKey: SOURCE_KEY,
        perceptualHash: null,
        md5: OFFERED_MD5,
      }])).resolves.toMatchObject({ inserted: 0 });

      await expect(repository.getById(1_203)).resolves.toMatchObject({
        md5: EXISTING_MD5,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('closes the G2b signal-B gap: a discovery-time backfill suppresses a later md5-only re-offer', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      // Dismissed row with no md5 yet.
      await repository.insertCandidates([{
        ...candidateWithId(1_205),
        providerKey: 'waifu_im',
        providerItemId: 'waifu-1205',
        canonicalSourceKey: SOURCE_KEY,
        perceptualHash: null,
        md5: null,
      }]);
      await repository.activateNext(10);
      await repository.decide(1_205, 'dismissed', 20);

      // Discovery-time duplicate hit backfills the digest via the shared
      // canonical source key (signal A).
      await expect(repository.insertCandidates([{
        ...candidateWithoutId(1_206),
        providerKey: 'danbooru',
        providerItemId: 'danbooru-1206',
        canonicalSourceKey: SOURCE_KEY,
        perceptualHash: null,
        md5: DANBOORU_MD5,
      }])).resolves.toMatchObject({ inserted: 0 });

      // A third source shares only the md5 -- a different canonical source
      // key and no hash. Before the backfill above, the row's md5 was null,
      // so this offer would have reached the queue; the backfill now makes
      // it suppressible by signal B.
      await expect(repository.insertCandidates([{
        ...candidateWithoutId(1_207),
        providerKey: 'e621',
        providerItemId: 'e621-1207',
        canonicalSourceKey: 'e621:445566',
        perceptualHash: null,
        md5: DANBOORU_MD5,
      }])).resolves.toMatchObject({ inserted: 0 });

      await expect(database.getAll('SELECT id FROM images')).resolves.toEqual([
        { id: 1_205 },
      ]);
      await expect(repository.restoreDeck()).resolves.toEqual({
        active: null,
        queued: [],
      });
      await expect(repository.getById(1_205)).resolves.toMatchObject({
        decision: 'dismissed',
        decidedAt: 20,
      });
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('insertCandidates per-provider breakdown (G3b)', () => {
  test('attributes each insert to its source and omits sources that inserted nothing', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const base = candidateWithId(700);
      const { id: _localId, ...waifuCandidate } = base;
      const asProvider = (
        providerKey: ImageCandidate['providerKey'],
        providerItemId: string,
      ) => ({
        ...waifuCandidate,
        providerKey,
        providerItemId,
        canonicalSourceKey: null,
        perceptualHash: null,
        md5: null,
        remoteUrl: `https://cdn.example.com/${providerKey}/${providerItemId}.webp`,
      });

      await expect(repository.insertCandidates([
        asProvider('waifu_im', 'w1'),
        asProvider('danbooru', 'd1'),
        asProvider('waifu_im', 'w2'),
      ])).resolves.toEqual({
        inserted: 3,
        byProvider: { waifu_im: 2, danbooru: 1 },
      });

      // Danbooru re-offers the post it already contributed while Waifu brings a
      // new one: the total alone cannot say who went quiet, the breakdown can.
      await expect(repository.insertCandidates([
        asProvider('danbooru', 'd1'),
        asProvider('waifu_im', 'w3'),
      ])).resolves.toEqual({
        inserted: 1,
        byProvider: { waifu_im: 1 },
      });

      // An all-duplicate call reports an empty breakdown, not a missing one.
      await expect(repository.insertCandidates([asProvider('danbooru', 'd1')]))
        .resolves.toEqual({ inserted: 0, byProvider: {} });
      await expect(repository.insertCandidates([]))
        .resolves.toEqual({ inserted: 0, byProvider: {} });
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('insertCandidates orderSurvivors (G3c Task 4)', () => {
  test('reseats queue_ordinal over the survivors of a suppressed collision, preserves default order without the callback, and falls back on a bad permutation', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      const seed = { ...candidateWithId(1_301), canonicalSourceKey: 'pixiv:1301' };
      await repository.insertCandidates([seed]);

      const offered = [
        { ...candidateWithoutId(1_302), canonicalSourceKey: 'pixiv:1302' },
        // Collides with the seed's canonical source key: suppressed, not inserted.
        { ...candidateWithoutId(1_303), canonicalSourceKey: 'pixiv:1301' },
        { ...candidateWithoutId(1_304), canonicalSourceKey: 'pixiv:1304' },
        { ...candidateWithoutId(1_305), canonicalSourceKey: 'pixiv:1305' },
      ];

      await expect(
        repository.insertCandidates(offered, {
          // Reverse the *survivors* -- 3 items, not the 4 offered.
          orderSurvivors: (survivors) => [...survivors].reverse(),
        }),
      ).resolves.toEqual({ inserted: 3, byProvider: { waifu_im: 3 } });

      const afterReorder = await repository.restoreDeck();
      expect(afterReorder.queued.map(({ providerItemId }) => providerItemId)).toEqual([
        '1301', '1305', '1304', '1302',
      ]);

      // A second call with no callback keeps plain insertion order.
      await repository.insertCandidates([
        candidateWithoutId(1_306),
        candidateWithoutId(1_307),
      ]);
      const afterPlainInsert = await repository.restoreDeck();
      expect(
        afterPlainInsert.queued.slice(-2).map(({ providerItemId }) => providerItemId),
      ).toEqual(['1306', '1307']);

      // A callback that does not return a permutation of what it was handed
      // (wrong length here) is not trusted: insertion order stands.
      await repository.insertCandidates(
        [candidateWithoutId(1_308), candidateWithoutId(1_309)],
        { orderSurvivors: (survivors) => survivors.slice(1) },
      );
      const finalDeck = await repository.restoreDeck();
      expect(
        finalDeck.queued.slice(-2).map(({ providerItemId }) => providerItemId),
      ).toEqual(['1308', '1309']);

      // Same guard, other two branches: a foreign object (identity miss) and a
      // repeated object both fall back to insertion order.
      await repository.insertCandidates(
        [candidateWithoutId(1_310), candidateWithoutId(1_311)],
        {
          orderSurvivors: (survivors) => [
            { ...survivors[0]! },
            survivors[1]!,
          ],
        },
      );
      await repository.insertCandidates(
        [candidateWithoutId(1_312), candidateWithoutId(1_313)],
        { orderSurvivors: (survivors) => [survivors[0]!, survivors[0]!] },
      );
      const guardDeck = await repository.restoreDeck();
      expect(
        guardDeck.queued.slice(-4).map(({ providerItemId }) => providerItemId),
      ).toEqual(['1310', '1311', '1312', '1313']);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('sampleUrl persistence (R8.18)', () => {
  test('round-trips a source sample url and falls back to remote_url when absent', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      // A source that publishes a distinct medium sample (moebooru/gelbooru
      // sample_url, danbooru large_file_url) persists it verbatim.
      await repository.insertCandidates([
        {
          ...candidateWithId(1_401),
          remoteUrl: 'https://cdn.example.com/1401-original.png',
          sampleUrl: 'https://cdn.example.com/1401-sample.jpg',
        },
        // A source with no sample leaves it undefined; the row column is NULL.
        {
          ...candidateWithId(1_402),
          remoteUrl: 'https://cdn.example.com/1402-original.png',
          sampleUrl: undefined,
        },
      ]);

      const deck = await repository.restoreDeck();
      const byId = new Map(
        [deck.active, ...deck.queued]
          .filter((card): card is NonNullable<typeof card> => card !== null)
          .map((card) => [card.id, card]),
      );

      // The deck card renders sampleUrl; a real sample must survive the round trip.
      expect(byId.get(1_401)?.sampleUrl).toBe(
        'https://cdn.example.com/1401-sample.jpg',
      );
      // No sample → mapImageRow resolves to remote_url so the card always has a
      // usable display url, and saving still downloads remoteUrl.
      expect(byId.get(1_402)?.sampleUrl).toBe(
        'https://cdn.example.com/1402-original.png',
      );
      expect(byId.get(1_402)?.remoteUrl).toBe(
        'https://cdn.example.com/1402-original.png',
      );
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('saveMirroredCandidate (K2)', () => {
  test('a new restored row is saved+mirrored with no collection file', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const saved = await repository.saveMirroredCandidate(candidateWithoutId(3101), 500);
      expect(saved).toMatchObject({
        decision: 'saved',
        downloadState: 'mirrored',
        localUri: null,
        downloadError: null,
        decidedAt: 500,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('keeps this device\'s own ready collection file when the identity already exists', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const own = await repository.saveCandidate(candidateWithoutId(3102), 100);
      await repository.markDownloadReady(own.id, 'file:///collection/3102.jpg');
      const merged = await repository.saveMirroredCandidate(candidateWithoutId(3102), 900);
      expect(merged.id).toBe(own.id);
      expect(merged.downloadState).toBe('ready');
      expect(merged.localUri).toBe('file:///collection/3102.jpg');
    } finally {
      nativeDatabase.close();
    }
  });

  test('an existing saved+pending row becomes mirrored', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const pending = await repository.saveCandidate(candidateWithoutId(3103), 100);
      expect(pending.downloadState).toBe('pending');
      const merged = await repository.saveMirroredCandidate(candidateWithoutId(3103), 900);
      expect(merged.id).toBe(pending.id);
      expect(merged.downloadState).toBe('mirrored');
      expect(merged.localUri).toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });

  test('saveCandidate still writes pending (regression)', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const saved = await repository.saveCandidate(candidateWithoutId(3104), 100);
      expect(saved.downloadState).toBe('pending');
    } finally {
      nativeDatabase.close();
    }
  });

  test('row mapper accepts mirrored+null uri and rejects mirrored+uri', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      const saved = await repository.saveMirroredCandidate(candidateWithoutId(3105), 100);
      await expect(repository.getById(saved.id)).resolves.toMatchObject({ downloadState: 'mirrored' });
      await database.run(
        `UPDATE images SET local_uri = 'file:///collection/x.jpg' WHERE id = ?`,
        [saved.id],
      );
      await expect(repository.getById(saved.id)).rejects.toThrow('Invalid images state');
    } finally {
      nativeDatabase.close();
    }
  });

  test('K2b: reclaimMirroredForDownload moves a mirrored row to pending so an explicit repair can re-fetch', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const m = await repository.saveMirroredCandidate(candidateWithoutId(3120), 100);
      await expect(repository.reclaimMirroredForDownload(m.id)).resolves.toBe(true);
      await expect(repository.getById(m.id)).resolves.toMatchObject({ downloadState: 'pending', localUri: null, downloadError: null });
      // idempotent / wrong-state → false
      await expect(repository.reclaimMirroredForDownload(m.id)).resolves.toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('K2b: saveCandidate on an existing mirrored identity keeps it mirrored (metadata merge only)', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      // The mirrored row starts with no md5; the re-collect supplies one. The
      // keeps-bytes branch merges metadata by backfilling NULL fields only
      // (COALESCE), exactly like the accepted ready-file case — it never
      // overwrites an existing value and never touches the download state.
      const m = await repository.saveMirroredCandidate(candidateWithoutId(3130), 100);
      expect(m.md5).toBeNull();
      const again = await repository.saveCandidate(
        { ...candidateWithoutId(3130), md5: 'a'.repeat(32), artistName: 'Renamed' },
        900,
      );
      expect(again.id).toBe(m.id);
      expect(again.downloadState).toBe('mirrored');
      expect(again.localUri).toBeNull();
      expect(again.md5).toBe('a'.repeat(32));          // NULL field backfilled
      expect(again.artistName).toBe('Example Artist'); // existing value kept
    } finally {
      nativeDatabase.close();
    }
  });

  test.each(['queued', 'active', 'dismissed'] as const)(
    'K2b: an existing %s row becomes saved+mirrored via saveMirroredCandidate',
    async (historicalDecision) => {
      const { nativeDatabase, repository } = await openRepository();
      try {
        await repository.insertCandidates([candidateWithId(3140)]);
        if (historicalDecision !== 'queued') await repository.activateNext(10);
        if (historicalDecision === 'dismissed') await repository.decide(3140, 'dismissed', 20);
        const merged = await repository.saveMirroredCandidate(candidateWithoutId(3140), 900);
        expect(merged.id).toBe(3140);
        expect(merged.decision).toBe('saved');
        expect(merged.downloadState).toBe('mirrored');
        expect(merged.localUri).toBeNull();
      } finally {
        nativeDatabase.close();
      }
    },
  );
});

describe('K6-5 C: library ingest failures on a collected row', () => {
  // `download_error` describes a provider fetch that failed. This describes a
  // row whose fetch SUCCEEDED and whose library ingest then threw — a different
  // failure, on a row that stays `ready`, so it never touches `download_state`.

  test('a saved row starts with no ingest error and no attempts', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const saved = await repository.saveCandidate(candidateWithoutId(4101), 100);
      expect(saved.libraryError).toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });

  test('records the code and counts the attempts without disturbing the download state', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const saved = await repository.saveCandidate(candidateWithoutId(4102), 100);
      await repository.markDownloadReady(saved.id, 'file:///collection/4102.jpg');

      await expect(repository.recordLibraryIngestFailure(saved.id, 'decode_failed'))
        .resolves.toBe(true);
      await expect(repository.getById(saved.id)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: 'file:///collection/4102.jpg',
        downloadError: null,
        libraryError: 'decode_failed',
      });

      await repository.recordLibraryIngestFailure(saved.id, 'decode_failed');
      await expect(nativeDatabase
        .prepare('SELECT library_error_attempts AS n FROM images WHERE id = ?')
        .get(saved.id)).toMatchObject({ n: 2 });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a successful re-ingest clears the code and the counter', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const saved = await repository.saveCandidate(candidateWithoutId(4103), 100);
      await repository.markDownloadReady(saved.id, 'file:///collection/4103.jpg');
      await repository.recordLibraryIngestFailure(saved.id, 'unreadable_source');

      await expect(repository.clearLibraryIngestError(saved.id)).resolves.toBe(true);
      await expect(repository.getById(saved.id)).resolves.toMatchObject({
        libraryError: null,
      });
      await expect(nativeDatabase
        .prepare('SELECT library_error_attempts AS n FROM images WHERE id = ?')
        .get(saved.id)).toMatchObject({ n: 0 });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a row that leaves the collection carries no stale ingest error back in', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const saved = await repository.saveCandidate(candidateWithoutId(4104), 100);
      await repository.markDownloadReady(saved.id, 'file:///collection/4104.jpg');
      await repository.recordLibraryIngestFailure(saved.id, 'decode_failed');

      await repository.deleteFromCollection(saved.id);
      const resaved = await repository.saveCandidate(candidateWithoutId(4104), 200);

      expect(resaved.id).toBe(saved.id);
      expect(resaved.libraryError).toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });

  test('refuses an empty code and an unknown row', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const saved = await repository.saveCandidate(candidateWithoutId(4105), 100);
      await expect(repository.recordLibraryIngestFailure(saved.id, '  ')).resolves.toBe(false);
      await expect(repository.recordLibraryIngestFailure(987654, 'decode_failed'))
        .resolves.toBe(false);
      await expect(repository.clearLibraryIngestError(987654)).resolves.toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  describe('board #5 — download_error_kind', () => {
    async function savedPending(repository: Awaited<ReturnType<typeof openRepository>>['repository'], id: number) {
      await repository.insertCandidates([candidateWithId(id)]);
      await repository.activateNext(10);
      await repository.decide(id, 'saved', 20);
    }

    test('markDownloadFailed records source_gone, and defaults to transient', async () => {
      const { nativeDatabase, repository } = await openRepository();
      try {
        await savedPending(repository, 5001);
        await expect(repository.markDownloadFailed(5001, 'download_failed', undefined, 'source_gone'))
          .resolves.toBe(true);
        await expect(repository.getById(5001)).resolves.toMatchObject({
          downloadState: 'failed',
          downloadError: 'download_failed',
          downloadErrorKind: 'source_gone',
        });

        await savedPending(repository, 5002);
        await expect(repository.markDownloadFailed(5002, 'download_failed')).resolves.toBe(true);
        await expect(repository.getById(5002)).resolves.toMatchObject({
          downloadState: 'failed',
          downloadErrorKind: 'transient',
        });
      } finally {
        nativeDatabase.close();
      }
    });

    test('a locally missing file is a transient failure, never a gone source', async () => {
      const { nativeDatabase, repository } = await openRepository();
      try {
        await savedPending(repository, 5003);
        await repository.markDownloadReady(5003, 'file:///collection/5003.webp');
        await expect(repository.markFileMissing(5003, 'file_missing')).resolves.toBe(true);
        await expect(repository.getById(5003)).resolves.toMatchObject({
          downloadState: 'failed',
          downloadErrorKind: 'transient',
        });
      } finally {
        nativeDatabase.close();
      }
    });

    test('every transition that clears download_error clears the kind with it', async () => {
      const { nativeDatabase, repository } = await openRepository();
      try {
        // re-saving a failed candidate → pending, kind gone
        await savedPending(repository, 5004);
        await repository.markDownloadFailed(5004, 'download_failed', undefined, 'source_gone');
        await expect(repository.decide(5004, 'saved', 30)).resolves.toMatchObject({
          downloadState: 'pending',
          downloadError: null,
          downloadErrorKind: null,
        });
        // ready clears it
        await expect(repository.markDownloadReady(5004, 'file:///collection/5004.webp')).resolves.toBe(true);
        await expect(repository.getById(5004)).resolves.toMatchObject({
          downloadState: 'ready',
          downloadErrorKind: null,
        });
        // delete from collection clears it
        await repository.markFileMissing(5004, 'file_missing');
        await repository.deleteFromCollection(5004);
        await expect(repository.getById(5004)).resolves.toMatchObject({
          decision: 'dismissed',
          downloadState: 'none',
          downloadError: null,
          downloadErrorKind: null,
        });
      } finally {
        nativeDatabase.close();
      }
    });

    test('a pre-v20 failed row (NULL kind) still maps, and a kind on a non-failed row is rejected', async () => {
      const { nativeDatabase, database, repository } = await openRepository();
      try {
        await savedPending(repository, 5005);
        await repository.markDownloadFailed(5005, 'download_failed');
        await database.run('UPDATE images SET download_error_kind = NULL WHERE id = 5005');
        await expect(repository.getById(5005)).resolves.toMatchObject({
          downloadState: 'failed',
          downloadErrorKind: null,
        });

        await savedPending(repository, 5006);
        await repository.markDownloadReady(5006, 'file:///collection/5006.webp');
        await database.run("UPDATE images SET download_error_kind = 'transient' WHERE id = 5006");
        await expect(repository.getById(5006)).rejects.toThrow('Invalid images state');

        await database.run("UPDATE images SET download_error_kind = 'bogus' WHERE id = 5005");
        await expect(repository.getById(5005)).rejects.toThrow('download_error_kind');
      } finally {
        nativeDatabase.close();
      }
    });
  });
});
