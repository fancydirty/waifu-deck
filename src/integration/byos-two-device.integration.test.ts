/**
 * App-level two-device BYOS sync against a real S3-compatible backend, with
 * real AES-256-GCM crypto (P5 Task 3).
 *
 * The unit two-device suite (`library-sync-two-device.test.ts`) proves the
 * conflict/convergence contract against an in-process `FakeS3Library` and the
 * deterministic crypto double. The encrypted round-trip suite proves the
 * ciphers and the transport over real MinIO, but only for a single hand-wired
 * seal/put/get. This suite is the join of the two: two INDEPENDENT device
 * compositions — each its own SQLite database, file store, outbox, cursors and
 * sync engine, wired from the same production factories
 * `library-integration-impl.ts` composes (session port + S3 client +
 * reconciliation port + sync engine + apply + cipher dispatch) — pointed at
 * ONE bucket/prefix, adopting ONE vault (same password -> same vaultId -> same
 * accountScope -> same assetId), talking to real MinIO with the real cipher.
 *
 * Why the harness wires the factories directly instead of calling
 * `createLibraryIntegration`: that entry point takes only `{ database, byos }`
 * (no injectable transport/fetchImpl) and builds its transport from
 * `expo/fetch`, whose native module is unavailable under the Node integration
 * env, and pulls in the expo file/image/reachability stack. The established
 * integration pattern (see the other three suites) is to wire the real ports
 * over Node `fetch`; this suite extends that to the whole engine composition,
 * and the interruption fault is injected at the transport's `fetchImpl` seam
 * (`createS3Transport(credentials, { fetchImpl })`, decision already exposed
 * for exactly this), so no production surface is added for the test.
 *
 * Parameterized by the same BYOS_IT_* environment as the other suites;
 * `npm run verify:byos-minio` supplies a throwaway container's values.
 */
import { DatabaseSync } from 'node:sqlite';

import { randomUUID } from 'expo-crypto';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createVaultOrAdopt } from '@/features/byos/byos-vault-init';
import type { VaultMeta } from '@/features/byos/byos-vault-meta';
import {
  createS3Transport,
  type S3FetchPort,
  type S3UploadFilePort,
} from '@/features/byos/s3-transport';
import type { S3DownloadFilePort } from '@/features/byos/s3-file-download';
import { S3TransportError, type S3Credentials } from '@/features/byos/s3-transport-types';
import { createLibraryAccountActions } from '@/features/library/library-account-actions';
import { createLibraryActionOutbox } from '@/features/library/library-action-outbox';
import type {
  LibraryObjectRole,
} from '@/features/library/library-actions-types';
import {
  createLibraryCacheStore,
  type LibraryCacheEntry,
} from '@/features/library/library-cache-store';
import { createLibraryLocalActions } from '@/features/library/library-local-actions';
import {
  decodeAssetState,
  type LibraryAssetStateRecord,
} from '@/features/library/library-asset-state-codec';
import { createS3LibraryCloudClient } from '@/features/library/library-cloud-client-s3';
import { createJsFileDecryptor } from '@/features/library/library-file-decryptor';
import { createLibraryDeviceTrashSweep } from '@/features/library/library-device-trash-sweep';
import { createLibraryFileStore } from '@/features/library/library-file-store';
import {
  deriveLibraryAssetId,
  sha256PlaintextHex,
} from '@/features/library/library-identity';
import { createLibraryObjectCipher } from '@/features/library/library-object-crypto';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import {
  createLibraryRenderReaders,
  type LibraryRenderReaders,
} from '@/features/library/library-render-source';
import { readSourceMetadata } from '@/features/library/library-source-metadata';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import { createLibraryReconciliationPort } from '@/features/library/library-reconciliation-port';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import { createImageRepository } from '@/features/images/image-repository';
import { createLibraryRepository } from '@/features/library/library-repository';
import { createByosLibrarySessionPort } from '@/features/library/library-session-port';
import { createLibrarySyncApplyWriter } from '@/features/library/library-sync-apply';
import { createLibrarySyncCursorStore } from '@/features/library/library-sync-cursors';
import {
  createLibrarySyncEngine,
  type LibrarySyncController,
} from '@/features/library/library-sync-engine';
import { createLibrarySyncOutbox } from '@/features/library/library-sync-outbox';
import { createLibrarySyncReconciler } from '@/features/library/library-sync-reconciler';
import { createLibraryTrashActions } from '@/features/library/library-trash-actions';
import { createLibraryBatchOrchestrator } from '@/features/library/library-batch-orchestrator';
import {
  createTransferCoalescer,
  type LibraryRoleFetch,
} from '@/features/library/library-transfer-coalescer';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';
import { libraryTransferProgress } from '@/features/library/library-transfer-progress';
import {
  createNodeBlobStaging,
  createNodeDownloadFilePort,
  createNodeUploadFilePort,
  withNodeStreamRoot,
} from '@/test/node-file-transfer';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';
import { openExistingVault } from '@/test/byos-vault-open';
import type { ImageCandidate } from '@/features/waifu/types';

const endpoint = process.env.BYOS_IT_ENDPOINT ?? '';
const bucket = process.env.BYOS_IT_BUCKET ?? '';
const accessKeyId = process.env.BYOS_IT_ACCESS_KEY ?? '';
const secretAccessKey = process.env.BYOS_IT_SECRET ?? '';
const basePrefix = process.env.BYOS_IT_PREFIX ?? '';
const region = process.env.BYOS_IT_REGION ?? 'us-east-1';

const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

if (!configured) {
  console.warn(
    '[byos-integration] Skipping the two-device app-level suite: '
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
 * A fixed collect time well in the past. The restored row must carry THIS
 * instant, not the restore moment: the collection sorts by `decided_at`, so a
 * "now" stamp would silently reorder the user's library on the second device.
 */
const COLLECTED_AT = 1_700_000_000_000;

/** The provider identity a v2 envelope carries, and B must rebuild verbatim. */
const PROVIDER_CANDIDATE: ImageCandidate = {
  providerKey: 'danbooru',
  providerItemId: '9871234',
  canonicalSourceKey: 'danbooru:9871234',
  perceptualHash: null,
  md5: '0123456789abcdef0123456789abcdef',
  remoteUrl: 'https://example.test/original.jpg',
  sampleUrl: 'https://example.test/sample.jpg',
  sourceUrl: 'https://example.test/posts/9871234',
  artistName: 'test_artist',
  artistUrl: 'https://example.test/artists/test_artist',
  width: 64,
  height: 64,
  byteSize: 4096,
  extension: 'jpg',
  dominantColor: '#1188cc',
  contentRating: 'explicit',
  nativeRating: 'e',
  isNsfw: true,
  isAnimated: false,
  tags: ['maid', 'solo', 'long_hair'],
};

/** Stands in for a collected image: incompressible enough to be recognisable. */
const imageBytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed * 37 + i * 11 + (i % 7) * 53) % 256);

