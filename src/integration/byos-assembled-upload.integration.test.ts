/**
 * K1 gate: the ASSEMBLED upload chain on a real S3 backend.
 *
 * Every prior BYOS gate drove submitMutations / the sync engine / the transport
 * in isolation with hand-written SQL for the collect intent, so all of them
 * passed while the device uploaded nothing: ingest derived account_scope from
 * the master key while the session port derived it from sha256(vaultId), and
 * under aes-gcm those differ. This suite builds the REAL ingest service over the
 * REAL BYOS session/account ports (aes-gcm, a random master key that is NOT
 * sha256(vaultId)) and asserts a collected image actually lands in the bucket.
 *
 * Parameterized by BYOS_IT_*; `npm run verify:byos-minio` supplies them.
 */
import { DatabaseSync } from 'node:sqlite';

import { randomUUID } from 'expo-crypto';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createVaultOrAdopt } from '@/features/byos/byos-vault-init';
import { createS3Transport } from '@/features/byos/s3-transport';
import type { S3Credentials } from '@/features/byos/s3-transport-types';
import { createLibraryActionOutbox } from '@/features/library/library-action-outbox';
import { decodeAssetState } from '@/features/library/library-asset-state-codec';
import { createByosLibraryAccountPort } from '@/features/library/library-account-port';
import { createS3LibraryCloudClient } from '@/features/library/library-cloud-client-s3';
import { createLibraryDecodeGate } from '@/features/library/library-decode-gate';
import { createLibraryFileStore } from '@/features/library/library-file-store';
import {
  deriveLibraryAccountScope,
  deriveLibraryAssetId,
  sha256PlaintextHex,
} from '@/features/library/library-identity';
import { createLibraryIngestService } from '@/features/library/library-ingest';
import { createLibraryMirrorUp } from '@/features/library/library-mirror-up';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import { createLibraryObjectCipher } from '@/features/library/library-object-crypto';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import { createLibraryReconciliationPort } from '@/features/library/library-reconciliation-port';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import { createLibraryRepository } from '@/features/library/library-repository';
import { createByosLibrarySessionPort } from '@/features/library/library-session-port';
import { readSourceMetadata } from '@/features/library/library-source-metadata';
import { createFakeLibraryFilePort, JPEG_FIXTURE, PNG_FIXTURE, GIF_FIXTURE } from '@/features/library/library-test-support';
import { libraryTransferProgress } from '@/features/library/library-transfer-progress';
import {
  createNodeBlobStaging,
  createNodeUploadFilePort,
  withNodeStreamRoot,
} from '@/test/node-file-transfer';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const endpoint = process.env.BYOS_IT_ENDPOINT ?? '';
const bucket = process.env.BYOS_IT_BUCKET ?? '';
const accessKeyId = process.env.BYOS_IT_ACCESS_KEY ?? '';
const secretAccessKey = process.env.BYOS_IT_SECRET ?? '';
const basePrefix = process.env.BYOS_IT_PREFIX ?? '';
const region = process.env.BYOS_IT_REGION ?? 'us-east-1';
const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
if (!configured) {
  console.warn('[byos-integration] Skipping assembled-upload suite: BYOS_IT_* not all set. Run `npm run verify:byos-minio`.');
}
const describeBackend = configured ? describe : describe.skip;
const credentials: S3Credentials = { endpoint, region, bucket, accessKeyId, secretAccessKey };
const PASSWORD = 'correct horse battery staple';

const workingDerived = {
  async derive() {
    return {
      thumbnail: { role: 'thumbnail' as const, bytes: new Uint8Array([11, 22, 33]), width: 8, height: 8, format: 'webp' as const },
      preview: { role: 'preview' as const, bytes: new Uint8Array([44, 55, 66, 77]), width: 16, height: 16, format: 'webp' as const },
      animated: false,
      failed: false,
    };
  },
};

/**
 * K7 ⑨: `protect` answers as soon as the ORIGINAL blob and the `[collect,
 * protect]` state write are durable, leaving the derived uploads and their one
 * follow-up state patch running behind it. Nothing in the app waits for that
 * tail, so a gate that asserts on it polls the bucket.
 */
