import { randomUUID } from 'expo-crypto';

import type { SqlDatabasePort } from '@/db/sql-port';
import { createExpoFileRepository } from '@/features/collection/expo-file-repository';
import type { ImageRepository } from '@/features/images/image-repository';
import { cloudFetch } from '@/features/byos/cloud-fetch';
import { createS3Transport } from '@/features/byos/s3-transport';
import { selectDownloadFilePort } from '@/features/byos/s3-file-download';
import { selectUploadFilePort } from '@/features/byos/s3-file-transfer';
import type { VaultEncryption } from '@/features/byos/byos-vault-meta';
import {
  createLibraryAccountActions,
  type LibraryAccountActions,
} from '@/features/library/library-account-actions';
import { createByosLibraryAccountPort } from '@/features/library/library-account-port';
import { clearAccountProjection } from '@/features/library/library-account-projection';
import {
  createLibraryActionOutbox,
} from '@/features/library/library-action-outbox';
import {
  createExpoBackgroundTaskApi,
  createLibraryBackgroundSync,
} from '@/features/library/library-background-sync';
import {
  getLibraryBackgroundRound,
  holdLibrarySync,
  setLibraryBackgroundRound,
} from '@/features/library/library-background-sync-slot';
import type {
  LibraryActionResult,
} from '@/features/library/library-actions-types';
import {
  createLibraryActionsService,
} from '@/features/library/library-actions-service';
import {
  createLibraryBatchOrchestrator,
} from '@/features/library/library-batch-orchestrator';
import { createLibraryCacheStore } from '@/features/library/library-cache-store';
import {
  createLibraryChangeFeed,
  type LibraryChangeKind,
} from '@/features/library/library-change-feed';
import type { LibraryCollectionFilesPort } from '@/features/library/library-collection-handover';
import {
  createAppendLibraryCloudClient,
} from '@/features/library/library-cloud-client-append';
import {
  createS3LibraryCloudClient,
  type LibraryCloudClient,
} from '@/features/library/library-cloud-client-s3';
import {
  createLibraryDerivedImages,
} from '@/features/library/library-derived-images';
import { createLibraryDeviceTrashSweep } from '@/features/library/library-device-trash-sweep';
import {
  createExpoLibraryFilePort,
  createExpoLibraryFileStore,
} from '@/features/library/library-expo-file-store';
import { createExpoLibraryImageResizer } from '@/features/library/library-expo-image-resizer';
import {
  createLocalLibraryIntegration,
} from '@/features/library/library-integration-local-core';
import type {
  ByosResolvedContext,
  LibraryIntegration,
  LibraryIntegrationInput,
  LibraryStorageModeControl,
} from '@/features/library/library-integration-types';
import {
  createLibraryLocalActions,
  type LibraryLocalActions,
} from '@/features/library/library-local-actions';
import { selectFileDecryptor } from '@/features/library/library-file-decryptor';
import { createLibraryMirrorDown } from '@/features/library/library-mirror-down';
import { createMirrorDeadSavedImageIds } from '@/features/library/library-mirror-dead';
import { createLibraryMirrorUp } from '@/features/library/library-mirror-up';
import {
  createTransferCoalescer,
  type LibraryRoleFetch,
} from '@/features/library/library-transfer-coalescer';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import type { LibraryObjectCipher } from '@/features/library/library-object-crypto';
import { createLibraryObjectCipher } from '@/features/library/library-object-crypto';
import {
  createPassthroughLibraryCipher,
} from '@/features/library/library-passthrough-cipher';
import {
  createLibraryProtectAction,
  type LibraryProtectAction,
} from '@/features/library/library-protect-action';
import {
  createLibraryProtectResume,
} from '@/features/library/library-protect-resume';
import { readSourceMetadata } from '@/features/library/library-source-metadata';
import {
  createLibraryProtectionRepository,
} from '@/features/library/library-protection-repository';
import {
  createExpoLibraryReachability,
} from '@/features/library/library-reachability';
import {
  createAppendLibraryReconciliationPort,
  type AppendLibraryReconciliationPort,
} from '@/features/library/library-reconciliation-append';
import {
  createLibraryReaddAuthorityLookup,
} from '@/features/library/library-readd-authority';
import { parseNoteName } from '@/features/library/library-note-name';
import {
  createLibraryReconciliationPort,
  type LibraryReconciliationPort,
} from '@/features/library/library-reconciliation-port';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import {
  assessRemoveDeviceData,
  exportUnprotectedOriginals as exportUnprotectedOriginalsHelper,
  listRemoveDeviceDataRows,
  removeAccountDataFromThisDevice,
} from '@/features/library/library-remove-device-data';
import {
  createLibraryRenderReaders,
} from '@/features/library/library-render-source';
import { createLibraryRepository } from '@/features/library/library-repository';
import { createByosLibrarySessionPort } from '@/features/library/library-session-port';
import {
  createLibrarySyncApplyWriter,
} from '@/features/library/library-sync-apply';
import {
  createLibrarySyncCursorStore,
} from '@/features/library/library-sync-cursors';
import type { LibrarySyncController } from '@/features/library/library-sync-engine';
import { createLibrarySyncEngine } from '@/features/library/library-sync-engine';
import {
  createLibrarySyncOutbox,
} from '@/features/library/library-sync-outbox';
import {
  createLibrarySyncReconciler,
} from '@/features/library/library-sync-reconciler';
import { createLibrarySyncRound } from '@/features/library/library-sync-round';
import {
  createLibrarySyncTrigger,
} from '@/features/library/library-sync-triggers';
import {
  createLibraryTrashActions,
  type LibraryTrashActions,
} from '@/features/library/library-trash-actions';
import { libraryTransferProgress } from '@/features/library/library-transfer-progress';
import { createLibraryViewModel } from '@/features/library/library-view-model';
import { createLibraryEviction } from '@/features/library/library-eviction';
import {
  createLibraryLocalThumbnails,
  LIBRARY_THUMBNAIL_SOURCE_ORIGINAL_MAX_BYTES,
} from '@/features/library/library-local-thumbnails';
import {
  createLibraryStorageModeStore,
  type LibraryStorageModeStore,
} from '@/features/library/library-storage-mode';
import { createLibraryThumbnailPass } from '@/features/library/library-thumbnail-pass';
import {
  createSyncForegroundGuard,
} from '@/features/library/library-sync-foreground';
import {
  requestPostNotificationsPermission,
} from '@/features/library/library-sync-notifications';
import i18n from '@/i18n';