/**
 * A transport-level fault injector. Wraps Node `fetch` and, once armed, injects
 * a network error on the FIRST `PUT` to a `state.json` key that happens after a
 * blob PUT has already succeeded — the protect flow's blob-durable-then-state
 * window.
 *
 * It lets the state PUT reach the server and land, THEN throws, so the client
 * sees a network error it cannot correlate to an outcome. This models the
 * realistic semantics of a cut on a write: the request may already have been
 * applied, which is exactly what the protocol's `outcomeKnown=false` +
 * stable-mutationId replay is built for. The blob is written before the state
 * (blob-first invariant), so any state a peer can ever observe already has its
 * bytes behind it — there is no blob-without-state dangling reference — and the
 * fresh-engine drain replays the same mutation, which the CAS decision table
 * resolves as `merged` (idempotent: exactly one generation, `lastMutationId`
 * unchanged).
 */
type FaultController = {
  fetchImpl: S3FetchPort;
  /**
   * K6-2: blob PUTs stream from a staged file through the upload port, not
   * through `fetch`, so "a blob has landed" is observed here now. Without this
   * the fault would never reach its arming condition and would silently never
   * fire.
   */
  uploadFile: S3UploadFilePort;
  arm(): void;
  disarm(): void;
  /** True once the injected fault has actually fired. */
  fired(): boolean;
};

/**
 * `ack-lost`: the state PUT reaches the server and LANDS, then the ack is lost
 * — the outcome is genuinely unknown and a replay resolves as `merged`
 * (idempotent).
 *
 * `never-landed`: the state PUT is thrown BEFORE it is ever sent, modelling a
 * true process death after the blobs are durable but before `state.json` was
 * written at all. Only the collect `state.json` (written before any blob PUT)
 * exists; the protected record and its whole generation triad must be produced
 * for the first time by the restart drain's replay — the exact defect this
 * task fixes.
 */
/**
 * K7 ⑨: `protect` answers as soon as the ORIGINAL blob and the `[collect,
 * protect]` state write are durable, and leaves the derived uploads and their
 * one follow-up state patch running behind it. Nothing in the app waits for
 * that tail, so a gate that asserts on it polls for the condition.
 */
async function waitForCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createFaultController(mode: 'ack-lost' | 'never-landed' = 'ack-lost'): FaultController {
  let armed = false;
  let blobSeen = false;
  let didFire = false;
  const realFetch = fetch as unknown as S3FetchPort;
  const realUpload = createNodeUploadFilePort();
  return {
    uploadFile: async (request) => {
      // Let the blob land, then remember we are past the point of no return.
      const response = await realUpload(request);
      blobSeen = true;
      return response;
    },
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT' && url.includes('/blobs/')) {
        // Let the blob land, then remember we are past the point of no return.
        const response = await realFetch(input, init);
        blobSeen = true;
        return response;
      }
      if (
        armed
        && blobSeen
        && method === 'PUT'
        && url.includes('/state.json')
      ) {
        didFire = true;
        armed = false;
        if (mode === 'ack-lost') {
          // Let the write LAND at the server first, then lose the response: the
          // outcome is genuinely unknown to the client.
          await realFetch(input, init);
          throw new S3TransportError(
            0, 'network', 'injected: state.json PUT ack lost after it landed', false,
          );
        }
        // never-landed: the request is never sent. `state.json` stays at the
        // collect revision; the protected record does not exist yet anywhere.
        throw new S3TransportError(
          0, 'network', 'injected: state.json PUT never left the device', false,
        );
      }
      return realFetch(input, init);
    },
    arm() { armed = true; },
    disarm() { armed = false; },
    fired() { return didFire; },
  };
}

/** A working derived-image double so protect mints real thumbnail/preview blobs. */
const workingDerived = {
  async derive() {
    return {
      thumbnail: {
        role: 'thumbnail' as const,
        bytes: new Uint8Array([11, 22, 33]),
        width: 8,
        height: 8,
        format: 'webp' as const,
      },
      preview: {
        role: 'preview' as const,
        bytes: new Uint8Array([44, 55, 66, 77]),
        width: 16,
        height: 16,
        format: 'webp' as const,
      },
      animated: false,
      failed: false,
    };
  },
};

type DeviceInput = Readonly<{
  name: string;
  deviceId: string;
  meta: VaultMeta;
  masterKey: Uint8Array | null;
  prefix: string;
  /** Only the interruption device passes a fault-injecting transport. */
  fetchImpl?: S3FetchPort;
  /** K6-2: the blob-upload seam, for suites that fault or count blob PUTs. */
  uploadFile?: S3UploadFilePort;
  /** K6-2: the blob-download seam, for suites that count blob GETs. */
  downloadFile?: S3DownloadFilePort;
  /**
   * When true, protect mints real thumbnail/preview blobs (the triad the
   * never-landed replay must reconstruct). The default double throws, so
   * protect uploads only the original.
   */
  withDerived?: boolean;
  /**
   * K7 ⑨: a gate that must observe the state.json the COMMIT wrote, before the
   * derived tail patches it, holds derivation open until it has read it.
   * Implies `withDerived`.
   */
  derivedHeldUntil?: Promise<void>;
}>;

