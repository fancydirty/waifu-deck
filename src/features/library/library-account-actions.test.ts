jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createLibraryAccountActions,
  type LibraryAccountActions,
} from '@/features/library/library-account-actions';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import { createLibraryLocalActions } from '@/features/library/library-local-actions';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import {
  createActionsHarness,
  createFailingLibraryDerivedImages,
  TEST_ACCOUNT_SCOPE,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const bytes = Uint8Array.from([2, 7, 1, 8, 2, 8]);
const digest = sha256PlaintextHex(bytes);
const originalUri = `file:///data/library/originals/${digest}.jpg`;
const trashUri = `file:///data/library/trash/${digest}.jpg`;

type Built = {
  actions: LibraryAccountActions;
  protect: ReturnType<typeof createLibraryProtectAction>;
  local: ReturnType<typeof createLibraryLocalActions>;
};

let harness: ActionsHarness;
let built: Built;

function build(current: ActionsHarness): Built {
  const session = { async current() { return current.session.value; } };
  const protect = createLibraryProtectAction({
    repository: current.repository,
    protection: current.protection,
    outbox: current.outbox,
    files: current.files,
    cipher: current.cipher,
    cloud: current.s3,
    reconciliation: current.reconciliation,
    session,
    derived: createFailingLibraryDerivedImages(),
    // C3a: the harness's real projection, so an ad-hoc composition can never
    // pass while sealing a source-less envelope the app would never seal.
    readSource: current.protectDependencies.readSource,
    clock: current.clock,
    newGenerationId: current.newGenerationId,
  });
  const local = createLibraryLocalActions({
    repository: current.repository,
    protection: current.protection,
    outbox: current.outbox,
    files: current.files,
    cipher: current.cipher,
    decryptor: current.decryptor,
    cloud: current.s3,
    session,
    transferCoalescer: current.localDependencies.transferCoalescer,
    clock: current.clock,
  });
  return {
    protect,
    local,
    actions: createLibraryAccountActions({
      repository: current.repository,
      protection: current.protection,
      outbox: current.outbox,
      files: current.files,
      cloud: current.s3,
      session,
      protectAction: protect,
      localActions: local,
      clock: current.clock,
    }),
  };
}

beforeEach(async () => {
  resetExpoCryptoDouble();
  harness = await createActionsHarness();
  built = build(harness);
  await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
});

afterEach(() => {
  harness.close();
});

describe('stop Cloud Vault protection', () => {
  it('downloads and proves a local copy before any cloud deletion', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    expect(await built.local.freeDeviceSpace(digest)).toEqual({ status: 'applied' });
    expect(harness.port.files.has(originalUri)).toBe(false);

    expect(await built.actions.stopProtection(digest)).toEqual({ status: 'applied' });

    expect(harness.port.files.has(originalUri)).toBe(true);
    const local = await harness.repository.findLocalAsset(digest);
    expect(local?.residency).toBe('local-original');
    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record).toMatchObject({
      protection: 'unprotected', originalGenerationId: null,
    });
    const order = harness.cloud.submitted.map((mutation) => mutation.kind);
    expect(order).toEqual(['collect', 'protect', 'stop-protection']);
  });

  it('blocks and deletes nothing when the local copy cannot be proved', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    await built.local.freeDeviceSpace(digest);
    harness.cloud.corruptOnRead = true;
    expect(await built.actions.stopProtection(digest)).toEqual({
      status: 'blocked', category: 'integrity',
    });
    expect(
      harness.cloud.submitted.some((mutation) => mutation.kind === 'stop-protection'),
    ).toBe(false);
    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record?.protection).toBe('protected');
  });

  it('blocks on insufficient local space and on being offline, queueing nothing', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    await built.local.freeDeviceSpace(digest);

    harness.port.failWrites = true;
    expect(await built.actions.stopProtection(digest)).toEqual({
      status: 'blocked', category: 'local_space',
    });
    harness.port.failWrites = false;

    harness.cloud.offline = true;
    expect(await built.actions.stopProtection(digest)).toEqual({
      status: 'blocked', category: 'offline',
    });
    expect(await harness.outbox.list(TEST_ACCOUNT_SCOPE)).toEqual([]);
  });

  it('is a no-op for an asset that is not protected', async () => {
    expect(await built.actions.stopProtection(digest)).toEqual({
      status: 'noop', reason: 'not-applicable',
    });
  });

  it('keeps the intent and forbids freeing space when the response is lost', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    // The Worker commits the account-global deletion; the answer never arrives.
    harness.cloud.loseResponseAfterCommit = 'stop-protection';
    expect(await built.actions.stopProtection(digest)).toEqual({
      status: 'blocked', category: 'offline',
    });

    const queued = (await harness.outbox.list(TEST_ACCOUNT_SCOPE))[0];
    expect(queued).toMatchObject({ kind: 'stop-protection', state: 'sending' });

    // The cloud original is gone, so the local file is now the only reliable
    // original and no eviction path may touch it.
    expect(await built.local.freeDeviceSpace(digest)).toEqual({
      status: 'blocked', category: 'stale_client',
    });
    expect(harness.port.files.has(originalUri)).toBe(true);
    expect(await built.local.availableActions(digest))
      .not.toContain('free-space');

    // Resolving the stable mutation adopts the authoritative outcome without
    // issuing a second destructive mutation.
    expect(await built.actions.stopProtection(digest)).toEqual({ status: 'applied' });
    expect(
      harness.cloud.submitted.filter((mutation) => mutation.kind === 'stop-protection'),
    ).toHaveLength(1);
    expect(await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest))
      .toMatchObject({ protection: 'unprotected', originalGenerationId: null });
    expect(await harness.outbox.list(TEST_ACCOUNT_SCOPE)).toEqual([]);
    expect(harness.port.files.has(originalUri)).toBe(true);
  });

  it('clears the intent when the Worker refuses the request outright', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    harness.cloud.submitError = new LibraryCloudError(
      400, 'bad_request', 'integrity', 'refused', true,
    );
    expect(await built.actions.stopProtection(digest)).toEqual({
      status: 'blocked', category: 'integrity',
    });
    expect((await harness.outbox.list(TEST_ACCOUNT_SCOPE))[0]).toMatchObject({
      kind: 'stop-protection', state: 'failed', lastErrorCode: 'integrity',
    });

    // Nothing was applied, so the verified cloud original still permits an
    // eviction the user asks for.
    harness.cloud.submitError = null;
    expect(await built.local.freeDeviceSpace(digest)).toEqual({ status: 'applied' });
    expect(harness.port.files.has(originalUri)).toBe(false);
  });
});

