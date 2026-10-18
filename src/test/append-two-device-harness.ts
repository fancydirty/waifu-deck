/**
 * Board #12: the in-process two-device harness for the append-only protocol
 * v2, extracted (P12-B Task 11) from `library-append-two-device.test.ts` so
 * the real-backend gate (`src/integration/webdav-two-device.integration.test.ts`)
 * runs the SAME production stack over a live `CloudObjectStore`.
 *
 * Everything above the store is the production stack the composition root
 * binds for a cloud-drive backend (`library-integration-impl.ts`): the real
 * protect action, local/account/trash actions, batch orchestrator, sync
 * engine, apply writer, reconciler, outbox, sweep, and the durable ETag index.
 * Below the store seam this file supplies what a Node process needs: the Node
 * tmp-dir blob staging, the fake file port, the SQLite adapter; the vault meta
 * is hand-written (no connect flow, no scrypt); there is no derived-image
 * pipeline; and each device sees the ONE shared store through a passthrough
 * recorder, because a shared call log cannot say which device issued a read.
 *
 * `expo-crypto` is imported plainly: under `npm test` the importing suite
 * mocks it with the double, under the integration config the module map
 * supplies the real WebCrypto shim.
 */

import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { randomUUID } from 'expo-crypto';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  SUPPORTED_PROTOCOL_VERSION,
  type VaultMeta,
} from '@/features/byos/byos-vault-meta';
import type { CloudObjectStore } from '@/features/cloud-store/cloud-object-store';
import type { MemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import { createImageRepository } from '@/features/images/image-repository';
import type { ImageCandidate } from '@/features/waifu/types';
import { createLibraryAccountActions } from '@/features/library/library-account-actions';
import { createLibraryActionOutbox } from '@/features/library/library-action-outbox';
import type { LibraryActionResult } from '@/features/library/library-actions-types';
import { createLibraryBatchOrchestrator } from '@/features/library/library-batch-orchestrator';
import { createAppendLibraryCloudClient } from '@/features/library/library-cloud-client-append';
import { createLibraryDeviceTrashSweep } from '@/features/library/library-device-trash-sweep';
import { createLibraryFileStore } from '@/features/library/library-file-store';
import { createJsFileDecryptor } from '@/features/library/library-file-decryptor';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import { createLibraryLocalActions } from '@/features/library/library-local-actions';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import { parseNoteName, writerTag } from '@/features/library/library-note-name';
import { createLibraryObjectCipher } from '@/features/library/library-object-crypto';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import {
  createAppendLibraryReconciliationPort,
  type AppendLibraryReconciliationPort,
} from '@/features/library/library-reconciliation-append';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import { createLibraryRepository } from '@/features/library/library-repository';
import { createByosLibrarySessionPort } from '@/features/library/library-session-port';
import { readSourceMetadata } from '@/features/library/library-source-metadata';
import { createLibrarySyncApplyWriter } from '@/features/library/library-sync-apply';
import { createLibrarySyncCursorStore } from '@/features/library/library-sync-cursors';
import {
  createLibrarySyncEngine,
  type LibrarySyncController,
} from '@/features/library/library-sync-engine';
import { createLibrarySyncOutbox } from '@/features/library/library-sync-outbox';
import { createLibrarySyncReconciler } from '@/features/library/library-sync-reconciler';
import type { LibraryRestoreIntentResult } from '@/features/library/library-sync-types';
import {
  createTransferCoalescer,
  type LibraryRoleFetch,
} from '@/features/library/library-transfer-coalescer';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';
import { libraryTransferProgress } from '@/features/library/library-transfer-progress';
import { createLibraryTrashActions } from '@/features/library/library-trash-actions';
import { createNodeBlobStaging, withNodeStreamRoot } from '@/test/node-file-transfer';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

export const imageBytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed * 37 + i * 11 + (i % 7) * 53) % 256);

export const STATE_PREFIX = 'state/';

/**
 * The store's side of `putFromFile`: production hands the backend a staged
 * temp file rather than a buffer (K6-2), so the store has to read that file
 * back or the blob upload path under test would be a buffer PUT wearing the
 * name of the streaming one.
 */
export const readStagedFile = async (uri: string): Promise<Uint8Array | null> => {
  try {
    return new Uint8Array(await fs.readFile(fileURLToPath(uri)));
  } catch {
    return null;
  }
};