type Device = {
  readonly name: string;
  ingest(digest: string, bytes: Uint8Array): Promise<void>;
  /**
   * C3b: ingest as a PROVIDER collection, the way the real collect path does —
   * a real `images` row plus a `device_library_assets.source_image_id` pointing
   * at it. That pointer is what makes protect seal a v2 envelope carrying the
   * provider identity, which is the only input device B can rebuild from.
   */
  ingestCollected(
    digest: string,
    bytes: Uint8Array,
    candidate: ImageCandidate,
  ): Promise<void>;
  /** How many `images` rows exist for one provider identity (idempotence). */
  imageRowCountFor(candidate: ImageCandidate): Promise<number>;
  /** The rebuilt `images` row device B linked to the mirrored asset, if any. */
  restoredImageOf(digest: string): Promise<{
    provider_key: string;
    provider_item_id: string;
    decision: string;
    download_state: string;
    local_uri: string | null;
    tags_json: string;
    decided_at: number;
  } | null>;
  protect(digest: string): Promise<{ status: string }>;
  removeFromLibrary(digest: string): Promise<{ status: string }>;
  restore(digest: string): Promise<unknown>;
  permanentDelete(digest: string): Promise<unknown>;
  download(digest: string): Promise<{ status: string }>;
  sync(): ReturnType<LibrarySyncController['sync']>;
  /** A fresh engine over the SAME database — the drain-after-restart path. */
  restartEngine(): void;
  protectionOf(digest: string): Promise<LibraryAssetStateRecord['lifecycle'] | null>;
  recordOf(digest: string): Promise<{
    lifecycle: string;
    protection: string;
    generation: number;
    revision: number | null;
    originalGenerationId: string | null;
    thumbnailGenerationId: string | null;
    previewGenerationId: string | null;
  } | null>;
  localBytesOf(digest: string): Promise<Uint8Array | null>;
  readonly renderReaders: LibraryRenderReaders;
  renderBytes(uri: string): Promise<Uint8Array>;
  renderCacheEntry(digest: string, role: LibraryObjectRole): Promise<LibraryCacheEntry | null>;
  streamFiles(): Promise<string[]>;
  /** The durable protect outbox row's state, or null if none survives. */
  outboxStateOf(digest: string): Promise<string | null>;
  close(): void;
};

