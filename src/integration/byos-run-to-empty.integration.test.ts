/**
 * K4 Task T6 (spec `2026-09-12-byos-k4-seamless-sync-design.md` §6 E18): the
 * `runToEmpty` loop (`library-sync-run-to-empty.ts`) driving the real
 * `mirrorUp`/`mirrorDown` pools against real MinIO, over one device with a
 * mixed workload — local originals it still owes the cloud AND cloud-only
 * originals the cloud already owes it — proving the whole seamless-sync
 * round (§4.2/§4.7) converges without any button press.
 *
 * This is a narrower composition than `byos-two-device.integration.test.ts`:
 * it wires the same production factories that file's `createDevice` does
 * (session port + S3 transport + cloud client + reconciliation + protect/
 * local actions + sync engine), but adds the mirror layer
 * (`createLibraryMirrorUp`/`createLibraryMirrorDown`) on top and exposes it,
 * which that file's `Device` type does not. Kept as its own harness rather
 * than extending the shared one so this suite's device composition (and any
 * future changes to it) never risks the other suite's already-green cases.
 *
 * Scenario: device A ingests 25 local assets WITHOUT protecting them —
 * simulating pre-binding collections whose `collect` intent already exists
 * but has never been protected. Device B, sharing the same vault/bucket, has
 * already protected 25 DIFFERENT assets. Once A has reconciled B's state (one
 * `sync()`, exactly as production's trigger does before driving the loop —
 * `round()` itself never calls `sync()`, see
 * `library-integration-impl.ts:349-361`), A owes the cloud 25 uploads
 * and the cloud owes A 25 downloads. `round()` lists every candidate with no
 * pagination (`listProtectCandidates`/`listDownloadCandidates`), so a single
 * pool pass drains both sides in round 1; `runToEmpty` still needs a second,
 * empty round to confirm nothing is left before it reports `clean`.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { randomUUID } from 'expo-crypto';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createVaultOrAdopt } from '@/features/byos/byos-vault-init';
import type { VaultMeta } from '@/features/byos/byos-vault-meta';
import { createS3Transport } from '@/features/byos/s3-transport';
import type { S3Credentials } from '@/features/byos/s3-transport-types';
import { createLibraryActionOutbox } from '@/features/library/library-action-outbox';
import { createLibraryLocalActions } from '@/features/library/library-local-actions';
import { createJsFileDecryptor } from '@/features/library/library-file-decryptor';
import type { LibraryMirrorCounts } from '@/features/library/library-protection-repository';
import { createS3LibraryCloudClient } from '@/features/library/library-cloud-client-s3';
import { createLibraryDeviceTrashSweep } from '@/features/library/library-device-trash-sweep';
import { createLibraryFileStore } from '@/features/library/library-file-store';
import { deriveLibraryAssetId, sha256PlaintextHex } from '@/features/library/library-identity';
import { createLibraryMirrorDown } from '@/features/library/library-mirror-down';
import { createLibraryMirrorUp } from '@/features/library/library-mirror-up';
import { createLibraryObjectCipher } from '@/features/library/library-object-crypto';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import { readSourceMetadata } from '@/features/library/library-source-metadata';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import { createLibraryReconciliationPort } from '@/features/library/library-reconciliation-port';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import { createLibraryRepository } from '@/features/library/library-repository';
import { createByosLibrarySessionPort } from '@/features/library/library-session-port';
import { createLibrarySyncApplyWriter } from '@/features/library/library-sync-apply';
import { createLibrarySyncCursorStore } from '@/features/library/library-sync-cursors';
import {
  createLibrarySyncEngine,
  type LibrarySyncController,
} from '@/features/library/library-sync-engine';
import { createLibrarySyncOutbox } from '@/features/library/library-sync-outbox';
import {
  createTransferCoalescer,
  type LibraryRoleFetch,
} from '@/features/library/library-transfer-coalescer';
import { createLibrarySyncReconciler } from '@/features/library/library-sync-reconciler';
import { runToEmpty, type SyncRoundResult } from '@/features/library/library-sync-run-to-empty';
import type { TransferPoolResult } from '@/features/library/library-transfer-pool';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';
import { createNodeDownloadFilePort, withNodeStreamRoot } from '@/test/node-file-transfer';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';
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
    '[byos-integration] Skipping the run-to-empty suite: '
    + 'BYOS_IT_ENDPOINT/BYOS_IT_BUCKET/BYOS_IT_ACCESS_KEY/BYOS_IT_SECRET are '
    + 'not all set. Run `npm run verify:byos-minio` to start a throwaway MinIO '
    + 'container and run this gate against it.',
  );
}

const describeBackend = configured ? describe : describe.skip;

const credentials: S3Credentials = {
  endpoint, region, bucket, accessKeyId, secretAccessKey,
};

const PASSWORD = 'correct horse battery staple';

/**
 * Stands in for a collected image: incompressible enough to be recognisable.
 * SHA-256 counter mode, not a linear or LCG-based generator -- both alias:
 * a linear `f(seed, i) mod 256` collides whenever two seeds differ by a
 * multiple of 256, and a classic 32-bit LCG's low byte has period <= 256
 * regardless of seed or multiplier (low-order bits of a power-of-2-modulus
 * LCG are the weakest part of its state). This suite caught both: seeds
 * 1000/1024 collided under the first, then again under the second. A real
 * hash has no such structure to alias on.
 */