/**
 * A hand-written vault-meta: this suite never runs the connect flow, so no
 * scrypt and no password verification. Both devices are handed the SAME meta
 * and the SAME master key, which is what makes their `accountScope` and their
 * per-asset ids agree — the precondition for them to be talking about the
 * same asset at all.
 */
export const APPEND_TEST_META: VaultMeta = {
  format: 'waifu-deck-byos',
  protocolVersion: SUPPORTED_PROTOCOL_VERSION,
  encryption: 'aes-gcm',
  vaultId: 'vault-two-device',
  kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'c2FsdA==' },
  keyCheckB64: 'a2V5Q2hlY2s=',
  createdAt: '2026-09-18T00:00:00.000Z',
};
export const APPEND_TEST_MASTER_KEY = new Uint8Array(32).fill(7);

export type AppendDeviceInput = Readonly<{
  deviceId: string;
  /** ONE shared store per scenario: the memory store with chaos knobs here, a real backend in the gates. */
  store: CloudObjectStore;
  clock: () => number;
}>;

export type AppendDevice = {
  readonly database: SqlDatabasePort;
  readonly cipher: ReturnType<typeof createLibraryObjectCipher>;
  ingest(
    digest: string,
    bytes: Uint8Array,
    options?: {
      importClassification?: 'safe' | 'adult' | 'unknown';
      collectedAt?: number;
    },
  ): Promise<void>;
  ingestCollected(
    digest: string,
    bytes: Uint8Array,
    candidate: ImageCandidate,
    collectedAt?: number,
  ): Promise<number>;
  deviceAssetOf(digest: string): Promise<{
    origin: string;
    source_image_id: number | null;
    import_classification: string;
    created_at: number;
    residency: string;
  } | null>;
  protect(digest: string): Promise<LibraryActionResult>;
  download(digest: string): Promise<LibraryActionResult>;
  freeDeviceSpace(digest: string): Promise<LibraryActionResult>;
  streamFiles(): Promise<readonly string[]>;
  removeFromLibrary(digest: string): Promise<LibraryActionResult>;
  restore(digest: string): Promise<LibraryRestoreIntentResult>;
  sync(): ReturnType<LibrarySyncController['sync']>;
  recordOf(digest: string): Promise<{
    lifecycle: string;
    protection: string;
    generation: number;
    revision: number | null;
    originalGenerationId: string | null;
    thumbnailGenerationId: string | null;
    previewGenerationId: string | null;
    verifiedAt: number | null;
    appliedStateKey: string | null;
  } | null>;
  /**
   * The reconciliation head this device would decide its NEXT write against —
   * the value a lost note would regress, which the local projection can hide
   * (the apply writer's `excluded.revision > existing.revision` guard
   * swallows a stale re-projection).
   */
  head(digest: string): ReturnType<AppendLibraryReconciliationPort['getAssetHead']>;
  /** `state/` notes THIS device GET that it had written itself. */
  ownStateGets(): readonly string[];
  close(): void;
};