describe('remove from library', () => {
  it('trashes the account asset and retains an unprotected original in device trash', async () => {
    expect(await built.actions.removeFromLibrary(digest)).toEqual({ status: 'applied' });
    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record).toMatchObject({ lifecycle: 'trash' });
    expect(record?.trashedAt).not.toBeNull();
    expect(harness.port.files.has(originalUri)).toBe(false);
    expect(harness.port.files.has(trashUri)).toBe(true);
    const state = await harness.protection.readDeviceState(digest);
    expect(state?.deviceTrashUri).toBe(trashUri);
    expect(state?.deviceTrashedAt).not.toBeNull();
    expect(
      harness.cloud.submitted.some((mutation) => mutation.kind === 'trash'),
    ).toBe(true);
  });

  it('leaves a protected asset local original in place', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    expect(await built.actions.removeFromLibrary(digest)).toEqual({ status: 'applied' });
    expect(harness.port.files.has(originalUri)).toBe(true);
    expect(harness.port.files.has(trashUri)).toBe(false);
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('local-original');
  });

  it('works offline by queueing the trash intent and keeping the bytes', async () => {
    harness.cloud.offline = true;
    expect(await built.actions.removeFromLibrary(digest)).toEqual({
      status: 'queued', category: 'offline',
    });
    expect((await harness.outbox.list(TEST_ACCOUNT_SCOPE))[0]).toMatchObject({
      kind: 'trash', state: 'pending',
    });
    expect(harness.port.files.has(trashUri)).toBe(true);
    expect(harness.port.files.has(originalUri)).toBe(false);
  });

  it('is not the same operation as freeing device space', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    await built.actions.removeFromLibrary(digest);
    // Freeing space is blocked for a trashed asset, and remove never evicted.
    expect(await built.local.freeDeviceSpace(digest)).toEqual({
      status: 'blocked', category: 'object_missing',
    });
    expect(harness.port.files.has(originalUri)).toBe(true);
  });

  it('never deletes device-trash bytes and is idempotent', async () => {
    expect(await built.actions.removeFromLibrary(digest)).toEqual({ status: 'applied' });
    expect(await built.actions.removeFromLibrary(digest)).toEqual({
      status: 'noop', reason: 'already-satisfied',
    });
    expect(harness.port.files.has(trashUri)).toBe(true);
  });

  it('keeps the trash intent and forbids freeing space when the response is lost', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    // The Worker commits the account-global trash; the answer never arrives.
    harness.cloud.loseResponseAfterCommit = 'trash';
    expect(await built.actions.removeFromLibrary(digest)).toEqual({
      status: 'blocked', category: 'offline',
    });

    const queued = (await harness.outbox.list(TEST_ACCOUNT_SCOPE))[0];
    expect(queued).toMatchObject({ kind: 'trash', state: 'sending' });

    // A protected local original that still looks verified must not be freed
    // while the account may already be in trash — the cloud original is gone.
    expect(await built.local.freeDeviceSpace(digest)).toEqual({
      status: 'blocked', category: 'stale_client',
    });
    expect(harness.port.files.has(originalUri)).toBe(true);
    expect(await built.local.availableActions(digest))
      .not.toContain('free-space');

    // Resolving the stable mutation adopts the authoritative trash without a
    // second destructive submit.
    expect(await built.actions.removeFromLibrary(digest)).toEqual({ status: 'applied' });
    expect(
      harness.cloud.submitted.filter((mutation) => mutation.kind === 'trash'),
    ).toHaveLength(1);
    expect(await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest))
      .toMatchObject({ lifecycle: 'trash' });
    expect(await harness.outbox.list(TEST_ACCOUNT_SCOPE)).toEqual([]);
    // Protected originals stay on device until SP8 learns the trash revision.
    expect(harness.port.files.has(originalUri)).toBe(true);
  });

  it('adopts purged when a lost trash response is followed by server purge', async () => {
    expect(await built.protect.protect(digest)).toEqual({ status: 'applied' });
    harness.cloud.loseResponseAfterCommit = 'trash';
    expect(await built.actions.removeFromLibrary(digest)).toEqual({
      status: 'blocked', category: 'offline',
    });
    expect((await harness.outbox.list(TEST_ACCOUNT_SCOPE))[0]).toMatchObject({
      kind: 'trash', state: 'sending',
    });

    // After the lost trash commit, the account permanently deletes the asset.
    const assetId = harness.assetIdFor(digest);
    const previous = harness.cloud.remote.get(assetId);
    expect(previous?.lifecycle).toBe('trash');
    harness.cloud.remote.set(assetId, {
      ...previous!,
      lifecycle: 'purged',
      protection: 'unprotected',
      generations: {},
    });

    expect(await built.actions.removeFromLibrary(digest)).toEqual({ status: 'applied' });
    expect(
      harness.cloud.submitted.filter((mutation) => mutation.kind === 'trash'),
    ).toHaveLength(1);
    expect(await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest))
      .toMatchObject({
        lifecycle: 'purged',
        protection: 'unprotected',
        originalGenerationId: null,
        originalCiphertextBytes: null,
        verifiedAt: null,
      });
    expect(await harness.outbox.list(TEST_ACCOUNT_SCOPE)).toEqual([]);
    // SP7 preserves device bytes; protected originals stay until SP8.
    expect(harness.port.files.has(originalUri)).toBe(true);
    expect(harness.port.files.has(trashUri)).toBe(false);
  });
});