const imageBytes = (length: number, seed: number): Uint8Array => {
  const out = new Uint8Array(length);
  let offset = 0;
  let counter = 0;
  while (offset < length) {
    const digest = createHash('sha256').update(`${seed}:${counter}`).digest();
    const n = Math.min(digest.length, length - offset);
    out.set(digest.subarray(0, n), offset);
    offset += n;
    counter += 1;
  }
  return out;
};

/** A working derived-image double is not needed: this suite never asserts on thumbnails. */
const failingDerived = { async derive(): Promise<never> { throw new Error('no derived in this gate'); } };

type DeviceInput = Readonly<{
  name: string;
  deviceId: string;
  meta: VaultMeta;
  masterKey: Uint8Array | null;
  prefix: string;
}>;

type Device = {
  readonly name: string;
  /**
   * The durable local state SP6 ingest leaves for one collected image: local
   * original bytes, its `device_library_assets` row, its account enrolment,
   * and one `collect` outbox intent — WITHOUT protecting it. Mirrors
   * `byos-two-device.integration.test.ts`'s `ingest`.
   */
  ingest(digest: string, bytes: Uint8Array): Promise<void>;
  protect(digest: string): Promise<{ status: string }>;
  sync(): ReturnType<LibrarySyncController['sync']>;
  /** K4 §4.2/§4.7: `library-integration-impl.ts`'s `round()`, verbatim shape. */
  round(): Promise<SyncRoundResult>;
  readMirrorCounts(): Promise<LibraryMirrorCounts>;
  close(): void;
};