async function createDevice(input: DeviceInput): Promise<Device> {
  const native = new DatabaseSync(':memory:');
  const database: SqlDatabasePort = createNodeSqliteAdapter(native);
  await migrateDatabase(database);

  const { prefix } = input;
  const cipher = createLibraryObjectCipher();
  const filePort = withNodeStreamRoot(createFakeLibraryFilePort());
  // The app's own repository, over this device's database: the C3b rebuild port
  // must be the production factory, not a stand-in.
  const images = createImageRepository(database);
  const files = createLibraryFileStore({ port: filePort });
  const cache = createLibraryCacheStore({ database, files, port: filePort });
  const decryptor = createJsFileDecryptor(cipher, filePort);

  const session = createByosLibrarySessionPort({
    vault: { meta: input.meta, masterKey: input.masterKey, deviceId: input.deviceId },
  });

  // The transport is the fault seam. Everything above it is production.
  const transport = createS3Transport(credentials, {
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    // K6-2: blobs now stream from a staged file so the native upload task can
    // report `bytesSent`. Under Node there is no `expo-file-system`, so inject
    // the equivalent — the signed wire request is identical to production's.
    uploadFile: input.uploadFile ?? createNodeUploadFilePort(),
    downloadFile: input.downloadFile ?? createNodeDownloadFilePort(),
  });
  const cloud = createS3LibraryCloudClient({
    transport, prefix, decide: decideLibraryMutation,
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
  const actionOutbox = createLibraryActionOutbox({
    database, newMutationId: () => randomUUID(),
  });

  const protectAction = createLibraryProtectAction({
    repository, protection, outbox: actionOutbox, files, cipher, cloud,
    reconciliation, session,
    // Failing derived-images: protect uploads only the ORIGINAL blob, so the
    // interruption fault fires deterministically on the one state.json PUT
    // that follows the one blob PUT.
    derived: input.derivedHeldUntil !== undefined
      ? {
          async derive() {
            await input.derivedHeldUntil;
            return workingDerived.derive();
          },
        }
      : input.withDerived === true
        ? workingDerived
        : { async derive() { throw new Error('no derived in this gate'); } },
    // C3a: the same projection the production composition binds, so this gate
    // exercises the real envelope shape rather than a source-less variant.
    readSource: (sourceImageId) => readSourceMetadata(database, sourceImageId),
    newGenerationId: () => randomUUID(),
  });
  const transferCoalescer = createTransferCoalescer<LibraryRoleFetch>();
  const localActions = createLibraryLocalActions({
    repository,
    protection,
    outbox: actionOutbox,
    files,
    cipher,
    decryptor,
    cloud,
    session,
    transferCoalescer,
  });
  const accountActions = createLibraryAccountActions({
    repository, protection, outbox: actionOutbox, files, cloud, session,
    protectAction, localActions,
  });
  const renderReaders = createLibraryRenderReaders({
    repository,
    protection,
    cache,
    cloud,
    derived: workingDerived,
    files: filePort,
    streams: files,
    decryptor,
    coalescer: transferCoalescer,
    reachability: { async isReachable() { return true; } },
    session,
  });

  function buildEngine(): LibrarySyncController {
    return createLibrarySyncEngine({
      session,
      cloud,
      reconciliation,
      cipher,
      database,
      cursors: createLibrarySyncCursorStore({ database }),
      apply: createLibrarySyncApplyWriter({
        database,
        cipher,
        restoreImage: async (candidate, savedAt) => {
          // K2: mirrors the real binding in library-integration-impl.ts
          // — a restored row is owned by the library, not a pending download.
          const stored = await images.saveMirroredCandidate(candidate, savedAt);
          return stored.id;
        },
      }),
      reconciler: createLibrarySyncReconciler({ database, protection, files }),
      outbox: createLibrarySyncOutbox({
        database, newMutationId: () => randomUUID(),
      }),
      pipelines: {
        retryProtect: async (digest) => { await protectAction.protect(digest); },
      },
      // K6-3a: the same ownership wiring the Direct composition binds, so this
      // gate exercises the real relationship between a live protect and a
      // concurrent drain against a real backend.
      isProtectInFlight: (assetId) => protectAction.isInFlight(assetId),
      sweep: createLibraryDeviceTrashSweep({
        database, protection, files: filePort,
      }),
    });
  }

  let engine = buildEngine();

  const batches = createLibraryBatchOrchestrator({
    protection,
    session,
    runner: {
      protect: (digest) => protectAction.protect(digest),
      download: (digest) => localActions.download(digest),
      freeDeviceSpace: (digest) => localActions.freeDeviceSpace(digest),
      permanentDelete: async (digest) => {
        const queued = await engine.enqueuePermanentDeleteIntent(digest);
        return queued.status === 'queued' || queued.status === 'already-queued'
          ? { status: 'applied' }
          : { status: 'noop', reason: 'not-applicable' };
      },
    },
    database,
    newBatchId: () => randomUUID(),
  });
  const trashActions = createLibraryTrashActions({
    session,
    batches,
    sync: {
      enqueueRestoreIntent: (d) => engine.enqueueRestoreIntent(d),
      enqueuePermanentDeleteIntent: (d) => engine.enqueuePermanentDeleteIntent(d),
      sync: () => engine.sync(),
    },
  });

  const ctx = async () => {
    const c = await session.current();
    if (c === null) throw new Error('no session');
    return c;
  };

  /**
   * The durable local state SP6 ingest leaves behind for one collected image:
   * the local original bytes, its `device_library_assets` row, its account
   * enrolment, and one `collect` outbox intent — all under the vault-derived
   * accountScope/assetId (not a test constant), so protect and reconcile agree
   * about identity across devices.
   */
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

  const ingestCollected: Device['ingestCollected'] = async (
    digest, bytes, candidate,
  ) => {
    await ingest(digest, bytes);
    const stored = await images.saveCandidate(candidate, COLLECTED_AT);
    await database.run(
      `UPDATE device_library_assets
          SET origin = 'provider', source_image_id = ?, created_at = ?
        WHERE plaintext_sha256 = ?`,
      [stored.id, COLLECTED_AT, digest],
    );
    // The outbox intent was already queued by `ingest` with origin 'import' and
    // a null pointer; realign it so the sealed envelope describes a provider
    // collection, which is what protect reads.
    const context = await ctx();
    const assetId = deriveLibraryAssetId(context.masterKey, digest);
    await database.run(
      `UPDATE library_outbox SET local_metadata_json = ?
        WHERE account_scope = ? AND asset_id = ? AND kind = 'collect'`,
      [
        JSON.stringify({
          assetId, plaintextSha256: digest, format: 'jpeg', byteSize: bytes.byteLength,
          width: 64, height: 64, origin: 'provider', sourceImageId: stored.id,
          collectedAt: COLLECTED_AT,
        }),
        context.accountScope, assetId,
      ],
    );
  };

  const imageRowCountFor: Device['imageRowCountFor'] = async (candidate) => {
    const row = await database.getFirst<{ n: number }>(
      'SELECT COUNT(*) AS n FROM images WHERE canonical_source_key = ?',
      [candidate.canonicalSourceKey],
    );
    return row?.n ?? 0;
  };

  const restoredImageOf: Device['restoredImageOf'] = (digest) =>
    database.getFirst(
      `SELECT i.provider_key, i.provider_item_id, i.decision, i.download_state,
              i.local_uri, i.tags_json, i.decided_at
         FROM images i
         JOIN device_library_assets a ON a.source_image_id = i.id
        WHERE a.plaintext_sha256 = ?`,
      [digest],
    );

  const recordOf: Device['recordOf'] = async (digest) => {
    const context = await ctx();
    const assetId = deriveLibraryAssetId(context.masterKey, digest);
    return database.getFirst(
      `SELECT lifecycle, protection, generation, revision,
              original_generation_id AS originalGenerationId,
              thumbnail_generation_id AS thumbnailGenerationId,
              preview_generation_id AS previewGenerationId
         FROM library_asset_protection
        WHERE account_scope = ? AND asset_id = ?`,
      [context.accountScope, assetId],
    );
  };

  return {
    name: input.name,
    ingest,
    ingestCollected,
    restoredImageOf,
    imageRowCountFor,
    protect: (digest) => protectAction.protect(digest),
    removeFromLibrary: (digest) => accountActions.removeFromLibrary(digest),
    restore: (digest) => trashActions.restore(digest),
    permanentDelete: (digest) => trashActions.permanentDelete(digest),
    async download(digest) {
      const result = await localActions.download(digest);
      expect(await filePort.listStream()).toEqual([]);
      return result;
    },
    sync: () => engine.sync(),
    restartEngine() { engine = buildEngine(); },
    async protectionOf(digest) {
      return (await recordOf(digest))?.lifecycle as
        LibraryAssetStateRecord['lifecycle'] ?? null;
    },
    recordOf,
    async outboxStateOf(digest) {
      const context = await ctx();
      const assetId = deriveLibraryAssetId(context.masterKey, digest);
      const row = await database.getFirst<{ state: string }>(
        `SELECT state FROM library_outbox
          WHERE account_scope = ? AND asset_id = ? AND kind = 'protect'`,
        [context.accountScope, assetId],
      );
      return row?.state ?? null;
    },
    async localBytesOf(digest) {
      const row = await database.getFirst<{ local_original_uri: string | null }>(
        `SELECT local_original_uri FROM device_library_assets
          WHERE plaintext_sha256 = ?`,
        [digest],
      );
      const uri = row?.local_original_uri ?? null;
      return uri === null ? null : await filePort.readBytes(uri);
    },
    renderReaders,
    renderBytes: (uri) => filePort.readBytes(uri),
    async renderCacheEntry(digest, role) {
      const context = await ctx();
      return cache.find(context.accountScope, digest, role);
    },
    streamFiles: () => filePort.listStream(),
    close() { native.close(); },
  };
}

/** One prefix per run, one sub-prefix per case: cases never see each other. */
const runPrefix = `${basePrefix}twodev-${Date.now().toString(36)}/`;

describeBackend('BYOS two-device app-level convergence and interruption recovery', () => {
  const cleanupTransport = createS3Transport(credentials);

  async function cleanup(prefix: string): Promise<void> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await cleanupTransport.listObjects(prefix, token);
      for (const object of page.objects) keys.push(object.key);
      token = page.nextToken;
    } while (token !== undefined);
    await Promise.all(
      keys.map((key) => cleanupTransport.deleteObject(key).catch(() => undefined)),
    );
  }

  test('a full lifecycle converges byte-identically across two devices', async () => {
    const prefix = `${runPrefix}convergence/`;
    const digest = sha256PlaintextHex(imageBytes(4096, 3));
    const plaintext = imageBytes(4096, 3);

    // One vault, adopted by both devices: A creates it, B opens it, and scrypt
    // must re-derive the same key so they share vaultId -> accountScope.
    const setupTransport = createS3Transport(credentials);
    const vaultA = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');
    const vaultB = await openExistingVault(setupTransport, prefix, PASSWORD);
    expect(vaultB.meta.vaultId).toBe(vaultA.meta.vaultId);
    expect(Array.from(vaultB.masterKey!)).toEqual(Array.from(vaultA.masterKey!));

    const a = await createDevice({
      name: 'A', deviceId: 'device-a', meta: vaultA.meta,
      masterKey: vaultA.masterKey, prefix,
    });
    const b = await createDevice({
      name: 'B', deviceId: 'device-b', meta: vaultB.meta,
      masterKey: vaultB.masterKey, prefix,
    });

    try {
      // --- A: collect + protect (real AES-GCM) -----------------------------
      await a.ingest(digest, plaintext);
      expect((await a.protect(digest)).status).toBe('applied');
      const aRecord = await a.recordOf(digest);
      expect(aRecord).toMatchObject({
        lifecycle: 'active', protection: 'protected', generation: 1,
      });

      // --- B: reconcile materializes; download decrypts to identical bytes --
      const bSync = await b.sync();
      expect(bSync.status).toBe('completed');
      expect(bSync.materialized).toBe(1);
      const bAfterSync = await b.recordOf(digest);
      expect(bAfterSync).toMatchObject({
        lifecycle: 'active', protection: 'protected',
      });
      expect(bAfterSync!.originalGenerationId).toBe(aRecord!.originalGenerationId);

      expect((await b.download(digest)).status).toBe('applied');
      const bBytes = await b.localBytesOf(digest);
      expect(bBytes).not.toBeNull();
      // Byte-identical: A sealed with a real AES key, B decrypted with the
      // scrypt-adopted key, over real MinIO — not the crypto double.
      expect(Array.from(bBytes!)).toEqual(Array.from(plaintext));

      // --- B: trash -> A reconciles and converges on trashed ----------------
      expect((await b.removeFromLibrary(digest)).status).toBe('applied');
      await b.sync();
      await a.sync();
      expect(await a.protectionOf(digest)).toBe('trash');

      // --- A: restore -> B reconciles, meta preserved -----------------------
      const restored = await a.restore(digest);
      expect(restored).toMatchObject({ status: expect.any(String) });
      expect(await a.protectionOf(digest)).toBe('active');
      await b.sync();
      expect(await b.protectionOf(digest)).toBe('active');
      // Metadata survived the trash/restore round trip: read the authoritative
      // state.json off the bucket and assert its sealed `meta` envelope is
      // genuinely still present (not merely restate the local lifecycle) — a
      // restore that null-erased `meta` would leave a device that never held
      // this asset unable to ever materialize it.
      const restoredAssetId = deriveLibraryAssetId(vaultA.masterKey!, digest);
      const restoredKey = `${prefix}assets/${restoredAssetId}/state.json`;
      const restoredStored = await cleanupTransport.getObject(restoredKey);
      expect(restoredStored).not.toBeNull();
      const restoredState = decodeAssetState(restoredStored!.body);
      expect(restoredState.lifecycle).toBe('active');
      expect(restoredState.meta).not.toBeUndefined();
      expect(typeof restoredState.meta).toBe('string');

      // --- A: trash again then permanent-delete -> both purge ---------------
      expect((await a.removeFromLibrary(digest)).status).toBe('applied');
      await a.sync();
      await a.permanentDelete(digest);
      expect(await a.protectionOf(digest)).toBe('purged');
      await b.sync();
      expect(await b.protectionOf(digest)).toBe('purged');

      // The purge tombstone strips generations and meta at the source of truth.
      const context = { assetId: deriveLibraryAssetId(vaultA.masterKey!, digest) };
      const stateKey = `${prefix}assets/${context.assetId}/state.json`;
      const stored = await cleanupTransport.getObject(stateKey);
      expect(stored).not.toBeNull();
      const tombstone = decodeAssetState(stored!.body);
      expect(tombstone.lifecycle).toBe('purged');
      expect(tombstone.generations).toEqual({});
      expect(tombstone.meta).toBeUndefined();
    } finally {
      a.close();
      b.close();
      await cleanup(prefix);
    }
  });

  test('a cloud-only device resolves the original and derived roles through file-backed readers', async () => {
    const prefix = `${runPrefix}render-source/`;
    const plaintext = imageBytes(4096, 41);
    const digest = sha256PlaintextHex(plaintext);
    let originalGenerationId: string | null = null;
    let originalBlobGets = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && originalGenerationId !== null) {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith(`/blobs/${originalGenerationId}`)) originalBlobGets += 1;
      }
      return fetch(input, init);
    };

    const setupTransport = createS3Transport(credentials);
    const vaultA = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');
    const vaultB = await openExistingVault(setupTransport, prefix, PASSWORD);
    const a = await createDevice({
      name: 'A', deviceId: 'device-a', meta: vaultA.meta,
      masterKey: vaultA.masterKey, prefix, withDerived: true,
    });
    const b = await createDevice({
      name: 'B', deviceId: 'device-b', meta: vaultB.meta,
      masterKey: vaultB.masterKey,
      prefix,
      downloadFile: createNodeDownloadFilePort(countingFetch),
    });

    try {
      await a.ingest(digest, plaintext);
      expect((await a.protect(digest)).status).toBe('applied');

      let aRecord = await a.recordOf(digest);
      for (let attempt = 0; attempt < 120 && aRecord?.thumbnailGenerationId == null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        aRecord = await a.recordOf(digest);
      }
      expect(aRecord?.originalGenerationId).toBeTruthy();
      expect(aRecord?.thumbnailGenerationId).toBeTruthy();
      originalGenerationId = aRecord!.originalGenerationId;

      const bSync = await b.sync();
      expect(bSync.status).toBe('completed');
      expect(await b.localBytesOf(digest)).toBeNull();
      expect(await b.renderCacheEntry(digest, 'original')).toBeNull();

      const source = await b.renderReaders.resolver.resolve(digest, 'full');
      expect(source).toMatchObject({
        kind: 'file',
        tier: 'cloud-original',
        role: 'original',
      });
      if (source.kind === 'file') {
        const bytes = await b.renderBytes(source.uri);
        expect(sha256PlaintextHex(bytes)).toBe(digest);
        expect(bytes.byteLength).toBe(plaintext.byteLength);
      }
      const originalEntry = await b.renderCacheEntry(digest, 'original');
      expect(originalEntry?.byteSize).toBe(plaintext.byteLength);
      expect(originalBlobGets).toBe(1);
      await expect(b.streamFiles()).resolves.toEqual([]);

      const thumbnail = await b.renderReaders.roles.read(digest, 'thumbnail');
      expect(thumbnail).toMatchObject({
        kind: 'file',
        role: 'thumbnail',
      });
      if (thumbnail.kind === 'file') {
        await expect(b.renderBytes(thumbnail.uri)).resolves.toEqual(
          Uint8Array.from([11, 22, 33]),
        );
      }
      expect((await b.renderCacheEntry(digest, 'thumbnail'))?.byteSize).toBe(3);
      await expect(b.streamFiles()).resolves.toEqual([]);
    } finally {
      a.close();
      b.close();
      await cleanup(prefix);
    }
  });

  test('a brand-new asset pays two sequential round trips, not six', async () => {
    // K6-1b/K6-1c's whole point, measured against a real bucket rather than a
    // fake: spec §2 asks for a saved image to be in the cloud within five
    // seconds, and §4.5 measured ~1.5 s per round trip on the owner's warm
    // link, so the per-image request shape IS the deadline. This counts it.
    const prefix = `${runPrefix}round-trips/`;
    const plaintext = imageBytes(2048, 29);
    const digest = sha256PlaintextHex(plaintext);

    const setupTransport = createS3Transport(credentials);
    const vault = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');

    const realFetch = fetch as unknown as S3FetchPort;
    const realUpload = createNodeUploadFilePort();
    const log: string[] = [];
    // Derivation is held across the whole commit, so the request log and the
    // state.json read below cannot race the follow-up patch.
    let releaseDerive!: () => void;
    const derivationHeld = new Promise<void>((resolve) => { releaseDerive = resolve; });
    const a = await createDevice({
      name: 'A',
      deviceId: 'device-a',
      meta: vault.meta,
      masterKey: vault.masterKey,
      prefix,
      derivedHeldUntil: derivationHeld,
      // Log each request when it has COMPLETED, not when it was issued: the
      // assertions below read state.json the moment the log shows the second
      // `PUT state`, so an entry pushed before the await lets that read race
      // the write on a higher-latency backend (Wasabi: 1 pass in 3 runs; MinIO
      // and R2 were fast enough to hide it). Completion is what "the write has
      // landed" means, and it is what blob-durable-before-state is about.
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const kind = url.includes('/blobs/')
          ? 'blob'
          : url.includes('/state.json') ? 'state' : 'other';
        const response = await realFetch(input, init);
        log.push(`${method} ${kind}`);
        return response;
      },
      // K6-2: a blob PUT no longer goes through `fetch`, so count it here.
      uploadFile: async (request) => {
        const result = await realUpload(request);
        log.push('PUT blob');
        return result;
      },
    });

    try {
      // Ingest is local-only; the stopwatch starts at "saved to this device".
      await a.ingest(digest, plaintext);
      log.length = 0;
      expect((await a.protect(digest)).status).toBe('applied');

      // Three role blobs, launched together (one round trip), then ONE
      // state.json write that carries BOTH the collect and the protect. Gone:
      // the pre-flight `readRemoteState` GET, the separate collect submit's own
      // GET + CAS PUT (K6-1b), and the surviving CAS read (K6-1c) — this device
      // has never seen the asset, so it writes `If-None-Match: '*'` straight
      // away and lets the bucket refuse it if that belief is wrong.
      //
      // K7 ⑨: what the USER waits for is now exactly two requests — the
      // ORIGINAL's blob PUT and that merged state write. The derived roles
      // used to be inside this window (two native decode+encode passes, two
      // seals, two more PUTs, and on a cold link a 10-85 s handshake each) for
      // objects this device never reads.
      expect(log).toEqual(['PUT blob', 'PUT state']);

      const assetId = deriveLibraryAssetId(vault.masterKey!, digest);
      const stateKey = `${prefix}assets/${assetId}/state.json`;
      const first = decodeAssetState(
        (await setupTransport.getObject(stateKey))!.body,
      );
      // The FIRST state.json the bucket ever holds for this asset already says
      // protected — that is the orange cloud — and it references only the
      // original, whose bytes are already durable above.
      expect(first).toMatchObject({ lifecycle: 'active', protection: 'protected' });
      expect(first.generations.original).toBeTruthy();
      expect(first.generations.thumbnail).toBeUndefined();
      expect(first.generations.preview).toBeUndefined();
      expect(first.meta).not.toBeUndefined();

      // Behind the answer: the two derived blobs, then ONE follow-up state
      // write that adds their references.
      releaseDerive();
      await waitForCondition(
        () => log.filter((entry) => entry === 'PUT state').length === 2,
        'the derived generations patch',
      );
      expect(log.filter((entry) => entry === 'PUT blob')).toHaveLength(3);
      expect(log.filter((entry) => entry === 'PUT state')).toHaveLength(2);
      // Blob-durable-before-state holds for BOTH writes: each state object was
      // written after the blobs it references, and is the last request of its
      // own phase.
      expect(log.at(-1)).toBe('PUT state');
      expect(log.indexOf('PUT state')).toBeLessThan(log.lastIndexOf('PUT blob'));

      // The asset ends up with the whole triad, same original, same envelope.
      const landed = decodeAssetState(
        (await setupTransport.getObject(stateKey))!.body,
      );
      expect(landed).toMatchObject({ lifecycle: 'active', protection: 'protected' });
      expect(landed.generations.original).toBe(first.generations.original);
      expect(landed.generations.thumbnail).toBeTruthy();
      expect(landed.generations.preview).toBeTruthy();
      expect(landed.meta).toBe(first.meta);
      for (const generationId of [
        landed.generations.thumbnail,
        landed.generations.preview,
      ]) {
        expect(
          await setupTransport.getObject(`${prefix}blobs/${generationId}`),
        ).not.toBeNull();
      }
    } finally {
      releaseDerive();
      a.close();
      await cleanup(prefix);
    }
  });

  test('a sync round mid-upload never steals the live protect’s collect intent', async () => {
    // K6-3a, the proven emulator defect (asset a8bfed37, 02:25–02:29) against a
    // real backend. The fresh-collect protect enqueues its `protect` row
    // BEFORE its combined collect+protect submit, and that row is instantly
    // due. A sync round landing in that window used to pick it up, pair it with
    // the collect intent (K6-1b), replay both, and DELETE both on commit —
    // taking the intent the live protect was about to submit. The protect then
    // saw `findCollectIntent() === null`, recorded the terminal
    // `object_missing`, and re-failed the same image every round afterwards.
    const prefix = `${runPrefix}drain-live-race/`;
    const plaintext = imageBytes(2048, 11);
    const digest = sha256PlaintextHex(plaintext);

    const setupTransport = createS3Transport(credentials);
    const vault = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');

    // Hold the blob upload open, so a whole sync round runs while this
    // protect's bytes are genuinely in flight.
    const realUpload = createNodeUploadFilePort();
    let reachedUpload!: () => void;
    const inUpload = new Promise<void>((resolve) => { reachedUpload = resolve; });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let held = false;

    const a = await createDevice({
      name: 'A', deviceId: 'device-a', meta: vault.meta,
      masterKey: vault.masterKey, prefix,
      uploadFile: async (request) => {
        if (!held) {
          held = true;
          reachedUpload();
          await gate;
        }
        return realUpload(request);
      },
    });

    try {
      await a.ingest(digest, plaintext);
      const assetId = deriveLibraryAssetId(vault.masterKey!, digest);

      const protecting = a.protect(digest);
      await inUpload;

      // A full sync cycle, concurrent with the live upload.
      const during = await a.sync();
      // It must submit NOTHING for this asset: the upload owns it.
      expect(during.submitted).toBe(0);
      expect(during.committed).toBe(0);

      openGate();
      expect((await protecting).status).toBe('applied');

      // The protect landed for real: a protected record referencing a blob
      // that is durably present.
      const stateKey = `${prefix}assets/${assetId}/state.json`;
      const landed = decodeAssetState((await setupTransport.getObject(stateKey))!.body);
      expect(landed.protection).toBe('protected');
      expect(landed.generations.original).toBeTruthy();
      expect(
        await setupTransport.getObject(`${prefix}blobs/${landed.generations.original}`),
      ).not.toBeNull();
      expect(await a.recordOf(digest)).toMatchObject({
        lifecycle: 'active', protection: 'protected',
      });

      // And the asset is genuinely finished: a later round has nothing left to
      // do for it, so there is no row being retried and re-failed forever.
      const after = await a.sync();
      expect(after.status).toBe('completed');
      expect(await a.recordOf(digest)).toMatchObject({ protection: 'protected' });
    } finally {
      a.close();
      await cleanup(prefix);
    }
  });

  test('an interrupted protect replays idempotently and B never sees a dangling ref', async () => {
    const prefix = `${runPrefix}interruption/`;
    const plaintext = imageBytes(2048, 7);
    const digest = sha256PlaintextHex(plaintext);

    const setupTransport = createS3Transport(credentials);
    const vault = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');

    const fault = createFaultController();
    const a = await createDevice({
      name: 'A', deviceId: 'device-a', meta: vault.meta,
      masterKey: vault.masterKey, prefix, fetchImpl: fault.fetchImpl,
      uploadFile: fault.uploadFile,
    });
    const b = await createDevice({
      name: 'B', deviceId: 'device-b', meta: vault.meta,
      masterKey: vault.masterKey, prefix,
    });

    try {
      await a.ingest(digest, plaintext);

      // Cut the wire on the protect state.json PUT — after the original blob
      // landed and after the state write reached the server, but before its
      // acknowledgement got back. A's client cannot know the write applied.
      fault.arm();
      const interrupted = await a.protect(digest);
      expect(fault.fired()).toBe(true);
      // Protect did not confirm: it is queued/blocked and its durable outbox
      // row survives (state 'sending') with the uploaded generation id.
      const assetId = deriveLibraryAssetId(vault.masterKey!, digest);
      const stateKey = `${prefix}assets/${assetId}/state.json`;
      expect(['queued', 'blocked']).toContain(interrupted.status);
      // K6-1 (root cause F7): a lost-ack network cut is bridged to `offline`, so
      // protect queues rather than recording a hard failure — the write may have
      // landed, so its outcome is unknown and its durable outbox row survives in
      // the `sending` state for an idempotent replay under the same mutationId.
      expect(interrupted.status).toBe('queued');
      expect(await a.outboxStateOf(digest)).toBe('sending');

      // Blob-first invariant: the state a peer can observe (rev 2, protected)
      // already references a blob that is durably present — never a dangling
      // reference. The write DID land; only its ack was lost.
      const landed = decodeAssetState((await setupTransport.getObject(stateKey))!.body);
      expect(landed.revision).toBe(2);
      expect(landed.protection).toBe('protected');
      expect(landed.generations.original).toBeTruthy();
      expect(await setupTransport.getObject(`${prefix}blobs/${landed.generations.original}`))
        .not.toBeNull();
      const committedMutationId = landed.lastMutationId!;
      expect(landed.lastMutationId).not.toBeNull();

      // B reconciles and sees only the complete, protected result: it can
      // materialize and download to the original bytes right away.
      const bBefore = await b.sync();
      expect(bBefore.status).toBe('completed');
      const bMid = await b.recordOf(digest);
      expect(bMid).toMatchObject({ lifecycle: 'active', protection: 'protected' });
      expect(bMid!.originalGenerationId).toBe(landed.generations.original);
      expect((await b.download(digest)).status).toBe('applied');
      expect(Array.from((await b.localBytesOf(digest))!)).toEqual(Array.from(plaintext));

      // Restart: a fresh engine over the SAME database drains the surviving
      // 'sending' row and replays the protect under its stable mutationId.
      fault.disarm();
      a.restartEngine();
      const drained = await a.sync();
      expect(drained.status).toBe('completed');
      const aAfter = await a.recordOf(digest);
      expect(aAfter).toMatchObject({
        lifecycle: 'active', protection: 'protected', generation: 1,
      });
      expect(aAfter!.originalGenerationId).toBe(landed.generations.original);

      // Idempotent: exactly one generation committed. The replay resolved as
      // `merged` (the asset was already protected at this generation), so the
      // state is byte-untouched — same revision, same lastMutationId.
      const state1 = decodeAssetState((await setupTransport.getObject(stateKey))!.body);
      expect(state1.revision).toBe(2);
      expect(state1.lastMutationId).toBe(committedMutationId);

      // A second drain must not double-apply: the row is gone, nothing resubmits.
      const secondDrain = await a.sync();
      expect(secondDrain.submitted).toBe(0);
      const state2 = decodeAssetState((await setupTransport.getObject(stateKey))!.body);
      expect(state2.revision).toBe(2);

      // lastMutationId idempotency at the CAS layer, asserted directly:
      // replaying the exact same protect mutation resolves as `merged` and
      // writes nothing new.
      const replayClient = createS3LibraryCloudClient({
        transport: setupTransport, prefix, decide: decideLibraryMutation,
      });
      const replay = await replayClient.submitMutations({
        mutations: [{
          mutationId: committedMutationId, assetId, kind: 'protect',
          baseRevision: 1, observedGeneration: 1,
          originalGenerationId: aAfter!.originalGenerationId, newBlob: null,
        }],
      });
      expect(replay.results[0]!.outcome).toBe('merged');
      const state3 = decodeAssetState((await setupTransport.getObject(stateKey))!.body);
      expect(state3.revision).toBe(2);

      // B remains converged on the complete result.
      await b.sync();
      expect((await b.recordOf(digest))).toMatchObject({ protection: 'protected' });
    } finally {
      a.close();
      b.close();
      await cleanup(prefix);
    }
  });

  test('a never-landed protect replays the committed original so B materializes', async () => {
    const prefix = `${runPrefix}never-landed/`;
    const plaintext = imageBytes(3072, 13);
    const digest = sha256PlaintextHex(plaintext);

    const setupTransport = createS3Transport(credentials);
    const vault = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');

    // never-landed: the protect state.json PUT is thrown before it is ever
    // sent, so only the collect state.json exists at the crash. `withDerived`
    // makes protect mint real thumbnail + preview blobs.
    //
    // K7 ⑨ changed what the replay can reconstruct, and this gate now pins the
    // new contract rather than the old one. The commit no longer waits for
    // derivation, so the durable `protect` outbox row is written BEFORE the
    // derived generation ids exist and cannot carry them; the follow-up patch
    // that would add them only runs after a commit, and here there was none.
    // What the replay must still guarantee is everything the user's library
    // depends on: the asset comes back PROTECTED, its ORIGINAL is referenced
    // and byte-exact, and device B materializes it. The thumbnail and preview
    // are regenerable extras with an explicit fallback — `library-render-
    // tiers.ts` renders the original when a derived role is absent — and the
    // blobs this crash left behind are exactly what the orphan sweep (spec
    // G7) exists for.
    const fault = createFaultController('never-landed');
    const a = await createDevice({
      name: 'A', deviceId: 'device-a', meta: vault.meta,
      masterKey: vault.masterKey, prefix, fetchImpl: fault.fetchImpl,
      uploadFile: fault.uploadFile,
      withDerived: true,
    });
    const b = await createDevice({
      name: 'B', deviceId: 'device-b', meta: vault.meta,
      masterKey: vault.masterKey, prefix,
    });

    try {
      await a.ingest(digest, plaintext);
      const assetId = deriveLibraryAssetId(vault.masterKey!, digest);
      const stateKey = `${prefix}assets/${assetId}/state.json`;

      // Protect uploads all three role blobs, then dies before state.json is
      // written.
      fault.arm();
      const interrupted = await a.protect(digest);
      expect(fault.fired()).toBe(true);
      expect(['queued', 'blocked']).toContain(interrupted.status);

      // K6-1b: a brand-new asset's `collect` and `protect` ride in ONE CAS PUT,
      // so a crash before that PUT leaves NO state.json at all — not even the
      // collect record the old two-submit path used to leave behind. Only the
      // three role blobs are on the bucket, unreferenced until the replay
      // writes the record. This is the crash window the outbox rows must
      // survive, and it is wider than the one this test was written for.
      expect(await setupTransport.getObject(stateKey)).toBeNull();

      // Restart: a fresh engine over the SAME database drains the surviving
      // row and replays the protect. This is the FIRST time the protected
      // record and its generation triad are ever written.
      fault.disarm();
      a.restartEngine();
      const drained = await a.sync();
      expect(drained.status).toBe('completed');

      const landed = decodeAssetState((await setupTransport.getObject(stateKey))!.body);
      expect(landed.revision).toBe(2);
      expect(landed.protection).toBe('protected');
      // The original is referenced — not `generations: {}`, which would lose
      // the asset's only irreplaceable bytes.
      expect(landed.generations.original).toBeTruthy();
      // Meta from the collect record survived the protect merge.
      expect(landed.meta).not.toBeUndefined();
      // Every referenced blob is durably present.
      expect(
        await setupTransport.getObject(`${prefix}blobs/${landed.generations.original}`),
      ).not.toBeNull();

      // B reconciles the replayed record, adopts the original, and renders
      // from it wherever a derived role is absent (`library-render-tiers.ts`).
      const bSync = await b.sync();
      expect(bSync.status).toBe('completed');
      const bRecord = await b.recordOf(digest);
      expect(bRecord).toMatchObject({ lifecycle: 'active', protection: 'protected' });
      expect(bRecord!.originalGenerationId).toBe(landed.generations.original);
      expect(bRecord!.thumbnailGenerationId).toBe(landed.generations.thumbnail ?? null);
      expect(bRecord!.previewGenerationId).toBe(landed.generations.preview ?? null);

      // B downloads to the exact original bytes over real crypto.
      expect((await b.download(digest)).status).toBe('applied');
      expect(Array.from((await b.localBytesOf(digest))!)).toEqual(Array.from(plaintext));
    } finally {
      a.close();
      b.close();
      await cleanup(prefix);
    }
  });

  test('B rebuilds the provider images row for an asset it never collected', async () => {
    const prefix = `${runPrefix}restore-images/`;
    const plaintext = imageBytes(4096, 11);
    const digest = sha256PlaintextHex(plaintext);

    const setupTransport = createS3Transport(credentials);
    const vaultA = await createVaultOrAdopt(setupTransport, prefix, PASSWORD, 'aes-gcm');
    const vaultB = await openExistingVault(setupTransport, prefix, PASSWORD);

    const a = await createDevice({
      name: 'A', deviceId: 'device-a', meta: vaultA.meta,
      masterKey: vaultA.masterKey, prefix,
    });
    const b = await createDevice({
      name: 'B', deviceId: 'device-b', meta: vaultB.meta,
      masterKey: vaultB.masterKey, prefix,
    });

    try {
      // A collected this from a provider, so protect seals a v2 envelope.
      await a.ingestCollected(digest, plaintext, PROVIDER_CANDIDATE);
      expect((await a.protect(digest)).status).toBe('applied');

      // B has never seen this asset: no images row, nothing local.
      expect(await b.restoredImageOf(digest)).toBeNull();

      await b.sync();

      // The mirrored asset is linked to a rebuilt images row carrying the
      // provider identity verbatim -- not invented, not defaulted.
      expect(await b.restoredImageOf(digest)).toEqual({
        provider_key: 'danbooru',
        provider_item_id: '9871234',
        // A mirrored asset is one the user kept, so it reads as collected.
        decision: 'saved',
        // K2: the row's bytes are the library's; the collection never fetches
        // it from the provider. `local_uri` stays NULL by invariant.
        download_state: 'mirrored',
        local_uri: null,
        tags_json: JSON.stringify(['long_hair', 'maid', 'solo']),
        // The original collect instant, not the restore moment.
        decided_at: COLLECTED_AT,
      });

      // Re-applying the same revision must not fork a second images row.
      b.restartEngine();
      await b.sync();
      await expect(b.imageRowCountFor(PROVIDER_CANDIDATE)).resolves.toBe(1);
    } finally {
      a.close();
      b.close();
      await cleanup(prefix);
    }
  });
});
