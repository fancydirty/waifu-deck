import type { SqlDatabasePort } from '@/db/sql-port';
import {
  createImageRepository,
  type ImageRepository,
} from '@/features/images/image-repository';
import {
  createLibraryCollectAdapter,
  type LibraryCollectAdapter,
  type LibraryCollectEvent,
} from '@/features/library/library-collect-adapter';
import { createLibraryCollectBackfill } from '@/features/library/library-collect-backfill';
import {
  createLibraryCollectedPurge,
  type LibraryCollectedPurge,
  type LibraryCollectedPurgeHooks,
} from '@/features/library/library-collected-purge';
import {
  deriveLibraryAccountScope,
  deriveLibraryAssetId,
  sha256PlaintextHex,
} from '@/features/library/library-identity';
import {
  createLibraryIngestService,
  type LibraryIngestService,
} from '@/features/library/library-ingest';
import { createPassthroughLibraryCipher } from '@/features/library/library-passthrough-cipher';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import {
  buildLibraryEncryptedMetadata,
  readSourceMetadata,
} from '@/features/library/library-source-metadata';
import {
  createLibrarySyncApplyWriter,
  type LibrarySyncRestoreImage,
} from '@/features/library/library-sync-apply';
import type { LibraryProjectedAsset } from '@/features/library/library-sync-types';
import {
  readLibraryEntries,
  readLibraryEntry,
} from '@/features/library/library-view-model';
import {
  createLibraryTestHarness,
  JPEG_FIXTURE,
  LOCAL_ONLY_ACCOUNT_PORT,
  type LibraryTestHarness,
} from '@/features/library/library-test-support';
import type { WaifuImage } from '@/features/waifu/types';

const COLLECTION = 'file:///documents/collection';
const GENERATION = '11111111-1111-4111-8111-111111111111';

type IntentKind = 'collect' | 'protect';
type IntentState = 'pending' | 'sending' | 'sent' | 'failed';

function candidate(id: number): WaifuImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: `url:https://example.com/art/${id}`,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: `https://example.com/art/${id}`,
    artistName: 'Example Artist',
    artistUrl: 'https://example.com/artist',
    width: 1200,
    height: 1800,
    byteSize: 456_789,
    extension: '.jpg',
    dominantColor: '#aabbcc',
    isNsfw: false,
    isAnimated: false,
    tags: ['solo'],
  };
}

/** A real JPEG header plus one distinguishing byte: a distinct digest per seed. */
function bytesFor(seed: number): Uint8Array {
  return Uint8Array.from([...JPEG_FIXTURE, seed]);
}