export async function createAppendDevice(input: AppendDeviceInput): Promise<AppendDevice> {
  const native = new DatabaseSync(':memory:');
  const database: SqlDatabasePort = createNodeSqliteAdapter(native);
  await migrateDatabase(database);

  const { clock } = input;
  const tag = writerTag(input.deviceId);
  // One shared store, seen through a per-device passthrough recorder: a note
  // path carries only its WRITER, so the shared `store.calls` cannot say which
  // device issued a read, and "did this device re-read its own note" is
  // exactly what this suite has to be able to ask.
  const gets: string[] = [];
  const store: CloudObjectStore = {
    ...input.store,
    async get(path) {
      gets.push(path);
      return input.store.get(path);
    },
  };
  // `selectLibraryCipher(meta.encryption)` for an 'aes-gcm' vault.
  const cipher = createLibraryObjectCipher();
  const filePort = withNodeStreamRoot(createFakeLibraryFilePort());
  const images = createImageRepository(database);
  const files = createLibraryFileStore({ port: filePort });

  const session = createByosLibrarySessionPort({
    vault: { meta: APPEND_TEST_META, masterKey: APPEND_TEST_MASTER_KEY, deviceId: input.deviceId },
  });

  // The append-only pair, wired exactly as the composition root's `store`
  // branch does: one reconciliation port, handed to the cloud client, over the
  // same durable ETag index the S3 stack uses.
  const reconciliation = createAppendLibraryReconciliationPort(
    store,
    bindLibraryRemoteStateIndex(
      createLibraryRemoteStateCacheRepository({ database }),
      async () => (await session.current())?.accountScope ?? null,
    ),
    { writer: input.deviceId, now: clock },
  );
  const cloud = createAppendLibraryCloudClient({
    store,
    reconciliation,
    decide: decideLibraryMutation,
    writer: input.deviceId,
    clock,
    now: () => new Date(clock()).toISOString(),
    // Same K6-2 wiring as the composition root: a blob is staged to a temp
    // file and streamed with `putFromFile`, reporting into the progress ring
    // the tile's percentage reads.
    blobStaging: createNodeBlobStaging(),
    transferProgress: libraryTransferProgress,
  });

  const protection = createLibraryProtectionRepository({ database });
  const repository = createLibraryRepository(database);
  const actionOutbox = createLibraryActionOutbox({
    database,
    newMutationId: () => randomUUID(),
  });

  const protectAction = createLibraryProtectAction({
    repository, protection, outbox: actionOutbox, files, cipher, cloud,
    reconciliation, session,
    // Only the ORIGINAL blob is uploaded, so each protect is exactly one blob
    // PUT followed by exactly one note PUT.
    derived: { async derive() { throw new Error('no derived in this gate'); } },
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
  const accountActions = createLibraryAccountActions({
    repository, protection, outbox: actionOutbox, files, cloud, session,
    protectAction, localActions,
  });

  const engine: LibrarySyncController = createLibrarySyncEngine({
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
        const stored = await images.saveMirroredCandidate(candidate, savedAt);
        return stored.id;
      },
    }),
    reconciler: createLibrarySyncReconciler({ database, protection, files }),
    outbox: createLibrarySyncOutbox({
      database,
      newMutationId: () => randomUUID(),
    }),
    pipelines: {
      retryProtect: async (digest) => { await protectAction.protect(digest); },
    },
    isProtectInFlight: (assetId) => protectAction.isInFlight(assetId),
    sweep: createLibraryDeviceTrashSweep({ database, protection, files: filePort }),
  });

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

  const ingest: AppendDevice['ingest'] = async (digest, bytes, options) => {
    const context = await ctx();
    const assetId = deriveLibraryAssetId(context.masterKey, digest);
    const uri = filePort.resolveOriginal(`${digest}.jpg`);
    filePort.files.set(uri, Uint8Array.from(bytes));
    const at = options?.collectedAt ?? Date.now();
    const importClassification = options?.importClassification ?? 'unknown';
    await database.run(
      `INSERT INTO device_library_assets (
         plaintext_sha256, format, canonical_extension, byte_size, width, height,
         origin, source_image_id, local_original_uri, residency, protect_eligible,
         missing_original_since, import_classification, created_at, updated_at
       ) VALUES (?, 'jpeg', 'jpg', ?, 64, 64, 'import', NULL, ?,
         'local-original', 1, NULL, ?, ?, ?)
       ON CONFLICT(plaintext_sha256) DO UPDATE SET
         local_original_uri = excluded.local_original_uri,
         residency = 'local-original', missing_original_since = NULL,
         import_classification = excluded.import_classification,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      [digest, bytes.byteLength, uri, importClassification, at, at],
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
       ON CONFLICT(account_scope, kind, asset_id) DO UPDATE SET
         local_metadata_json = excluded.local_metadata_json,
         updated_at = excluded.updated_at`,
      [
        randomUUID(), context.accountScope, context.deviceId, assetId,
        JSON.stringify({
          assetId, plaintextSha256: digest, format: 'jpeg', byteSize: bytes.byteLength,
          width: 64, height: 64, origin: 'import', sourceImageId: null, collectedAt: at,
          importClassification,
        }),
        at, at,
      ],
    );
  };

  const ingestCollected: AppendDevice['ingestCollected'] = async (
    digest,
    bytes,
    candidate,
    collectedAt = 1_700_000_000_000,
  ) => {
    await ingest(digest, bytes, { collectedAt });
    const stored = await images.saveCandidate(candidate, collectedAt);
    await database.run(
      `UPDATE device_library_assets
          SET origin = 'provider', source_image_id = ?, import_classification = 'unknown', created_at = ?
        WHERE plaintext_sha256 = ?`,
      [stored.id, collectedAt, digest],
    );
    await database.run(
      `INSERT OR REPLACE INTO library_provider_image_assets (
         image_id, plaintext_sha256, updated_at
       ) VALUES (?, ?, ?)`,
      [stored.id, digest, collectedAt],
    );
    const context = await ctx();
    const assetId = deriveLibraryAssetId(context.masterKey, digest);
    await database.run(
      `UPDATE library_outbox SET local_metadata_json = ?
        WHERE account_scope = ? AND asset_id = ? AND kind = 'collect'`,
      [
        JSON.stringify({
          assetId,
          plaintextSha256: digest,
          format: 'jpeg',
          byteSize: bytes.byteLength,
          width: 64,
          height: 64,
          origin: 'provider',
          sourceImageId: stored.id,
          collectedAt,
          importClassification: 'unknown',
        }),
        context.accountScope,
        assetId,
      ],
    );
    return stored.id;
  };

  const deviceAssetOf: AppendDevice['deviceAssetOf'] = (digest) =>
    database.getFirst(
      `SELECT origin, source_image_id, import_classification, created_at, residency
         FROM device_library_assets
        WHERE plaintext_sha256 = ?`,
      [digest],
    );

  const recordOf: AppendDevice['recordOf'] = async (digest) => {
    const context = await ctx();
    const assetId = deriveLibraryAssetId(context.masterKey, digest);
    return database.getFirst(
      `SELECT lifecycle, protection, generation, revision,
              original_generation_id AS originalGenerationId,
              thumbnail_generation_id AS thumbnailGenerationId,
              preview_generation_id AS previewGenerationId,
              verified_at AS verifiedAt,
              applied_state_key AS appliedStateKey
         FROM library_asset_protection
        WHERE account_scope = ? AND asset_id = ?`,
      [context.accountScope, assetId],
    );
  };

  return {
    database,
    cipher,
    ingest,
    ingestCollected,
    deviceAssetOf,
    protect: (digest) => protectAction.protect(digest),
    download: (digest) => localActions.download(digest),
    freeDeviceSpace: (digest) => localActions.freeDeviceSpace(digest),
    streamFiles: () => filePort.listStream(),
    removeFromLibrary: (digest) => accountActions.removeFromLibrary(digest),
    restore: (digest) => trashActions.restore(digest),
    sync: () => engine.sync(),
    recordOf,
    async head(digest) {
      const context = await ctx();
      return await reconciliation.getAssetHead(
        deriveLibraryAssetId(context.masterKey, digest),
      );
    },
    ownStateGets: () =>
      gets.filter((path) => {
        if (!path.startsWith(STATE_PREFIX)) return false;
        const parsed = parseNoteName(path.slice(STATE_PREFIX.length));
        return parsed !== null && parsed.writer === tag;
      }),
    close() { native.close(); },
  };
}

