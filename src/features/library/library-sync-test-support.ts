import {
  createActionsHarness,
  createFakeAccountState,
  TEST_ACCOUNT_SCOPE,
  type ActionsHarness,
  type FakeAccountState,
} from '@/features/library/library-actions-test-support';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import { createLibraryLocalActions } from '@/features/library/library-local-actions';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import { createLibrarySyncApplyWriter } from '@/features/library/library-sync-apply';
import { createLibrarySyncCursorStore } from '@/features/library/library-sync-cursors';
import {
  createLibrarySyncEngine,
  type LibrarySyncController,
  type LibrarySyncEngineDependencies,
} from '@/features/library/library-sync-engine';
import {
  createLibrarySyncOutbox,
  type LibrarySyncOutbox,
} from '@/features/library/library-sync-outbox';
import { createLibrarySyncReconciler } from '@/features/library/library-sync-reconciler';
import type { LibrarySyncReport } from '@/features/library/library-sync-types';
import { JPEG_FIXTURE } from '@/features/library/library-test-support';

/** Shared digest for SP9B permanent-delete / trash intent suites. */
export const DIGEST = 'a'.repeat(64);

/**
 * Actions harness with DIGEST seeded and projected. Default lifecycle is
 * trash (seed → sync → remote trash → sync). Pass `{ lifecycle: 'active' }`
 * to stop after the collect projection.
 *
 * `outbox` is a sync outbox over the same SQLite so tests can `listDue` the
 * engine's durable rows; it shadows the action outbox on the returned object.
 */
export type TrashedAssetHarness = Omit<ActionsHarness, 'outbox'> & {
  outbox: LibrarySyncOutbox;
  scope: string;
};

export async function harnessWithTrashedAsset(
  options: { lifecycle?: 'active' | 'trash' } = {},
): Promise<TrashedAssetHarness> {
  const harness = await createActionsHarness();
  await harness.seedLocalAsset({ plaintextSha256: DIGEST });
  await buildEngine(harness).sync();
  if ((options.lifecycle ?? 'trash') === 'trash') {
    harness.cloud.trashRemoteAsset(DIGEST);
    await buildEngine(harness).sync();
  }
  const outbox = createLibrarySyncOutbox({
    database: harness.database,
    newMutationId: () => 'unused',
    clock: () => harness.now,
  });
  return {
    ...harness,
    outbox,
    scope: TEST_ACCOUNT_SCOPE,
  };
}

/**
 * One engine construction shared by every SP8 suite, so the read half, the
 * write half, and the restore seam can never be tested against differently
 * wired engines. There is no retry-backoff seam to make deterministic any
 * more: K7 ⑬ deleted the backoff, so a failed row is simply due next round.
 */
export function buildEngine(
  harness: ActionsHarness,
  overrides: Partial<LibrarySyncEngineDependencies> = {},
): LibrarySyncController {
  const clock = () => harness.now;
  const cursors = createLibrarySyncCursorStore({
    database: harness.database,
    clock,
  });
  let sequence = 0;
  return createLibrarySyncEngine({
    session: harness.session,
    // BYOS: the write face is the S3 client, and change discovery is the
    // reconciliation port — there is no change feed to read.
    cloud: harness.s3,
    reconciliation: harness.reconciliation,
    cipher: harness.cipher,
    database: harness.database,
    cursors,
    apply: createLibrarySyncApplyWriter({
      database: harness.database,
      cipher: harness.cipher,
      clock,
    }),
    reconciler: createLibrarySyncReconciler({
      database: harness.database,
      protection: harness.protection,
      files: harness.files,
      clock,
    }),
    outbox: createLibrarySyncOutbox({
      database: harness.database,
      newMutationId: () => {
        sequence += 1;
        return `00000000-0000-4000-a000-${sequence.toString().padStart(12, '0')}`;
      },
      clock,
    }),
    clock,
    ...overrides,
  });
}

const FIXTURE_BYTES = new Map<string, Uint8Array>();

/**
 * A digest with real bytes behind it. `protect`, `download`, and the device
 * trash all re-hash the plaintext they hold, so a made-up 64-character digest
 * would fail integrity for the wrong reason and prove nothing about sync.
 */
