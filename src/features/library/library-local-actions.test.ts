import {
  createJsFileDecryptor,
  LibraryLocalStorageError,
} from '@/features/library/library-file-decryptor';
import {
  createTransferCoalescer,
  type LibraryRoleFetch,
} from '@/features/library/library-transfer-coalescer';

jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

/**
 * Counts every `sha256PlaintextHex` call made through the real module during a
 * test. K6-1f: `download` verifies the decrypted original against its known
 * digest, and on Hermes (no JIT) that pure-JS @noble hash is seconds of JS
 * thread for a multi-MB image — a hang the user sees as a frozen app. The
 * verification itself stays; only its engine changes, so the count must be
 * zero. The wrapper delegates to the real implementation, so this file's own
 * expected-value computations keep their behaviour.
 */
const mockShaCalls = { count: 0 };
jest.mock('@/features/library/library-identity', () => {
  const actual = jest.requireActual('@/features/library/library-identity');
  return {
    ...actual,
    sha256PlaintextHex: (plaintext: Uint8Array): string => {
      mockShaCalls.count += 1;
      return actual.sha256PlaintextHex(plaintext);
    },
  };
});

import { sha256PlaintextHex } from '@/features/library/library-identity';
import {
  createLibraryLocalActions,
  type LibraryLocalActions,
} from '@/features/library/library-local-actions';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import {
  createActionsHarness,
  createFailingLibraryDerivedImages,
  TEST_ACCOUNT_SCOPE,
  TEST_DEVICE_ID,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const bytes = Uint8Array.from([3, 1, 4, 1, 5, 9]);
const digest = sha256PlaintextHex(bytes);

let harness: ActionsHarness;
let actions: LibraryLocalActions;

function build(current: ActionsHarness): LibraryLocalActions {
  return createLibraryLocalActions({
    repository: current.repository,
    protection: current.protection,
    outbox: current.outbox,
    files: current.files,
    cipher: current.cipher,
    decryptor: current.decryptor,
    cloud: current.s3,
    session: { async current() { return current.session.value; } },
    transferCoalescer: current.localDependencies.transferCoalescer,
    clock: current.clock,
  });
}

async function protectAndVerify(current: ActionsHarness): Promise<void> {
  const protect = createLibraryProtectAction({
    repository: current.repository,
    protection: current.protection,
    outbox: current.outbox,
    files: current.files,
    cipher: current.cipher,
    cloud: current.s3,
    reconciliation: current.reconciliation,
    session: { async current() { return current.session.value; } },
    derived: createFailingLibraryDerivedImages(),
    readSource: current.protectDependencies.readSource,
    clock: current.clock,
    newGenerationId: current.newGenerationId,
  });
  expect(await protect.protect(digest)).toEqual({ status: 'applied' });
}

async function projectTrash(
  current: ActionsHarness,
  residency: 'local-original' | 'cloud-only',
): Promise<void> {
  const record = await current.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
  expect(record).not.toBeNull();
  await current.protection.upsertProtection({
    accountScope: TEST_ACCOUNT_SCOPE,
    assetId: record!.assetId,
    plaintextSha256: digest,
    lifecycle: 'trash',
    protection: 'protected',
    generation: record!.generation,
    revision: record!.revision,
    originalGenerationId: record!.originalGenerationId,
    originalCiphertextBytes: record!.originalCiphertextBytes,
    thumbnailGenerationId: record!.thumbnailGenerationId,
    previewGenerationId: record!.previewGenerationId,
    verifiedAt: record!.verifiedAt,
    failureCategory: null,
    trashedAt: current.clock(),
  });
  if (residency === 'cloud-only') {
    const local = await current.repository.findLocalAsset(digest);
    if (local?.localOriginalUri != null) {
      await current.files.deleteOriginal(local.localOriginalUri);
    }
    await current.protection.setResidency(digest, 'cloud-only', null);
  }
}

async function enqueueUnknownDestructive(
  current: ActionsHarness,
  kind: 'stop-protection' | 'trash',
): Promise<void> {
  const assetId = current.assetIdFor(digest);
  const record = await current.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId);
  const queued = await current.outbox.enqueue({
    accountScope: TEST_ACCOUNT_SCOPE,
    deviceId: TEST_DEVICE_ID,
    assetId,
    kind,
    baseRevision: record?.revision ?? null,
    observedGeneration: record?.generation ?? null,
    payload: {
      assetId,
      plaintextSha256: digest,
      kind,
      reservationId: null,
      originalGenerationId: record?.originalGenerationId ?? null,
      originalCiphertextBytes: null,
      queuedAt: current.clock(),
    },
  });
  await current.outbox.markOutcomeUnknown(queued.mutationId, 'offline');
}