import { WaifuSyncService } from '../../../modules/waifu-sync-service';

/**
 * Cipher selection for a BYOS vault (decisions #14, #21).
 *
 * Encryption is fixed when the vault is created and lives in its vault-meta,
 * so this single dispatch decides the cipher for the whole composition; the
 * five consumers below (protect, local actions, render resolver, sync engine,
 * sync apply) all receive the same instance and never choose for themselves.
 *
 * **Safety line for the `'none'` pseudo masterKey.** An `encryption: 'none'`
 * session carries `sha256(utf8(vaultId))` as its masterKey so that identity,
 * scope, and asset-id derivation keep working with encryption off (decision
 * #21 — "no encryption" must not silently become "no sync"). That value is not
 * key material. It never reaches a real cipher because of this dispatch and
 * only this dispatch: `encryption: 'none'` is exactly the case that selects
 * the passthrough cipher, so the pseudo key is only ever handed to an
 * implementation that ignores it. The converse holds too — a real `'aes-gcm'`
 * vault always has a real `masterKey`, so the passthrough cipher can never be
 * paired with ciphertext.
 */
function selectLibraryCipher(encryption: VaultEncryption): LibraryObjectCipher {
  return encryption === 'none'
    ? createPassthroughLibraryCipher()
    : createLibraryObjectCipher();
}

/**
 * Adapts the sync engine's permanent-delete intent to the batch orchestrator's
 * per-item result, for the `'empty-trash'` batch kind.
 *
 * The batch enqueues intents; it does not confirm purges. That is the contract
 * `library-trash-actions.ts` documents for `emptyTrash` — one durable
 * permanent-delete outbox row per trashed asset, then a single sync cycle
 * drains them all. So this runner deliberately calls the intent queue rather
 * than `trashActions.permanentDelete` (which syncs per call, and would fire
 * one network cycle per asset), and a successful enqueue counts the item done.
 *
 * A lost session mid-drain is the one halting case: `auth_attention` pauses
 * the batch and leaves the remaining items `pending` for a later resume,
 * instead of marking a whole trash's worth of assets failed.
 */
function queuePermanentDelete(
  sync: Pick<LibrarySyncController, 'enqueuePermanentDeleteIntent'>,
): (plaintextSha256: string) => Promise<LibraryActionResult> {
  return async (plaintextSha256) => {
    const queued = await sync.enqueuePermanentDeleteIntent(plaintextSha256);
    if (queued.status === 'queued' || queued.status === 'already-queued') {
      return { status: 'applied' };
    }
    if (queued.reason === 'no_account') {
      return { status: 'blocked', category: 'auth_attention' };
    }
    // The asset left trash or vanished between listing and running: not this
    // batch's work any more, and not a failure.
    return { status: 'noop', reason: 'not-applicable' };
  };
}

/**
 * The BYOS cloud composition. Every remote port is built from the resolved
 * context's credentials, so this function performs no I/O of its own and no
 * async work: `createLibraryIntegration` stays synchronous (decision #23).
 */
