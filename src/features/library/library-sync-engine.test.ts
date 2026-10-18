jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import { S3TransportError } from '@/features/byos/s3-transport-types';
import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import { encodeAssetState } from '@/features/library/library-asset-state-codec';
import { createLibraryDeviceTrashSweep } from '@/features/library/library-device-trash-sweep';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import {
  createLibraryReconciliationPort,
  LibraryReconciliationCorruptionError,
  type LibraryReconciliationPort,
  type LibraryReconciliationTransport,
} from '@/features/library/library-reconciliation-port';
import { LIBRARY_TRASH_RETENTION_MS } from '@/features/library/library-trash-deadline';
import type { LibrarySyncApplyInput } from '@/features/library/library-sync-apply';
import { buildEngine } from '@/features/library/library-sync-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'waifu-deck/';

/**
 * The port's durable ETag index over the harness's own database, bound to the
 * harness's account scope — the production wiring, so a "relaunched" port
 * built from the same harness starts warm exactly as the app's would.
 */
const newIndex = (harness: ActionsHarness) => bindLibraryRemoteStateIndex(
  createLibraryRemoteStateCacheRepository({ database: harness.database }),
  async () => TEST_ACCOUNT_SCOPE,
);

/**
 * A reconciliation port stub for the failure-path cases: the engine only calls
 * `discoverChanges` there, so the other two members exist to satisfy the type.
 */
const failingPort = (
  discoverChanges: () => Promise<never>,
): LibraryReconciliationPort => ({
  discoverChanges,
  getAssetState: async () => null,
  remember: async () => undefined,
});

/**
 * Serves the harness's remote records as real `state.json` objects — with
 * content-derived ETags, the way a backend derives them from the bytes — so
 * the engine can run against the *real* reconciliation port and every state
 * GET it issues can be counted.
 *
 * The rest of the harness (blob reads, mutation submission) still goes
 * through `harness.cloud`; this transport backs change discovery only.
 */
function etagBackend(harness: ActionsHarness) {
  const counts = { lists: 0, gets: 0 };
  const gotKeys: string[] = [];
  const stateKey = (assetId: string) => `${PREFIX}assets/${assetId}/state.json`;

  const etagOf = (body: Uint8Array): string => {
    let hash = 0x811c9dc5;
    for (const byte of body) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return `"${hash.toString(16)}"`;
  };
  const objectFor = (assetId: string) => {
    const record = harness.cloud.remote.get(assetId);
    if (record === undefined) return null;
    const body = encodeAssetState(record);
    return { body, etag: etagOf(body) };
  };

  const transport: LibraryReconciliationTransport = {
    async listObjects(prefix: string, _token: string | undefined) {
      counts.lists += 1;
      const objects = [...harness.cloud.remote.keys()]
        .map((assetId) => ({ key: stateKey(assetId), object: objectFor(assetId)! }))
        .filter(({ key }) => key.startsWith(prefix))
        .map(({ key, object }) => ({
          key,
          etag: object.etag,
          lastModified: '',
          size: object.body.length,
        }));
      return { objects, nextToken: undefined };
    },
    async getObject(key: string) {
      counts.gets += 1;
      gotKeys.push(key);
      return objectFor(
        key.slice(`${PREFIX}assets/`.length, -'/state.json'.length),
      );
    },
  };
  return { transport, counts, gotKeys, stateKey };
}