beforeEach(async () => {
  resetExpoCryptoDouble();
  harness = await createActionsHarness();
  actions = build(harness);
  await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
});

afterEach(() => {
  harness.close();
});

describe('free device space', () => {
  it('refuses before the original is committed and verified', async () => {
    expect(await actions.freeDeviceSpace(digest)).toEqual({
      status: 'blocked', category: 'object_missing',
    });
    const uri = `file:///data/library/originals/${digest}.jpg`;
    expect(harness.port.files.has(uri)).toBe(true);
  });

  it('evicts only the local file, makes no account mutation, and keeps the cloud copy', async () => {
    await protectAndVerify(harness);
    const before = harness.cloud.submitted.length;
    expect(await actions.freeDeviceSpace(digest)).toEqual({ status: 'applied' });
    const local = await harness.repository.findLocalAsset(digest);
    expect(local?.residency).toBe('cloud-only');
    expect(local?.localOriginalUri).toBeNull();
    expect(harness.port.files.has(`file:///data/library/originals/${digest}.jpg`))
      .toBe(false);
    expect(harness.cloud.submitted.length).toBe(before);
    expect(await harness.outbox.list(TEST_ACCOUNT_SCOPE)).toEqual([]);
    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record).toMatchObject({ protection: 'protected' });
    expect(record?.verifiedAt).not.toBeNull();
  });

  it('blocks eviction when stop-protection outcome is unknown', async () => {
    await protectAndVerify(harness);
    await enqueueUnknownDestructive(harness, 'stop-protection');
    expect(await actions.freeDeviceSpace(digest)).toEqual({
      status: 'blocked', category: 'stale_client',
    });
    expect(harness.port.files.has(`file:///data/library/originals/${digest}.jpg`))
      .toBe(true);
    expect(await actions.availableActions(digest)).toEqual([
      'stop-protection', 'remove',
    ]);
  });

  it('blocks eviction when trash outcome is unknown', async () => {
    await protectAndVerify(harness);
    await enqueueUnknownDestructive(harness, 'trash');
    expect(await actions.freeDeviceSpace(digest)).toEqual({
      status: 'blocked', category: 'stale_client',
    });
    expect(harness.port.files.has(`file:///data/library/originals/${digest}.jpg`))
      .toBe(true);
    expect(await actions.availableActions(digest)).toEqual([
      'stop-protection', 'remove',
    ]);
  });
});