function collectionUri(id: number): string {
  return `${COLLECTION}/${id}.jpg`;
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function ticks(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

type Fixture = Readonly<{
  harness: LibraryTestHarness;
  database: SqlDatabasePort;
  images: ImageRepository;
  ingest: LibraryIngestService;
  collect: LibraryCollectAdapter;
  scope: string;
  purge(hooks?: LibraryCollectedPurgeHooks): LibraryCollectedPurge;
  tick(): number;
  close(): void;
}>;

/**
 * The library on node:sqlite with the migrated schema and the fake file port,
 * with a real ingest behind a real collect adapter — the same pool a Discover
 * save goes through. The ingest is local-only (Layer A): the BYOS rows each
 * test needs are written with plain SQL, so the fixture states exactly what
 * the account holds.
 */
async function openFixture(
  options: Readonly<{ holdIngest?: Promise<void> }> = {},
): Promise<Fixture> {
  const harness = await createLibraryTestHarness();
  const images = createImageRepository(harness.database);
  const real = createLibraryIngestService({
    files: harness.files,
    repository: harness.repository,
    decodeGate: harness.decodeGate,
    account: LOCAL_ONLY_ACCOUNT_PORT,
    newMutationId: harness.newMutationId,
    clock: harness.clock,
    // A genuine SHA-256: under `jest-expo` the native default answers zeros,
    // which would give every image one digest (K6-1f).
    digest: async (bytes) => sha256PlaintextHex(bytes),
  });
  const { holdIngest } = options;
  const ingest: LibraryIngestService = holdIngest === undefined ? real : {
    ...real,
    ingestUri: async (input) => {
      await holdIngest;
      return real.ingestUri(input);
    },
  };
  const collect = createLibraryCollectAdapter({ ingest });
  let now = 10_000;
  return {
    harness,
    database: harness.database,
    images,
    ingest,
    collect,
    scope: deriveLibraryAccountScope(harness.masterKey),
    purge: (hooks) => createLibraryCollectedPurge({
      database: harness.database,
      files: harness.files,
      collect,
      withDigestGate: (sha, work) => ingest.withDigestGate(sha, work),
      hooks,
    }),
    tick: () => {
      now += 10;
      return now;
    },
    close: () => harness.close(),
  };
}

/** A Search-or-Discover save whose download finished. Returns its `decided_at`. */
async function saved(fixture: Fixture, id: number): Promise<number> {
  await fixture.images.insertCandidates([candidate(id)]);
  const row = await fixture.images.saveCandidate(candidate(id), fixture.tick());
  await expect(
    fixture.images.markDownloadReady(id, collectionUri(id)),
  ).resolves.toBe(true);
  return row.decidedAt!;
}

/** The finished download reaches the library through the collect pool. */
async function collected(
  fixture: Fixture,
  id: number,
  bytes: Uint8Array,
  uri = collectionUri(id),
): Promise<string> {
  fixture.harness.port.files.set(uri, bytes);
  fixture.collect.onOriginalReady({ imageId: id, localUri: uri });
  await fixture.collect.drain();
  return sha256PlaintextHex(bytes);
}

async function savedAndCollected(
  fixture: Fixture,
  id: number,
  bytes = bytesFor(id),
): Promise<Readonly<{ digest: string; decidedAt: number }>> {
  const decidedAt = await saved(fixture, id);
  const digest = await collected(fixture, id, bytes);
  return { digest, decidedAt };
}

/** The durable flip a rewind makes (Task 1): the row is back on the deck. */
async function rewind(fixture: Fixture, id: number, decidedAt: number): Promise<void> {
  await expect(
    fixture.images.rewindDecision(id, { decision: 'saved', decidedAt }),
  ).resolves.not.toBeNull();
}

/**
 * The BYOS rows of an enrolled asset: the account row, its projection and the
 * given intents. The defaults are the plan's fixture — an `active`/`protected`
 * projection carrying a halting `quota_full`.
 */
async function enrolled(
  fixture: Fixture,
  digest: string,
  options: Readonly<{
    intents?: Partial<Record<IntentKind, IntentState>>;
    protection?: 'pending' | 'protected';
    failureCategory?: string | null;
  }> = {},
): Promise<string> {
  const assetId = deriveLibraryAssetId(fixture.harness.masterKey, digest);
  const protection = options.protection ?? 'protected';
  await fixture.database.run(
    `INSERT INTO library_account_assets (
       account_scope, asset_id, plaintext_sha256, device_id, enrolled_at,
       updated_at
     ) VALUES (?, ?, ?, ?, 1, 1)`,
    [fixture.scope, assetId, digest, fixture.harness.deviceId],
  );
  await fixture.database.run(
    `INSERT INTO library_asset_protection (
       account_scope, asset_id, plaintext_sha256, lifecycle, protection,
       generation, revision, original_generation_id, original_ciphertext_bytes,
       verified_at, failure_category, trashed_at, updated_at
     ) VALUES (?, ?, ?, 'active', ?, 1, 7, ?, ?, ?, ?, NULL, 1)`,
    [
      fixture.scope,
      assetId,
      digest,
      protection,
      protection === 'protected' ? GENERATION : null,
      protection === 'protected' ? 64 : null,
      protection === 'protected' ? 5 : null,
      options.failureCategory === undefined ? 'quota_full' : options.failureCategory,
    ],
  );
  for (const [kind, state] of Object.entries(options.intents ?? {})) {
    await fixture.database.run(
      `INSERT INTO library_outbox (
         mutation_id, account_scope, device_id, asset_id, kind, base_revision,
         observed_generation, state, attempt_count, next_attempt_at,
         last_error_code, local_metadata_json, encrypted_payload, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, NULL, NULL, '{}', NULL, 1, 1)`,
      [
        fixture.harness.newMutationId(),
        fixture.scope,
        fixture.harness.deviceId,
        assetId,
        kind,
        state,
      ],
    );
  }
  return assetId;
}

/** A device-trash copy of the original, as SP7's remove path leaves one. */
async function withDeviceTrashCopy(fixture: Fixture, digest: string): Promise<string> {
  const uri = fixture.harness.port.resolveTrash(`${digest}.jpg`);
  fixture.harness.port.files.set(uri, bytesFor(0));
  await fixture.database.run(
    `INSERT INTO library_device_asset_state (
       plaintext_sha256, cached_roles_json, device_trash_uri, device_trashed_at,
       updated_at
     ) VALUES (?, '[]', ?, 1, 1)`,
    [digest, uri],
  );
  return uri;
}

function originalUri(fixture: Fixture, digest: string): string {
  return fixture.harness.port.resolveOriginal(`${digest}.jpg`);
}

function hasFile(fixture: Fixture, uri: string): boolean {
  return fixture.harness.port.files.has(uri);
}

/** Names a thumbnail file on the row, the way `ensureLocalThumbnail` does. */
async function withLocalThumbnail(
  fixture: Fixture,
  digest: string,
  extension: 'webp' | 'jpg' | 'png' = 'webp',
): Promise<string> {
  const uri = fixture.harness.files.thumbnailUriFor(digest, extension);
  fixture.harness.port.files.set(uri, bytesFor(3));
  await expect(
    fixture.harness.repository.setLocalThumbnail(digest, uri),
  ).resolves.toBe(true);
  return uri;
}

/** An import: no `images` row, its original already on disk. */
async function looseImport(fixture: Fixture): Promise<string> {
  const bytes = bytesFor(90);
  const digest = sha256PlaintextHex(bytes);
  const uri = originalUri(fixture, digest);
  fixture.harness.port.files.set(uri, bytes);
  await fixture.database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width,
       height, origin, source_image_id, local_original_uri, residency,
       protect_eligible, missing_original_since, created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', ?, 320, 240, 'import', NULL, ?,
       'local-original', 1, NULL, 1, 1)`,
    [digest, bytes.byteLength, uri],
  );
  return digest;
}

async function deviceRowsOf(fixture: Fixture, imageId: number): Promise<string[]> {
  const rows = await fixture.database.getAll<{ plaintext_sha256: string }>(
    `SELECT plaintext_sha256 FROM device_library_assets
      WHERE source_image_id = ? ORDER BY plaintext_sha256`,
    [imageId],
  );
  return rows.map((row) => row.plaintext_sha256);
}

async function libraryRows(fixture: Fixture, digest: string) {
  const count = async (table: string): Promise<number> => (
    (await fixture.database.getFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE plaintext_sha256 = ?`,
      [digest],
    ))?.n ?? 0
  );
  return {
    device: await count('device_library_assets'),
    deviceState: await count('library_device_asset_state'),
    account: await count('library_account_assets'),
  };
}

async function projection(fixture: Fixture, digest: string) {
  return fixture.database.getFirst<{
    lifecycle: string;
    protection: string;
    revision: number | null;
    failure_category: string | null;
  }>(
    `SELECT lifecycle, protection, revision, failure_category
       FROM library_asset_protection WHERE plaintext_sha256 = ?`,
    [digest],
  );
}

async function intents(
  fixture: Fixture,
  digest: string,
): Promise<Partial<Record<IntentKind, IntentState>>> {
  const rows = await fixture.database.getAll<{ kind: IntentKind; state: IntentState }>(
    `SELECT o.kind, o.state FROM library_outbox o
       JOIN library_account_assets a
         ON a.account_scope = o.account_scope AND a.asset_id = o.asset_id
      WHERE a.plaintext_sha256 = ?
      ORDER BY o.kind`,
    [digest],
  );
  return Object.fromEntries(rows.map((row) => [row.kind, row.state]));
}

/**
 * Board #24 stage 1, spec §5.4.2: after the durable flip, a rewound save's
 * copy leaves this device's library. The cloud copy and its bookkeeping stay
 * (row 25), which is exactly what keeps sync from bringing it back (§5.4.3).
 */
