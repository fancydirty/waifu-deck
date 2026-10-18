/**
 * ETag-incremental change discovery against a real S3-compatible backend
 * (P5 Task 2 / P3C decision #24, protocol spec "变更发现").
 *
 * The unit suite proves the port's diff logic against a fake whose ETags it
 * chooses. This suite proves the assumption underneath it, which only a real
 * backend can settle: that the ETag `ListObjectsV2` reports for a `state.json`
 * is the same string the GET of that key returns, and that a CAS overwrite
 * moves it. If a backend ever violated that (R2 in Task 4 re-runs exactly
 * these cases), the optimization would silently stop re-reading changed
 * assets — so the GET counts here are asserted exactly, not as bounds.
 *
 * K7 cut 3 adds the half that only a device database can settle: the index is
 * now DURABLE, so a relaunched process over an unchanged library must read
 * zero `state.json` objects, not merely re-use an in-process map.
 *
 * Parameterized by the same BYOS_IT_* environment as the other integration
 * suites; `npm run verify:byos-minio` supplies a throwaway container's values.
 */
import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createS3Transport } from '@/features/byos/s3-transport';
import type { S3Credentials } from '@/features/byos/s3-transport-types';
import {
  createS3LibraryCloudClient,
  type S3LibraryPendingMutation,
} from '@/features/library/library-cloud-client-s3';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import {
  createLibraryReconciliationPort,
  type LibraryReconciliationTransport,
} from '@/features/library/library-reconciliation-port';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import { createMemoryLibraryRemoteStateIndex } from '@/features/library/library-test-support';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const endpoint = process.env.BYOS_IT_ENDPOINT ?? '';
const bucket = process.env.BYOS_IT_BUCKET ?? '';
const accessKeyId = process.env.BYOS_IT_ACCESS_KEY ?? '';
const secretAccessKey = process.env.BYOS_IT_SECRET ?? '';
const basePrefix = process.env.BYOS_IT_PREFIX ?? '';
const region = process.env.BYOS_IT_REGION ?? 'us-east-1';

const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

if (!configured) {
  console.warn(
    '[byos-integration] Skipping the ETag-incremental reconciliation suite: '
    + 'BYOS_IT_ENDPOINT/BYOS_IT_BUCKET/BYOS_IT_ACCESS_KEY/BYOS_IT_SECRET are '
    + 'not all set. Run `npm run verify:byos-minio` to start a throwaway MinIO '
    + 'container and run this gate against it.',
  );
}

const describeBackend = configured ? describe : describe.skip;

const credentials: S3Credentials = {
  endpoint, region, bucket, accessKeyId, secretAccessKey,
};

/** One prefix per run, one sub-prefix per case: cases never see each other. */
const runPrefix = `${basePrefix}etag-${Date.now().toString(36)}/`;

const META_ENVELOPE = 'd2QxAcarriedMetadataEnvelopePlaceholder_0123456789-_';