async function createDevice(input: DeviceInput): Promise<Device> {
  const native = new DatabaseSync(':memory:');
  const database: SqlDatabasePort = createNodeSqliteAdapter(native);
  await migrateDatabase(database);

  const { prefix } = input;
  const cipher = createLibraryObjectCipher();
  const filePort = withNodeStreamRoot(createFakeLibraryFilePort());
  const files = createLibraryFileStore({ port: filePort });

  const session = createByosLibrarySessionPort({
    vault: { meta: input.meta, masterKey: input.masterKey, deviceId: input.deviceId },
  });

  const transport = createS3Transport(credentials, {
    downloadFile: createNodeDownloadFilePort(),
  });
  const cloud = createS3LibraryCloudClient({ transport, prefix, decide: decideLibraryMutation });
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
  const actionOutbox = createLibraryActionOutbox({ database, newMutationId: () => randomUUID() });

  const protectAction = createLibraryProtectAction({
    repository, protection, outbox: actionOutbox, files, cipher, cloud,
    reconciliation, session,
    derived: failingDerived,
    readSource: (sourceImageId) => readSourceMetadata(database, sourceImageId),
    newGenerationId: () => randomUUID(),
  });
  const localActions = createLibraryLocalActions({
    repository,
    protection,
    outbox: actionOutbox,
    files,
    cipher,
    decryptor: createJsFileDecryptor(cipher, filePort),
    cloud,
    session,
    transferCoalescer: createTransferCoalescer<LibraryRoleFetch>(),
  });

  const engine = createLibrarySyncEngine({
    session,
    cloud,
    reconciliation,
    cipher,
    database,
    cursors: createLibrarySyncCursorStore({ database }),
    apply: createLibrarySyncApplyWriter({
      database,
      cipher,
      restoreImage: async () => {
        throw new Error('this suite never restores a provider collection');
      },
    }),
    reconciler: createLibrarySyncReconciler({ database, protection, files }),
    outbox: createLibrarySyncOutbox({ database, newMutationId: () => randomUUID() }),
    pipelines: {
      retryProtect: async (digest) => { await protectAction.protect(digest); },
    },
    sweep: createLibraryDeviceTrashSweep({ database, protection, files: filePort }),
  });

  // K4 §4.2/§4.7: the same round shape `library-integration-impl.ts`
  // assembles — enrol (no-op here: `ingest` below already writes the collect
  // intent directly, exactly as the two-device harness's `ingest` does) then
  // upload, best-effort, then download.
  const mirrorUp = createLibraryMirrorUp({
    enrollMissing: async () => undefined,
    getAccountScope: async () => (await session.current())?.accountScope ?? null,
    listProtectCandidates: (scope) => protection.listProtectCandidates(scope),
    protect: (digest) => protectAction.protect(digest),
  });
  const mirrorDown = createLibraryMirrorDown({
    getAccountScope: async () => (await session.current())?.accountScope ?? null,
    listDownloadCandidates: (scope) => protection.listDownloadCandidates(scope),
    download: (digest) => localActions.download(digest),
  });
  const round: Device['round'] = async () => {
    let up: TransferPoolResult = { total: 0, done: 0, failed: 0 };
    try {
      up = await mirrorUp.mirrorUp();
    } catch {
      // Best effort, matching `library-integration-impl.ts`'s
      // `round()`: an upload-side failure must not cost this round its
      // download pass.
    }
    const down = await mirrorDown.mirrorDown();
    expect(await filePort.listStream()).toEqual([]);
    return { up, down };
  };

  const ctx = async () => {
    const c = await session.current();
    if (c === null) throw new Error('no session');
    return c;
  };

  const ingest: Device['ingest'] = async (digest, bytes) => {
    const context = await ctx();
    const assetId = deriveLibraryAssetId(context.masterKey, digest);
    const uri = filePort.resolveOriginal(`${digest}.jpg`);
    filePort.files.set(uri, Uint8Array.from(bytes));
    const at = Date.now();
    await database.run(
      `INSERT INTO device_library_assets (
         plaintext_sha256, format, canonical_extension, byte_size, width, height,
         origin, source_image_id, local_original_uri, residency, protect_eligible,
         missing_original_since, created_at, updated_at
       ) VALUES (?, 'jpeg', 'jpg', ?, 64, 64, 'import', NULL, ?,
         'local-original', 1, NULL, ?, ?)
       ON CONFLICT(plaintext_sha256) DO UPDATE SET
         local_original_uri = excluded.local_original_uri,
         residency = 'local-original', missing_original_since = NULL,
         updated_at = excluded.updated_at`,
      [digest, bytes.byteLength, uri, at, at],
    );
    await database.run(
      `INSERT INTO library_account_assets (
         account_scope, asset_id, plaintext_sha256, device_id, enrolled_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_scope, asset_id) DO NOTHING`,
      [context.accountScope, assetId, digest, context.deviceId, at, at],
    );
    await database.run(
      `INSERT INTO library_outbox (
         mutation_id, account_scope, device_id, asset_id, kind, base_revision,
         observed_generation, state, attempt_count, next_attempt_at,
         last_error_code, local_metadata_json, encrypted_payload,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'collect', NULL, NULL, 'pending', 0, NULL, NULL,
         ?, NULL, ?, ?)
       ON CONFLICT(account_scope, kind, asset_id) DO NOTHING`,
      [
        randomUUID(), context.accountScope, context.deviceId, assetId,
        JSON.stringify({
          assetId, plaintextSha256: digest, format: 'jpeg', byteSize: bytes.byteLength,
          width: 64, height: 64, origin: 'import', sourceImageId: null, collectedAt: at,
        }),
        at, at,
      ],
    );
  };

  const readMirrorCounts: Device['readMirrorCounts'] = async () => {
    const context = await session.current();
    const scope = context?.accountScope ?? null;
    if (scope === null) return {
      backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0, inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: 0,
    };
    return protection.countMirrorState(scope);
  };

  return {
    name: input.name,
    ingest,
    protect: (digest) => protectAction.protect(digest),
    sync: () => engine.sync(),
    round,
    readMirrorCounts,
    close() { native.close(); },
  };
}