describe('board #24: purging a rewound save from the library (spec §5.4.2)', () => {
  test('removes the rows, the original, the device-trash copy and the pending intents; keeps the account row, the projection and in-flight intents', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      const other = await savedAndCollected(fixture, 42);
      const y = await savedAndCollected(fixture, 43);
      await enrolled(fixture, x.digest, { intents: { collect: 'sending', protect: 'pending' } });
      await enrolled(fixture, other.digest, { intents: { collect: 'pending', protect: 'pending' } });
      await enrolled(fixture, y.digest, { intents: { collect: 'pending', protect: 'sending' } });
      const trashUri = await withDeviceTrashCopy(fixture, x.digest);
      await rewind(fixture, 43, y.decidedAt);
      await rewind(fixture, 41, x.decidedAt); // 41 active, 43 at the queue front

      const events: string[] = [];
      const purge = fixture.purge({
        before: async (asset) => {
          const rows = await libraryRows(fixture, asset.plaintextSha256);
          events.push(`before:${asset.sourceImageId}:device=${rows.device}`);
        },
        after: (asset) => {
          const original = hasFile(fixture, originalUri(fixture, asset.plaintextSha256));
          events.push(`after:${asset.sourceImageId}:original=${original}`);
        },
      });

      await purge.purgeCollectedImage(41);
      await purge.purgeCollectedImage(43);

      // `before` runs ahead of the transaction, `after` once the files are gone.
      expect(events).toEqual([
        'before:41:device=1',
        'after:41:original=false',
        'before:43:device=1',
        'after:43:original=false',
      ]);

      await expect(libraryRows(fixture, x.digest)).resolves.toEqual({
        device: 0,
        deviceState: 0,
        account: 1,
      });
      expect(hasFile(fixture, originalUri(fixture, x.digest))).toBe(false);
      expect(hasFile(fixture, trashUri)).toBe(false);
      await expect(intents(fixture, x.digest)).resolves.toEqual({ collect: 'sending' });
      await expect(projection(fixture, x.digest)).resolves.toEqual({
        lifecycle: 'active',
        protection: 'protected',
        revision: 7,
        failure_category: null,
      });

      await expect(libraryRows(fixture, y.digest)).resolves.toEqual({
        device: 0,
        deviceState: 0,
        account: 1,
      });
      expect(hasFile(fixture, originalUri(fixture, y.digest))).toBe(false);
      await expect(intents(fixture, y.digest)).resolves.toEqual({ protect: 'sending' });
      await expect(projection(fixture, y.digest)).resolves.toEqual({
        lifecycle: 'active',
        protection: 'protected',
        revision: 7,
        failure_category: null,
      });

      // Image 42 is still saved: nothing of it is touched.
      await expect(libraryRows(fixture, other.digest)).resolves.toEqual({
        device: 1,
        deviceState: 0,
        account: 1,
      });
      await expect(deviceRowsOf(fixture, 42)).resolves.toEqual([other.digest]);
      expect(hasFile(fixture, originalUri(fixture, other.digest))).toBe(true);
      await expect(intents(fixture, other.digest)).resolves.toEqual({
        collect: 'pending',
        protect: 'pending',
      });
      await expect(projection(fixture, other.digest)).resolves.toMatchObject({
        failure_category: 'quota_full',
      });
      // The collection files are the collection service's to delete, not this one's.
      expect(hasFile(fixture, collectionUri(41))).toBe(true);
    } finally {
      fixture.close();
    }
  });

  test('the purge deletes the local thumbnail after the rows, the file the row names', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      // A cloud jpeg thumbnail is stored as `<sha>.jpg`: a purge that rebuilt a
      // `.webp` path would miss it.
      const thumbnail = await withLocalThumbnail(fixture, x.digest, 'jpg');
      const webpTwin = fixture.harness.files.thumbnailUriFor(x.digest, 'webp');
      fixture.harness.port.files.set(webpTwin, bytesFor(2));
      await rewind(fixture, 41, x.decidedAt);
      const seen: boolean[] = [];
      const purge = fixture.purge({
        after: () => {
          seen.push(hasFile(fixture, thumbnail));
        },
      });

      await purge.purgeCollectedImage(41);

      expect(seen).toEqual([false]);
      expect(hasFile(fixture, thumbnail)).toBe(false);
      expect(hasFile(fixture, webpTwin)).toBe(true); // no row names it
      await expect(libraryRows(fixture, x.digest)).resolves.toMatchObject({ device: 0 });
    } finally {
      fixture.close();
    }
  });

  test('a row with no local original (an evicted cloud-only asset) still loses its thumbnail', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      const original = (await fixture.harness.repository.findLocalAsset(x.digest))!.localOriginalUri!;
      await fixture.harness.database.run(
        "UPDATE device_library_assets SET residency = 'cloud-only', local_original_uri = NULL WHERE plaintext_sha256 = ?",
        [x.digest],
      );
      fixture.harness.port.files.delete(original);
      const thumbnail = await withLocalThumbnail(fixture, x.digest, 'jpg');
      await rewind(fixture, 41, x.decidedAt);

      await fixture.purge().purgeCollectedImage(41);

      expect(hasFile(fixture, thumbnail)).toBe(false);
      await expect(libraryRows(fixture, x.digest)).resolves.toMatchObject({ device: 0 });
    } finally {
      fixture.close();
    }
  });

  test('a purge whose row delete fails keeps the thumbnail: files go only after the commit', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      const thumbnail = await withLocalThumbnail(fixture, x.digest, 'jpg');
      await rewind(fixture, 41, x.decidedAt);
      await fixture.harness.database.exec(`
        CREATE TRIGGER s2_refuse_device_delete BEFORE DELETE ON device_library_assets
        BEGIN SELECT RAISE(ABORT, 'row delete refused'); END;
      `);

      await fixture.purge().purgeCollectedImage(41).catch(() => undefined);

      expect(hasFile(fixture, thumbnail)).toBe(true);
      await expect(fixture.harness.repository.findLocalAsset(x.digest)).resolves.toMatchObject({
        localThumbnailUri: thumbnail,
      });
    } finally {
      fixture.close();
    }
  });

  test('purges every device row of the image: a re-download with other bytes added a second one', async () => {
    const fixture = await openFixture();
    try {
      const first = await savedAndCollected(fixture, 41);
      const second = await collected(
        fixture,
        41,
        bytesFor(141),
        `${COLLECTION}/41-again.jpg`,
      );
      await expect(deviceRowsOf(fixture, 41)).resolves.toEqual(
        [first.digest, second].sort(),
      );
      await rewind(fixture, 41, first.decidedAt);

      await fixture.purge().purgeCollectedImage(41);

      await expect(deviceRowsOf(fixture, 41)).resolves.toEqual([]);
      expect(hasFile(fixture, originalUri(fixture, first.digest))).toBe(false);
      expect(hasFile(fixture, originalUri(fixture, second))).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test('shared bytes: the purge also takes a still-saved image\'s library copy, and the backfill brings it back', async () => {
    const fixture = await openFixture();
    try {
      const shared = bytesFor(44);
      const rewound = await savedAndCollected(fixture, 44, shared);
      // A duplicate ingest keeps the first `source_image_id` (library-ingest.ts).
      const kept = await savedAndCollected(fixture, 45, shared);
      expect(kept.digest).toBe(rewound.digest);
      await expect(deviceRowsOf(fixture, 44)).resolves.toEqual([rewound.digest]);
      await expect(deviceRowsOf(fixture, 45)).resolves.toEqual([]);
      await rewind(fixture, 44, rewound.decidedAt);

      await fixture.purge().purgeCollectedImage(44);

      // Documented collateral (spec §5.4.3): 45's library copy went with 44's.
      await expect(libraryRows(fixture, kept.digest)).resolves.toMatchObject({ device: 0 });
      expect(hasFile(fixture, originalUri(fixture, kept.digest))).toBe(false);
      // Its 收藏 tile still renders from its own collection file.
      expect(hasFile(fixture, collectionUri(45))).toBe(true);

      // The K6-5 C backfill is the repair: it offers 45, and the re-ingest puts
      // the bytes back in the library under 45. The rewound 44 stays out.
      const offered: number[] = [];
      const backfill = createLibraryCollectBackfill({
        database: fixture.database,
        collect: (event: LibraryCollectEvent) => {
          offered.push(event.imageId);
          fixture.collect.onOriginalReady(event);
        },
      });
      await expect(backfill.run()).resolves.toBe(1);
      await fixture.collect.drain();

      expect(offered).toEqual([45]);
      await expect(deviceRowsOf(fixture, 45)).resolves.toEqual([kept.digest]);
      await expect(deviceRowsOf(fixture, 44)).resolves.toEqual([]);
      expect(hasFile(fixture, originalUri(fixture, kept.digest))).toBe(true);
    } finally {
      fixture.close();
    }
  });

  test('an image that never reached the library resolves without touching anything', async () => {
    const fixture = await openFixture();
    try {
      const other = await savedAndCollected(fixture, 42);
      const decidedAt = await saved(fixture, 48); // saved, never ingested
      await rewind(fixture, 48, decidedAt);
      const before = jest.fn(async () => undefined);
      const after = jest.fn();

      await expect(
        fixture.purge({ before, after }).purgeCollectedImage(48),
      ).resolves.toBeUndefined();

      expect(before).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
      await expect(deviceRowsOf(fixture, 42)).resolves.toEqual([other.digest]);
      expect(hasFile(fixture, originalUri(fixture, other.digest))).toBe(true);
    } finally {
      fixture.close();
    }
  });

  test('waits for an ingest of the image that is still running, and removes the asset it commits', async () => {
    const hold = deferred();
    const fixture = await openFixture({ holdIngest: hold.promise });
    try {
      const decidedAt = await saved(fixture, 41);
      fixture.harness.port.files.set(collectionUri(41), bytesFor(41));
      // The download finished just before the rewind; its ingest is still running.
      fixture.collect.onOriginalReady({ imageId: 41, localUri: collectionUri(41) });
      await rewind(fixture, 41, decidedAt);

      let finished = false;
      const purging = fixture.purge().purgeCollectedImage(41).then(() => {
        finished = true;
      });
      await ticks();
      expect(finished).toBe(false);

      hold.resolve();
      await purging;

      const digest = sha256PlaintextHex(bytesFor(41));
      await expect(deviceRowsOf(fixture, 41)).resolves.toEqual([]);
      await expect(libraryRows(fixture, digest)).resolves.toMatchObject({ device: 0 });
      expect(hasFile(fixture, originalUri(fixture, digest))).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test('re-checks the image inside the transaction: saved again (a Search save) means nothing is deleted', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      await enrolled(fixture, x.digest, { intents: { collect: 'pending', protect: 'pending' } });
      const trashUri = await withDeviceTrashCopy(fixture, x.digest);
      await rewind(fixture, 41, x.decidedAt);
      const after = jest.fn();
      const purge = fixture.purge({
        // Runs right before the transaction: the user saves the same card from Search.
        before: async () => {
          await fixture.images.saveCandidate(candidate(41), fixture.tick());
        },
        after,
      });

      await purge.purgeCollectedImage(41);

      await expect(fixture.images.getById(41)).resolves.toMatchObject({ decision: 'saved' });
      await expect(libraryRows(fixture, x.digest)).resolves.toEqual({
        device: 1,
        deviceState: 1,
        account: 1,
      });
      expect(hasFile(fixture, originalUri(fixture, x.digest))).toBe(true);
      expect(hasFile(fixture, trashUri)).toBe(true);
      await expect(intents(fixture, x.digest)).resolves.toEqual({
        collect: 'pending',
        protect: 'pending',
      });
      await expect(projection(fixture, x.digest)).resolves.toMatchObject({
        failure_category: 'quota_full',
      });
      expect(after).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  test('saved again (a Search save) → the local thumbnail stays with its row', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      const thumbnail = await withLocalThumbnail(fixture, x.digest);
      await rewind(fixture, 41, x.decidedAt);
      const purge = fixture.purge({
        before: async () => {
          await fixture.images.saveCandidate(candidate(41), fixture.tick());
        },
      });

      await purge.purgeCollectedImage(41);

      expect(hasFile(fixture, thumbnail)).toBe(true);
      await expect(
        fixture.harness.repository.findLocalAsset(x.digest),
      ).resolves.toMatchObject({ localThumbnailUri: thumbnail });
    } finally {
      fixture.close();
    }
  });

  test('is single-flight per image: two concurrent calls run one purge', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      await rewind(fixture, 41, x.decidedAt);
      const gate = deferred();
      const before = jest.fn(async () => {
        await gate.promise;
      });
      const purge = fixture.purge({ before });

      const first = purge.purgeCollectedImage(41);
      const second = purge.purgeCollectedImage(41);
      await waitUntil(() => before.mock.calls.length > 0, 'the first purge');
      await ticks(); // time for a second, independent purge to get there too
      gate.resolve();
      await Promise.all([first, second]);

      expect(before).toHaveBeenCalledTimes(1);
      await expect(deviceRowsOf(fixture, 41)).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('a file that cannot be deleted does not fail the purge (reconcileStorage reclaims it)', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      const trashUri = await withDeviceTrashCopy(fixture, x.digest);
      await rewind(fixture, 41, x.decidedAt);
      const port = fixture.harness.port;
      const realDelete = port.delete.bind(port);
      port.delete = async (uri) => {
        if (uri === originalUri(fixture, x.digest)) throw new Error('file busy');
        await realDelete(uri);
      };

      await expect(fixture.purge().purgeCollectedImage(41)).resolves.toBeUndefined();

      await expect(libraryRows(fixture, x.digest)).resolves.toMatchObject({ device: 0 });
      expect(hasFile(fixture, trashUri)).toBe(false);
    } finally {
      fixture.close();
    }
  });
});

/**
 * Spec §5.4: a rewind, a 收藏 delete, or a 回到发现 whose library phase never
 * ran (the app was killed) is finished by the next resume sweep. Every library
 * row whose image is gone or no longer saved goes; a saved row, and a row
 * with no image, stay.
 */
describe('board #24: purgeUndoneLibraryRows (crash recovery, spec §5.4)', () => {
  test('purges every library row whose image is gone or no longer saved; keeps saved rows and rows with no image', async () => {
    const fixture = await openFixture();
    try {
      const rewoundActive = await savedAndCollected(fixture, 50);
      const rewoundQueued = await savedAndCollected(fixture, 51);
      const kept = await savedAndCollected(fixture, 52);
      const deleted = await savedAndCollected(fixture, 53);
      const returned = await savedAndCollected(fixture, 54);
      // 收藏 delete and 回到发现: their purge never ran.
      await fixture.images.deleteFromCollection(53);
      await fixture.images.returnToDiscovery(54);
      await rewind(fixture, 51, rewoundQueued.decidedAt);
      await rewind(fixture, 50, rewoundActive.decidedAt);
      const loose = await looseImport(fixture);

      await expect(fixture.purge().purgeUndoneLibraryRows()).resolves.toBe(4);
      // 50, 51, 53, 54: device rows and originals are gone.
      await expect(deviceRowsOf(fixture, 50)).resolves.toEqual([]);
      await expect(deviceRowsOf(fixture, 51)).resolves.toEqual([]);
      await expect(deviceRowsOf(fixture, 53)).resolves.toEqual([]);
      await expect(deviceRowsOf(fixture, 54)).resolves.toEqual([]);
      expect(hasFile(fixture, originalUri(fixture, rewoundActive.digest))).toBe(false);
      expect(hasFile(fixture, originalUri(fixture, rewoundQueued.digest))).toBe(false);
      expect(hasFile(fixture, originalUri(fixture, deleted.digest))).toBe(false);
      expect(hasFile(fixture, originalUri(fixture, returned.digest))).toBe(false);
      await expect(deviceRowsOf(fixture, 52)).resolves.toEqual([kept.digest]);
      expect(hasFile(fixture, originalUri(fixture, kept.digest))).toBe(true);
      await expect(libraryRows(fixture, loose)).resolves.toMatchObject({ device: 1 });
      expect(hasFile(fixture, originalUri(fixture, loose))).toBe(true);
    } finally {
      fixture.close();
    }
  });

  test('one image that fails to purge does not stop the others', async () => {
    const fixture = await openFixture();
    try {
      const failing = await savedAndCollected(fixture, 50);
      const next = await savedAndCollected(fixture, 51);
      await rewind(fixture, 51, next.decidedAt);
      await rewind(fixture, 50, failing.decidedAt);
      const purge = fixture.purge({
        before: async (asset) => {
          if (asset.sourceImageId === 50) throw new Error('database is busy');
        },
      });

      await expect(purge.purgeUndoneLibraryRows()).resolves.toBe(2);

      // 50 is left for the next sweep; 51 is done.
      await expect(deviceRowsOf(fixture, 50)).resolves.toEqual([failing.digest]);
      await expect(deviceRowsOf(fixture, 51)).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });
});

/**
 * Spec §5.4.3, the reason the account row must stay: an asset is "known" to
 * sync exactly while its `library_account_assets` row exists. The cloud copy
 * of a rewound save is still there (row 25), so the next round reads its
 * record — and must only update the projection, never re-materialise it.
 */
describe('board #24: sync cannot bring a rewound save back (spec §5.4.3)', () => {
  test('apply() of the asset\'s own remote record, meta and all, inserts no device row and never re-saves the image', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      const assetId = await enrolled(fixture, x.digest, { failureCategory: null });
      // Exactly the envelope this device sealed when it uploaded the save: a
      // valid v2 metadata block with a `source`, so the record CAN materialise.
      const local = await fixture.harness.repository.findLocalAsset(x.digest);
      const metadata = buildLibraryEncryptedMetadata({
        plaintextSha256: local!.plaintextSha256,
        format: local!.format,
        canonicalExtension: local!.canonicalExtension,
        byteSize: local!.byteSize,
        width: local!.width,
        height: local!.height,
        origin: local!.origin,
        sourceImageId: local!.sourceImageId,
        collectedAt: local!.createdAt,
      }, await readSourceMetadata(fixture.database, 41));
      expect(metadata.source).toMatchObject({ providerKey: 'waifu_im', providerItemId: '41' });
      const cipher = createPassthroughLibraryCipher();
      const record: LibraryProjectedAsset = {
        assetId,
        revision: 8, // above the local projection's 7
        generation: 1,
        lifecycle: 'active',
        protection: 'protected',
        encryptedMetadata: await cipher.sealMetadata({
          masterKey: fixture.harness.masterKey,
          assetId,
          metadata,
        }),
        trashedAtMs: null,
        originalGenerationId: GENERATION,
        originalCiphertextBytes: null,
        thumbnailGenerationId: null,
        previewGenerationId: null,
      };
      await rewind(fixture, 41, x.decidedAt);
      await fixture.purge().purgeCollectedImage(41);

      // The production binding: a restore re-saves the matching images row.
      const restoreImage = jest.fn<ReturnType<LibrarySyncRestoreImage>, Parameters<LibrarySyncRestoreImage>>(
        async (restored, savedAt) => (
          (await fixture.images.saveMirroredCandidate(restored, savedAt)).id
        ),
      );
      const writer = createLibrarySyncApplyWriter({
        database: fixture.database,
        cipher,
        restoreImage,
      });
      const report = await writer.apply({
        accountScope: fixture.scope,
        deviceId: fixture.harness.deviceId,
        masterKey: fixture.harness.masterKey,
        assets: [record],
      });

      expect(report).toMatchObject({ projected: 1, written: 1, materialized: 0 });
      await expect(libraryRows(fixture, x.digest)).resolves.toEqual({
        device: 0,
        deviceState: 0,
        account: 1,
      });
      expect(restoreImage).not.toHaveBeenCalled();
      await expect(fixture.images.getById(41)).resolves.toMatchObject({ decision: 'active' });
      await expect(fixture.images.listCollection()).resolves.toEqual([]);
      // The record was read as known: only the projection moved on.
      await expect(projection(fixture, x.digest)).resolves.toMatchObject({
        lifecycle: 'active',
        protection: 'protected',
        revision: 8,
      });
    } finally {
      fixture.close();
    }
  });

  test('the purged asset leaves the protect candidates, the download candidates and the mirror counts', async () => {
    const fixture = await openFixture();
    try {
      // 42 stays saved: a protect candidate before and after.
      const control = await savedAndCollected(fixture, 42);
      await enrolled(fixture, control.digest, { protection: 'pending', failureCategory: null });
      // 46: an upload still owed (a protect candidate).
      const uploading = await savedAndCollected(fixture, 46);
      await enrolled(fixture, uploading.digest, { protection: 'pending', failureCategory: null });
      // 47: freed to cloud-only before the rewind (a download candidate).
      const cloudOnlyDecidedAt = await saved(fixture, 47);
      const cloudOnly = sha256PlaintextHex(bytesFor(47));
      await fixture.database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width,
           height, origin, source_image_id, local_original_uri, residency,
           protect_eligible, missing_original_since, created_at, updated_at
         ) VALUES (?, 'jpeg', 'jpg', 13, 320, 240, 'provider', 47, NULL,
           'cloud-only', 1, NULL, 1, 1)`,
        [cloudOnly],
      );
      await enrolled(fixture, cloudOnly, { failureCategory: null });
      await rewind(fixture, 47, cloudOnlyDecidedAt);
      await rewind(fixture, 46, uploading.decidedAt);
      const protection = createLibraryProtectionRepository({ database: fixture.database });
      const before = {
        protect: await protection.listProtectCandidates(fixture.scope),
        download: await protection.listDownloadCandidates(fixture.scope),
        counts: await protection.countMirrorState(fixture.scope),
      };
      expect(before.protect).toEqual(expect.arrayContaining([control.digest, uploading.digest]));
      expect(before.download).toEqual([cloudOnly]);

      const purge = fixture.purge();
      await purge.purgeCollectedImage(46);
      await purge.purgeCollectedImage(47);

      await expect(protection.listProtectCandidates(fixture.scope)).resolves.toEqual([
        control.digest,
      ]);
      await expect(protection.listDownloadCandidates(fixture.scope)).resolves.toEqual([]);
      const after = await protection.countMirrorState(fixture.scope);
      expect(after.backedUpTotal).toBe(before.counts.backedUpTotal - 1);
      expect(after.downloadedTotal).toBe(before.counts.downloadedTotal - 1);
    } finally {
      fixture.close();
    }
  });
});

// Board #24 Task 3 review: a finished purge releases its single-flight slot (a
// second rewind of the same card in one session purges the second copy), and a
// purge whose images row vanished meanwhile (demoted, then deleted by a
// settings change) still purges — the recovery sweep's JOIN could not find it.
describe('board #24: purge lifetime edge cases', () => {
  test('save → rewind → re-save → rewind again purges the second copy too (single-flight slot released)', async () => {
    const fixture = await openFixture();
    try {
      const purge = fixture.purge();
      const first = await savedAndCollected(fixture, 41);
      await rewind(fixture, 41, first.decidedAt);
      await purge.purgeCollectedImage(41);
      await expect(deviceRowsOf(fixture, 41)).resolves.toEqual([]);
      const again = await fixture.images.saveCandidate(candidate(41), fixture.tick());
      await expect(fixture.images.markDownloadReady(41, collectionUri(41))).resolves.toBe(true);
      await collected(fixture, 41, bytesFor(41));
      await expect(deviceRowsOf(fixture, 41)).resolves.toEqual([first.digest]);
      await rewind(fixture, 41, again.decidedAt!);
      await purge.purgeCollectedImage(41);
      await expect(deviceRowsOf(fixture, 41)).resolves.toEqual([]);
      expect(hasFile(fixture, originalUri(fixture, first.digest))).toBe(false);
    } finally {
      fixture.close();
    }
  });

  test('a rewound save whose images row is gone by the time the purge runs is still purged', async () => {
    const fixture = await openFixture();
    try {
      const x = await savedAndCollected(fixture, 41);
      const y = await savedAndCollected(fixture, 42);
      await rewind(fixture, 41, x.decidedAt);
      await rewind(fixture, 42, y.decidedAt); // 42 active, 41 demoted to queued
      await expect(fixture.images.deleteQueuedCandidates()).resolves.toBe(1);
      await fixture.purge().purgeCollectedImage(41);
      await expect(libraryRows(fixture, x.digest)).resolves.toMatchObject({ device: 0 });
      expect(hasFile(fixture, originalUri(fixture, x.digest))).toBe(false);
    } finally {
      fixture.close();
    }
  });
});

describe('board #27: clearDeviceLibrary', () => {
  test('removes every device row, pending intent, cache row and library file; keeps account rows, the projection and in-flight intents', async () => {
    const fixture = await openFixture();
    try {
      const first = await savedAndCollected(fixture, 70);
      const second = await savedAndCollected(fixture, 71);
      await enrolled(fixture, first.digest, {
        intents: { collect: 'pending', protect: 'sending' },
      });
      const trashUri = await withDeviceTrashCopy(fixture, second.digest);
      const cacheUri = fixture.harness.port.resolveCache(`${first.digest}.preview`);
      fixture.harness.port.files.set(cacheUri, bytesFor(70));
      await fixture.database.run(
        `INSERT INTO library_cache_entries (
           account_scope, plaintext_sha256, role, uri, byte_size,
           generation_id, created_at, last_used_at
         ) VALUES (?, ?, 'preview', ?, 4, NULL, 5, 5)`,
        [fixture.scope, first.digest, cacheUri],
      );
      const stagingUri = fixture.harness.port.resolveTemp('wd-lib-1-1.tmp');
      fixture.harness.port.files.set(stagingUri, bytesFor(1));
      const orphanUri = fixture.harness.port.resolveOriginal('orphan.png');
      fixture.harness.port.files.set(orphanUri, bytesFor(2));
      const thumbnailUri = await withLocalThumbnail(fixture, first.digest, 'jpg');

      await expect(fixture.purge().clearDeviceLibrary()).resolves.toEqual({ failed: [] });

      await expect(libraryRows(fixture, first.digest)).resolves.toEqual({
        device: 0,
        deviceState: 0,
        account: 1,
      });
      await expect(projection(fixture, first.digest)).resolves.toMatchObject({
        lifecycle: 'active',
        protection: 'protected',
        failure_category: null,
      });
      await expect(intents(fixture, first.digest)).resolves.toEqual({ protect: 'sending' });
      await expect(
        fixture.database.getFirst('SELECT COUNT(*) AS n FROM library_cache_entries'),
      ).resolves.toEqual({ n: 0 });
      // both originals, the trash copy, the cache file, the staging file and the orphan
      expect(hasFile(fixture, originalUri(fixture, first.digest))).toBe(false);
      expect(hasFile(fixture, originalUri(fixture, second.digest))).toBe(false);
      expect(hasFile(fixture, trashUri)).toBe(false);
      expect(hasFile(fixture, cacheUri)).toBe(false);
      expect(hasFile(fixture, stagingUri)).toBe(false);
      expect(hasFile(fixture, orphanUri)).toBe(false);
      expect(hasFile(fixture, thumbnailUri)).toBe(false);
      await expect(libraryRows(fixture, second.digest)).resolves.toEqual({
        device: 0,
        deviceState: 0,
        account: 0,
      });
      expect(hasFile(fixture, collectionUri(70))).toBe(true); // the collection's files are the collection's
      expect(hasFile(fixture, collectionUri(71))).toBe(true);
    } finally {
      fixture.close();
    }
  });

  test('waits for a running ingest, then for the uploads, then clears', async () => {
    const ingestHold = deferred();
    const uploadsHold = deferred();
    const fixture = await openFixture({ holdIngest: ingestHold.promise });
    const record: string[] = [];
    let clearing: Promise<unknown> = Promise.resolve();
    try {
      await saved(fixture, 72);
      fixture.harness.port.files.set(collectionUri(72), bytesFor(72));
      fixture.collect.onOriginalReady({
        imageId: 72,
        localUri: collectionUri(72),
      });

      clearing = fixture.purge().clearDeviceLibrary(async () => {
        record.push(`uploads:${(await deviceRowsOf(fixture, 72)).length}`);
        await uploadsHold.promise;
      });
      await ticks();
      expect(record).toEqual([]);

      ingestHold.resolve();
      await waitUntil(() => record.length > 0, 'the upload settle');
      expect(record).toEqual(['uploads:1']);

      uploadsHold.resolve();
      await expect(clearing).resolves.toEqual({ failed: [] });
      await expect(deviceRowsOf(fixture, 72)).resolves.toEqual([]);
      await expect(fixture.harness.port.listOriginals()).resolves.toEqual([]);
    } finally {
      ingestHold.resolve();
      uploadsHold.resolve();
      await fixture.collect.drain();
      await clearing.catch(() => undefined);
      fixture.close();
    }
  });
});

describe('board #27 S1b T8: settled() and refuse()', () => {
  test('settled waits for every running purge and never rejects', async () => {
    const fixture = await openFixture();
    try {
      const gates = new Map([[1, deferred()], [2, deferred()]]);
      const purge = createLibraryCollectedPurge({
        database: fixture.database,
        files: fixture.harness.files,
        collect: {
          settled: (imageId) => gates.get(imageId)!.promise,
          drain: async () => undefined,
        },
      });
      // A third settled() with nothing in flight resolves at once.
      await expect(purge.settled()).resolves.toBeUndefined();

      const first = purge.purgeCollectedImage(1);
      // A purge that fails: its hook throws once a row exists for the image.
      const second = createLibraryCollectedPurge({
        database: fixture.database,
        files: fixture.harness.files,
        collect: {
          settled: async (imageId) => {
            await gates.get(imageId)!.promise;
            throw new Error('the pool broke');
          },
          drain: async () => undefined,
        },
      });
      const failing = second.purgeCollectedImage(2);
      const failedSettled = second.settled();

      let settled = false;
      const waiting = purge.settled().then(() => {
        settled = true;
      });
      let failedDone = false;
      const failedWaiting = failedSettled.then(() => {
        failedDone = true;
      });
      await ticks();
      expect(settled).toBe(false);
      expect(failedDone).toBe(false);

      gates.get(1)!.resolve();
      gates.get(2)!.resolve();
      await first;
      await expect(failing).rejects.toThrow('the pool broke');
      await waiting;
      await failedWaiting;
      expect(settled).toBe(true);
      expect(failedDone).toBe(true);
      await expect(purge.settled()).resolves.toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  test('refuse holds new purges off until every release is called, and each release counts once', async () => {
    const fixture = await openFixture();
    try {
      const undone = await savedAndCollected(fixture, 50);
      await rewind(fixture, 50, undone.decidedAt);
      const purge = fixture.purge();
      const r1 = purge.refuse();
      const r2 = purge.refuse();
      r1();
      r1();

      await expect(purge.purgeCollectedImage(50)).resolves.toBeUndefined();
      await expect(purge.purgeUndoneLibraryRows()).resolves.toBe(0);
      await expect(deviceRowsOf(fixture, 50)).resolves.toEqual([undone.digest]);
      expect(hasFile(fixture, originalUri(fixture, undone.digest))).toBe(true);

      r2();
      await expect(purge.purgeUndoneLibraryRows()).resolves.toBe(1);
      await expect(deviceRowsOf(fixture, 50)).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });
});

describe('N6-A2: purgeImportedAsset & two-member shared-byte safety (spec §4.4, §4.8)', () => {
  test('purgeImportedAsset removes standalone import membership and files while keeping account mapping and protection projection', async () => {
    const fixture = await openFixture();
    try {
      const digest = await looseImport(fixture);
      await enrolled(fixture, digest, {
        intents: { collect: 'pending', protect: 'sending' },
      });
      const thumbUri = await withLocalThumbnail(fixture, digest);
      const after = jest.fn();

      await expect(
        fixture.purge({ after }).purgeImportedAsset(digest),
      ).resolves.toBe(true);

      await expect(libraryRows(fixture, digest)).resolves.toEqual({
        device: 0,
        deviceState: 0,
        account: 1,
      });
      expect(hasFile(fixture, originalUri(fixture, digest))).toBe(false);
      expect(hasFile(fixture, thumbUri)).toBe(false);
      expect(after).toHaveBeenCalledWith({
        plaintextSha256: digest,
        sourceImageId: null,
      });
      // In-flight `sending` intent is preserved; pending `collect` is removed.
      await expect(intents(fixture, digest)).resolves.toEqual({
        protect: 'sending',
      });
      await expect(projection(fixture, digest)).resolves.toMatchObject({
        lifecycle: 'active',
        protection: 'protected',
        failure_category: null,
      });
    } finally {
      fixture.close();
    }
  });

  test('import-first + late provider save: deleting the import removes the import original while preserving the provider ready file and committed association', async () => {
    const fixture = await openFixture();
    try {
      const bytes = bytesFor(88);
      const digest = sha256PlaintextHex(bytes);
      const importOrigUri = originalUri(fixture, digest);
      fixture.harness.port.files.set(importOrigUri, bytes);
      await fixture.database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width,
           height, origin, source_image_id, local_original_uri, residency,
           protect_eligible, missing_original_since, import_classification,
           created_at, updated_at
         ) VALUES (?, 'jpeg', 'jpg', ?, 320, 240, 'import', NULL, ?,
           'local-original', 1, NULL, 'adult', 1000, 1000)`,
        [digest, bytes.byteLength, importOrigUri],
      );

      // Late provider save #88 arrives with the same bytes.
      await saved(fixture, 88);
      await collected(fixture, 88, bytes);

      // The digest row keeps origin='import' and import_classification='adult',
      // while `library_provider_image_assets` records provider #88's association.
      const beforePurge = await fixture.harness.repository.findLocalAsset(digest);
      expect(beforePurge).toMatchObject({
        origin: 'import',
        sourceImageId: null,
        importClassification: 'adult',
        createdAt: 1000,
      });
      await expect(
        fixture.database.getAll(
          'SELECT image_id, plaintext_sha256 FROM library_provider_image_assets WHERE image_id = 88',
        ),
      ).resolves.toEqual([{ image_id: 88, plaintext_sha256: digest }]);
      // Provider #88 keeps its own ready collection file.
      expect(hasFile(fixture, collectionUri(88))).toBe(true);

      // Delete the import: its private digest copy goes, while provider #88's
      // ready collection file and committed association remain intact.
      await expect(fixture.purge().purgeImportedAsset(digest)).resolves.toBe(true);
      expect(hasFile(fixture, importOrigUri)).toBe(false);
      expect(hasFile(fixture, collectionUri(88))).toBe(true);
      await expect(
        fixture.database.getAll(
          'SELECT image_id, plaintext_sha256 FROM library_provider_image_assets WHERE image_id = 88',
        ),
      ).resolves.toEqual([{ image_id: 88, plaintext_sha256: digest }]);
    } finally {
      fixture.close();
    }
  });

  test('provider save mirrored to digest + cloud import convergence: deleting either member preserves usable bytes for the surviving member', async () => {
    const fixture = await openFixture();
    try {
      // Provider #89 saves and hands over to the library original (`mirrored`),
      // then cloud convergence converts the digest row to `origin = 'import'`
      // (§4.4 second row: local provider save loses to cloud import record).
      const saved89 = await savedAndCollected(fixture, 89);
      await fixture.database.run(
        `UPDATE images SET download_state = 'mirrored', local_uri = NULL WHERE id = 89`,
      );
      await fixture.harness.repository.applyCrossDeviceCollisionAuthority({
        plaintextSha256: saved89.digest,
        origin: 'import',
        sourceImageId: null,
        importClassification: 'safe',
        collectedAt: 500,
        at: 2000,
      });

      // Case A: delete the import membership on this phone -> import_deleted_at
      // is set, `source_image_id` is linked back to mirrored provider #89, the
      // shared digest original file stays on disk, AND `readLibraryEntries`
      // still projects the entry for mirrored provider #89 (with importDeletedAt
      // set so the import tile is suppressed)!
      await expect(
        fixture.purge().purgeImportedAsset(saved89.digest),
      ).resolves.toBe(true);
      expect(hasFile(fixture, originalUri(fixture, saved89.digest))).toBe(true);
      const afterImportDelete = await fixture.harness.repository.findLocalAsset(
        saved89.digest,
      );
      expect(afterImportDelete?.importDeletedAt).not.toBeNull();
      expect(afterImportDelete?.sourceImageId).toBe(89);
      const viewEntries = await readLibraryEntries(fixture.database, null);
      expect(viewEntries).toHaveLength(1);
      expect(viewEntries[0]).toMatchObject({
        plaintextSha256: saved89.digest,
        sourceImageId: 89,
        origin: 'import',
        importClassification: 'safe',
        hasLocalOriginal: true,
      });
      expect(viewEntries[0]?.importDeletedAt).not.toBeNull();
      await expect(
        readLibraryEntry(fixture.database, null, saved89.digest),
      ).resolves.toMatchObject({
        plaintextSha256: saved89.digest,
        sourceImageId: 89,
      });

      // Case B: if instead the import is active and provider #89 is deleted,
      // the active import keeps the digest row and its original file!
      await fixture.database.run(
        `UPDATE device_library_assets
            SET import_deleted_at = NULL, origin = 'import'
          WHERE plaintext_sha256 = ?`,
        [saved89.digest],
      );
      await rewind(fixture, 89, saved89.decidedAt);
      await fixture.purge().purgeCollectedImage(89);

      expect(hasFile(fixture, originalUri(fixture, saved89.digest))).toBe(true);
      const afterProviderDelete = await fixture.harness.repository.findLocalAsset(
        saved89.digest,
      );
      expect(afterProviderDelete).toMatchObject({
        origin: 'import',
        sourceImageId: null,
        importClassification: 'safe',
        importDeletedAt: null,
      });
    } finally {
      fixture.close();
    }
  });

  test('purgeImportedAsset serializes physical file deletion under withDigestGate so a concurrent re-add cannot have its promoted file deleted', async () => {
    const fixture = await openFixture();
    try {
      const bytes = bytesFor(91);
      const digest = sha256PlaintextHex(bytes);
      const uri = originalUri(fixture, digest);
      fixture.harness.port.files.set(uri, bytes);
      await fixture.database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width,
           height, origin, source_image_id, local_original_uri, residency,
           protect_eligible, missing_original_since, import_classification,
           created_at, updated_at
         ) VALUES (?, 'jpeg', 'jpg', ?, 320, 240, 'import', NULL, ?,
           'local-original', 1, NULL, 'safe', 1000, 1000)`,
        [digest, bytes.byteLength, uri],
      );

      let notifyDeleteEntered!: () => void;
      const deleteEntered = new Promise<void>((res) => {
        notifyDeleteEntered = res;
      });
      const holdDelete = deferred();
      const realDelete = fixture.harness.files.deleteOriginal.bind(
        fixture.harness.files,
      );
      fixture.harness.files.deleteOriginal = async (targetUri) => {
        if (targetUri === uri) {
          notifyDeleteEntered();
          await holdDelete.promise;
        }
        await realDelete(targetUri);
      };

      const purging = fixture.purge().purgeImportedAsset(digest);
      await deleteEntered;

      // Start a concurrent re-add of the exact same bytes while purgeImportOnce
      // is paused right before deleting the physical original file. Because
      // `purgeImportOnce` holds `withDigestGate(digest)`, the re-add waits until
      // the physical delete finishes, then promotes fresh bytes cleanly.
      const readding = fixture.ingest.ingestBytes({
        bytes,
        origin: 'import',
        importClassification: 'adult',
        strictImportDuplicate: true,
      });

      holdDelete.resolve();
      const [purged, readdOutcome] = await Promise.all([purging, readding]);

      expect(purged).toBe(true);
      expect(readdOutcome.status).toBe('ingested');
      expect(hasFile(fixture, uri)).toBe(true);
      await expect(
        fixture.harness.repository.findLocalAsset(digest),
      ).resolves.toMatchObject({
        origin: 'import',
        importClassification: 'adult',
        importDeletedAt: null,
        localOriginalUri: uri,
      });
    } finally {
      fixture.close();
    }
  });

  test('purgeCollectedImage serializes late-provider association cleanup under withDigestGate', async () => {
    const fixture = await openFixture();
    try {
      const bytes = bytesFor(92);
      const digest = sha256PlaintextHex(bytes);
      const uri = originalUri(fixture, digest);
      fixture.harness.port.files.set(uri, bytes);
      await fixture.database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width,
           height, origin, source_image_id, local_original_uri, residency,
           protect_eligible, missing_original_since, import_classification,
           created_at, updated_at
         ) VALUES (?, 'jpeg', 'jpg', ?, 320, 240, 'import', NULL, ?,
           'local-original', 1, NULL, 'safe', 1000, 1000)`,
        [digest, bytes.byteLength, uri],
      );
      const decidedAt92 = await saved(fixture, 92);
      await collected(fixture, 92, bytes);
      await rewind(fixture, 92, decidedAt92);

      const gatedShas: string[] = [];
      const purge = createLibraryCollectedPurge({
        database: fixture.database,
        files: fixture.harness.files,
        collect: fixture.collect,
        withDigestGate: async (sha, work) => {
          gatedShas.push(sha);
          return work();
        },
      });

      await purge.purgeCollectedImage(92);
      expect(gatedShas).toEqual([digest]);
      await expect(
        fixture.database.getAll(
          'SELECT image_id FROM library_provider_image_assets WHERE image_id = 92',
        ),
      ).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });
});
