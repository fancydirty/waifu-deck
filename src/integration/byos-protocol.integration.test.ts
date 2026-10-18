/**
 * BYOS protocol round-trip against a real S3-compatible backend.
 *
 * Where the transport suite proves SigV4 bytes on the wire, this one proves
 * the layer above it: vault creation/adoption, the per-asset CAS write path,
 * the tombstone shape, and the reconciliation reader — all against real
 * MinIO, with the real production modules and the real global `fetch`. The
 * conditional writes here (`If-None-Match: *`, `If-Match: <etag>`) are the
 * protocol's entire concurrency story, so only a real backend that actually
 * serializes them can prove the retry/adoption paths behave.
 *
 * Boundary (P3C decision #9): no two-device app-level convergence, no real
 * encryption UX, no real R2 — those are P5. `expo-crypto` is the double, so
 * `meta` here is an opaque placeholder envelope, which is exactly how the
 * codec and CAS writer treat it. scrypt (`@noble/hashes`, not `expo-crypto`)
 * is real in this suite: the vault's key-check is genuine.
 *
 * Parameterized by the same BYOS_IT_* environment as the transport suite so
 * both can be pointed at R2 later; `npm run verify:byos-minio` supplies a
 * throwaway container's values.
 */
import { createVaultOrAdopt } from '@/features/byos/byos-vault-init';
import { VaultMetaError } from '@/features/byos/byos-vault-meta';
import { createS3Transport } from '@/features/byos/s3-transport';
import type { S3Credentials } from '@/features/byos/s3-transport-types';
import {
  decodeAssetState,
  type LibraryAssetStateGenerations,
} from '@/features/library/library-asset-state-codec';
import {
  createS3LibraryCloudClient,
  type S3LibraryPendingMutation,
  type S3LibraryTransportPort,
} from '@/features/library/library-cloud-client-s3';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import { createLibraryReconciliationPort } from '@/features/library/library-reconciliation-port';
import { createMemoryLibraryRemoteStateIndex } from '@/features/library/library-test-support';
import { openExistingVault } from '@/test/byos-vault-open';

const endpoint = process.env.BYOS_IT_ENDPOINT ?? '';
const bucket = process.env.BYOS_IT_BUCKET ?? '';
const accessKeyId = process.env.BYOS_IT_ACCESS_KEY ?? '';
const secretAccessKey = process.env.BYOS_IT_SECRET ?? '';
const basePrefix = process.env.BYOS_IT_PREFIX ?? '';
const region = process.env.BYOS_IT_REGION ?? 'us-east-1';

const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

if (!configured) {
  console.warn(
    '[byos-integration] Skipping the BYOS protocol round-trip suite: '
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
const runPrefix = `${basePrefix}proto-${Date.now().toString(36)}/`;

const PASSWORD = 'correct horse battery staple';

/**
 * An opaque stand-in for `sealMetadata`'s base64url envelope. Nothing below
 * the cipher ever opens it — the codec and the CAS writer carry it verbatim —
 * so the gate can prove the carried-field contract without a real seal
 * (decision #9).
 */
const META_ENVELOPE = 'd2QxAcarriedMetadataEnvelopePlaceholder_0123456789-_';

const bytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed * 37 + i * 11) % 256);

const decoder = new TextDecoder();