/** One prefix per run, one sub-prefix per case: cases never see each other. */
const runPrefix = `${basePrefix}runtoempty-${Date.now().toString(36)}/`;

describeBackend('BYOS run-to-empty against real MinIO (K4 E18)', () => {
  const cleanupTransport = createS3Transport(credentials);

  async function listObjectKeys(prefix: string): Promise<readonly string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await cleanupTransport.listObjects(prefix, token);
      for (const object of page.objects) keys.push(object.key);
      token = page.nextToken;
    } while (token !== undefined);
    return keys;
  }

  async function cleanup(prefix: string): Promise<void> {
    const keys = await listObjectKeys(prefix);
    await Promise.all(
      keys.map((key) => cleanupTransport.deleteObject(key).catch(() => undefined)),
    );
  }

  test(
    'device A drains 25 pending uploads and 25 cloud-only downloads to a clean '
    + 'state in exactly two rounds (round 1 does the transfers, round 2 confirms empty)',
    async () => {
      const prefix = `${runPrefix}case/`;
      const setupTransport = createS3Transport(credentials);
      const vaultA = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');
      const vaultB = await openExistingVault(setupTransport, prefix, PASSWORD);
      expect(vaultB.meta.vaultId).toBe(vaultA.meta.vaultId);

      const a = await createDevice({
        name: 'A', deviceId: 'device-a', meta: vaultA.meta, masterKey: vaultA.masterKey, prefix,
      });
      const b = await createDevice({
        name: 'B', deviceId: 'device-b', meta: vaultB.meta, masterKey: vaultB.masterKey, prefix,
      });

      try {
        // `byte_size` is the plaintext length (`ingest` writes
        // `bytes.byteLength`), so the card's totalBytes (spec §4.2) over A's
        // final 50-asset pool is exactly the sum of every corpus image's
        // length.
        let corpusBytes = 0;
        // B: 25 assets protected up front -- the cloud-only corpus A must pull.
        for (let i = 0; i < 25; i += 1) {
          const bytes = imageBytes(512, 1000 + i);
          const digest = sha256PlaintextHex(bytes);
          await b.ingest(digest, bytes);
          corpusBytes += bytes.byteLength;
          expect((await b.protect(digest)).status).toBe('applied');
        }

        // A: 25 DIFFERENT local assets, ingested but never protected --
        // pre-binding collections that predate account binding.
        for (let i = 0; i < 25; i += 1) {
          const bytes = imageBytes(512, 2000 + i);
          const digest = sha256PlaintextHex(bytes);
          await a.ingest(digest, bytes);
          corpusBytes += bytes.byteLength;
        }

        // Before any round: A owes the cloud 25 uploads and knows nothing yet
        // about B's 25 cloud assets (no download candidates without a sync).
        // Board #27 S3a T2's counts (spec §5.15): nothing of A's is cloud-only
        // yet (inCloud 0, 0 bytes), and all 25 uploads are still to go.
        const before = await a.readMirrorCounts();
        expect(before).toEqual({
          backedUp: 0, backedUpTotal: 25, downloaded: 0, downloadedTotal: 0,
          inCloud: 0, inCloudBytes: 0, pending: 25, totalBytes: 0,
        });

        // One sync.sync() reconciles B's 25 protected assets into A's local
        // projection (residency 'cloud-only'). Production calls this once,
        // before driving the loop (`library-sync-triggers`' `start()`) --
        // `round()` itself never calls `sync()`
        // (`library-integration-impl.ts:349-361`).
        await a.sync();

        const outcome = await runToEmpty(a.round, { maxRounds: 20 });

        // `listProtectCandidates`/`listDownloadCandidates` are unpaginated, so
        // one pool pass already uploads all 25 and downloads all 25 in round
        // 1 (real progress: up.done=25, down.done=25 -- not the done===0
        // stop). `runToEmpty` still needs a second, empty round before it can
        // report `clean` -- the confirmation that nothing is left.
        expect(outcome.rounds).toBeGreaterThanOrEqual(2);
        expect(outcome).toMatchObject({ clean: true, capped: false });

        const after = await a.readMirrorCounts();
        // Both halves converge to 50/50, not the naive 25/25-and-50/50 split.
        // `backedUp`/`backedUpTotal` (library-protection-repository.ts:454-471)
        // count every `device_library_assets` row with
        // `residency = 'local-original' AND protect_eligible = 1` in active
        // protection state -- it does NOT distinguish "originated on this
        // device" from "downloaded from another device". Once mirrorDown
        // flips B's 25 rows from `cloud-only` to `local-original`
        // (`library-sync-apply.ts:203-204` already set `protect_eligible = 1`
        // on arrival, since these fixtures are far under
        // LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES), they satisfy this query's
        // candidate criteria too and are already `done` (already protected)
        // -- so A's own 25 plus B's mirrored-in 25 make backedUpTotal 50.
        // `downloaded`/`downloadedTotal` (ibid. 472-485) count every asset
        // A's account projection knows as protected regardless of residency
        // -- A's own 25 (protected in place, never left `local-original`)
        // plus B's 25 (downloaded) -- also 50.
        // And with every original on this phone and every upload done:
        // inCloud 0, inCloudBytes 0, pending 0.
        expect(after).toEqual({
          backedUp: 50, backedUpTotal: 50, downloaded: 50, downloadedTotal: 50,
          inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: corpusBytes,
        });

        // The bucket carries one state.json per asset: A's 25 + B's 25 = 50.
        const keys = await listObjectKeys(`${prefix}assets/`);
        const stateJsonKeys = keys.filter((key) => key.endsWith('/state.json'));
        expect(stateJsonKeys).toHaveLength(50);
      } finally {
        a.close();
        b.close();
        await cleanup(prefix);
      }
    },
    // Real R2: 50 full protect/mirror pipelines (collect CAS + 3 blob PUTs +
    // state CAS + verify GET each, then reconcile + run-to-empty) measured
    // 175 s from this host on 2026-09-13 against R2 APAC, versus ~2 s on local
    // MinIO. 180 s lost by 0.4 s once; 600 s leaves real headroom. This is a
    // test ceiling, not a product timeout — per-request timeouts are K5's.
    600_000,
  );
});