export function digestFixture(label: string): string {
  const bytes = Uint8Array.from([
    ...JPEG_FIXTURE,
    ...[...label].map((character) => character.charCodeAt(0)),
  ]);
  const digest = sha256PlaintextHex(bytes);
  FIXTURE_BYTES.set(digest, bytes);
  return digest;
}

function bytesFor(plaintextSha256: string): Uint8Array {
  const bytes = FIXTURE_BYTES.get(plaintextSha256);
  if (bytes === undefined) {
    throw new Error(`No fixture bytes for ${plaintextSha256}.`);
  }
  return bytes;
}

/**
 * `harness.protectDependencies` defaults to an always-failing derived-image
 * double (the shared harness's baseline, exercising the "still protects on
 * the original alone" path most action-layer tests want). The two-device
 * suite needs the opposite: a working double, so `protect()` actually mints
 * and uploads thumbnail/preview blobs and both devices' generation-id triad
 * assertions have real, distinct ids to compare instead of two nulls.
 */
function workingLibraryDerivedImages(): LibraryDerivedImages {
  return {
    async derive() {
      return {
        thumbnail: {
          role: 'thumbnail',
          bytes: new Uint8Array([1, 2, 3]),
          width: 8,
          height: 8,
          format: 'webp',
        },
        preview: {
          role: 'preview',
          bytes: new Uint8Array([4, 5, 6, 7]),
          width: 16,
          height: 16,
          format: 'webp',
        },
        animated: false,
        failed: false,
      };
    },
  };
}

export type SyncDevice = Readonly<{
  name: 'A' | 'B';
  harness: ActionsHarness;
  engine: LibrarySyncController;
  /** One full cycle. Every scenario step is one of these. */
  sync(): Promise<LibrarySyncReport>;
  /** Cuts this device off without touching the shared account. */
  setOffline(offline: boolean): void;
  collect(plaintextSha256: string): Promise<unknown>;
  protect(plaintextSha256: string): Promise<unknown>;
  trash(plaintextSha256: string): Promise<unknown>;
  restore(plaintextSha256: string): Promise<unknown>;
  download(plaintextSha256: string): Promise<unknown>;
  lifecycleOf(plaintextSha256: string): Promise<string | null>;
  generationOf(plaintextSha256: string): Promise<number | null>;
  revisionOf(plaintextSha256: string): Promise<number | null>;
  /**
   * The content-addressed blob-id triad this device's protection row carries
   * for the asset, straight off `library_protections` — not a fresh read of
   * the remote state. On the minting device this is what it uploaded via
   * `putBlob`; on a reconciling device it is what its own sync/reconcile
   * pass wrote down after pulling the remote state. Comparing the two
   * proves the ids themselves — not just the numeric `generation` counter —
   * propagate device to device.
   */
  generationIdsOf(plaintextSha256: string): Promise<{
    thumbnail: string | null;
    preview: string | null;
    original: string | null;
  } | null>;
  hasLocalOriginal(plaintextSha256: string): Promise<boolean>;
  residencyOf(plaintextSha256: string): Promise<string | null>;
}>;

export type TwoDeviceHarness = Readonly<{
  account: FakeAccountState;
  a: SyncDevice;
  b: SyncDevice;
  /** Advances both devices' shared clock. */
  advance(ms: number): void;
  close(): void;
}>;