describeBackend('BYOS protocol against a real S3-compatible backend', () => {
  const transport = createS3Transport(credentials);

  /** Returns the error an operation threw, failing if it resolved instead. */
  async function captureError(op: Promise<unknown>): Promise<unknown> {
    try {
      await op;
    } catch (error) {
      return error;
    }
    throw new Error('Expected the operation to be rejected.');
  }

  function newClient(prefix: string, port: S3LibraryTransportPort = transport) {
    return createS3LibraryCloudClient({
      transport: port, prefix, decide: decideLibraryMutation,
    });
  }

  /** Reads and decodes an asset's state.json straight off the backend. */
  async function readState(prefix: string, assetId: string) {
    const raw = await transport.getObject(`${prefix}assets/${assetId}/state.json`);
    expect(raw).not.toBeNull();
    return decodeAssetState(raw!.body);
  }

  const collect = (
    assetId: string,
    overrides: Partial<S3LibraryPendingMutation> = {},
  ): S3LibraryPendingMutation => ({
    assetId,
    kind: 'collect',
    baseRevision: null,
    observedGeneration: null,
    originalGenerationId: null,
    mutationId: `m-collect-${assetId}`,
    newBlob: null,
    meta: META_ENVELOPE,
    ...overrides,
  });

  afterAll(async () => {
    // Sweep everything this run wrote. The container is thrown away anyway,
    // but the same suite is meant to run against a real bucket in P5.
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

  describe('vault lifecycle', () => {
    test('first init creates vault-meta.json; reopening derives the same master key', async () => {
      const prefix = `${runPrefix}vault-open/`;

      const created = await createVaultOrAdopt(transport, prefix, PASSWORD, 'aes-gcm');
      expect(created.meta.format).toBe('waifu-deck-byos');
      expect(created.meta.encryption).toBe('aes-gcm');
      expect(created.masterKey).not.toBeNull();

      // The create really was a create-only PUT that landed in the bucket.
      const raw = await transport.getObject(`${prefix}vault-meta.json`);
      expect(raw).not.toBeNull();
      expect(JSON.parse(decoder.decode(raw!.body)).vaultId).toBe(created.meta.vaultId);

      const reopened = await openExistingVault(transport, prefix, PASSWORD);
      // Same identity and salt => it adopted the stored meta rather than
      // building a fresh one, and the key-check passed against real scrypt.
      expect(reopened.meta.vaultId).toBe(created.meta.vaultId);
      expect(reopened.meta.kdf.saltB64).toBe(created.meta.kdf.saltB64);
      expect(reopened.meta.createdAt).toBe(created.meta.createdAt);
      expect(Array.from(reopened.masterKey!)).toEqual(Array.from(created.masterKey!));
    });

    test('a wrong password is refused with a wrong-password VaultMetaError', async () => {
      const prefix = `${runPrefix}vault-wrong-password/`;
      await createVaultOrAdopt(transport, prefix, PASSWORD, 'aes-gcm');

      const error = await captureError(
        openExistingVault(transport, prefix, 'not the password'),
      );
      expect(error).toBeInstanceOf(VaultMetaError);
      expect((error as VaultMetaError).code).toBe('wrong-password');

      // A refused open must not have disturbed the stored vault.
      const reopened = await openExistingVault(transport, prefix, PASSWORD);
      expect(reopened.masterKey).not.toBeNull();
    });

    test('two concurrent first-inits converge: one creates, the loser adopts its meta', async () => {
      const prefix = `${runPrefix}vault-race/`;
      const deviceB = createS3Transport(credentials);

      // Both build a candidate meta before either writes, and `buildVaultMeta`
      // draws a fresh salt and vaultId for each from `getRandomBytesAsync`
      // (P5 Task 1 mapped that to real randomness, so the two candidates
      // differ with overwhelming probability). Converging on one identity
      // therefore proves the loser really did adopt the winner's stored meta
      // off the 412, not that both built the same thing.
      const [a, b] = await Promise.all([
        createVaultOrAdopt(transport, prefix, PASSWORD, 'aes-gcm'),
        createVaultOrAdopt(deviceB, prefix, PASSWORD, 'aes-gcm'),
      ]);

      expect(b.meta.vaultId).toBe(a.meta.vaultId);
      expect(b.meta.kdf.saltB64).toBe(a.meta.kdf.saltB64);
      expect(b.meta.createdAt).toBe(a.meta.createdAt);
      expect(Array.from(b.masterKey!)).toEqual(Array.from(a.masterKey!));

      // Exactly one meta object exists, and it is the converged one.
      const stored = await transport.getObject(`${prefix}vault-meta.json`);
      expect(JSON.parse(decoder.decode(stored!.body)).vaultId).toBe(a.meta.vaultId);
    });
  });

  describe('CAS write path', () => {
    test('collect then protect writes the generation triad, meta and revision', async () => {
      const prefix = `${runPrefix}cas-protect/`;
      const client = newClient(prefix);
      const assetId = 'asset-protect';

      const collected = await client.submitMutations({ mutations: [collect(assetId)] });
      expect(collected.results[0]!.outcome).toBe('applied');
      expect(collected.results[0]!.revision).toBe(1);

      // The protect flow: three role blobs uploaded first, then one mutation
      // folds all three into `generations` (the caller-owned "blob durable
      // before state" ordering the client documents).
      const generations: LibraryAssetStateGenerations = {
        thumbnail: 'gen-thumbnail-01', preview: 'gen-preview-01', original: 'gen-original-01',
      };
      await client.putBlob(generations.thumbnail!, bytes(64, 2));
      await client.putBlob(generations.preview!, bytes(256, 3));
      await client.putBlob(generations.original!, bytes(1024, 5));

      const protect: S3LibraryPendingMutation = {
        assetId,
        kind: 'protect',
        baseRevision: 1,
        observedGeneration: 1,
        originalGenerationId: generations.original!,
        mutationId: 'm-protect',
        newBlob: null,
        generationsPatch: generations,
      };
      const protectedResult = await client.submitMutations({ mutations: [protect] });
      expect(protectedResult.results[0]!.outcome).toBe('applied');

      // Raw GET + the real codec: what a second device would actually read.
      const record = await readState(prefix, assetId);
      expect(record.revision).toBe(2);
      expect(record.generation).toBe(1);
      expect(record.lifecycle).toBe('active');
      expect(record.protection).toBe('protected');
      expect(record.lastMutationId).toBe('m-protect');
      expect(record.generations).toEqual(generations);
      // meta was supplied by collect and never re-sent by protect.
      expect(record.meta).toBe(META_ENVELOPE);

      // Every generation the record points at is really readable.
      for (const generationId of Object.values(generations)) {
        expect(await client.getObject(generationId)).not.toBeNull();
      }
    });

    test('two clients racing one asset: exactly one write lands, the loser converges', async () => {
      const prefix = `${runPrefix}cas-race/`;
      const assetId = 'asset-race';
      await newClient(prefix).submitMutations({ mutations: [collect(assetId)] });

      // A pure forwarding counter: the production client and transport are
      // untouched, but counting the state.json PUTs that actually resolved
      // pins the invariant that matters — two writers, one surviving write.
      // (Observed against MinIO: both clients do reach the PUT, and the loser
      // is refused with a real 412 before it retries. That overlap is timing,
      // not contract, so it is reported rather than asserted; the stale-ETag
      // test below forces the same path deterministically.)
      const succeeded = { a: 0, b: 0 };
      const counting = (which: 'a' | 'b'): S3LibraryTransportPort => {
        const own = createS3Transport(credentials);
        return {
          getObject: (key) => own.getObject(key),
          async putObject(key, body, options) {
            const result = await own.putObject(key, body, options);
            if (key.endsWith('state.json')) succeeded[which] += 1;
            return result;
          },
        };
      };

      const trash = (which: string): S3LibraryPendingMutation => ({
        assetId,
        kind: 'trash',
        baseRevision: 1,
        observedGeneration: 1,
        mutationId: `m-trash-${which}`,
        originalGenerationId: null,
        newBlob: null,
      });

      const [ra, rb] = await Promise.all([
        newClient(prefix, counting('a')).submitMutations({ mutations: [trash('a')] }),
        newClient(prefix, counting('b')).submitMutations({ mutations: [trash('b')] }),
      ]);

      // Both terminate as results, never as exceptions, and the decision table
      // makes the loser's outcome deterministic whichever way the race went:
      // a second trash against an already-trashed asset is `merged`.
      const results = [ra.results[0]!, rb.results[0]!];
      expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'merged']);
      expect(succeeded.a + succeeded.b).toBe(1);

      const record = await readState(prefix, assetId);
      expect(record.revision).toBe(2);
      expect(record.lifecycle).toBe('trash');
      expect(record.trashedAt).not.toBeNull();
      expect(record.lastMutationId).toBe(
        results.find((r) => r.outcome === 'applied')!.mutationId,
      );
    });

    test('a stale-ETag writer takes a real 412, re-reads, and re-decides', async () => {
      const prefix = `${runPrefix}cas-stale/`;
      const assetId = 'asset-stale';
      const client = newClient(prefix);
      await client.submitMutations({ mutations: [collect(assetId)] });

      // The race above cannot prove the retry path fired, because the loser
      // reaches the same outcome without ever writing. This one forces the
      // interleaving: B reads revision 1, A's trash lands, and only then is
      // B's CAS PUT released — so its If-Match is genuinely stale and the 412
      // comes from MinIO, not a fake.
      let releaseWrite = (): void => {};
      const mayWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
      let markRead = (): void => {};
      const didRead = new Promise<void>((resolve) => { markRead = resolve; });
      let heldWrite = false;
      const ownB = createS3Transport(credentials);
      const latchedB: S3LibraryTransportPort = {
        async getObject(key) {
          const result = await ownB.getObject(key);
          markRead();
          return result;
        },
        async putObject(key, body, options) {
          if (!heldWrite && key.endsWith('state.json')) {
            heldWrite = true;
            await mayWrite;
          }
          return ownB.putObject(key, body, options);
        },
      };

      const protect: S3LibraryPendingMutation = {
        assetId,
        kind: 'protect',
        baseRevision: 1,
        observedGeneration: 1,
        originalGenerationId: 'gen-original-stale',
        mutationId: 'm-protect-stale',
        newBlob: null,
      };
      const pendingB = newClient(prefix, latchedB)
        .submitMutations({ mutations: [protect] });

      await didRead;
      const trashed = await client.submitMutations({
        mutations: [{
          assetId,
          kind: 'trash',
          baseRevision: 1,
          observedGeneration: 1,
          mutationId: 'm-trash-winner',
          originalGenerationId: null,
          newBlob: null,
        }],
      });
      expect(trashed.results[0]!.outcome).toBe('applied');
      releaseWrite();

      const resultB = (await pendingB).results[0]!;
      // Re-read after the 412 shows a trashed asset, and protect loses to
      // trash by the decision table — resolved, not thrown.
      expect(resultB.outcome).toBe('rejected');
      expect(resultB.reason).toBe('trash_wins');

      const record = await readState(prefix, assetId);
      expect(record.revision).toBe(2);
      expect(record.lifecycle).toBe('trash');
      expect(record.protection).toBe('unprotected');
      expect(record.lastMutationId).toBe('m-trash-winner');
    });

    test('trash keeps meta, restore keeps meta, permanent-delete strips the tombstone', async () => {
      const prefix = `${runPrefix}cas-lifecycle/`;
      const assetId = 'asset-lifecycle';
      const client = newClient(prefix);
      const generationId = 'gen-original-lifecycle';

      await client.submitMutations({
        mutations: [collect(assetId, {
          newBlob: { generationId, bytes: bytes(512, 7), role: 'original' },
        })],
      });

      const trashed = await client.submitMutations({
        mutations: [{
          assetId,
          kind: 'trash',
          baseRevision: 1,
          observedGeneration: 1,
          mutationId: 'm-trash',
          originalGenerationId: null,
          newBlob: null,
        }],
      });
      expect(trashed.results[0]!.outcome).toBe('applied');
      const afterTrash = await readState(prefix, assetId);
      expect(afterTrash.lifecycle).toBe('trash');
      expect(afterTrash.trashedAt).not.toBeNull();
      expect(afterTrash.meta).toBe(META_ENVELOPE);

      const restored = await client.submitMutations({
        mutations: [{
          assetId,
          kind: 'restore',
          baseRevision: 2,
          observedGeneration: 1,
          mutationId: 'm-restore',
          originalGenerationId: null,
          newBlob: null,
        }],
      });
      expect(restored.results[0]!.outcome).toBe('applied');
      const afterRestore = await readState(prefix, assetId);
      expect(afterRestore.lifecycle).toBe('active');
      expect(afterRestore.trashedAt).toBeNull();
      // An explicit restore opens a new generation.
      expect(afterRestore.generation).toBe(2);
      // The carried-field hazard: neither trash nor restore supplies `meta`,
      // and losing it here would leave a second device unable to materialize
      // the asset it just got back.
      expect(afterRestore.meta).toBe(META_ENVELOPE);
      expect(afterRestore.generations).toEqual({ original: generationId });

      // permanent-delete is only legal from trash, so trash the new generation.
      await client.submitMutations({
        mutations: [{
          assetId,
          kind: 'trash',
          baseRevision: 3,
          observedGeneration: 2,
          mutationId: 'm-trash-again',
          originalGenerationId: null,
          newBlob: null,
        }],
      });
      const purged = await client.submitMutations({
        mutations: [{
          assetId,
          kind: 'permanent-delete',
          baseRevision: 4,
          observedGeneration: 2,
          mutationId: 'm-purge',
          originalGenerationId: null,
          newBlob: null,
        }],
      });
      expect(purged.results[0]!.outcome).toBe('applied');

      const tombstone = await readState(prefix, assetId);
      expect(tombstone.lifecycle).toBe('purged');
      expect(tombstone.protection).toBe('unprotected');
      expect(tombstone.generations).toEqual({});
      expect(tombstone.meta).toBeUndefined();
      expect('meta' in tombstone).toBe(false);

      // The tombstone is the GC signal, not the GC: the blob it used to
      // reference is still there for an opportunistic sweep to reclaim later.
      const blob = await transport.getObject(`${prefix}blobs/${generationId}`);
      expect(blob).not.toBeNull();
      expect(blob!.body.byteLength).toBe(512);
    });
  });

  describe('reconciliation port', () => {
    test('listAssetStates returns every seeded asset and getAssetState agrees', async () => {
      const prefix = `${runPrefix}reconcile/`;
      const client = newClient(prefix);
      const assetIds = ['asset-r-1', 'asset-r-2', 'asset-r-3'];

      for (const [index, assetId] of assetIds.entries()) {
        await client.submitMutations({
          mutations: [collect(assetId, {
            newBlob: {
              generationId: `gen-original-${assetId}`,
              bytes: bytes(32 + index, index + 1),
              role: 'original',
            },
          })],
        });
      }

      const port = createLibraryReconciliationPort(
        transport, prefix, createMemoryLibraryRemoteStateIndex(),
      );
      const { changed: listed, total } = await port.discoverChanges();
      expect(listed.map((record) => record.assetId).sort()).toEqual(assetIds);
      expect(total).toBe(assetIds.length);
      for (const record of listed) {
        expect(record.revision).toBe(1);
        expect(record.lifecycle).toBe('active');
        expect(record.meta).toBe(META_ENVELOPE);
        expect(record.generations).toEqual({
          original: `gen-original-${record.assetId}`,
        });
      }

      const single = await port.getAssetState(assetIds[1]!);
      expect(single).toEqual(listed.find((r) => r.assetId === assetIds[1]));
      expect(await port.getAssetState('asset-never-seeded')).toBeNull();

      // The port surfaces decoded records, which carry no `etag`/
      // `lastModified` — those live on the listing it consumes internally, so
      // that is where a real backend has to populate them for the port (and
      // the reconciler above it) to enumerate anything at all.
      const page = await transport.listObjects(`${prefix}assets/`, undefined);
      expect(page.objects).toHaveLength(assetIds.length);
      for (const object of page.objects) {
        expect(object.etag).toMatch(/^"[0-9a-f]{32}"$/);
        expect(Number.isNaN(Date.parse(object.lastModified))).toBe(false);
      }
    });
  });
});
