import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import {
  createLibrarySyncReconciler,
  planLibrarySyncFileAction,
  type LibrarySyncReconciler,
} from '@/features/library/library-sync-reconciler';

const DIGEST = 'e'.repeat(64);
const BYTES = Uint8Array.from([7, 7, 7, 7]);
const ORIGINAL_URI = `file:///data/library/originals/${DIGEST}.jpg`;
const TRASH_URI = `file:///data/library/trash/${DIGEST}.jpg`;

let harness: ActionsHarness;
let reconciler: LibrarySyncReconciler;
let now: number;

async function setLifecycle(
  lifecycle: 'active' | 'trash' | 'purged',
  protection: 'unprotected' | 'protected' = 'unprotected',
): Promise<void> {
  await harness.protection.upsertProtection({
    accountScope: TEST_ACCOUNT_SCOPE,
    assetId: harness.assetIdFor(DIGEST),
    plaintextSha256: DIGEST,
    lifecycle,
    protection,
    generation: 1,
    revision: 5,
    originalGenerationId: null,
    originalCiphertextBytes: null,
    thumbnailGenerationId: null,
    previewGenerationId: null,
    verifiedAt: null,
    failureCategory: null,
    trashedAt: lifecycle === 'trash' ? 100 : null,
  });
}

beforeEach(async () => {
  harness = await createActionsHarness();
  now = 8_000;
  reconciler = createLibrarySyncReconciler({
    database: harness.database,
    protection: harness.protection,
    files: harness.files,
    clock: () => now,
  });
});

afterEach(() => {
  harness.close();
});

describe('library sync file action plan', () => {
  it('maps each authoritative lifecycle to exactly one safe action', () => {
    expect(planLibrarySyncFileAction({
      plaintextSha256: DIGEST,
      lifecycle: 'trash',
      localOriginalUri: ORIGINAL_URI,
      deviceTrashUri: null,
    })).toEqual({
      kind: 'move-to-device-trash',
      plaintextSha256: DIGEST,
      fromUri: ORIGINAL_URI,
    });
    expect(planLibrarySyncFileAction({
      plaintextSha256: DIGEST,
      lifecycle: 'active',
      localOriginalUri: null,
      deviceTrashUri: TRASH_URI,
    })).toEqual({
      kind: 'restore-from-device-trash',
      plaintextSha256: DIGEST,
      fromUri: TRASH_URI,
    });
    expect(planLibrarySyncFileAction({
      plaintextSha256: DIGEST,
      lifecycle: 'purged',
      localOriginalUri: null,
      deviceTrashUri: TRASH_URI,
    })).toEqual({
      kind: 'delete-device-trash',
      plaintextSha256: DIGEST,
      uri: TRASH_URI,
    });
  });

  it('plans nothing destructive for a purged asset with no trash bytes', () => {
    expect(planLibrarySyncFileAction({
      plaintextSha256: DIGEST,
      lifecycle: 'purged',
      localOriginalUri: ORIGINAL_URI,
      deviceTrashUri: null,
    })).toBeNull();
    expect(planLibrarySyncFileAction({
      plaintextSha256: DIGEST,
      lifecycle: 'trash',
      localOriginalUri: null,
      deviceTrashUri: null,
    })).toBeNull();
    expect(planLibrarySyncFileAction({
      plaintextSha256: DIGEST,
      lifecycle: 'active',
      localOriginalUri: ORIGINAL_URI,
      deviceTrashUri: null,
    })).toBeNull();
  });
});