async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describeBackend('BYOS assembled upload chain on a real backend', () => {
  async function createDevice(
    prefix: string,
    deviceId: string,
    // K7 ⑨: a suite that must observe the state.json the COMMIT wrote, before
    // the derived tail patches it, holds derivation open with its own double.
    derivedImages: { derive: (typeof workingDerived)['derive'] } = workingDerived,
  ) {
    const native = new DatabaseSync(':memory:');
    const database: SqlDatabasePort = createNodeSqliteAdapter(native);
    await migrateDatabase(database);

    // Real vault: createVaultOrAdopt runs real scrypt, so masterKey is a real
    // 32-byte key that is NOT sha256(vaultId) — the exact aes-gcm condition
    // that split the two scopes on device.
    const setupTransport = createS3Transport(credentials);
    const vault = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');

    const filePort = withNodeStreamRoot(createFakeLibraryFilePort());
    const files = createLibraryFileStore({ port: filePort });
    const session = createByosLibrarySessionPort({
      vault: { meta: vault.meta, masterKey: vault.masterKey, deviceId },
    });
    const account = createByosLibraryAccountPort(session);
    const cipher = createLibraryObjectCipher();
    // K6-2: the blob PUT now streams from a staged file so the native upload
    // task can report `bytesSent` (spec §2 G3). `expo-file-system` has no
    // native module under Node, so this gate injects the equivalent Node
    // implementation — the wire path (SigV4 over the staged file's hash, raw
    // binary body) is exactly the production one and is what this suite proves.
    const transport = createS3Transport(credentials, {
      uploadFile: createNodeUploadFilePort(),
    });
    const cloud = createS3LibraryCloudClient({
      transport,
      prefix,
      decide: decideLibraryMutation,
      blobStaging: createNodeBlobStaging(),
      transferProgress: libraryTransferProgress,
    });
    const reconciliation = createLibraryReconciliationPort(
    transport,
    prefix,
    // K7 cut 3: the durable ETag index, wired exactly as production does
    // — same repository, scope from the same session port.
    bindLibraryRemoteStateIndex(
      createLibraryRemoteStateCacheRepository({ database }),
      async () => (await session.current())?.accountScope ?? null,
    ),
  );
    const protection = createLibraryProtectionRepository({ database });
    const repository = createLibraryRepository(database);
    const outbox = createLibraryActionOutbox({ database, newMutationId: () => randomUUID() });

    const protectAction = createLibraryProtectAction({
      repository, protection, outbox, files, cipher, cloud, reconciliation, session,
      derived: derivedImages,
      readSource: (sourceImageId) => readSourceMetadata(database, sourceImageId),
      newGenerationId: () => randomUUID(),
    });

    // A decode gate that accepts the fixtures (real magic bytes) and reports a
    // fixed size; ingest still runs its real format detection + digest + seal.
    const decodeGate = createLibraryDecodeGate({
      async decode() { return { width: 320, height: 240 }; },
    });
    const ingest = createLibraryIngestService({
      files, repository, decodeGate, account, newMutationId: () => randomUUID(),
    });

    const mirrorUp = createLibraryMirrorUp({
      enrollMissing: () => ingest.enrichLocalAssetsForAccount(),
      getAccountScope: () => account.accountScope(),
      listProtectCandidates: (scope) => protection.listProtectCandidates(scope),
      protect: (digest) => protectAction.protect(digest),
    });

    const stateKeyFor = (digest: string) =>
      `${prefix}assets/${deriveLibraryAssetId(vault.masterKey!, digest)}/state.json`;

    return {
      vault, prefix, transport, protection, account, database, cloud, cipher,
      async ingestBytes(bytes: Uint8Array) {
        return ingest.ingestBytes({ bytes, origin: 'import' });
      },
      async protect(digest: string) { return protectAction.protect(digest); },
      async mirrorUp() { return mirrorUp.mirrorUp(); },
      async stateExists(digest: string) {
        return (await transport.getObject(stateKeyFor(digest))) !== null;
      },
      /** The asset's state.json as the bucket holds it right now, or null. */
      async stateOf(digest: string) {
        const object = await transport.getObject(stateKeyFor(digest));
        return object === null ? null : decodeAssetState(object.body);
      },
      async counts() { return protection.countMirrorState((await account.accountScope())!); },
      close() { native.close(); },
    };
  }

  async function listAll(
    t: ReturnType<typeof createS3Transport>,
    prefix: string,
  ): Promise<string[]> {
    let token: string | undefined;
    const keys: string[] = [];
    do {
      const page = await t.listObjects(prefix, token);
      keys.push(...page.objects.map((o) => o.key));
      token = page.nextToken;
    } while (token);
    return keys;
  }

  async function cleanup(prefix: string) {
    const t = createS3Transport(credentials);
    const keys = await listAll(t, prefix);
    await Promise.all(keys.map((k) => t.deleteObject(k).catch(() => undefined)));
  }

  it('a newly collected image uploads to the bucket (immediate protect)', async () => {
    const prefix = `${basePrefix}k1-immediate-${Date.now().toString(36)}/`;
    // Derivation is held open across the whole commit, so the state.json read
    // below cannot race the follow-up patch: what it sees is exactly what the
    // commit wrote.
    let releaseDerive!: () => void;
    const derivationHeld = new Promise<void>((resolve) => { releaseDerive = resolve; });
    const d = await createDevice(prefix, 'device-immediate', {
      async derive() {
        await derivationHeld;
        return workingDerived.derive();
      },
    });
    try {
      const digest = sha256PlaintextHex(JPEG_FIXTURE);
      const outcome = await d.ingestBytes(JPEG_FIXTURE);
      expect(outcome.status).toBe('ingested');
      // The real chain: ingest enrolled under the session scope; protect reads
      // the same scope and uploads. On HEAD this is object_missing (scope split).
      expect((await d.protect(digest)).status).toBe('applied');
      expect(await d.stateExists(digest)).toBe(true);

      // K7 ⑨, on a real backend: the FIRST state.json this asset ever has
      // already says `protected` — the orange cloud — and it references only
      // the ORIGINAL. The derived blobs are not in the bucket yet, which is
      // the whole point: the mark no longer waits for two native re-encodes,
      // two seals and two more PUTs of objects this device never reads.
      const committed = await d.stateOf(digest);
      expect(committed).toMatchObject({ lifecycle: 'active', protection: 'protected' });
      expect(committed!.generations.original).toBeTruthy();
      expect(Object.keys(committed!.generations)).toEqual(['original']);
      const blobKeys = (await listAll(d.transport, prefix))
        .filter((key) => key.startsWith(`${prefix}blobs/`));
      expect(blobKeys).toEqual([`${prefix}blobs/${committed!.generations.original}`]);

      // Then the tail lands: the two derived blobs, then ONE follow-up
      // state.json write that adds their references to the same original.
      releaseDerive();
      await waitForCondition(
        async () => Object.keys((await d.stateOf(digest))!.generations).length === 3,
        'the derived generations patch',
      );
      const settled = await d.stateOf(digest);
      expect(settled).toMatchObject({ lifecycle: 'active', protection: 'protected' });
      expect(settled!.generations.original).toBe(committed!.generations.original);
      expect(settled!.generations.thumbnail).toBeTruthy();
      expect(settled!.generations.preview).toBeTruthy();
      expect(settled!.revision).toBeGreaterThan(committed!.revision);
      // Every generation the final record names has durable bytes behind it.
      const settledBlobs = (await listAll(d.transport, prefix))
        .filter((key) => key.startsWith(`${prefix}blobs/`));
      for (const generationId of Object.values(settled!.generations)) {
        expect(settledBlobs).toContain(`${prefix}blobs/${generationId}`);
      }
    } finally {
      releaseDerive();
      d.close();
      await cleanup(prefix);
    }
  }, 120_000);

  it('backfills local assets stranded in the old scope, tolerating the orphan rows (spec \u00a76 A.4)', async () => {
    // This is the real phone's state, not a clean slate. On HEAD, ingest wrote
    // every collect intent and enrolment under `deriveLibraryAccountScope(
    // masterKey)` while protect/sync read `session.accountScope`, so the device
    // ended up with: rows under a WRONG scope, nothing under the session scope,
    // and a `failed/object_missing` protection row from each doomed attempt.
    //
    // Ingesting under the fixed code and then MOVING the rows to the wrong
    // scope reproduces that exactly. It also makes enrolment load-bearing:
    // `listProtectCandidates` reads `device_library_assets` (scope-free) so the
    // three digests are candidates either way, but protect's `ensureCollected`
    // only READS a collect intent — with none under the session scope every
    // lane fails `object_missing`. Building the vault before ingest (as the
    // other cases do) would leave ingest's own enrolment in place and the
    // assertion would hold with `enrollMissing()` deleted.
    const prefix = `${basePrefix}k1-backfill-${Date.now().toString(36)}/`;
    const d = await createDevice(prefix, 'device-backfill');
    try {
      const fixtures = [JPEG_FIXTURE, PNG_FIXTURE, GIF_FIXTURE];
      const digests = fixtures.map((f) => sha256PlaintextHex(f));
      for (const f of fixtures) expect((await d.ingestBytes(f)).status).toBe('ingested');

      const sessionScope = (await d.account.accountScope())!;
      const wrongScope = deriveLibraryAccountScope(d.vault.masterKey!);
      // The whole root cause in one assertion: under aes-gcm the two formulas
      // disagree. If they ever matched, this case would prove nothing.
      expect(wrongScope).not.toBe(sessionScope);

      const moved = await d.database.run(
        'UPDATE library_account_assets SET account_scope = ? WHERE account_scope = ?',
        [wrongScope, sessionScope],
      );
      expect(moved.changes).toBe(3);
      const movedOutbox = await d.database.run(
        'UPDATE library_outbox SET account_scope = ? WHERE account_scope = ?',
        [wrongScope, sessionScope],
      );
      expect(movedOutbox.changes).toBe(3);
      // The leftover the phone actually carries: one failed protection attempt
      // recorded under the session scope while the intent sat in the other one.
      await d.database.run(
        `INSERT INTO library_asset_protection (
           account_scope, asset_id, plaintext_sha256, lifecycle, protection,
           generation, revision, original_generation_id,
           original_ciphertext_bytes, verified_at, failure_category,
           trashed_at, updated_at
         ) VALUES (?, ?, ?, 'active', 'failed', 1, NULL, NULL, NULL, NULL,
                   'object_missing', NULL, ?)`,
        [
          sessionScope,
          deriveLibraryAssetId(d.vault.masterKey!, digests[0]!),
          digests[0]!,
          Date.now(),
        ],
      );

      const result = await d.mirrorUp();
      expect(result).toEqual({ total: 3, done: 3, failed: 0 });
      for (const digest of digests) expect(await d.stateExists(digest)).toBe(true);
      const counts = await d.counts();
      expect(counts.backedUp).toBe(counts.backedUpTotal);
      expect(counts.backedUpTotal).toBe(3);

      // Spec \u00a76 A.4: the orphan rows are invisible to the correct scope and
      // are neither read nor rewritten. A 'fix' that migrated them would also
      // make this suite pass, so pin that they are untouched.
      const orphanOutbox = await d.database.getFirst<{ n: number }>(
        "SELECT COUNT(*) AS n FROM library_outbox WHERE account_scope = ?",
        [wrongScope],
      );
      expect(orphanOutbox?.n).toBe(3);
      const orphanAssets = await d.database.getFirst<{ n: number }>(
        'SELECT COUNT(*) AS n FROM library_account_assets WHERE account_scope = ?',
        [wrongScope],
      );
      expect(orphanAssets?.n).toBe(3);

      // Spec \u00a72: three encrypted blobs per asset (original + thumbnail +
      // preview), not the original alone. `workingDerived` returns both derived
      // roles deterministically, and protect swallows a derived failure, so
      // without this the gate cannot tell a full triad from an original-only
      // upload.
      // K7 ⑨: the derived roles land behind each protect's answer, so wait for
      // the tails before counting. Three assets x three roles is unchanged.
      await waitForCondition(
        async () => (await listAll(d.transport, prefix))
          .filter((k) => k.startsWith(`${prefix}blobs/`)).length === 9,
        'all nine role blobs',
      );
      const keys = await listAll(d.transport, prefix);
      expect(keys.filter((k) => k.startsWith(`${prefix}blobs/`))).toHaveLength(9);
    } finally {
      d.close();
      await cleanup(prefix);
    }
  }, 120_000);

  it('the staged-file upload puts the SAME bytes in the bucket as the in-memory PUT', async () => {
    // K6-2 (spec §2 G3). The percentage ring only exists because blob PUTs moved
    // off `expo/fetch` (no upload-progress event) onto a file-backed upload
    // task. That is a new write path to the user's only copy of their library,
    // so the gate that matters is byte identity: what the staged file put in
    // the bucket must decrypt to exactly the image that was collected, and must
    // be indistinguishable from what the in-memory PUT would have written.
    const prefix = `${basePrefix}k6-2-identity-${Date.now().toString(36)}/`;
    const d = await createDevice(prefix, 'device-identity');
    try {
      const digest = sha256PlaintextHex(JPEG_FIXTURE);
      expect((await d.ingestBytes(JPEG_FIXTURE)).status).toBe('ingested');
      expect((await d.protect(digest)).status).toBe('applied');

      const assetId = deriveLibraryAssetId(d.vault.masterKey!, digest);
      const row = await d.protection.findByAssetId(
        (await d.account.accountScope())!,
        assetId,
      );
      expect(row?.originalGenerationId).toBeTruthy();

      // 1. Round-trip through the real backend: the ciphertext the staged file
      //    uploaded opens with this device's key and hashes back to the exact
      //    plaintext digest ingest computed. A body mangled by the upload task
      //    (multipart framing, a truncated stream, a text encoding) could not.
      const ciphertext = await d.cloud.getObject(row!.originalGenerationId!);
      expect(ciphertext).not.toBeNull();
      const plaintext = await d.cipher.open({
        masterKey: d.vault.masterKey!,
        assetId,
        scope: 'original',
        envelope: ciphertext!,
      });
      expect(sha256PlaintextHex(plaintext)).toBe(digest);
      expect(Array.from(plaintext)).toEqual(Array.from(JPEG_FIXTURE));

      // 2. Same bytes, other path: PUT the very same ciphertext with the
      //    in-memory `putObject` and read it back. Byte-for-byte equality is
      //    what proves the two write paths are interchangeable on the wire.
      const probeKey = `${prefix}blobs/k6-2-probe`;
      await d.transport.putObject(probeKey, ciphertext!, {});
      const probe = await d.transport.getObject(probeKey);
      expect(probe).not.toBeNull();
      expect(Array.from(probe!.body)).toEqual(Array.from(ciphertext!));
    } finally {
      d.close();
      await cleanup(prefix);
    }
  }, 120_000);

  it('a second mirror-up cycle uploads nothing new (idempotent)', async () => {
    const prefix = `${basePrefix}k1-idem-${Date.now().toString(36)}/`;
    const d = await createDevice(prefix, 'device-idem');
    try {
      await d.ingestBytes(JPEG_FIXTURE);
      await d.mirrorUp();
      // K7 ⑨: snapshot only once the first cycle's derived tail has finished,
      // or "nothing new" would be measured against a half-written bucket.
      await waitForCondition(
        async () => (await listAll(d.transport, prefix))
          .filter((k) => k.startsWith(`${prefix}blobs/`)).length === 3,
        'the derived tail of the first cycle',
      );
      let token: string | undefined;
      const before: string[] = [];
      do { const p = await d.transport.listObjects(prefix, token); before.push(...p.objects.map((o) => o.key)); token = p.nextToken; } while (token);
      const second = await d.mirrorUp();
      expect(second.failed).toBe(0);
      let t2: string | undefined; const after: string[] = [];
      do { const p = await d.transport.listObjects(prefix, t2); after.push(...p.objects.map((o) => o.key)); t2 = p.nextToken; } while (t2);
      expect(after.sort()).toEqual(before.sort());
    } finally {
      d.close();
      await cleanup(prefix);
    }
  }, 120_000);
});
