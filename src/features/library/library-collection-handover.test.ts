import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createImageRepository } from '@/features/images/image-repository';
import type { ImageRepository } from '@/features/images/image-repository';
import type { LibraryChange } from '@/features/library/library-change-feed';
import { createLibraryCollectionHandover } from '@/features/library/library-collection-handover';
import type { LibraryCollectionFilesPort } from '@/features/library/library-collection-handover';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';
import type {
  DeviceLibraryAsset,
  LibraryIngestOutcome,
} from '@/features/library/library-types';
import {
  seedDeviceAssetState,
  seedDeviceLibraryAsset,
  seedLibraryProtection,
  viewDigest,
} from '@/features/library/library-view-test-support';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const L = 'file:///documents/collection/7.jpg';
const d = viewDigest('d');

async function insertSavedReady(
  database: SqlDatabasePort,
  id: number,
  localUri: string,
): Promise<void> {
  await database.run(
    `INSERT INTO images (
       id, provider_key, provider_item_id, remote_url, width, height, byte_size,
       extension, dominant_color, content_rating, is_nsfw, is_animated,
       tags_json, decision, presented_at, decided_at, queue_ordinal,
       decision_ordinal, local_uri, download_state
     ) VALUES (?, 'waifu_im', ?, ?, 10, 10, 100, '.jpg', '#aabbcc', 'safe', 0, 0,
               '[]', 'saved', 1, 2, ?, ?, ?, 'ready')`,
    [id, String(id), `https://cdn.example.com/${id}.jpg`, id, id, localUri],
  );
}

/** A Map-backed collection double that records, at delete time, the row's state. */
function makeCollectionDouble(
  images: ImageRepository,
  initial: Record<string, number>,
): {
  port: LibraryCollectionFilesPort;
  deletions: [string, string | undefined][];
  has: (uri: string) => boolean;
  setSize: (uri: string, size: number) => void;
  drop: (uri: string) => void;
  failDelete: () => void;
} {
  const sizes = new Map<string, number>(Object.entries(initial));
  const deletions: [string, string | undefined][] = [];
  let failing = false;
  return {
    port: {
      async fileSize(uri) {
        return sizes.get(uri) ?? 0;
      },
      async deleteUri(uri) {
        deletions.push([uri, (await images.getById(7))?.downloadState]);
        if (failing) throw new Error('delete failed');
        sizes.delete(uri);
      },
    },
    deletions,
    has: (uri) => sizes.has(uri),
    setSize: (uri, size) => sizes.set(uri, size),
    drop: (uri) => sizes.delete(uri),
    failDelete: () => {
      failing = true;
    },
  };
}

/** Notes, per change, whether the collection still held L when it was emitted. */
function recordingFeed(holdsL: () => boolean): {
  emit: (change: LibraryChange) => void;
  heard: LibraryChange[];
  heldLAtEmit: boolean[];
  throwOnEmit: () => void;
} {
  const heard: LibraryChange[] = [];
  const heldLAtEmit: boolean[] = [];
  let throwing = false;
  return {
    emit: (change) => {
      heard.push(change);
      heldLAtEmit.push(holdsL());
      if (throwing) throw new Error('listener failed');
    },
    heard,
    heldLAtEmit,
    throwOnEmit: () => {
      throwing = true;
    },
  };
}

function deviceAsset(
  over: Partial<DeviceLibraryAsset> & { plaintextSha256: string },
): DeviceLibraryAsset {
  return {
    format: 'jpeg',
    canonicalExtension: 'jpg',
    byteSize: 5,
    width: 800,
    height: 600,
    origin: 'import',
    sourceImageId: 7,
    localOriginalUri: null,
    residency: 'local-original',
    protectEligible: true,
    missingOriginalSince: null,
    localThumbnailUri: null,
    createdAt: 200,
    updatedAt: 200,
    ...over,
  };
}

