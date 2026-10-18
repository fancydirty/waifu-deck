/**
 * End-to-end BYOS encryption against a real S3-compatible backend.
 *
 * The transport suite proves SigV4 on the wire and the protocol suite proves
 * the CAS/tombstone/reconciliation layer; both treat `state.json.meta` as an
 * opaque placeholder because P3C decision #9 mapped `expo-crypto` to the
 * deterministic double. P5 Task 1 lifts that boundary: `expo-crypto` is now
 * the real AES-256-GCM shim over Node WebCrypto (see
 * `src/test/expo-crypto-real.ts` for the combined-layout citations proving it
 * is byte-compatible with the native module), so this suite runs the real
 * production ciphers over real MinIO and asserts what only that combination
 * can show — that bytes sealed on one device come back byte-identical on
 * another, that they are genuinely unreadable in between, and that a wrong
 * password is distinguishable from a corrupted object.
 *
 * Everything here is production code: `createVaultOrAdopt` (real scrypt, already
 * genuine via `@noble/hashes`), `createLibraryObjectCipher`,
 * `createPassthroughLibraryCipher`, `createS3LibraryCloudClient`,
 * `createLibraryReconciliationPort` and the asset-state codec. The only test
 * scaffolding is the BYOS_IT_* environment and the per-run prefix.
 */
import { deriveVaultKey } from '@/features/byos/byos-keys';
import { createVaultOrAdopt } from '@/features/byos/byos-vault-init';
import { VaultMetaError } from '@/features/byos/byos-vault-meta';
import { createS3Transport } from '@/features/byos/s3-transport';
import type { S3Credentials } from '@/features/byos/s3-transport-types';
import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import type { LibraryAssetStateGenerations } from '@/features/library/library-asset-state-codec';
import {
  createS3LibraryCloudClient,
  type S3LibraryPendingMutation,
} from '@/features/library/library-cloud-client-s3';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import {
  LIBRARY_OBJECT_ENVELOPE_MAGIC,
  createLibraryObjectCipher,
} from '@/features/library/library-object-crypto';
import { createPassthroughLibraryCipher } from '@/features/library/library-passthrough-cipher';
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
    '[byos-integration] Skipping the encrypted round-trip suite: '
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
const runPrefix = `${basePrefix}crypt-${Date.now().toString(36)}/`;

const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'incorrect horse battery staple';

/** The cipher's `assertAssetId` requires 64 lowercase hex characters. */
const assetIdOf = (seed: string): string => seed.padEnd(64, '0').slice(0, 64);

/** Stands in for a collected image: incompressible enough to be recognisable. */
const imageBytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed * 37 + i * 11 + (i % 7) * 53) % 256);

const metadataOf = (byteSize: number): LibraryEncryptedMetadata => ({
  version: 1,
  plaintextSha256: 'a'.repeat(64),
  format: 'png',
  canonicalExtension: 'png',
  byteSize,
  width: 512,
  height: 768,
  origin: 'provider',
  sourceImageId: 4242,
  collectedAt: 1756512000000,
  tags: ['blue-archive', 'solo'],
});