describeBackend('ETag-incremental reconciliation against a real backend', () => {
  const transport = createS3Transport(credentials);

  /**
   * Wraps the real transport so the port's reads can be counted. Writes go
   * through the unwrapped transport, so every count below is change
   * discovery's own traffic and nothing else.
   */
  function counting() {
    const counts = { lists: 0, gets: 0 };
    const gotKeys: string[] = [];
    const port: LibraryReconciliationTransport = {
      async listObjects(prefix, token) {
        counts.lists += 1;
        return transport.listObjects(prefix, token);
      },
      async getObject(key) {
        counts.gets += 1;
        gotKeys.push(key);
        return transport.getObject(key);
      },
    };
    return { port, counts, gotKeys };
  }

  const client = (prefix: string) => createS3LibraryCloudClient({
    transport, prefix, decide: decideLibraryMutation,
  });

  const collect = (assetId: string): S3LibraryPendingMutation => ({
    assetId,
    kind: 'collect',
    baseRevision: null,
    observedGeneration: null,
    originalGenerationId: null,
    mutationId: `m-collect-${assetId}`,
    newBlob: null,
    meta: META_ENVELOPE,
  });

  const trash = (assetId: string): S3LibraryPendingMutation => ({
    assetId,
    kind: 'trash',
    baseRevision: 1,
    observedGeneration: 1,
    originalGenerationId: null,
    mutationId: `m-trash-${assetId}`,
    newBlob: null,
  });

  const stateKey = (prefix: string, assetId: string) =>
    `${prefix}assets/${assetId}/state.json`;

  afterAll(async () => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await transport.listObjects(runPrefix, token);
      for (const object of page.objects) keys.push(object.key);
      token = page.nextToken;
    } while (token !== undefined);
    await Promise.all(
      keys.map((key) => transport.deleteObject(key).catch(() => undefined)),
    );
  });

  test('a second pass over an unchanged library reads no state object', async () => {
    const prefix = `${runPrefix}incremental/`;
    const assetIds = ['a1', 'a2', 'a3', 'a4', 'a5'];
    await client(prefix).submitMutations({ mutations: assetIds.map(collect) });

    const backend = counting();
    const index = createMemoryLibraryRemoteStateIndex();
    const reconciliation = createLibraryReconciliationPort(
      backend.port, prefix, index,
    );

    const first = await reconciliation.discoverChanges();
    expect(first.changed.map((s) => s.assetId).sort()).toEqual(assetIds);
    expect(first.total).toBe(5);
    expect(backend.counts).toEqual({ lists: 1, gets: 5 });

    // Nothing was written in between: the listing's ETags all match what the
    // first pass read, so this pass costs exactly one LIST and reports nothing
    // for the caller to project.
    const second = await reconciliation.discoverChanges();
    expect(second.changed).toEqual([]);
    expect(second.removedKeys).toEqual([]);
    expect(second.total).toBe(5);
    expect(backend.counts).toEqual({ lists: 2, gets: 5 });

    // One real CAS overwrite (trash is a smaller body at the same key).
    backend.gotKeys.length = 0;
    const trashed = await client(prefix).submitMutations({
      mutations: [trash('a3')],
    });
    expect(trashed.results[0]!.outcome).toBe('applied');

    const third = await reconciliation.discoverChanges();
    expect(backend.gotKeys).toEqual([stateKey(prefix, 'a3')]);
    expect(backend.counts).toEqual({ lists: 3, gets: 6 });
    expect(third.changed).toHaveLength(1);
    expect(third.changed[0]).toMatchObject({
      assetId: 'a3',
      lifecycle: 'trash',
      revision: 2,
    });
    expect(third.total).toBe(5);
  });

  test('a RELAUNCHED device over an unchanged library GETs zero state.json', async () => {
    // K7 cut 3, the measured defect and the hard proof for this cut. The index
    // lived in an in-process Map, so every cold start re-read the whole bucket
    // — ~55 s of serial GETs on the owner's 450-asset library, before any
    // outbox row drained or any other device's new image downloaded. A second
    // process over the same device database must now read nothing at all.
    const prefix = `${runPrefix}relaunch/`;
    const assetIds = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    await client(prefix).submitMutations({ mutations: assetIds.map(collect) });

    const native = new DatabaseSync(':memory:');
    const database: SqlDatabasePort = createNodeSqliteAdapter(native);
    await migrateDatabase(database);
    const repository = createLibraryRemoteStateCacheRepository({ database });
    const scope = 'relaunch-scope';
    // A NEW port each time, over the SAME device database: exactly what
    // happens when the app is killed and reopened.
    const launch = (port: LibraryReconciliationTransport) =>
      createLibraryReconciliationPort(
        port,
        prefix,
        bindLibraryRemoteStateIndex(repository, async () => scope),
      );

    try {
      const cold = counting();
      const first = await launch(cold.port).discoverChanges();
      expect(first.changed).toHaveLength(6);
      expect(cold.counts).toEqual({ lists: 1, gets: 6 });

      const relaunched = counting();
      const second = await launch(relaunched.port).discoverChanges();
      expect(relaunched.gotKeys).toEqual([]);
      expect(relaunched.counts).toEqual({ lists: 1, gets: 0 });
      expect(second.changed).toEqual([]);
      expect(second.total).toBe(6);

      // And a relaunch still sees a real change: one CAS overwrite, one GET.
      expect((await client(prefix).submitMutations({ mutations: [trash('r4')] }))
        .results[0]!.outcome).toBe('applied');
      const third = counting();
      const after = await launch(third.port).discoverChanges();
      expect(third.gotKeys).toEqual([stateKey(prefix, 'r4')]);
      expect(third.counts).toEqual({ lists: 1, gets: 1 });
      expect(after.changed).toHaveLength(1);
      expect(after.changed[0]).toMatchObject({ assetId: 'r4', lifecycle: 'trash' });
    } finally {
      native.close();
    }
  });

  test('the listing ETag equals the GET ETag and moves on overwrite', async () => {
    // The property the whole optimization rests on, asserted against the real
    // backend rather than assumed.
    const prefix = `${runPrefix}etag-identity/`;
    await client(prefix).submitMutations({ mutations: [collect('b1')] });
    const key = stateKey(prefix, 'b1');

    const listed = async () => {
      const page = await transport.listObjects(`${prefix}assets/`, undefined);
      return page.objects.find((object) => object.key === key);
    };

    const before = await listed();
    const readBefore = await transport.getObject(key);
    expect(before?.etag).toBeTruthy();
    expect(readBefore?.etag).toBe(before?.etag);

    await client(prefix).submitMutations({ mutations: [trash('b1')] });

    const after = await listed();
    const readAfter = await transport.getObject(key);
    expect(after?.etag).toBe(readAfter?.etag);
    expect(after?.etag).not.toBe(before?.etag);
  });

  test('a targeted getAssetState read primes the index for the next listing', async () => {
    const prefix = `${runPrefix}targeted/`;
    await client(prefix).submitMutations({
      mutations: [collect('c1'), collect('c2')],
    });

    const backend = counting();
    const reconciliation = createLibraryReconciliationPort(
      backend.port, prefix, createMemoryLibraryRemoteStateIndex(),
    );
    await reconciliation.discoverChanges();

    // Stands in for the engine's post-drain convergence: this device wrote
    // c1, then re-read it through the port.
    await client(prefix).submitMutations({ mutations: [trash('c1')] });
    expect(await reconciliation.getAssetState('c1')).toMatchObject({
      lifecycle: 'trash',
    });

    backend.gotKeys.length = 0;
    const discovered = await reconciliation.discoverChanges();
    // The write this device just made is already indexed, so discovery reads
    // nothing at all — and reports nothing left to project.
    expect(backend.gotKeys).toEqual([]);
    expect(discovered.changed).toEqual([]);
    expect(discovered.total).toBe(2);
  });

  test('a committed CAS write indexes itself, so discovery never re-reads it', async () => {
    // K7 audit ⑪, the other half of this cut: the client's successful PUT hands
    // the (key, etag, record) triple straight to the port, so the write this
    // device just made costs no GET — not on convergence, not on the next pass.
    const prefix = `${runPrefix}writeback/`;
    const backend = counting();
    const reconciliation = createLibraryReconciliationPort(
      backend.port, prefix, createMemoryLibraryRemoteStateIndex(),
    );
    const writing = createS3LibraryCloudClient({
      transport, prefix, decide: decideLibraryMutation,
      rememberState: (key, etag, record) => (
        reconciliation.remember(key, etag, record)
      ),
    });

    expect((await writing.submitMutations({ mutations: [collect('w1')] }))
      .results[0]!.outcome).toBe('applied');
    expect((await writing.submitMutations({ mutations: [trash('w1')] }))
      .results[0]!.outcome).toBe('applied');

    const discovered = await reconciliation.discoverChanges();
    expect(backend.counts).toEqual({ lists: 1, gets: 0 });
    expect(discovered.changed).toEqual([]);
    expect(discovered.total).toBe(1);

    // The indexed record is the one that actually landed, not a guess: a peer's
    // read of the same key agrees with it.
    const landed = await transport.getObject(stateKey(prefix, 'w1'));
    expect(landed).not.toBeNull();
  });
});