describe('library sync reconciler', () => {
  it('moves a protected original into the device trash on a trash revision', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await setLifecycle('trash', 'protected');

    await expect(
      reconciler.reconcile(TEST_ACCOUNT_SCOPE),
    ).resolves.toMatchObject({ movedToDeviceTrash: 1, refused: 0, failed: 0 });

    expect(harness.port.files.has(ORIGINAL_URI)).toBe(false);
    expect(harness.port.files.has(TRASH_URI)).toBe(true);
    await expect(
      harness.protection.readDeviceState(DIGEST),
    ).resolves.toMatchObject({ deviceTrashUri: TRASH_URI, deviceTrashedAt: now });
    await expect(harness.database.getFirst(
      `SELECT residency, local_original_uri FROM device_library_assets
        WHERE plaintext_sha256 = ?`,
      [DIGEST],
    )).resolves.toEqual({ residency: 'cached', local_original_uri: null });
  });

  it('restores device-trash bytes when the account restores the asset', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await setLifecycle('trash');
    await reconciler.reconcile(TEST_ACCOUNT_SCOPE);
    await setLifecycle('active');

    await expect(
      reconciler.reconcile(TEST_ACCOUNT_SCOPE),
    ).resolves.toMatchObject({ restoredFromDeviceTrash: 1 });

    expect(harness.port.files.has(ORIGINAL_URI)).toBe(true);
    await expect(
      harness.protection.readDeviceState(DIGEST),
    ).resolves.toMatchObject({ deviceTrashUri: null, deviceTrashedAt: null });
    await expect(harness.database.getFirst(
      `SELECT residency, local_original_uri FROM device_library_assets
        WHERE plaintext_sha256 = ?`,
      [DIGEST],
    )).resolves.toEqual({
      residency: 'local-original',
      local_original_uri: ORIGINAL_URI,
    });
  });

  it('deletes only device-trash bytes on an authoritative purge', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await setLifecycle('trash');
    await reconciler.reconcile(TEST_ACCOUNT_SCOPE);
    await setLifecycle('purged');

    await expect(
      reconciler.reconcile(TEST_ACCOUNT_SCOPE),
    ).resolves.toMatchObject({ purgedDeviceTrash: 1, refused: 0 });

    expect(harness.port.files.has(TRASH_URI)).toBe(false);
    await expect(
      harness.protection.readDeviceState(DIGEST),
    ).resolves.toMatchObject({ deviceTrashUri: null });
  });

  it('never deletes a durable local original on a purge', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await setLifecycle('purged');

    await expect(
      reconciler.reconcile(TEST_ACCOUNT_SCOPE),
    ).resolves.toMatchObject({ purgedDeviceTrash: 0, refused: 0, failed: 0 });
    expect(harness.port.files.has(ORIGINAL_URI)).toBe(true);
  });

  it('refuses a device-trash delete that points at the durable original', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await setLifecycle('purged');
    // A corrupted sidecar claims the durable original is the trash copy.
    await harness.protection.setDeviceTrash(DIGEST, ORIGINAL_URI, 1);

    await expect(
      reconciler.reconcile(TEST_ACCOUNT_SCOPE),
    ).resolves.toMatchObject({ purgedDeviceTrash: 0, refused: 1 });
    expect(harness.port.files.has(ORIGINAL_URI)).toBe(true);
    await expect(
      harness.protection.readDeviceState(DIGEST),
    ).resolves.toMatchObject({ deviceTrashUri: ORIGINAL_URI });
  });

  it('never sets verified_at and never evicts', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await setLifecycle('trash', 'protected');
    await reconciler.reconcile(TEST_ACCOUNT_SCOPE);
    await expect(
      harness.protection.findByAssetId(
        TEST_ACCOUNT_SCOPE,
        harness.assetIdFor(DIGEST),
      ),
    ).resolves.toMatchObject({ verifiedAt: null });
  });

  it('counts a storage failure without losing the sidecar', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await setLifecycle('trash');
    harness.port.failMoves = true;

    await expect(
      reconciler.reconcile(TEST_ACCOUNT_SCOPE),
    ).resolves.toMatchObject({ movedToDeviceTrash: 0, failed: 1 });
    expect(harness.port.files.has(ORIGINAL_URI)).toBe(true);
    await expect(harness.database.getFirst(
      'SELECT local_original_uri FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST],
    )).resolves.toEqual({ local_original_uri: ORIGINAL_URI });
  });

  it('is idempotent across repeated cycles', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await setLifecycle('trash');
    await reconciler.reconcile(TEST_ACCOUNT_SCOPE);
    await expect(
      reconciler.reconcile(TEST_ACCOUNT_SCOPE),
    ).resolves.toEqual({
      movedToDeviceTrash: 0,
      restoredFromDeviceTrash: 0,
      purgedDeviceTrash: 0,
      refused: 0,
      failed: 0,
    });
  });
});