describeBackend('BYOS encrypted round-trip against a real S3-compatible backend', () => {
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

  /**
   * A distinct "device": its own transport instance (own connection state and
   * signer) and its own cloud client, sharing only the bucket.
   */
  function newDevice(prefix: string) {
    const deviceTransport = createS3Transport(credentials);
    return {
      transport: deviceTransport,
      client: createS3LibraryCloudClient({
        transport: deviceTransport, prefix, decide: decideLibraryMutation,
      }),
      reconciliation: createLibraryReconciliationPort(
        deviceTransport, prefix, createMemoryLibraryRemoteStateIndex(),
      ),
    };
  }

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

  test('an aes-gcm vault round-trips image bytes and metadata to a second device', async () => {
    const prefix = `${runPrefix}encrypted-roundtrip/`;
    const assetId = assetIdOf('e1');
    const generationId = 'gen-original-encrypted-01';
    const plaintext = imageBytes(4096, 3);
    const metadata = metadataOf(plaintext.byteLength);

    // --- Device A: create the vault, seal, upload -------------------------
    const deviceA = newDevice(prefix);
    const vaultA = await createVaultOrAdopt(deviceA.transport, prefix, PASSWORD, 'aes-gcm');
    expect(vaultA.meta.encryption).toBe('aes-gcm');
    expect(vaultA.masterKey).not.toBeNull();

    const cipherA = createLibraryObjectCipher();
    const sealedMeta = await cipherA.sealMetadata({
      masterKey: vaultA.masterKey!, assetId, metadata,
    });
    const envelope = await cipherA.seal({
      masterKey: vaultA.masterKey!, assetId, scope: 'original', plaintext,
    });

    // The envelope is MAGIC || wrapped data key (12 IV + 32 key + 16 tag) ||
    // payload (12 IV + n + 16 tag). `seal` itself asserts the 60-byte wrap, so
    // a shim whose combined layout disagreed with the native module could not
    // even reach this line.
    expect(envelope.byteLength).toBe(8 + 60 + 12 + plaintext.byteLength + 16);

    await deviceA.client.putBlob(generationId, envelope);
    const collected = await deviceA.client.submitMutations({
      mutations: [{
        assetId,
        kind: 'collect',
        baseRevision: null,
        observedGeneration: null,
        originalGenerationId: null,
        mutationId: 'm-collect-encrypted',
        newBlob: null,
        meta: sealedMeta,
      }],
    });
    expect(collected.results[0]!.outcome).toBe('applied');

    const generations: LibraryAssetStateGenerations = { original: generationId };
    const protect: S3LibraryPendingMutation = {
      assetId,
      kind: 'protect',
      baseRevision: 1,
      observedGeneration: 1,
      originalGenerationId: generationId,
      mutationId: 'm-protect-encrypted',
      newBlob: null,
      generationsPatch: generations,
    };
    expect((await deviceA.client.submitMutations({ mutations: [protect] }))
      .results[0]!.outcome).toBe('applied');

    // --- What actually sits in the bucket is ciphertext -------------------
    const stored = await transport.getObject(`${prefix}blobs/${generationId}`);
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored!.body.slice(0, 8)))
      .toBe(LIBRARY_OBJECT_ENVELOPE_MAGIC);
    // Past the magic, nothing resembles the plaintext: a passthrough
    // regression that shipped raw image bytes would fail here.
    expect(Array.from(stored!.body.slice(8, 8 + plaintext.byteLength)))
      .not.toEqual(Array.from(plaintext.slice(0, plaintext.byteLength)));

    // --- Device B: independent instances, same password -------------------
    const deviceB = newDevice(prefix);
    const vaultB = await openExistingVault(deviceB.transport, prefix, PASSWORD);
    // Adopted, not rebuilt: same identity, and scrypt re-derived the same key.
    expect(vaultB.meta.vaultId).toBe(vaultA.meta.vaultId);
    expect(Array.from(vaultB.masterKey!)).toEqual(Array.from(vaultA.masterKey!));

    const { changed: listed } = await deviceB.reconciliation.discoverChanges();
    expect(listed.map((record) => record.assetId)).toEqual([assetId]);
    const record = listed[0]!;
    expect(record.protection).toBe('protected');
    expect(record.generations).toEqual(generations);

    const cipherB = createLibraryObjectCipher();
    expect(await cipherB.openMetadata({
      masterKey: vaultB.masterKey!, assetId, sealed: record.meta!,
    })).toEqual(metadata);

    const downloaded = await deviceB.client.getObject(record.generations.original!);
    expect(downloaded).not.toBeNull();
    const opened = await cipherB.open({
      masterKey: vaultB.masterKey!, assetId, scope: 'original', envelope: downloaded!,
    });
    expect(Array.from(opened)).toEqual(Array.from(plaintext));
  });

  test('a wrong password is a keyCheck refusal, a damaged object is a decrypt failure', async () => {
    const prefix = `${runPrefix}wrong-password-vs-corruption/`;
    const assetId = assetIdOf('e2');
    const plaintext = imageBytes(512, 11);

    const vault = await createVaultOrAdopt(transport, prefix, PASSWORD, 'aes-gcm');
    const cipher = createLibraryObjectCipher();
    const envelope = await cipher.seal({
      masterKey: vault.masterKey!, assetId, scope: 'original', plaintext,
    });

    // 1. Wrong password, normal path: the vault's key-check rejects it before
    //    any object is touched, with the code the connect UI branches on.
    const refusal = await captureError(
      openExistingVault(transport, prefix, WRONG_PASSWORD),
    );
    expect(refusal).toBeInstanceOf(VaultMetaError);
    expect((refusal as VaultMetaError).code).toBe('wrong-password');

    // 2. Wrong password, key-check bypassed: a key really derived from the
    //    wrong password reaches AES-GCM and fails authentication instead. It
    //    must NOT masquerade as the wrong-password refusal above — that is the
    //    distinction the "unrecoverable password" messaging rests on.
    const wrongKey = await deriveVaultKey(
      WRONG_PASSWORD,
      Uint8Array.from(Buffer.from(vault.meta.kdf.saltB64, 'base64')),
      { N: vault.meta.kdf.N, r: vault.meta.kdf.r, p: vault.meta.kdf.p },
    );
    expect(Array.from(wrongKey)).not.toEqual(Array.from(vault.masterKey!));
    const authFailure = await captureError(
      cipher.open({ masterKey: wrongKey, assetId, scope: 'original', envelope }),
    );
    expect(authFailure).not.toBeInstanceOf(VaultMetaError);
    expect((authFailure as { code?: string }).code).not.toBe('wrong-password');

    // 3. Right key, damaged ciphertext: also a decrypt failure, never silent
    //    plaintext. Flip one byte inside the payload ciphertext.
    const damaged = Uint8Array.from(envelope);
    const payloadStart = 8 + 60 + 12;
    damaged[payloadStart + 5] = damaged[payloadStart + 5]! ^ 0xff;
    const damagedFailure = await captureError(
      cipher.open({
        masterKey: vault.masterKey!, assetId, scope: 'original', envelope: damaged,
      }),
    );
    expect(damagedFailure).not.toBeInstanceOf(VaultMetaError);

    // 4. Structural damage is reported by the envelope reader itself, with
    //    messages that do not depend on the crypto backend.
    const foreign = Uint8Array.from(envelope);
    foreign[0] = foreign[0]! ^ 0xff;
    await expect(cipher.open({
      masterKey: vault.masterKey!, assetId, scope: 'original', envelope: foreign,
    })).rejects.toThrow('Unsupported library object envelope.');

    await expect(cipher.open({
      masterKey: vault.masterKey!,
      assetId,
      scope: 'original',
      envelope: envelope.slice(0, 8 + 60 + 12 + 16 - 1),
    })).rejects.toThrow('Library object envelope is truncated or oversized.');

    // 5. The correct password still opens everything: none of the failures
    //    above disturbed the vault or the sealed bytes.
    const reopened = await openExistingVault(transport, prefix, PASSWORD);
    expect(Array.from(await cipher.open({
      masterKey: reopened.masterKey!, assetId, scope: 'original', envelope,
    }))).toEqual(Array.from(plaintext));
  });

  test("a 'none' vault round-trips the same flow with the passthrough cipher", async () => {
    const prefix = `${runPrefix}passthrough-roundtrip/`;
    const assetId = assetIdOf('e3');
    const generationId = 'gen-original-passthrough-01';
    const plaintext = imageBytes(1024, 23);
    const metadata = metadataOf(plaintext.byteLength);

    const deviceA = newDevice(prefix);
    const vaultA = await createVaultOrAdopt(deviceA.transport, prefix, null, 'none');
    expect(vaultA.meta.encryption).toBe('none');
    expect(vaultA.masterKey).toBeNull();

    // The passthrough cipher ignores masterKey by contract, so a `'none'`
    // session's pseudo key is never needed to exercise it.
    const pseudoKey = new Uint8Array(32);
    const cipherA = createPassthroughLibraryCipher();
    const sealedMeta = await cipherA.sealMetadata({
      masterKey: pseudoKey, assetId, metadata,
    });
    const envelope = await cipherA.seal({
      masterKey: pseudoKey, assetId, scope: 'original', plaintext,
    });
    // Passthrough really is the identity on object bytes.
    expect(Array.from(envelope)).toEqual(Array.from(plaintext));

    await deviceA.client.putBlob(generationId, envelope);
    const collected = await deviceA.client.submitMutations({
      mutations: [{
        assetId,
        kind: 'collect',
        baseRevision: null,
        observedGeneration: null,
        originalGenerationId: null,
        mutationId: 'm-collect-passthrough',
        newBlob: null,
        meta: sealedMeta,
      }],
    });
    expect(collected.results[0]!.outcome).toBe('applied');
    expect((await deviceA.client.submitMutations({
      mutations: [{
        assetId,
        kind: 'protect',
        baseRevision: 1,
        observedGeneration: 1,
        originalGenerationId: generationId,
        mutationId: 'm-protect-passthrough',
        newBlob: null,
        generationsPatch: { original: generationId },
      }],
    })).results[0]!.outcome).toBe('applied');

    // Second device: no password, adopts the `'none'` vault, reads it back.
    const deviceB = newDevice(prefix);
    const vaultB = await openExistingVault(deviceB.transport, prefix, null);
    expect(vaultB.meta.vaultId).toBe(vaultA.meta.vaultId);
    expect(vaultB.masterKey).toBeNull();

    const { changed: listed } = await deviceB.reconciliation.discoverChanges();
    expect(listed.map((r) => r.assetId)).toEqual([assetId]);
    const cipherB = createPassthroughLibraryCipher();
    expect(await cipherB.openMetadata({
      masterKey: pseudoKey, assetId, sealed: listed[0]!.meta!,
    })).toEqual(metadata);

    const downloaded = await deviceB.client.getObject(generationId);
    expect(Array.from(await cipherB.open({
      masterKey: pseudoKey, assetId, scope: 'original', envelope: downloaded!,
    }))).toEqual(Array.from(plaintext));
  });
});