describe('download to this device', () => {
  it('rechecks a row that becomes local before the coalesced task starts', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transferCoalescer = {
      run: jest.fn(async (_key: string, task: () => Promise<LibraryRoleFetch>) => {
        enter();
        await gate;
        return task();
      }),
    };
    const getObjectToFile = jest.spyOn(harness.s3, 'getObjectToFile');
    const delayed = createLibraryLocalActions({
      ...harness.localDependencies,
      transferCoalescer,
    });

    const pending = delayed.download(digest);
    await entered;
    await harness.ingest(digest, bytes);
    release();

    await expect(pending).resolves.toEqual({
      status: 'noop', reason: 'already-satisfied',
    });
    expect(getObjectToFile).not.toHaveBeenCalled();
  });

  it('rechecks a row evicted before the coalesced task starts', async () => {
    await protectAndVerify(harness);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transferCoalescer = {
      run: jest.fn(async (_key: string, task: () => Promise<LibraryRoleFetch>) => {
        enter();
        await gate;
        return task();
      }),
    };
    const getObjectToFile = jest.spyOn(harness.s3, 'getObjectToFile');
    const delayed = createLibraryLocalActions({
      ...harness.localDependencies,
      transferCoalescer,
    });

    const pending = delayed.download(digest);
    await entered;
    await expect(createLibraryLocalActions(harness.localDependencies)
      .freeDeviceSpace(digest)).resolves.toEqual({ status: 'applied' });
    release();

    await expect(pending).resolves.toEqual({ status: 'applied' });
    expect(getObjectToFile).toHaveBeenCalledTimes(1);
  });

  it('rejects when residency persistence fails after promotion', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    const failure = new Error('residency write failed');
    const setResidency = jest.spyOn(harness.protection, 'setResidency')
      .mockRejectedValueOnce(failure);

    try {
      await expect(actions.download(digest)).rejects.toBe(failure);
      await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
      expect((await harness.repository.findLocalAsset(digest))?.residency)
        .toBe('cloud-only');
      expect(harness.port.files.has(`file:///data/library/originals/${digest}.jpg`))
        .toBe(true);
    } finally {
      setResidency.mockRestore();
    }
  });

  it('rejects when verification persistence fails after promotion', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    const failure = new Error('verification write failed');
    const markVerified = jest.spyOn(harness.protection, 'markVerified')
      .mockRejectedValueOnce(failure);

    try {
      await expect(actions.download(digest)).rejects.toBe(failure);
      await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
      expect((await harness.repository.findLocalAsset(digest))?.residency)
        .toBe('local-original');
      expect(harness.port.files.has(`file:///data/library/originals/${digest}.jpg`))
        .toBe(true);
    } finally {
      markVerified.mockRestore();
    }
  });

  it('fetches, decrypts, verifies the digest, and restores a durable original', async () => {
    await protectAndVerify(harness);
    expect(await actions.freeDeviceSpace(digest)).toEqual({ status: 'applied' });
    expect(await actions.download(digest)).toEqual({ status: 'applied' });
    const local = await harness.repository.findLocalAsset(digest);
    expect(local?.residency).toBe('local-original');
    expect(local?.localOriginalUri)
      .toBe(`file:///data/library/originals/${digest}.jpg`);
    expect([...harness.port.files.get(local!.localOriginalUri!)!]).toEqual([...bytes]);
  });

  it('rejects a corrupted object without replacing local state', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    harness.cloud.corruptOnRead = true;
    expect(await actions.download(digest)).toEqual({
      status: 'blocked', category: 'integrity',
    });
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('cloud-only');
    expect(harness.port.files.has(`file:///data/library/originals/${digest}.jpg`))
      .toBe(false);
    await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
  });

  it('maps a missing generation to object_missing and removes both temps', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record?.originalGenerationId).not.toBeNull();
    harness.cloud.blobs.delete(record!.originalGenerationId!);

    await expect(actions.download(digest)).resolves.toEqual({
      status: 'blocked', category: 'object_missing',
    });
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('cloud-only');
    expect(harness.port.files.has(`file:///data/library/originals/${digest}.jpg`))
      .toBe(false);
    await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
  });

  it('reports local space exhaustion without losing the cloud original', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    harness.port.failWrites = true;
    expect(await actions.download(digest)).toEqual({
      status: 'blocked', category: 'local_space',
    });
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('cloud-only');
    await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
    harness.port.failWrites = false;
    expect(await actions.download(digest)).toEqual({ status: 'applied' });
  });

  it('maps a JS fallback plaintext write failure to local_space', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    const original = harness.s3.getObjectToFile;
    const cloud = {
      async getObjectToFile(...args: Parameters<typeof original>) {
        harness.port.failWrites = false;
        try {
          return await original(...args);
        } finally {
          harness.port.failWrites = true;
        }
      },
    };
    const fallbackWrite = createLibraryLocalActions({
      ...harness.localDependencies,
      cloud,
      transferCoalescer: createTransferCoalescer(),
    });

    try {
      await expect(fallbackWrite.download(digest)).resolves.toEqual({
        status: 'blocked', category: 'local_space',
      });
      await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
    } finally {
      harness.port.failWrites = false;
    }
  });

  it('restores an original whose local file vanished, and clears the flag', async () => {
    await protectAndVerify(harness);
    const uri = `file:///data/library/originals/${digest}.jpg`;
    harness.port.files.delete(uri);
    await harness.database.run(
      `UPDATE device_library_assets
          SET missing_original_since = 7
        WHERE plaintext_sha256 = ?`,
      [digest],
    );

    expect(await actions.download(digest)).toEqual({ status: 'applied' });

    await expect(harness.repository.findLocalAsset(digest)).resolves.toMatchObject({
      residency: 'local-original',
      localOriginalUri: uri,
      missingOriginalSince: null,
    });
    expect([...harness.port.files.get(uri)!]).toEqual([...bytes]);
  });

  it('is a no-op when a verified permanent original already exists', async () => {
    await protectAndVerify(harness);
    expect(await actions.download(digest)).toEqual({
      status: 'noop', reason: 'already-satisfied',
    });
  });

  it('is offline-safe and never a derived-object substitute', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    harness.cloud.offline = true;
    expect(await actions.download(digest)).toEqual({
      status: 'blocked', category: 'offline',
    });
    harness.cloud.offline = false;
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId: harness.assetIdFor(digest),
      plaintextSha256: digest,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 3,
      originalGenerationId: null,
      originalCiphertextBytes: 10,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    expect(await actions.download(digest)).toEqual({
      status: 'blocked', category: 'object_missing',
    });
  });

  it('verifies the downloaded original without the JS-thread hash (K6-1f)', async () => {
    await protectAndVerify(harness);
    expect(await actions.freeDeviceSpace(digest)).toEqual({ status: 'applied' });

    mockShaCalls.count = 0;
    expect(await actions.download(digest)).toEqual({ status: 'applied' });

    // A restored file still named by its verified digest, with zero @noble
    // calls, can only have been verified by the native port.
    const local = await harness.repository.findLocalAsset(digest);
    expect(local?.localOriginalUri)
      .toBe(`file:///data/library/originals/${digest}.jpg`);
    expect(mockShaCalls.count).toBe(0);
  });

  it('verifies through the injected digest port, exactly once', async () => {
    const digestSpy = jest.fn(async (plaintext: Uint8Array) =>
      sha256PlaintextHex(plaintext));
    const withPort = createLibraryLocalActions({
      repository: harness.repository,
      protection: harness.protection,
      outbox: harness.outbox,
      files: harness.files,
      cipher: harness.cipher,
      decryptor: createJsFileDecryptor(harness.cipher, harness.port, digestSpy),
      cloud: harness.s3,
      session: { async current() { return harness.session.value; } },
      transferCoalescer: createTransferCoalescer(),
      clock: harness.clock,
    });
    await protectAndVerify(harness);
    expect(await actions.freeDeviceSpace(digest)).toEqual({ status: 'applied' });

    expect(await withPort.download(digest)).toEqual({ status: 'applied' });

    expect(digestSpy).toHaveBeenCalledTimes(1);
    expect([...digestSpy.mock.calls[0]![0]]).toEqual([...bytes]);
  });

  it('rejects download for a trashed protected asset', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    await projectTrash(harness, 'cloud-only');
    expect(await actions.download(digest)).toEqual({
      status: 'blocked', category: 'object_missing',
    });
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('cloud-only');
  });
  it('uses the streamed file path and leaves no stream temp after success', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    const getObject = jest.spyOn(harness.s3, 'getObject').mockImplementation(async () => {
      throw new Error('blob GET must not be used by mirror download');
    });
    const getObjectToFile = jest.spyOn(harness.s3, 'getObjectToFile');

    await expect(actions.download(digest)).resolves.toEqual({ status: 'applied' });

    expect(getObjectToFile).toHaveBeenCalledTimes(1);
    expect(getObject).not.toHaveBeenCalled();
    await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
    getObject.mockRestore();
  });

  it('deletes ciphertext before adopting the decrypted plaintext', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    let cipherPath = '';
    let plainPath = '';
    const streamedCloud = {
      async getObjectToFile(generationId: string, fileUri: string) {
        cipherPath = fileUri;
        return harness.s3.getObjectToFile(generationId, fileUri);
      },
    };
    const streamedDecryptor = {
      async openToFile(input: Parameters<typeof harness.decryptor.openToFile>[0]) {
        plainPath = input.plaintextUri;
        return harness.decryptor.openToFile(input);
      },
      copyToFile: (input: Parameters<typeof harness.decryptor.copyToFile>[0]) => (
        harness.decryptor.copyToFile(input)
      ),
    };
    const originalAdopt = harness.files.adoptStreamFile.bind(harness.files);
    const adopt = jest.spyOn(harness.files, 'adoptStreamFile')
      .mockImplementation(async (uri) => {
        if (uri === plainPath) {
          expect(harness.port.files.has(cipherPath)).toBe(false);
        }
        return originalAdopt(uri);
      });
    try {
      const streamed = createLibraryLocalActions({
        ...harness.localDependencies,
        cloud: streamedCloud,
        decryptor: streamedDecryptor,
        transferCoalescer: createTransferCoalescer(),
      });
      await expect(streamed.download(digest)).resolves.toEqual({ status: 'applied' });
    } finally {
      adopt.mockRestore();
    }
  });

  it('maps a decryptor digest mismatch to integrity without changing residency', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    const mismatch = createLibraryLocalActions({
      ...harness.localDependencies,
      decryptor: {
        async openToFile(input) {
          const result = await harness.decryptor.openToFile(input);
          return { ...result, plaintextSha256: '0'.repeat(64) };
        },
        copyToFile: (input: Parameters<typeof harness.decryptor.copyToFile>[0]) => (
          harness.decryptor.copyToFile(input)
        ),
      },
      transferCoalescer: createTransferCoalescer(),
    });

    await expect(mismatch.download(digest)).resolves.toEqual({
      status: 'blocked', category: 'integrity',
    });
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('cloud-only');
    expect(harness.port.files.has(`file:///data/library/originals/${digest}.jpg`))
      .toBe(false);
    await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
  });

  it('maps a decryptor local-storage failure to local_space and cleans temps', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    const localFailure = createLibraryLocalActions({
      ...harness.localDependencies,
      decryptor: {
        async openToFile() {
          throw new LibraryLocalStorageError('disk full');
        },
        copyToFile: (input: Parameters<typeof harness.decryptor.copyToFile>[0]) => (
          harness.decryptor.copyToFile(input)
        ),
      },
      transferCoalescer: createTransferCoalescer(),
    });

    await expect(localFailure.download(digest)).resolves.toEqual({
      status: 'blocked', category: 'local_space',
    });
    await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('cloud-only');
  });

  it('maps a promote failure to local_space and deletes the plaintext temp', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    harness.port.failMoves = true;

    await expect(actions.download(digest)).resolves.toEqual({
      status: 'blocked', category: 'local_space',
    });
    await expect(harness.files.sweepStreamDir()).resolves.toBe(0);
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('cloud-only');
  });

  it('coalesces concurrent downloads by asset and starts fresh after success', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    const original = harness.s3.getObjectToFile;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const getObjectToFile = jest.spyOn(harness.s3, 'getObjectToFile')
      .mockImplementation(async (...args) => {
        await gate;
        return original(...args);
      });

    const first = actions.download(digest);
    const second = actions.download(digest);
    await Promise.resolve();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(getObjectToFile).toHaveBeenCalledTimes(1);

    await expect(actions.download(digest)).resolves.toEqual({
      status: 'noop', reason: 'already-satisfied',
    });
    expect(getObjectToFile).toHaveBeenCalledTimes(1);
  });

  it('uses the asset identity, rather than a generation id, as the coalescing key', async () => {
    await protectAndVerify(harness);
    await actions.freeDeviceSpace(digest);
    let key = '';
    const transferCoalescer = {
      run: jest.fn((candidate: string, task: () => Promise<LibraryRoleFetch>) => {
        key = candidate;
        return task();
      }),
    };
    const keyed = createLibraryLocalActions({
      ...harness.localDependencies,
      transferCoalescer,
    });

    await expect(keyed.download(digest)).resolves.toEqual({ status: 'applied' });
    expect(key).toBe(`${harness.assetIdFor(digest)}:original`);
  });
});