async function createDevice(
  name: 'A' | 'B',
  account: FakeAccountState,
  deviceId: string,
  mutationIdPrefix: string,
): Promise<SyncDevice> {
  const harness = await createActionsHarness({
    account,
    deviceId,
    mutationIdPrefix,
  });

  const clock = () => harness.now;
  const outbox = createLibrarySyncOutbox({
    database: harness.database,
    // A distinct prefix per device: the account stores one terminal result per
    // mutation id, so a collision would replay the other device's answer.
    newMutationId: (() => {
      let sequence = 0;
      return () => {
        sequence += 1;
        return `${mutationIdPrefix}${(500_000 + sequence).toString().padStart(12, '0')}`;
      };
    })(),
    clock,
  });
  const protectAction = createLibraryProtectAction({
    ...harness.protectDependencies,
    derived: workingLibraryDerivedImages(),
  });
  const localActions = createLibraryLocalActions(harness.localDependencies);

  const engine = buildEngine(harness, {
    outbox,
    pipelines: {
      // The one delegated case: a protect row that never reached its upload.
      retryProtect: async (digest) => { await protectAction.protect(digest); },
    },
    // K6-3a: the same ownership wiring the Direct composition uses, so these
    // scenarios exercise the real relationship between a live protect and the
    // drain rather than a differently-wired engine.
    isProtectInFlight: (assetId) => protectAction.isInFlight(assetId),
  });

  const readProtection = async (plaintextSha256: string) =>
    await harness.protection.findByDigest(harness.accountScope, plaintextSha256);

  return {
    name,
    harness,
    engine,
    sync: () => engine.sync(),
    setOffline(offline) { harness.cloud.offline = offline; },
    collect: (digest) => harness.ingest(digest, bytesFor(digest)),
    protect: (digest) => protectAction.protect(digest),
    /**
     * SP7's `removeFromLibrary` submits its own trash inside the action and
     * projects `trash` locally first, which would make every queued-intent
     * contract row below decide against a projection it had already written.
     * The rows are about what a *durable queued* trash does across one cycle,
     * so this writes exactly that row — the same shape `enqueueRestoreIntent`
     * writes for restore — and lets `sync()` own submission and reconciliation.
     */
    async trash(digest) {
      const record = await readProtection(digest);
      const assetId = harness.assetIdFor(digest);
      return await outbox.enqueue({
        accountScope: harness.accountScope,
        deviceId: harness.deviceId,
        assetId,
        kind: 'trash',
        baseRevision: record?.revision ?? null,
        observedGeneration: record?.generation ?? null,
        payload: {
          assetId,
          plaintextSha256: digest,
          kind: 'trash',
          reservationId: null,
          originalGenerationId: null,
          originalCiphertextBytes: null,
          queuedAt: harness.now,
        },
      });
    },
    restore: async (digest) => {
      const queued = await engine.enqueueRestoreIntent(digest);
      // The intent is durable; the next cycle submits it like any other row.
      await engine.sync();
      return queued;
    },
    download: (digest) => localActions.download(digest),
    async lifecycleOf(digest) {
      return (await readProtection(digest))?.lifecycle ?? null;
    },
    async generationOf(digest) {
      return (await readProtection(digest))?.generation ?? null;
    },
    async revisionOf(digest) {
      return (await readProtection(digest))?.revision ?? null;
    },
    async generationIdsOf(digest) {
      const record = await readProtection(digest);
      if (record === null) return null;
      return {
        thumbnail: record.thumbnailGenerationId,
        preview: record.previewGenerationId,
        original: record.originalGenerationId,
      };
    },
    async hasLocalOriginal(digest) {
      const row = await harness.database.getFirst<{
        local_original_uri: string | null;
      }>(
        'SELECT local_original_uri FROM device_library_assets WHERE plaintext_sha256 = ?',
        [digest],
      );
      return (row?.local_original_uri ?? null) !== null;
    },
    async residencyOf(digest) {
      const row = await harness.database.getFirst<{ residency: string }>(
        'SELECT residency FROM device_library_assets WHERE plaintext_sha256 = ?',
        [digest],
      );
      return row?.residency ?? null;
    },
  };
}

/**
 * Two devices of one private library: separate SQLite databases, separate file
 * stores, separate outboxes, separate cursors, one shared account. Both derive
 * the same account scope because they share one master key; only `deviceId`
 * differs, which is what makes the provenance assertions meaningful.
 */
export async function createTwoDeviceHarness(): Promise<TwoDeviceHarness> {
  const account = createFakeAccountState();
  // Not the `...-8000-` prefix: that is what the expo-crypto double's
  // `randomUUID` hands out, and a shared account keys results by mutation id.
  const a = await createDevice('A', account, 'device-a', '00000000-0000-4000-a000-');
  const b = await createDevice('B', account, 'device-b', '00000000-0000-4000-b000-');
  return {
    account,
    a,
    b,
    advance(ms) {
      a.harness.now += ms;
      b.harness.now += ms;
    },
    close() {
      a.harness.close();
      b.harness.close();
    },
  };
}