/** The vault-scoped id both devices derive for the same plaintext. */
export const assetIdOf = (digest: string): string =>
  deriveLibraryAssetId(APPEND_TEST_MASTER_KEY, digest);

/** The head note: the greatest `mutationId` wins (LWW, spec §3.1). */
export const headOf = <T extends { mutationId: string }>(notes: readonly T[]): T =>
  [...notes].sort((x, y) => (x.mutationId < y.mutationId ? 1 : -1))[0]!;

/** Every live `state/` note in the store, decoded from its NAME. */
/**
 * Every live `state/` note in a MEMORY store, decoded from its NAME, read off
 * the raw object map — deliberately NOT through `list()`, whose chaos lag is
 * exactly what the unit scenarios are exercising (a note must count as live
 * the moment it is written, listable or not).
 */
export const notesIn = (store: MemoryCloudObjectStore) =>
  [...store.objects().keys()]
    .filter((key) => key.startsWith(STATE_PREFIX))
    .map((key) => parseNoteName(key.slice(STATE_PREFIX.length)))
    .filter((note): note is NonNullable<typeof note> => note !== null);

/** The same view through the port's own listing — the only window a real backend offers (the WebDAV gate). */
export const listedNotesIn = async (store: Pick<CloudObjectStore, 'list'>) =>
  (await store.list('state'))
    .map((entry) => parseNoteName(entry.name))
    .filter((note): note is NonNullable<typeof note> => note !== null);