describe('applicable actions', () => {
  it('offers only what the current state supports', async () => {
    expect(await actions.availableActions(digest)).toEqual(['protect', 'remove']);
    await protectAndVerify(harness);
    expect(await actions.availableActions(digest)).toEqual([
      // C4b: 'free-space' is no longer advertised. C4a deleted the only UI that
      // could offer it, and a complete mirror never evicts an original C2a
      // immediately re-downloads. `freeDeviceSpace` itself survives on the
      // service port for the batch orchestrator; what is gone is offering it
      // to the user as an applicable action.
      'stop-protection', 'remove',
    ]);
    await actions.freeDeviceSpace(digest);
    expect(await actions.availableActions(digest)).toEqual([
      'download', 'stop-protection', 'remove',
    ]);
  });

  it('offers nothing cloud-related without an account', async () => {
    harness.session.value = null;
    expect(await actions.availableActions(digest)).toEqual([]);
  });

  it('omits normal-library actions for a trashed protected asset', async () => {
    await protectAndVerify(harness);
    await projectTrash(harness, 'local-original');
    expect(await actions.availableActions(digest)).toEqual([]);
    expect(await actions.download(digest)).toEqual({
      status: 'blocked', category: 'object_missing',
    });
    expect(await actions.freeDeviceSpace(digest)).toEqual({
      status: 'blocked', category: 'object_missing',
    });

    await projectTrash(harness, 'cloud-only');
    expect(await actions.availableActions(digest)).toEqual([]);
    expect(await actions.download(digest)).toEqual({
      status: 'blocked', category: 'object_missing',
    });
  });
});