describe('library sync engine (reconcile half)', () => {
  let harness: ActionsHarness;

  beforeEach(async () => {
    resetExpoCryptoDouble();
    harness = await createActionsHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it('skips without an account and touches no network', async () => {
    harness.session.signOut();

    await expect(buildEngine(harness).sync()).resolves.toMatchObject({
      status: 'skipped',
      skipped: 'no_account',
      reconciled: 0,
    });
    expect(harness.cloud.requests).toHaveLength(0);
    await expect(buildEngine(harness).readSyncState()).resolves.toBeNull();
  });

  it('reconciles every asset state and materializes cloud-only assets', async () => {
    await harness.cloud.seedRemoteAsset({
      plaintextSha256: DIGEST_A,
      protection: 'protected',
      lifecycle: 'active',
    });

    const report = await buildEngine(harness).sync();

    expect(report).toMatchObject({
      status: 'completed',
      reconciled: 1,
      materialized: 1,
      submitted: 0,
    });
    await expect(harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      harness.assetIdFor(DIGEST_A),
    )).resolves.toMatchObject({
      protection: 'protected',
      lifecycle: 'active',
      verifiedAt: null,
    });
    await expect(harness.database.getFirst(
      `SELECT residency, local_original_uri FROM device_library_assets
        WHERE plaintext_sha256 = ?`,
      [DIGEST_A],
    )).resolves.toEqual({ residency: 'cloud-only', local_original_uri: null });
  });

  it('adopts the object references the state record carries', async () => {
    // BYOS keeps the generation ids on the asset's own state record, so one
    // reconcile learns them. There is no second index sweep to run.
    await harness.cloud.seedRemoteAsset({
      plaintextSha256: DIGEST_A,
      protection: 'protected',
      withDerived: true,
    });

    await buildEngine(harness).sync();

    await expect(harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      harness.assetIdFor(DIGEST_A),
    )).resolves.toMatchObject({
      originalGenerationId: harness.cloud.originalGenerationIdFor(DIGEST_A),
      thumbnailGenerationId: 'thumb-gen',
      previewGenerationId: 'preview-gen',
      // Knowing an object id is not proof the bytes are readable here.
      verifiedAt: null,
    });
  });

  it('records the watermark on the first completed cycle', async () => {
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_A });

    await buildEngine(harness).sync();

    await expect(buildEngine(harness).readSyncState()).resolves.toMatchObject({
      accountScope: TEST_ACCOUNT_SCOPE,
      lastSyncedAt: harness.now,
    });
  });

  it('lists the whole prefix every cycle and projects only what changed', async () => {
    await buildEngine(harness).sync();
    harness.cloud.requests.length = 0;
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_A });

    const report = await buildEngine(harness).sync();

    expect(report).toMatchObject({ reconciled: 1, materialized: 1 });
    // One listing per cycle: there is no cursor. Which listed keys are then
    // re-read — and which of those reach the projection — is the port's ETag
    // diff (below); the listing itself is always the whole prefix.
    expect(
      harness.cloud.requests.filter((path) => path === '/byos/assets/'),
    ).toHaveLength(1);
  });

  it('writes nothing at all when a relaunched device finds the library unchanged', async () => {
    // K7 cut 3, the whole point of the cut. The port returns only the records
    // whose remote ETag moved, so a cycle over an unchanged library reaches
    // `apply` with an empty batch and the writer is never called — no
    // full-account SELECT, no N no-op UPSERTs holding the shared FIFO SQL
    // queue while the collection screen and ingest wait behind them.
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_A });
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_B });
    const backend = etagBackend(harness);
    const reconciliation = createLibraryReconciliationPort(
      backend.transport,
      PREFIX,
      newIndex(harness),
    );
    await buildEngine(harness, { reconciliation }).sync();

    const applied: number[] = [];
    const counting = {
      apply: async (input: LibrarySyncApplyInput) => {
        applied.push(input.assets.length);
        return {
          projected: input.assets.length,
          written: 0,
          materialized: 0,
          skippedUnknownAsset: 0,
          skippedIntegrity: 0,
        };
      },
    };

    const report = await buildEngine(harness, {
      // A fresh port over the SAME durable index: the process restarted.
      reconciliation: createLibraryReconciliationPort(
        backend.transport,
        PREFIX,
        newIndex(harness),
      ),
      apply: counting,
    }).sync();

    expect(applied).toEqual([]);
    expect(report).toMatchObject({ status: 'completed', reconciled: 0 });
  });

  it('projects exactly the assets whose remote ETag moved', async () => {
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_A });
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_B });
    const backend = etagBackend(harness);
    const reconciliation = createLibraryReconciliationPort(
      backend.transport,
      PREFIX,
      newIndex(harness),
    );
    await buildEngine(harness, { reconciliation }).sync();

    harness.cloud.trashRemoteAsset(DIGEST_A);
    const applied: string[][] = [];
    const report = await buildEngine(harness, {
      reconciliation,
      apply: {
        apply: async (input: LibrarySyncApplyInput) => {
          applied.push(input.assets.map((asset) => asset.assetId));
          return {
            projected: input.assets.length,
            written: input.assets.length,
            materialized: 0,
            skippedUnknownAsset: 0,
            skippedIntegrity: 0,
          };
        },
      },
    }).sync();

    // One asset moved, one did not: one record reaches the writer.
    expect(applied).toEqual([[harness.assetIdFor(DIGEST_A)]]);
    expect(report).toMatchObject({ reconciled: 1 });
  });

  it('re-reads only the assets whose remote ETag changed since the last cycle', async () => {
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_A });
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_B });
    const backend = etagBackend(harness);
    // Production builds one reconciliation port per composition and reuses it
    // for the vault's lifetime (`library-integration-impl`), and its ETag index
    // is now durable, so it outlives the process — as here.
    const reconciliation = createLibraryReconciliationPort(
      backend.transport,
      PREFIX,
      newIndex(harness),
    );

    await expect(buildEngine(harness, { reconciliation }).sync())
      .resolves.toMatchObject({ status: 'completed', reconciled: 2 });
    expect(backend.counts).toEqual({ lists: 1, gets: 2 });

    backend.gotKeys.length = 0;
    // Nothing changed remotely: the cycle still lists everything, reads no
    // state object at all, and projects nothing.
    await expect(buildEngine(harness, { reconciliation }).sync())
      .resolves.toMatchObject({ status: 'completed', reconciled: 0 });
    expect(backend.gotKeys).toEqual([]);
    expect(backend.counts).toEqual({ lists: 2, gets: 2 });

    // A tombstone is a CAS overwrite of the same key, so its ETag moves and
    // exactly that one object is re-read — and projected.
    harness.cloud.purgeRemoteAsset(DIGEST_A);
    await expect(buildEngine(harness, { reconciliation }).sync())
      .resolves.toMatchObject({ reconciled: 1 });
    expect(backend.gotKeys).toEqual([
      backend.stateKey(harness.assetIdFor(DIGEST_A)),
    ]);
    await expect(harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      harness.assetIdFor(DIGEST_A),
    )).resolves.toMatchObject({ lifecycle: 'purged' });
  });

  it('takes a purged record as the authoritative tombstone', async () => {
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    harness.cloud.purgeRemoteAsset(DIGEST_A);

    await buildEngine(harness).sync();

    await expect(harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      harness.assetIdFor(DIGEST_A),
    )).resolves.toMatchObject({ lifecycle: 'purged' });
  });

  it('never forgets a local row just because the listing omits it', async () => {
    await harness.cloud.seedRemoteAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    // State objects are never DELETEd, so an absent key is "not written yet",
    // "raced a concurrent write", or "swept after tombstone retention" — none
    // of which authorize forgetting anything. Only a `purged` record does.
    harness.cloud.removeRemoteAsset(DIGEST_A);

    await expect(buildEngine(harness).sync()).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      harness.assetIdFor(DIGEST_A),
    )).resolves.toMatchObject({ lifecycle: 'active' });
  });

  it('reconciles files only after the projection is durable', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    harness.cloud.trashRemoteAsset(DIGEST_A);

    const seen: string[] = [];
    const engine = buildEngine(harness, {
      reconciler: {
        async reconcile(scope) {
          const row = await harness.database.getFirst<{ lifecycle: string }>(
            `SELECT lifecycle FROM library_asset_protection
              WHERE account_scope = ? AND plaintext_sha256 = ?`,
            [scope, DIGEST_A],
          );
          seen.push(row?.lifecycle ?? 'missing');
          return {
            movedToDeviceTrash: 0,
            restoredFromDeviceTrash: 0,
            purgedDeviceTrash: 0,
            refused: 0,
            failed: 0,
          };
        },
      },
    });
    await engine.sync();

    expect(seen).toEqual(['trash']);
  });

  it('halts offline without moving the watermark or deleting anything', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    const before = await buildEngine(harness).readSyncState();
    harness.cloud.offline = true;

    await expect(buildEngine(harness).sync()).resolves.toMatchObject({
      status: 'halted',
      haltedCategory: 'offline',
      files: { purgedDeviceTrash: 0, refused: 0 },
    });

    await expect(buildEngine(harness).readSyncState()).resolves.toEqual(before);
    expect(harness.port.files.has(harness.originalUriFor(DIGEST_A))).toBe(true);
  });

  it('halts on a raw S3 transport failure instead of rejecting', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    const engine = buildEngine(harness, {
      // The real transport throws this, not a LibraryCloudError. Without the
      // Task 2 bridge it would escape `sync()` as an unhandled rejection.
      reconciliation: failingPort(async () => {
        throw new S3TransportError(0, 'network', 'connection reset', false);
      }),
    });

    await expect(engine.sync()).resolves.toMatchObject({
      status: 'halted',
      haltedCategory: 'offline',
    });
    expect(harness.port.files.has(harness.originalUriFor(DIGEST_A))).toBe(true);
  });

  it('halts with auth_attention on a forbidden bucket', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    const engine = buildEngine(harness, {
      reconciliation: failingPort(async () => {
        throw new S3TransportError(403, 'credential', 'forbidden');
      }),
    });

    await expect(engine.sync()).resolves.toMatchObject({
      status: 'halted',
      haltedCategory: 'auth_attention',
    });
    expect(harness.port.files.has(harness.originalUriFor(DIGEST_A))).toBe(true);
  });

  it('halts with integrity when a remote state object is corrupt', async () => {
    const engine = buildEngine(harness, {
      reconciliation: failingPort(async () => {
        throw new LibraryReconciliationCorruptionError(
          'waifu-deck/assets/x/state.json',
          new Error('not JSON'),
        );
      }),
    });

    // A corrupt object does not heal by being read again, so the cycle stops
    // and says so instead of retrying it forever.
    await expect(engine.sync()).resolves.toMatchObject({
      status: 'halted',
      haltedCategory: 'integrity',
    });
    await expect(buildEngine(harness).readSyncState()).resolves.toMatchObject({
      lastSyncedAt: null,
    });
  });

  it('increments deviceTrashSweep.deleted for expired trash and leaves local_original_uri untouched', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();

    const originalUri = harness.originalUriFor(DIGEST_A);
    const trashUri = `${harness.port.trashRootUri}/${DIGEST_B}.jpg`;
    await harness.port.writeBytes(trashUri, Uint8Array.from([9, 9, 9, 9]));
    await harness.protection.setDeviceTrash(
      DIGEST_B,
      trashUri,
      harness.now - LIBRARY_TRASH_RETENTION_MS - DAY_MS,
    );

    const sweep = createLibraryDeviceTrashSweep({
      database: harness.database,
      protection: harness.protection,
      files: harness.port,
      clock: () => harness.now,
    });
    const report = await buildEngine(harness, { sweep }).sync();

    expect(report.deviceTrashSweep).toEqual({ deleted: 1, refused: 0, failed: 0 });
    expect(await harness.port.exists(trashUri)).toBe(false);
    expect(await harness.port.exists(originalUri)).toBe(true);
    await expect(harness.database.getFirst(
      `SELECT local_original_uri FROM device_library_assets
        WHERE plaintext_sha256 = ?`,
      [DIGEST_A],
    )).resolves.toEqual({ local_original_uri: originalUri });
  });
});