function createByosLibraryIntegration(
  database: SqlDatabasePort,
  byos: ByosResolvedContext,
  images: ImageRepository | undefined,
  subscribeActiveDownloads:
    | ((listener: (count: number) => void) => () => void)
    | undefined,
  collectionFiles: LibraryCollectionFilesPort | undefined,
  storageModeStore: LibraryStorageModeStore | undefined,
): LibraryIntegration {
  const { meta, masterKey, deviceId } = byos;

  const port = createExpoLibraryFilePort();
  const files = createExpoLibraryFileStore({ port });
  const cache = createLibraryCacheStore({ database, files, port });
  const derived = createLibraryDerivedImages({
    resizer: createExpoLibraryImageResizer(port),
  });
  const reachability = createExpoLibraryReachability();

  const session = createByosLibrarySessionPort({
    vault: { meta, masterKey, deviceId },
  });

  // BYOS has no server-side change feed: every sync cycle lists per-asset
  // state through this port instead (protocol spec, "变更发现"). K7 cut 3: its
  // ETag index is durable, so a relaunch over an unchanged library costs one
  // LIST and no state reads at all instead of re-reading the whole bucket.
  // The scope comes from the session — the one production source for it.
  // Board #12: shared verbatim by both protocol stacks below — S3's CAS index
  // and the append-only port's name index are the same durable table.
  const remoteIndex = bindLibraryRemoteStateIndex(
    createLibraryRemoteStateCacheRepository({ database }),
    async () => (await session.current())?.accountScope ?? null,
  );

  // Board #12 (spec §7): a `kind: 'store'` context is bound to a cloud-drive
  // backend (WebDAV/OneDrive/Drive) — the append-only protocol v2 stack. The
  // `kind: 's3'` context is today's overwhelmingly common case, protocol v1's
  // S3-compatible CAS stack, kept byte-for-byte below so `S3FetchPort`'s
  // pooled-connection tuning and the k6-2 prewarm pin stay intact.
  let warmTransport: ReturnType<typeof createS3Transport> | null = null;
  let cloudClient: LibraryCloudClient;
  let reconciliation: LibraryReconciliationPort;
  let appendPort: AppendLibraryReconciliationPort | null = null;
  let prefix: string | null = null;
  if (byos.kind === 'store') {
    const appendReconciliation = createAppendLibraryReconciliationPort(
      byos.store,
      remoteIndex,
      { writer: deviceId },
    );
    appendPort = appendReconciliation;
    reconciliation = appendReconciliation;
    cloudClient = createAppendLibraryCloudClient({
      store: byos.store,
      reconciliation: appendReconciliation,
      decide: decideLibraryMutation,
      writer: deviceId,
      // K6-2 (spec §2 G3/G5): same staged-temp-file / transfer-progress wiring
      // as the S3 branch below, so the tile's percentage ring works
      // identically on every backend.
      blobStaging: port,
      transferProgress: libraryTransferProgress,
    });
  } else {
    const { credentials } = byos;
    prefix = credentials.prefix;
    // React Native's global fetch cannot stream request bodies and mangles
    // binary payloads; `expo/fetch` is the supported native client. Injected
    // here rather than defaulted inside the transport so unit tests and the
    // MinIO gate can substitute a plain fetch.
    const downloadFile = selectDownloadFilePort(WaifuSyncService);
    const transport = createS3Transport(credentials, {
      fetchImpl: cloudFetch,
      // K6-1g (K7 finding #36): `expo-file-system`'s upload task builds its own
      // OkHttp client and hardcodes 60 s timeouts, so it bypasses the K6-1d
      // IPv4-first pooled factory and kills slow-but-live uploads. The local
      // module's port uses the tuned client with no timeout; where it is not
      // linked in (Store, web, tests) this resolves to the expo path unchanged.
      uploadFile: selectUploadFilePort(WaifuSyncService),
      ...(downloadFile === null ? {} : { downloadFile }),
    });
    warmTransport = transport;
    reconciliation = createLibraryReconciliationPort(transport, prefix, remoteIndex);
    const cloud = createS3LibraryCloudClient({
      transport,
      prefix,
      decide: decideLibraryMutation,
      // K6-2 (spec §2 G3/G5): a blob PUT is staged to a cache temp file so the
      // native upload task can stream it and report `bytesSent` — the only
      // channel in SDK 56 that reports upload progress at all — and a blob GET
      // publishes the bytes arriving. Both feed the tile's percentage ring.
      blobStaging: port,
      transferProgress: libraryTransferProgress,
      // K7 cut 3: a committed CAS write already knows the key, the ETag it got
      // back, and the record it wrote, so change discovery never pays to be told
      // what this device just said.
      rememberState: (key, etag, record) => (
        reconciliation.remember(key, etag, record)
      ),
    });
    cloudClient = cloud;
  }
  // Alias on purpose: every read below stays `cloud`, and the else branch keeps its verbatim `const cloud = createS3LibraryCloudClient(` call that src/test/k6-2-progress-wiring.test.ts greps for — a "simplify" pass must not inline or delete either.
  const cloud = cloudClient;

  const cipher = selectLibraryCipher(meta.encryption);
  const decryptor = selectFileDecryptor({
    cipher,
    encryption: meta.encryption,
    native: WaifuSyncService,
    files: port,
  });
  const transferCoalescer = createTransferCoalescer<LibraryRoleFetch>();

  const protection = createLibraryProtectionRepository({ database });
  const outbox = createLibraryActionOutbox({
    database,
    newMutationId: () => randomUUID(),
  });
  const repository = createLibraryRepository(database);
  // K6-2b (spec §2 G3): the composition owns the "something settled" channel,
  // and every action surface below is handed out already decorated, so no
  // caller — the actions service, the batch orchestrator, mirror-up/down, the
  // sync engine's retry pipeline — has to remember to announce anything.
  const libraryChanges = createLibraryChangeFeed();
  const announce = <R,>(
    plaintextSha256: string,
    work: Promise<R>,
    changed: (result: R) => LibraryChangeKind | null,
    settled?: LibraryChangeKind,
  ): Promise<R> => {
    const emit = (kind: LibraryChangeKind): void => {
      libraryChanges.emit({ kind, plaintextSha256 });
    };
    return work.then(
      (result) => {
        const kind = changed(result);
        if (kind !== null) emit(kind);
        if (settled !== undefined) emit(settled);
        return result;
      },
      (error: unknown) => {
        // An upload that threw is still an upload that ended: the tile has to
        // leave its in-flight rendering either way. The rejection is re-thrown
        // untouched so every existing caller keeps its exact error behaviour.
        if (settled !== undefined) emit(settled);
        throw error;
      },
    );
  };
  const wasApplied = (
    kind: LibraryChangeKind,
  ): ((result: LibraryActionResult) => LibraryChangeKind | null) => (
    (result) => (result.status === 'applied' ? kind : null)
  );

  // Assigned after the foreground guard, below this declaration. `reenroll`,
  // the mirror-up pass and the missing-original pass read `integration`, and
  // each of those runs only after the assignment.
  let integration!: LibraryIntegration;
  const uploads = createLibraryProtectAction({
    repository, protection, outbox, files, cipher, decryptor, cloud, reconciliation,
    session, derived,
    // C3a: the provider row behind a collected asset, so the sealed envelope
    // carries what a receiving device needs to rebuild an ordinary collection
    // item. Same projection the sync engine's own seal site uses.
    readSource: (sourceImageId) => readSourceMetadata(database, sourceImageId),
    // K6-3a: rebuild a lost `collect` intent instead of recording the terminal
    // `object_missing`, which is retried and re-failed every round forever.
    // `integration` is assigned below and this only runs mid-protect, never
    // during build — the same deferred-closure shape `mirrorUp` uses.
    reenroll: async (plaintextSha256) => {
      await integration.libraryController?.enrollLocalAssetForAccount(
        plaintextSha256,
      );
    },
  });
  /**
   * K6-2b: the upload the owner watched go stale. `protected` says the bucket
   * now holds the original (the orange cloud); `protect-settled` fires however
   * the attempt ended, so a tile also leaves the K6-2 percentage ring on a
   * blocked, queued, or thrown attempt.
   *
   * Both entry points are wrapped because both are real entry points:
   * `applySavePolicyAfterIngest` is the save path and `protect` is the sync
   * round's. They do not double-announce — the wrapper delegates to the
   * undecorated action, whose `applySavePolicyAfterIngest` is what calls its
   * own `protect`. Two callers that join K6-1c's single in-flight upload do
   * each hear their own settle; that is one extra coalesced re-read, never a
   * missed one.
   */
  const protectAction: LibraryProtectAction = {
    ...uploads,
    protect: (digest) => announce(
      digest, uploads.protect(digest), wasApplied('protected'), 'protect-settled',
    ),
    applySavePolicyAfterIngest: (digest) => announce(
      digest,
      uploads.applySavePolicyAfterIngest(digest),
      wasApplied('protected'),
      'protect-settled',
    ),
  };
  const downloads = createLibraryLocalActions({
    repository,
    protection,
    outbox,
    files,
    cipher,
    decryptor,
    cloud,
    session,
    transferCoalescer,
  });
  // 「下凡」: a cloud-only original that just landed here changes what the tile
  // may render, so the grid re-reads instead of waiting for the next focus.
  const localActions: LibraryLocalActions = {
    ...downloads,
    download: (digest) => announce(
      digest, downloads.download(digest), wasApplied('downloaded'),
    ),
  };
  const removals = createLibraryAccountActions({
    repository, protection, outbox, files, cloud, session, protectAction,
    localActions,
  });
  // A trashed asset leaves the grid; that is a change the grid must see now.
  const accountActions: LibraryAccountActions = {
    ...removals,
    removeFromLibrary: (digest) => announce(
      digest, removals.removeFromLibrary(digest), wasApplied('trashed'),
    ),
  };
  const syncOutbox = createLibrarySyncOutbox({
    database,
    newMutationId: () => randomUUID(),
  });
  const syncCursors = createLibrarySyncCursorStore({ database });
  const sync = createLibrarySyncEngine({
    session,
    cloud,
    reconciliation,
    cipher,
    database,
    cursors: syncCursors,
    apply: createLibrarySyncApplyWriter({
      database,
      cipher,
      // C3b: bound only when the app supplied its repository. K2: the restored
      // row is written `mirrored` — its bytes are the library's — so the
      // collection sweeper never re-fetches it from the provider. A throw is
      // caught by the writer and leaves the pointer NULL for the next cycle.
      ...(images === undefined ? {} : {
        restoreImage: async (candidate, savedAt) => {
          const stored = await images.saveMirroredCandidate(candidate, savedAt);
          return stored.id;
        },
      }),
    }),
    reconciler: createLibrarySyncReconciler({ database, protection, files }),
    outbox: syncOutbox,
    pipelines: {
      // The one delegated case: a protect row that never reached its upload.
      retryProtect: async (digest) => { await protectAction.protect(digest); },
    },
    // K6-3a: an asset whose protect is uploading right now owns its own outbox
    // rows. Without this the drain replayed and then deleted them mid-upload,
    // taking the `collect` intent the live protect still needed.
    isProtectInFlight: (assetId) => uploads.isInFlight(assetId),
    sweep: createLibraryDeviceTrashSweep({
      database,
      protection,
      files: port,
    }),
  });
  // Ordering: the batch orchestrator is built before the trash actions, not
  // inline inside the actions service as it once was. `emptyTrash` drives an
  // `'empty-trash'` batch, and that batch's per-item runner enqueues through
  // the sync engine (see `queuePermanentDelete`) rather than calling back into
  // the trash actions — so the two stay a straight line instead of a cycle.
  const batches = createLibraryBatchOrchestrator({
    protection,
    session,
    runner: {
      protect: (digest) => protectAction.protect(digest),
      download: (digest) => localActions.download(digest),
      freeDeviceSpace: (digest) => localActions.freeDeviceSpace(digest),
      permanentDelete: queuePermanentDelete(sync),
    },
    database,
    newBatchId: () => randomUUID(),
  });
  const restores = createLibraryTrashActions({
    session,
    batches,
    sync,
  });
  // A restore is an accepted intent, not an applied mutation: `queued` and
  // `already-queued` both mean the asset is on its way back into the grid.
  const trashActions: LibraryTrashActions = {
    ...restores,
    restore: (digest) => announce(
      digest,
      restores.restore(digest),
      (result) => (
        result.status === 'queued' || result.status === 'already-queued'
          ? 'restored'
          : null
      ),
    ),
  };
  const libraryActions = createLibraryActionsService({
    protectAction,
    localActions,
    accountActions,
    trashActions,
    batches,
    session,
    sync,
    readMirrorCounts: (scope) => protection.countMirrorState(scope),
    countFailureCategory: (scope, category) => protection.countFailureCategory(scope, category),
  });

  const renderDependencies = {
    repository,
    protection,
    cache,
    cloud,
    derived,
    files: port,
    streams: files,
    decryptor,
    coalescer: transferCoalescer,
    reachability,
    session,
  };
  const { resolver, roles } = createLibraryRenderReaders(renderDependencies);
  const libraryView = {
    model: createLibraryViewModel({ database, session }),
    resolver,
    shareFiles: {
      stage: (sourceUri: string, fileName: string) =>
        files.stageShareCopy(sourceUri, fileName),
      release: (uri: string) => files.releaseShareCopy(uri),
    },
  };
  // One trigger instance, so app-state foreground and library-screen focus
  // share its throttle window. Unlike the pre-BYOS composition there is no
  // null-sync branch left to guard: a resolved context always yields an engine.
  //
  // Mirror C2a: after each sync cycle, automatically download every original
  // this device is still missing (cloud-only, or a local original the resume
  // pass flagged as gone — board #27 §5.2b), through a bounded-concurrency pool
  // (a ceiling, not a rate limit — no artificial throttle). It reuses the same
  // verified `download` action the batch path uses, listing candidates from the
  // protection repository under the current account scope.
  const mirrorDown = createLibraryMirrorDown({
    getAccountScope: () => libraryActions.getAccountScope(),
    listDownloadCandidates: (scope) => protection.listDownloadCandidates(scope),
    download: (digest) => localActions.download(digest),
  });
  // K1: before each sync's download pass, push this device's not-yet-mirrored
  // originals up. enrollMissing writes the collect intents protect needs, so it
  // runs first; both are idempotent, so re-running every cycle is safe and a
  // partially-failed batch simply resumes next cycle. `integration` is assigned
  // just below and this closure only runs at sync time, never during build.
  const mirrorUp = createLibraryMirrorUp({
    enrollMissing: async () => {
      await integration.libraryController?.enrollLocalAssetsForAccount();
    },
    getAccountScope: () => libraryActions.getAccountScope(),
    listProtectCandidates: (scope) => protection.listProtectCandidates(scope),
    protect: (digest) => protectAction.protect(digest),
  });
  // Board #27 S3 (spec §5.8): this phone's 本机存储 choice for this vault.
  const storageModes = storageModeStore ?? createLibraryStorageModeStore();
  const isCloudOnly = async (): Promise<boolean> => (
    (await storageModes.read(meta.vaultId)) === 'cloud-only'
  );
  // One ensure serves the thumbnail pass and the eviction, so the pass's skip
  // map and the ensure's single-flight slots each live once per composition.
  const localThumbnails = createLibraryLocalThumbnails({
    repository,
    files,
    port,
    derived,
    cloud: { session, roles, cache },
    originalByteLimit: LIBRARY_THUMBNAIL_SOURCE_ORIGINAL_MAX_BYTES,
  });
  const thumbnailPass = createLibraryThumbnailPass({
    database,
    thumbnails: localThumbnails,
  });
  const eviction = createLibraryEviction({
    database,
    files,
    port,
    repository,
    thumbnails: localThumbnails,
    fillDerived: (plaintextSha256) => uploads.fillDerived(plaintextSha256),
    isCloudOnly,
    // N6-A3 (spec §4.3, §4.9): compare the projection's applied authority and
    // verified original reference against the current discovered winner before
    // candidate selection and before the transactional residency flip.
    isAuthorityCurrent: async (accountScope, plaintextSha256) => {
      const proj = await protection.findByDigest(accountScope, plaintextSha256);
      if (
        proj === null
        || proj.protection !== 'protected'
        || proj.lifecycle !== 'active'
        || proj.verifiedAt === null
        || proj.originalGenerationId === null
      ) {
        return false;
      }
      if (appendPort !== null) {
        const head = await appendPort.getAssetHead(proj.assetId);
        if (head !== null) {
          const appliedNoteId =
            proj.appliedStateKey !== null
            && proj.appliedStateKey !== undefined
            && proj.appliedStateKey.startsWith('state/')
              ? parseNoteName(proj.appliedStateKey.slice('state/'.length))?.mutationId ?? null
              : null;
          if (appliedNoteId === null || appliedNoteId !== head.mutationId) {
            return false;
          }
          if (
            head.record.lifecycle !== 'active'
            || head.record.protection !== 'protected'
            || head.record.generation !== proj.generation
            || (head.record.generations.original ?? null) !== proj.originalGenerationId
          ) {
            return false;
          }
        }
        return true;
      }
      if (prefix !== null) {
        const key = `${prefix}assets/${proj.assetId}/state.json`;
        const cached = await database.getFirst<{ record_json: string }>(
          `SELECT record_json FROM library_remote_state_cache
            WHERE account_scope = ? AND key = ?`,
          [accountScope, key],
        );
        if (cached !== null) {
          try {
            const parsed = JSON.parse(cached.record_json) as {
              revision?: number;
              lifecycle?: string;
              protection?: string;
              generation?: number;
              generations?: { original?: string };
            };
            if (
              typeof parsed.revision === 'number'
              && proj.revision !== null
              && parsed.revision !== proj.revision
            ) {
              return false;
            }
            if (
              parsed.lifecycle !== 'active'
              || parsed.protection !== 'protected'
              || parsed.generation !== proj.generation
              || (parsed.generations?.original ?? null) !== proj.originalGenerationId
            ) {
              return false;
            }
          } catch {
            return false;
          }
        }
      }
      return true;
    },
    changes: libraryChanges,
  });
  // K4 §4.2/§4.7: one round is a best-effort upload pass (same swallow as the
  // old `afterCycle`) followed by the mode's second half (spec §5.11): the
  // download pass in 本地+云端, thumbnails and eviction in 仅云端. Its result
  // is returned instead of discarded so `runToEmpty` can drive it to a clean
  // state.
  const round = createLibrarySyncRound({
    mirrorUp,
    mirrorDown,
    thumbnailPass,
    eviction,
    isCloudOnly,
    getAccountScope: () => libraryActions.getAccountScope(),
  });
  const librarySyncTrigger = createLibrarySyncTrigger({
    sync,
    round,
    // K6-1d (spec §1 F4 / §4.5): a session has just opened and the first real
    // upload is moments away, so open the connection now rather than making
    // that upload pay a cold DNS+TCP+TLS handshake (10–85 s measured on the
    // owner's network). `.warm` is not expected to exist — the 404 is free and
    // the established, pooled connection is the whole point. Fire-and-forget:
    // nothing awaits it and a failure is not this device's problem, because the
    // next real request simply opens its own connection as it does today.
    prewarm: () => {
      // Board #12: absent on the append-only stack (no long-lived connection
      // to warm — each CloudObjectStore call is its own request), so this is
      // a no-op there rather than the S3-only DNS+TCP+TLS warmup below.
      if (warmTransport === null || prefix === null) return;
      void warmTransport.getObject(`${prefix}.warm`).catch(() => undefined);
    },
  });
  // K6-2b: the K4b settings signal, now delivered through the same feed as the
  // per-asset ones, so the settings section has one subscription instead of a
  // second, differently-shaped one. Never unsubscribed: the trigger and the
  // feed are both owned by this composition and die together with it.
  librarySyncTrigger.onRoundComplete(() => {
    libraryChanges.emit({ kind: 'round-complete' });
    // K6-5 C: a round has just walked the library, so this is the cheapest
    // moment to notice a collected original that never became one. `integration`
    // is assigned below and this only runs after a round, never during build —
    // the same deferred-closure shape `mirrorUp` and `reenroll` use.
    void integration.libraryController?.reingestMissingLibraryRows()
      .catch(() => undefined);
  });
  // Board #27 S3 (spec §5.10): in 仅云端 a hand-over makes a row evictable; a
  // new save's own round may have passed its eviction before the hand-over
  // landed, so start one (the trigger coalesces bursts).
  libraryChanges.subscribe((change) => {
    if (change.kind !== 'handed-over') return;
    void isCloudOnly().then((cloudOnly) => {
      if (cloudOnly) librarySyncTrigger.onLibraryChanged();
    }, () => undefined);
  });
  const libraryStorageMode: LibraryStorageModeControl = {
    read: () => storageModes.read(meta.vaultId),
    async set(mode) {
      await storageModes.write(meta.vaultId, mode);
      // Spec §5.10 / §5.13: turning 仅云端 on evicts, switching back downloads.
      librarySyncTrigger.onLibraryChanged();
    },
  };
  // K6-3: while anything is uploading, a `dataSync` foreground service keeps
  // this process from being frozen. Measured 2026-09-14 02:30: three saves,
  // screen locked 1.5 s later, 0 of 3 in the bucket 90 s on — Android had
  // stopped scheduling the JS thread.
  // Board #28: unlike the feed and the trigger (which die with this
  // composition), the guard subscribes to the process-wide
  // `libraryTransferProgress`, so it outlives the composition unless released.
  // Two live guards both `stop()` on a drain. The native service enters the
  // foreground before it handles STOP, so a second stop does not kill the
  // process, but it can still end the service while another guard's batch
  // runs. The bundle closer therefore calls `libraryDispose`. A throw after
  // the guard exists releases it here, before the local-core fallback.
  const foregroundGuard = WaifuSyncService !== null
    ? createSyncForegroundGuard({
      service: WaifuSyncService,
      store: libraryTransferProgress,
      t: (key, values) => i18n.t(key, values ?? {}),
      requestPermission: requestPostNotificationsPermission,
      // K6-5 B: the booru download is the first half of the same save, and the
      // lock screen froze it (emulator-proven). One count, same guard.
      subscribeActiveDownloads,
    })
    : null;
  let libraryDisposed = false;
  const libraryDispose = (): void => {
    if (libraryDisposed) return;
    libraryDisposed = true;
    foregroundGuard?.dispose();
  };
  try {
    // K4 §4.5: the background task executor reads this module-level slot
    // (`library-background-sync-slot.ts`) because `TaskManager.defineTask` runs
    // in the global scope, before any composition exists to inject into it. A
    // background wakeup's round also runs `sync.sync()` first, mirroring the
    // foreground trigger's own cycle shape.
    setLibraryBackgroundRound(async () => {
      await sync.sync();
      return round();
    });

    integration = createLocalLibraryIntegration({
      database,
      account: createByosLibraryAccountPort(session),
      // K6-5 C: so an ingest that throws is written to `images.library_error`
      // instead of leaving a `ready` row that never entered the library.
      images,
      lookupReaddAuthority: createLibraryReaddAuthorityLookup({
        database,
        session,
        reconciliation,
        cipher,
        ...(images === undefined ? {} : {
          restoreImage: async (candidate, savedAt) => {
            const stored = await images.saveMirroredCandidate(candidate, savedAt);
            return stored.id;
          },
        }),
        unavailableReason: byos.kind === 'store' && byos.binding.kind !== 'webdav'
          ? 'reauth_required'
          : 'network',
      }),
      libraryActions,
      librarySync: sync,
      libraryView,
      libraryCache: cache,
      librarySyncTrigger,
      // K4 §4.5/§4.7: Direct owns the native background-task modules; app-services
      // only ever sees this port, so Store never bundles them.
      libraryBackgroundSync: createLibraryBackgroundSync({
        api: createExpoBackgroundTaskApi(),
        getRound: getLibraryBackgroundRound,
      }),
      onIngestOutcome: (outcome) => {
        // Design step 9. Fire-and-forget: the local asset is already durable.
        // The seam only reports new collections; this second check keeps the
        // no-silent-migration rule true even if that ever changes.
        if (outcome.status !== 'ingested') return;
        void libraryActions
          .applySavePolicyAfterIngest(outcome.asset.plaintextSha256)
          .catch(() => undefined);
        // K4 G2: a favorited/imported asset should start heading to the bucket
        // without waiting for the next screen focus or app-state transition.
        librarySyncTrigger.onLibraryChanged();
        // K6-2b: and the grid should show it now, not at the next focus. The
        // tile mounts knowing its digest, which is what the K6-2 ring is keyed
        // on, so the upload it just started is visible from its first byte.
        libraryChanges.emit({
          kind: 'ingested',
          plaintextSha256: outcome.asset.plaintextSha256,
        });
      },
      libraryChanges,
      collectionFiles,
      // Board #24 (spec §5.4.2 steps 3 and 6): the BYOS half of a rewound save's
      // purge. An upload of the same bytes that is already running lands before
      // the rows it writes to are deleted, and the decrypted roles leave the
      // cache; afterwards a mounted grid and the settings counts re-read. The
      // cloud copy itself stays until row 25.
      collectedPurgeHooks: {
        before: async ({ plaintextSha256 }) => {
          await uploads.settled(plaintextSha256);
          const context = await session.current();
          if (context !== null) await cache.forget(context.accountScope, plaintextSha256);
        },
        after: ({ plaintextSha256 }) => {
          libraryChanges.emit({ kind: 'purged', plaintextSha256 });
        },
      },
      // Board #27 (spec §5.4 steps 1, 3, 6): stop sync, then the uploads an
      // ingest started outside a round. On retire the trigger is disposed and
      // the background slot cleared before the lease is released — disconnected:
      // this in-memory session would sync the forgotten library straight back
      // (spec E-row 33); app-services recomposes.
      resetHooks: {
        hold: async () => {
          const release = await holdLibrarySync();
          return {
            settleUploads: () => uploads.settledAll(),
            end: ({ retire }) => {
              try {
                if (retire) {
                  librarySyncTrigger.dispose();
                  setLibraryBackgroundRound(null);
                }
              } finally {
                release();
              }
            },
          };
        },
      },
    });

    const baseController = integration.libraryController;
    if (
      baseController == null
      || integration.libraryActions == null
      || integration.libraryView == null
    ) {
      // A private-storage failure is a local shell with null surfaces. The
      // vault marker and the guard belong to a real composition, so they are
      // released here instead of being published on that shell.
      try {
        foregroundGuard?.dispose();
      } catch {
        // The local shell still has to come up.
      }
      setLibraryBackgroundRound(null);
      return integration;
    }

    let exportToPhotos: (uri: string) => Promise<void>;
    try {
      const collectionFiles = createExpoFileRepository();
      exportToPhotos = (uri) => collectionFiles.exportToPhotos(uri);
    } catch {
      exportToPhotos = async () => {
        throw new Error('Export to Photos is unavailable.');
      };
    }

    return {
      ...integration,
      libraryDispose,
      libraryStorageMode,
      libraryController: {
        ...baseController,
        clearAccountProjection: (accountScope) => (
          clearAccountProjection(database, accountScope)
        ),
        // N10 T1: the sweep's dead-mirrored-row query, session-scoped — the
        // committed cloud generation the local core's answer cannot see
        // counts here, so this overrides the inherited local selector.
        listMirrorDeadSavedImageIds: createMirrorDeadSavedImageIds({
          database,
          session,
        }),
        // N10 T2: the resume chain's re-protect pass, overriding the local
        // core's 0 — the committed cloud state only this core can see decides
        // what is already protected. Its own session guard answers 0 while no
        // session is held, and a mid-pass session death blocks durably inside
        // the protect action instead.
        reprotectUncommittedOriginals: createLibraryProtectResume({
          database,
          session,
          protect: (plaintextSha256) => protectAction.protect(plaintextSha256),
        }),
        assessRemoveDeviceData: async () => {
          const scope = await libraryActions.getAccountScope();
          if (scope === null) {
            return {
              affectedOriginals: 0,
              unprotectedCount: 0,
              unprotectedDigests: [],
            };
          }
          return assessRemoveDeviceData({
            rows: await listRemoveDeviceDataRows(database, scope),
          });
        },
        removeAccountDataFromThisDevice: async () => {
          const scope = await libraryActions.getAccountScope();
          if (scope === null) {
            return { status: 'removed', deletedOriginals: 0 };
          }
          return removeAccountDataFromThisDevice({
            database,
            accountScope: scope,
            originalsRootUri: port.originalsRootUri,
            deleteOriginal: (uri) => files.deleteOriginal(uri),
            clearCacheScope: (s) => cache.clearScope(s),
            // BYOS has no account to sign out of. The vault session is derived
            // from the injected context and lives only as long as this process,
            // so removing this device's data ends it by construction; forgetting
            // the stored bucket credentials is a separate, explicit P4 action.
            signOut: async () => undefined,
          });
        },
        exportUnprotectedOriginals: async () => {
          const scope = await libraryActions.getAccountScope();
          if (scope === null) return { exported: 0 };
          return exportUnprotectedOriginalsHelper({
            database,
            accountScope: scope,
            exportToPhotos,
          });
        },
      },
    };
  } catch (error) {
    try {
      foregroundGuard?.dispose();
    } catch {
      // The local-core fallback still has to come up.
    }
    setLibraryBackgroundRound(null);
    throw error;
  }
}