function ingestOutcome(asset: DeviceLibraryAsset): LibraryIngestOutcome {
  return {
    status: 'ingested',
    asset,
    enrollment: { status: 'skipped', reason: 'no_account' },
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  const images = createImageRepository(database);
  const libraryPort = createFakeLibraryFilePort();
  const U = `${libraryPort.originalsRootUri}/${d}.jpg`;

  await insertSavedReady(database, 7, L);
  await seedDeviceLibraryAsset(database, {
    plaintextSha256: d,
    sourceImageId: 7,
    residency: 'local-original',
    localOriginalUri: U,
    byteSize: 5,
    createdAt: 200,
  });
  libraryPort.files.set(U, new Uint8Array(5));

  const collection = makeCollectionDouble(images, { [L]: 5 });
  const feed = recordingFeed(() => collection.has(L));
  const handover = createLibraryCollectionHandover({
    database,
    libraryFiles: libraryPort,
    collectionFiles: collection.port,
    changes: feed,
  });

  return { native, database, images, libraryPort, collection, feed, handover, U };
}

describe('library collection hand-over', () => {
  test('hands a ready row over: the row first, then its file', async () => {
    const { native, images, libraryPort, collection, feed, handover, U } = await setup();
    try {
      await expect(handover.handOverExisting()).resolves.toBe(1);
      expect(await images.getById(7)).toMatchObject({
        downloadState: 'mirrored',
        localUri: null,
      });
      expect(collection.deletions).toEqual([[L, 'mirrored']]);
      expect(libraryPort.files.has(U)).toBe(true);
      expect(feed.heard).toEqual([
        { kind: 'handed-over', imageId: 7, plaintextSha256: d },
      ]);
      expect(feed.heldLAtEmit).toEqual([false]);
      await expect(handover.handOverExisting()).resolves.toBe(0);
    } finally {
      native.close();
    }
  });

  const keepVariants: [string, (fx: Fixture) => Promise<void>][] = [
    [
      'd flagged',
      async ({ database }) => {
        await database.run(
          'UPDATE device_library_assets SET missing_original_since = 7 WHERE plaintext_sha256 = ?',
          [d],
        );
      },
    ],
    [
      'd cloud-only, uri NULL',
      async ({ database }) => {
        await database.run(
          "UPDATE device_library_assets SET residency = 'cloud-only', local_original_uri = NULL WHERE plaintext_sha256 = ?",
          [d],
        );
      },
    ],
    [
      'd cached',
      async ({ database }) => {
        await database.run(
          "UPDATE device_library_assets SET residency = 'cached' WHERE plaintext_sha256 = ?",
          [d],
        );
      },
    ],
    [
      "d's source is 8",
      async ({ database }) => {
        await database.run(
          'UPDATE device_library_assets SET source_image_id = 8 WHERE plaintext_sha256 = ?',
          [d],
        );
      },
    ],
    [
      'a second device row for 7',
      async ({ database }) => {
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: viewDigest('e2'),
          sourceImageId: 7,
          residency: 'local-original',
          localOriginalUri: `file:///data/library/originals/${viewDigest('e2')}.jpg`,
          byteSize: 5,
          createdAt: 150,
        });
      },
    ],
    [
      'U not held',
      async ({ libraryPort, U }) => {
        libraryPort.files.delete(U);
      },
    ],
    [
      'U 4 bytes',
      async ({ libraryPort, U }) => {
        libraryPort.files.set(U, new Uint8Array(4));
      },
    ],
    [
      'L 6 bytes',
      async ({ collection }) => {
        collection.setSize(L, 6);
      },
    ],
    [
      "d's uri is another Android user's path",
      async ({ database, libraryPort }) => {
        const foreign = `file:///data/user/10/app.waifudeck.mobile/files/library/originals/${d}.jpg`;
        await database.run(
          'UPDATE device_library_assets SET local_original_uri = ? WHERE plaintext_sha256 = ?',
          [foreign, d],
        );
        libraryPort.files.set(foreign, new Uint8Array(5));
      },
    ],
    [
      "7's library_error (OQ-2)",
      async ({ database }) => {
        await database.run(
          "UPDATE images SET library_error = 'decode_failed' WHERE id = 7",
        );
      },
    ],
    [
      'a device-trash mark on d (OQ-1)',
      async ({ database }) => {
        await seedDeviceAssetState(database, {
          plaintextSha256: d,
          deviceTrashedAt: 5,
        });
      },
    ],
    [
      'a trash projection of d (OQ-1)',
      async ({ database }) => {
        await seedLibraryProtection(database, {
          plaintextSha256: d,
          lifecycle: 'trash',
        });
      },
    ],
  ];

  test.each(keepVariants)('rule 1 keeps the collection file: %s', async (_label, mutate) => {
    const fx = await setup();
    try {
      await mutate(fx);
      await expect(fx.handover.handOverExisting()).resolves.toBe(0);
      expect(await fx.images.getById(7)).toMatchObject({
        downloadState: 'ready',
        localUri: L,
      });
      expect(fx.collection.has(L)).toBe(true);
      expect(fx.feed.heard).toEqual([]);
    } finally {
      fx.native.close();
    }
  });

  const raceVariants: [string, (fx: Fixture) => Promise<void>][] = [
    [
      'markFileMissing(7)',
      async ({ images }) => {
        await images.markFileMissing(7, 'file_missing');
      },
    ],
    [
      'a second device row for 7',
      async ({ database }) => {
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: viewDigest('e2'),
          sourceImageId: 7,
          residency: 'local-original',
          localOriginalUri: `file:///data/library/originals/${viewDigest('e2')}.jpg`,
          byteSize: 5,
          createdAt: 150,
        });
      },
    ],
    [
      "d's flag set",
      async ({ database }) => {
        await database.run(
          'UPDATE device_library_assets SET missing_original_since = 9 WHERE plaintext_sha256 = ?',
          [d],
        );
      },
    ],
    [
      "d's source set to 8",
      async ({ database }) => {
        await database.run(
          'UPDATE device_library_assets SET source_image_id = 8 WHERE plaintext_sha256 = ?',
          [d],
        );
      },
    ],
    [
      'a device-trash mark on d (OQ-1)',
      async ({ database }) => {
        await seedDeviceAssetState(database, {
          plaintextSha256: d,
          deviceTrashedAt: 5,
        });
      },
    ],
    [
      'a trash projection of d (OQ-1)',
      async ({ database }) => {
        await seedLibraryProtection(database, {
          plaintextSha256: d,
          lifecycle: 'trash',
        });
      },
    ],
    [
      "d's uri re-pointed to another original",
      async ({ database, libraryPort }) => {
        await database.run(
          'UPDATE device_library_assets SET local_original_uri = ? WHERE plaintext_sha256 = ?',
          [`${libraryPort.originalsRootUri}/elsewhere.jpg`, d],
        );
      },
    ],
    [
      "d's source moves to 8 while a sibling of 7 appears (isolates a.source_image_id)",
      async ({ database }) => {
        // d was selected for image 7, then its source moves to 8 and a fresh
        // row for 7 takes its place: the single clause still sees exactly one
        // source-7 row and d is still the newest of source 8, so only
        // `a.source_image_id = ?` in the EXISTS refuses this flip.
        await database.run(
          'UPDATE device_library_assets SET source_image_id = 8 WHERE plaintext_sha256 = ?',
          [d],
        );
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: viewDigest('e2'),
          sourceImageId: 7,
          residency: 'cloud-only',
          localOriginalUri: null,
          byteSize: 5,
          createdAt: 150,
        });
      },
    ],
  ];

  test.each(raceVariants)(
    'a row that changes between the stat and the flip keeps its file: %s',
    async (_label, mutate) => {
      const fx = await setup();
      try {
        const original = fx.libraryPort.size.bind(fx.libraryPort);
        let first = true;
        fx.libraryPort.size = async (uri: string) => {
          if (first) {
            first = false;
            await mutate(fx);
          }
          return original(uri);
        };
        await expect(fx.handover.handOverExisting()).resolves.toBe(0);
        expect(fx.collection.has(L)).toBe(true);
        expect(fx.feed.heard).toEqual([]);
      } finally {
        fx.native.close();
      }
    },
  );

  test('handOver: a new save whose ingest named its digest', async () => {
    const { native, images, collection, feed, handover, U } = await setup();
    try {
      await expect(
        handover.handOver(
          { imageId: 7, localUri: L },
          ingestOutcome(
            deviceAsset({
              plaintextSha256: d,
              sourceImageId: 7,
              localOriginalUri: U,
              byteSize: 5,
              createdAt: 200,
            }),
          ),
        ),
      ).resolves.toBe(true);
      expect(await images.getById(7)).toMatchObject({ downloadState: 'mirrored' });
      expect(collection.deletions).toEqual([[L, 'mirrored']]);
      expect(feed.heard).toEqual([
        { kind: 'handed-over', imageId: 7, plaintextSha256: d },
      ]);
    } finally {
      native.close();
    }
  });

  test('handOver: bytes another image\'s row holds stay a collection file', async () => {
    const { native, database, images, collection, handover, U } = await setup();
    try {
      await database.run(
        'UPDATE device_library_assets SET source_image_id = 8 WHERE plaintext_sha256 = ?',
        [d],
      );
      await expect(
        handover.handOver(
          { imageId: 7, localUri: L },
          ingestOutcome(
            deviceAsset({ plaintextSha256: d, sourceImageId: 8, localOriginalUri: U }),
          ),
        ),
      ).resolves.toBe(false);
      expect(await images.getById(7)).toMatchObject({ downloadState: 'ready', localUri: L });
      expect(collection.has(L)).toBe(true);
    } finally {
      native.close();
    }
  });

  test('handOver does not need exactly one library row', async () => {
    const { native, database, handover, U } = await setup();
    try {
      const older = viewDigest('older');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: older,
        sourceImageId: 7,
        residency: 'local-original',
        localOriginalUri: `file:///data/library/originals/${older}.jpg`,
        byteSize: 5,
        createdAt: 100,
      });
      await expect(
        handover.handOver(
          { imageId: 7, localUri: L },
          ingestOutcome(
            deviceAsset({ plaintextSha256: d, localOriginalUri: U, createdAt: 200 }),
          ),
        ),
      ).resolves.toBe(true);
    } finally {
      native.close();
    }
  });

  test('handOver refuses a digest that is not the image\'s newest library row', async () => {
    const { native, database, images, collection, feed, handover, U } = await setup();
    try {
      const newer = viewDigest('dNew');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: newer,
        sourceImageId: 7,
        residency: 'cloud-only',
        localOriginalUri: null,
        byteSize: 5,
        createdAt: 300,
      });
      await expect(
        handover.handOver(
          { imageId: 7, localUri: L },
          ingestOutcome(
            deviceAsset({ plaintextSha256: d, localOriginalUri: U, createdAt: 200 }),
          ),
        ),
      ).resolves.toBe(false);
      expect(await images.getById(7)).toMatchObject({ downloadState: 'ready', localUri: L });
      expect(collection.has(L)).toBe(true);
      expect(feed.heard).toEqual([]);
    } finally {
      native.close();
    }
  });

  test.each([
    ['refuses when d has the larger digest', viewDigest('c'), false, 'ready'],
    ['hands over when d has the smaller digest', viewDigest('e'), true, 'mirrored'],
  ] as const)(
    'handOver breaks an equal created_at by digest: %s',
    async (_label, sibling, expected, state) => {
      const { native, database, images, handover, U } = await setup();
      try {
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: sibling,
          sourceImageId: 7,
          residency: 'cloud-only',
          localOriginalUri: null,
          byteSize: 5,
          createdAt: 200,
        });
        await expect(
          handover.handOver(
            { imageId: 7, localUri: L },
            ingestOutcome(
              deviceAsset({ plaintextSha256: d, localOriginalUri: U, createdAt: 200 }),
            ),
          ),
        ).resolves.toBe(expected);
        expect(await images.getById(7)).toMatchObject({ downloadState: state });
      } finally {
        native.close();
      }
    },
  );

  test('a row whose commit throws is skipped; the rest still go', async () => {
    const { native, database, images, libraryPort, collection, handover, U } = await setup();
    try {
      const L9 = 'file:///documents/collection/9.jpg';
      const d9 = viewDigest('nine');
      const U9 = `${libraryPort.originalsRootUri}/${d9}.jpg`;
      await insertSavedReady(database, 9, L9);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: d9,
        sourceImageId: 9,
        residency: 'local-original',
        localOriginalUri: U9,
        byteSize: 5,
        createdAt: 200,
      });
      libraryPort.files.set(U9, new Uint8Array(5));
      collection.setSize(L9, 5);
      const original = libraryPort.size.bind(libraryPort);
      libraryPort.size = async (uri: string) => {
        if (uri === U) throw new Error('stat failed');
        return original(uri);
      };

      await expect(handover.handOverExisting()).resolves.toBe(1);
      expect(await images.getById(7)).toMatchObject({ downloadState: 'ready', localUri: L });
      expect(await images.getById(9)).toMatchObject({ downloadState: 'mirrored' });
    } finally {
      native.close();
    }
  });

  test('handOver never throws: a failing stat answers false', async () => {
    const { native, images, libraryPort, handover, U } = await setup();
    try {
      libraryPort.size = async () => {
        throw new Error('stat failed');
      };
      await expect(
        handover.handOver(
          { imageId: 7, localUri: L },
          ingestOutcome(deviceAsset({ plaintextSha256: d, localOriginalUri: U })),
        ),
      ).resolves.toBe(false);
      expect(await images.getById(7)).toMatchObject({ downloadState: 'ready' });
    } finally {
      native.close();
    }
  });

  test('a throwing listener does not turn a completed hand-over into a refusal', async () => {
    const { native, images, feed, handover, U } = await setup();
    try {
      feed.throwOnEmit();
      await expect(
        handover.handOver(
          { imageId: 7, localUri: L },
          ingestOutcome(deviceAsset({ plaintextSha256: d, localOriginalUri: U })),
        ),
      ).resolves.toBe(true);
      expect(await images.getById(7)).toMatchObject({ downloadState: 'mirrored' });
      expect(feed.heard).toHaveLength(1);
    } finally {
      native.close();
    }
  });

  test('a file that cannot be deleted still counts; the sweep takes it later', async () => {
    const { native, images, collection, feed, handover } = await setup();
    try {
      collection.failDelete();
      await expect(handover.handOverExisting()).resolves.toBe(1);
      expect(await images.getById(7)).toMatchObject({ downloadState: 'mirrored' });
      expect(feed.heard).toHaveLength(1);
    } finally {
      native.close();
    }
  });

  test('two hand-overs of one row: one flip, one delete', async () => {
    const { native, collection, feed, handover, U } = await setup();
    try {
      const results = await Promise.all([
        handover.handOverExisting(),
        handover.handOver(
          { imageId: 7, localUri: L },
          ingestOutcome(
            deviceAsset({ plaintextSha256: d, localOriginalUri: U, createdAt: 200 }),
          ),
        ),
      ]);
      expect([[1, false], [0, true]]).toContainEqual(results);
      expect(collection.deletions).toHaveLength(1);
      expect(feed.heard).toHaveLength(1);
    } finally {
      native.close();
    }
  });

  test('handOverExisting is single-flight', async () => {
    const { native, handover } = await setup();
    try {
      const first = handover.handOverExisting();
      const second = handover.handOverExisting();
      // Settle before asserting: without single-flight `second` is a second
      // concurrent run, and a throw here would race the db close.
      const sameRef = second === first;
      await Promise.allSettled([first, second]);
      expect(sameRef).toBe(true);
      await expect(first).resolves.toBe(1);
      const third = handover.handOverExisting();
      await Promise.allSettled([third]);
      expect(third).not.toBe(first);
      await expect(third).resolves.toBe(0);
    } finally {
      native.close();
    }
  });

  test('N6-A2 (spec §4.4): refuses handOver when an import owns the digest (source_image_id is null even though library_provider_image_assets records the late provider)', async () => {
    const { native, database, images, libraryPort, collection, feed, handover, U } = await setup();
    try {
      await database.run(
        `UPDATE device_library_assets
            SET origin = 'import', source_image_id = NULL, import_classification = 'safe'
          WHERE plaintext_sha256 = ?`,
        [d],
      );
      await database.run(
        `INSERT INTO library_provider_image_assets (image_id, plaintext_sha256, updated_at)
         VALUES (7, ?, 200)`,
        [d],
      );

      await expect(
        handover.handOver(
          { imageId: 7, localUri: L },
          ingestOutcome(
            deviceAsset({
              plaintextSha256: d,
              origin: 'import',
              sourceImageId: null,
              localOriginalUri: U,
            }),
          ),
        ),
      ).resolves.toBe(false);
      await expect(handover.handOverExisting()).resolves.toBe(0);

      expect(await images.getById(7)).toMatchObject({
        downloadState: 'ready',
        localUri: L,
      });
      expect(collection.has(L)).toBe(true);
      expect(libraryPort.files.has(U)).toBe(true);
      expect(feed.heard).toEqual([]);
    } finally {
      native.close();
    }
  });
});