/**
 * Direct-build library composition. With no resolved BYOS context it is the
 * local-only core. A ready vault context builds the cloud integration on that
 * core.
 *
 * A construction failure falls back to that same local core rather than
 * propagating: the durable local library is the product, and it must not
 * become unusable because a bucket, a native storage module, or a malformed
 * vault-meta is unavailable. (The pre-BYOS composition guarded only the
 * native-module constructors this way; the whole cloud stack is now covered,
 * since none of it is load-bearing for local use.)
 */
export function createLibraryIntegration({
  database,
  byos = null,
  images,
  collectionFiles,
  subscribeActiveDownloads,
  localUnavailableCategory,
  byosStatus,
  storageModeStore,
}: LibraryIntegrationInput): LibraryIntegration {
  if (byos === null || byos === undefined) {
    return createLocalLibraryIntegration({
      database,
      images,
      collectionFiles,
      localUnavailableCategory,
      byosStatus,
    });
  }
  try {
    return createByosLibraryIntegration(
      database,
      byos,
      images,
      subscribeActiveDownloads,
      collectionFiles,
      storageModeStore,
    );
  } catch {
    return createLocalLibraryIntegration({
      database,
      images,
      collectionFiles,
      localUnavailableCategory,
      byosStatus,
    });
  }
}
