jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

/**
 * Counts every `sha256PlaintextHex` call made through the real module during a
 * test. K6-1f: the `original` tier verifies the decrypted plaintext against its
 * known digest, which on Hermes (no JIT) is seconds of pure-JS @noble hashing
 * on the JS thread for a multi-MB image — while the user is waiting to look at
 * it. K3's role gating is untouched: only the engine moves, so the count must
 * be zero. The wrapper delegates to the real implementation, so this file's own
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

import { S3TransportError } from '@/features/byos/s3-transport-types';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import type { LibraryProtection } from '@/features/library/library-actions-types';
import { LibraryLocalStorageError } from '@/features/library/library-file-decryptor';
import { createLibraryLocalActions } from '@/features/library/library-local-actions';
import {
  createTransferCoalescer,
  type LibraryRoleFetch,
  type LibraryTransferCoalescer,
} from '@/features/library/library-transfer-coalescer';
import {
  TEST_ACCOUNT_SCOPE,
  TEST_GENERATION_ID,
  TEST_PREVIEW_GENERATION_ID,
  TEST_THUMBNAIL_GENERATION_ID,
} from '@/features/library/library-actions-test-support';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import { createExpoLibraryReachability } from '@/features/library/library-reachability';
import {
  cacheRowCount,
  createRenderHarness,
  DIGEST,
  ORIGINAL,
  PREVIEW_BYTES,
  seedCloudOnly,
  sealAndStore,
  THUMB_BYTES,
  upsertProtected,
  WRONG_ORIGINAL,
  type RenderHarness,
} from '@/features/library/library-render-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

async function drainJoins(): Promise<void> {
  await new Promise((resolve) => { setImmediate(resolve); });
}

/** Polls on the macrotask clock until a coalescer registration has happened. */
async function waitUntilRegistered(count: () => number): Promise<void> {
  for (let tick = 0; tick < 500 && count() === 0; tick += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  expect(count()).toBeGreaterThan(0);
}

async function cloudOriginalPair(
  coalescer: LibraryTransferCoalescer<LibraryRoleFetch>,
) {
  const harness = await createRenderHarness({
    nodeStreamRoot: true,
    coalescer,
  });
  await seedCloudOnly(harness);
  await upsertProtected(harness, {
    thumbnailGenerationId: null,
    previewGenerationId: null,
  });
  await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);
  const local = createLibraryLocalActions({
    ...harness.actions.localDependencies,
    transferCoalescer: coalescer,
  });
  return { harness, local };
}

function holdFirstGetThen(
  harness: RenderHarness,
  after?: () => Promise<unknown> | unknown,
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const original = harness.actions.s3.getObjectToFile.bind(harness.actions.s3);
  let calls = 0;
  const getObject = jest.spyOn(harness.actions.s3, 'getObjectToFile')
    .mockImplementation(async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 1) {
        markEntered();
        await gate;
      }
      if (after !== undefined) {
        return await after() as Awaited<ReturnType<typeof original>>;
      }
      return original(...args);
    });
  return {
    getObject,
    entered,
    release,
    calls: () => calls,
  };
}

function holdFirstGet(harness: RenderHarness) {
  return holdFirstGetThen(harness);
}

async function rewriteProtection(
  harness: RenderHarness,
  patch: Readonly<{
    lifecycle?: 'active' | 'trash' | 'purged';
    protection?: LibraryProtection;
    originalGenerationId?: string | null;
    trashedAt?: number | null;
  }>,
): Promise<void> {
  const record = await harness.actions.protection.findByDigest(TEST_ACCOUNT_SCOPE, DIGEST);
  if (record === null) throw new Error('missing protection row');
  await harness.actions.protection.upsertProtection({
    accountScope: record.accountScope,
    assetId: record.assetId,
    plaintextSha256: record.plaintextSha256,
    lifecycle: patch.lifecycle ?? record.lifecycle,
    protection: patch.protection ?? record.protection,
    generation: record.generation,
    revision: record.revision,
    originalGenerationId: patch.originalGenerationId === undefined
      ? record.originalGenerationId
      : patch.originalGenerationId,
    originalCiphertextBytes: record.originalCiphertextBytes,
    thumbnailGenerationId: record.thumbnailGenerationId,
    previewGenerationId: record.previewGenerationId,
    verifiedAt: record.verifiedAt,
    failureCategory: record.failureCategory,
    trashedAt: patch.trashedAt === undefined ? record.trashedAt : patch.trashedAt,
  });
}

async function originalWithThumbnail(
  coalescer: LibraryTransferCoalescer<LibraryRoleFetch>,
) {
  const harness = await createRenderHarness({ nodeStreamRoot: true, coalescer });
  await seedCloudOnly(harness);
  const thumbnailUri = harness.actions.files.thumbnailUriFor(DIGEST, 'webp');
  harness.actions.port.files.set(thumbnailUri, THUMB_BYTES);
  await harness.actions.repository.setLocalThumbnail(DIGEST, thumbnailUri);
  await upsertProtected(harness, {
    thumbnailGenerationId: null,
    previewGenerationId: null,
  });
  await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);
  const local = createLibraryLocalActions({
    ...harness.actions.localDependencies,
    transferCoalescer: coalescer,
  });
  return { harness, local, thumbnailUri };
}

async function protectionSnapshot(
  harness: RenderHarness,
): Promise<Record<string, unknown>[]> {
  return harness.actions.database.getAll(
    `SELECT * FROM library_asset_protection
      WHERE account_scope = ? AND plaintext_sha256 = ?
      ORDER BY asset_id`,
    [TEST_ACCOUNT_SCOPE, DIGEST],
  );
}

beforeEach(() => {
  resetExpoCryptoDouble();
});

describe('library render source resolver', () => {
  it('local original resolves to a file URI and issues no fetch', async () => {
    const harness = await createRenderHarness();
    await harness.actions.seedLocalAsset({
      plaintextSha256: DIGEST,
      bytes: ORIGINAL,
    });
    await upsertProtected(harness);

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source).toEqual({
      kind: 'file',
      uri: harness.actions.originalUriFor(DIGEST),
      tier: 'local-original',
      role: 'original',
    });
    expect(harness.getObjectCalls).toEqual([]);
    harness.close();
  });

  it('cache hit resolves without a fetch and promotes last_used_at', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await harness.cache.put({
      accountScope: TEST_ACCOUNT_SCOPE,
      plaintextSha256: DIGEST,
      role: 'thumbnail',
      generationId: TEST_THUMBNAIL_GENERATION_ID,
      bytes: THUMB_BYTES,
    });
    const before = await harness.actions.database.getFirst<{ last_used_at: number }>(
      `SELECT last_used_at FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [TEST_ACCOUNT_SCOPE, DIGEST, 'thumbnail'],
    );
    expect(before).not.toBeNull();
    harness.actions.now = before!.last_used_at + 5_000;

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source.kind).toBe('file');
    if (source.kind === 'file') {
      expect(source.tier).toBe('cached-thumbnail');
      expect(source.role).toBe('thumbnail');
    }
    expect(harness.getObjectCalls).toEqual([]);
    const after = await harness.actions.database.getFirst<{ last_used_at: number }>(
      `SELECT last_used_at FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [TEST_ACCOUNT_SCOPE, DIGEST, 'thumbnail'],
    );
    expect(after?.last_used_at).toBe(harness.actions.now);
    harness.close();
  });

  it('cloud tier downloads, decrypts, caches, and resolves', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await sealAndStore(
      harness,
      'thumbnail',
      THUMB_BYTES,
      TEST_THUMBNAIL_GENERATION_ID,
    );

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source.kind).toBe('file');
    if (source.kind === 'file') {
      expect(source.tier).toBe('cloud-thumbnail');
      expect(source.role).toBe('thumbnail');
      expect(source.uri.startsWith('file://')).toBe(true);
    }
    expect(harness.getObjectCalls).toEqual([
      { generationId: TEST_THUMBNAIL_GENERATION_ID },
    ]);
    const cached = await harness.cache.find(
      TEST_ACCOUNT_SCOPE,
      DIGEST,
      'thumbnail',
    );
    expect(cached).not.toBeNull();
    expect(cached?.byteSize).toBe(THUMB_BYTES.byteLength);
    expect([...(await harness.cache.readBytes(cached!))]).toEqual([...THUMB_BYTES]);
    harness.close();
  });

  it('cloud original full and animated detail use file transfer and putFromFile', async () => {
    for (const intent of ['full', 'detail'] as const) {
      const harness = await createRenderHarness({ nodeStreamRoot: true });
      await seedCloudOnly(harness);
      await upsertProtected(harness, {
        thumbnailGenerationId: null,
        previewGenerationId: null,
      });
      if (intent === 'detail') {
        await harness.actions.database.run(
          "UPDATE device_library_assets SET format = 'gif' WHERE plaintext_sha256 = ?",
          [DIGEST],
        );
      }
      await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);

      const source = await harness.resolver.resolve(DIGEST, intent);

      expect(source).toMatchObject({
        kind: 'file',
        tier: 'cloud-original',
        role: 'original',
      });
      expect(harness.getObjectCalls).toEqual([{ generationId: TEST_GENERATION_ID }]);
      const row = await harness.actions.database.getFirst<{ role: string; byte_size: number }>(
        `SELECT role, byte_size FROM library_cache_entries
          WHERE account_scope = ? AND plaintext_sha256 = ? AND role = 'original'`,
        [TEST_ACCOUNT_SCOPE, DIGEST],
      );
      expect(row).toEqual({ role: 'original', byte_size: ORIGINAL.byteLength });
      await expect(harness.actions.port.listStream()).resolves.toEqual([]);
      harness.close();
    }
  });

  it('concurrent same-role resolves share one file transfer while different roles do not', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await sealAndStore(harness, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);
    await sealAndStore(harness, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);

    const sameRole = await Promise.all([
      harness.resolver.resolve(DIGEST, 'grid'),
      harness.resolver.resolve(DIGEST, 'grid'),
    ]);
    expect(sameRole[0]).toEqual(sameRole[1]);
    expect(harness.getObjectCalls).toHaveLength(1);

    harness.getObjectCalls.length = 0;
    await harness.cache.clearScope(TEST_ACCOUNT_SCOPE);
    await Promise.all([
      harness.roles.read(DIGEST, 'thumbnail'),
      harness.roles.read(DIGEST, 'preview'),
    ]);
    expect(harness.getObjectCalls.map((call) => call.generationId).sort()).toEqual([
      TEST_PREVIEW_GENERATION_ID,
      TEST_THUMBNAIL_GENERATION_ID,
    ].sort());
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('resolver and role reader share one original transfer', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);

    const [resolved, read] = await Promise.all([
      harness.resolver.resolve(DIGEST, 'full'),
      harness.roles.read(DIGEST, 'original'),
    ]);

    const expected = {
      kind: 'file',
      uri: resolved.kind === 'file' ? resolved.uri : '',
      tier: 'cloud-original',
      role: 'original',
    } as const;
    expect(resolved).toEqual(expected);
    expect(read).toEqual(expected);
    expect(harness.getObjectCalls).toEqual([{ generationId: TEST_GENERATION_ID }]);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a resolve joining an in-flight download consumes its promoted original', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);

    const download = local.download(DIGEST);
    await held.entered;
    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await drainJoins();
    expect(held.calls()).toBe(1);
    held.release();

    await expect(download).resolves.toEqual({ status: 'applied' });
    await expect(resolved).resolves.toEqual({
      kind: 'file',
      uri: harness.actions.originalUriFor(DIGEST),
      tier: 'local-original',
      role: 'original',
    });
    expect(held.calls()).toBe(1);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a download joining an in-flight resolve promotes a verified cache copy', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);
    const copy = jest.spyOn(harness.actions.decryptor, 'copyToFile');

    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await held.entered;
    const download = local.download(DIGEST);
    await drainJoins();
    expect(held.calls()).toBe(1);
    held.release();

    await expect(resolved).resolves.toMatchObject({
      kind: 'file', tier: 'cloud-original', role: 'original',
    });
    await expect(download).resolves.toEqual({ status: 'applied' });
    expect(held.calls()).toBe(1);
    expect(copy).toHaveBeenCalledTimes(1);
    await expect(copy.mock.results[0]!.value).resolves.toMatchObject({ sha256: DIGEST });
    expect([...await harness.actions.port.readBytes(harness.actions.originalUriFor(DIGEST))])
      .toEqual([...ORIGINAL]);
    expect(await harness.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'original'))
      .not.toBeNull();
    await expect(harness.actions.repository.findLocalAsset(DIGEST)).resolves.toMatchObject({
      residency: 'local-original',
    });
    const record = await harness.actions.protection.findByDigest(TEST_ACCOUNT_SCOPE, DIGEST);
    expect(record?.verifiedAt).not.toBeNull();
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a copied cache file whose digest mismatches is integrity and promotes nothing', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);
    const realPut = harness.cache.putFromFile.bind(harness.cache);
    jest.spyOn(harness.cache, 'putFromFile').mockImplementation(async (input) => {
      const entry = await realPut(input);
      if (entry !== null) {
        const bytes = Uint8Array.from(await harness.actions.port.readBytes(entry.uri));
        bytes[0] ^= 0xff;
        await harness.actions.port.writeBytes(entry.uri, bytes);
      }
      return entry;
    });

    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await held.entered;
    const download = local.download(DIGEST);
    await drainJoins();
    held.release();

    await expect(resolved).resolves.toMatchObject({ kind: 'file', tier: 'cloud-original' });
    await expect(download).resolves.toEqual({ status: 'blocked', category: 'integrity' });
    expect(held.calls()).toBe(1);
    expect(harness.actions.port.files.has(harness.actions.originalUriFor(DIGEST))).toBe(false);
    await expect(harness.actions.repository.findLocalAsset(DIGEST)).resolves.toMatchObject({
      residency: 'cloud-only',
    });
    expect(await harness.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'original')).not.toBeNull();
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('runs its own GET when the cache file is gone before the download copies it', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);
    const realPut = harness.cache.putFromFile.bind(harness.cache);
    jest.spyOn(harness.cache, 'putFromFile').mockImplementation(async (input) => {
      const entry = await realPut(input);
      if (entry !== null) {
        await harness.cache.forget(TEST_ACCOUNT_SCOPE, DIGEST, 'original');
      }
      return entry;
    });

    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await held.entered;
    const download = local.download(DIGEST);
    await drainJoins();
    held.release();

    await expect(resolved).resolves.toMatchObject({ kind: 'file', tier: 'cloud-original' });
    await expect(download).resolves.toEqual({ status: 'applied' });
    expect(held.calls()).toBe(2);
    await expect(harness.actions.repository.findLocalAsset(DIGEST)).resolves.toMatchObject({
      residency: 'local-original',
    });
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('shares a GET 503 and a decrypt failure with each side\'s category', async () => {
    const transport = createTransferCoalescer<LibraryRoleFetch>();
    const transportPair = await cloudOriginalPair(transport);
    let releaseTransport!: () => void;
    const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
    let markTransport!: () => void;
    const transportEntered = new Promise<void>((resolve) => { markTransport = resolve; });
    let transportCalls = 0;
    jest.spyOn(transportPair.harness.actions.s3, 'getObjectToFile')
      .mockImplementation(async () => {
        transportCalls += 1;
        if (transportCalls === 1) {
          markTransport();
          await transportGate;
        }
        throw new S3TransportError(503, 'rate_limited', 'S3 GET slow down.', true);
      });
    const downloading = transportPair.local.download(DIGEST);
    await transportEntered;
    const viewing = transportPair.harness.resolver.resolve(DIGEST, 'full');
    await drainJoins();
    releaseTransport();
    await expect(downloading).resolves.toEqual({ status: 'blocked', category: 'offline' });
    await expect(viewing).resolves.toEqual({ kind: 'unavailable', category: 'offline' });
    expect(transportCalls).toBe(1);
    await expect(transportPair.harness.actions.port.listStream()).resolves.toEqual([]);
    transportPair.harness.close();

    const decrypt = createTransferCoalescer<LibraryRoleFetch>();
    const decryptPair = await cloudOriginalPair(decrypt);
    const held = holdFirstGet(decryptPair.harness);
    jest.spyOn(decryptPair.harness.actions.decryptor, 'openToFile')
      .mockRejectedValue(new Error('bad tag'));
    const resolved = decryptPair.harness.resolver.resolve(DIGEST, 'full');
    await held.entered;
    const download = decryptPair.local.download(DIGEST);
    await drainJoins();
    held.release();
    await expect(resolved).resolves.toEqual({
      kind: 'unavailable', category: 'integrity', role: 'original',
    });
    await expect(download).resolves.toEqual({ status: 'blocked', category: 'integrity' });
    expect(held.calls()).toBe(1);
    await expect(decryptPair.harness.actions.port.listStream()).resolves.toEqual([]);
    decryptPair.harness.close();
  });

  it('maps a shared local-storage decrypt to retryable_transfer on the view and local_space on the download', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);
    jest.spyOn(harness.actions.decryptor, 'openToFile')
      .mockRejectedValue(new LibraryLocalStorageError('disk full'));

    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await held.entered;
    const download = local.download(DIGEST);
    await drainJoins();
    held.release();

    await expect(resolved).resolves.toEqual({
      kind: 'unavailable', category: 'retryable_transfer',
    });
    await expect(download).resolves.toEqual({ status: 'blocked', category: 'local_space' });
    expect(held.calls()).toBe(1);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a cache refusal while a download waits makes the download transfer the original itself', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);
    jest.spyOn(harness.cache, 'putFromFile').mockResolvedValueOnce(null);

    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await held.entered;
    const download = local.download(DIGEST);
    await drainJoins();
    held.release();

    await expect(resolved).resolves.toEqual({
      kind: 'unavailable', category: 'retryable_transfer',
    });
    await expect(download).resolves.toEqual({ status: 'applied' });
    expect(held.calls()).toBe(2);
    await expect(harness.actions.repository.findLocalAsset(DIGEST)).resolves.toMatchObject({
      residency: 'local-original',
    });
    const record = await harness.actions.protection.findByDigest(TEST_ACCOUNT_SCOPE, DIGEST);
    expect(record?.verifiedAt).not.toBeNull();
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a download promote failure makes the waiting view transfer the original itself', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);
    const promote = jest.spyOn(harness.actions.files, 'promoteToOriginal')
      .mockRejectedValueOnce(new Error('disk full'));

    const download = local.download(DIGEST);
    await held.entered;
    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await drainJoins();
    held.release();

    await expect(download).resolves.toEqual({ status: 'blocked', category: 'local_space' });
    await expect(resolved).resolves.toMatchObject({
      kind: 'file', tier: 'cloud-original', role: 'original',
    });
    expect(held.calls()).toBe(2);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(await harness.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'original')).not.toBeNull();
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('keeps a cloud local_space on both the view and a waiting download', async () => {
    const diskFull = new LibraryCloudError(0, 's3_local_write', 'local_space', 'disk full', true);
    const viewOwned = createTransferCoalescer<LibraryRoleFetch>();
    const viewPair = await cloudOriginalPair(viewOwned);
    const viewHeld = holdFirstGetThen(viewPair.harness, () => { throw diskFull; });
    const viewing = viewPair.harness.resolver.resolve(DIGEST, 'full');
    await viewHeld.entered;
    const waitingDownload = viewPair.local.download(DIGEST);
    await drainJoins();
    viewHeld.release();
    await expect(viewing).resolves.toEqual({ kind: 'unavailable', category: 'local_space' });
    await expect(waitingDownload).resolves.toEqual({ status: 'blocked', category: 'local_space' });
    expect(viewHeld.calls()).toBe(1);
    await expect(viewPair.harness.actions.port.listStream()).resolves.toEqual([]);
    viewPair.harness.close();

    const downloadOwned = createTransferCoalescer<LibraryRoleFetch>();
    const downloadPair = await cloudOriginalPair(downloadOwned);
    const downloadHeld = holdFirstGetThen(downloadPair.harness, () => { throw diskFull; });
    const downloading = downloadPair.local.download(DIGEST);
    await downloadHeld.entered;
    const waitingView = downloadPair.harness.resolver.resolve(DIGEST, 'full');
    await drainJoins();
    downloadHeld.release();
    await expect(downloading).resolves.toEqual({ status: 'blocked', category: 'local_space' });
    await expect(waitingView).resolves.toEqual({ kind: 'unavailable', category: 'local_space' });
    expect(downloadHeld.calls()).toBe(1);
    await expect(downloadPair.harness.actions.port.listStream()).resolves.toEqual([]);
    downloadPair.harness.close();
  });

  it('a view-owned dropped body falls through and a waiting download reports integrity', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local, thumbnailUri } = await originalWithThumbnail(shared);
    const held = holdFirstGetThen(harness, () => { throw new Error('dropped body'); });
    const resolved = harness.resolver.resolve(DIGEST, 'detail');
    await held.entered;
    const download = local.download(DIGEST);
    await drainJoins();
    held.release();
    await expect(resolved).resolves.toEqual({
      kind: 'file', uri: thumbnailUri, tier: 'local-thumbnail', role: 'thumbnail',
    });
    await expect(download).resolves.toEqual({ status: 'blocked', category: 'integrity' });
    expect(held.calls()).toBe(1);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a download-owned dropped body is integrity and the waiting view falls through', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local, thumbnailUri } = await originalWithThumbnail(shared);
    const held = holdFirstGetThen(harness, () => { throw new Error('dropped body'); });
    const download = local.download(DIGEST);
    await held.entered;
    const resolved = harness.resolver.resolve(DIGEST, 'detail');
    await drainJoins();
    held.release();
    await expect(download).resolves.toEqual({ status: 'blocked', category: 'integrity' });
    await expect(resolved).resolves.toEqual({
      kind: 'file', uri: thumbnailUri, tier: 'local-thumbnail', role: 'thumbnail',
    });
    expect(held.calls()).toBe(1);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a second download refuses a row that changed while the owner GET is in flight', async () => {
    const cases: readonly {
      name: string;
      apply: (harness: RenderHarness) => Promise<void>;
      expected: { status: 'blocked'; category: 'object_missing' } | { status: 'noop'; reason: 'already-satisfied' };
    }[] = [
      {
        name: 'trash',
        apply: async (harness) => {
          await rewriteProtection(harness, { lifecycle: 'trash', trashedAt: harness.actions.clock() });
        },
        expected: { status: 'blocked', category: 'object_missing' },
      },
      {
        name: 'purged',
        apply: async (harness) => {
          await rewriteProtection(harness, { lifecycle: 'purged', trashedAt: harness.actions.clock() });
        },
        expected: { status: 'blocked', category: 'object_missing' },
      },
      {
        name: 'unprotected',
        apply: async (harness) => {
          await rewriteProtection(harness, { protection: 'unprotected' });
        },
        expected: { status: 'blocked', category: 'object_missing' },
      },
      {
        name: 'no generation',
        apply: async (harness) => {
          await rewriteProtection(harness, { originalGenerationId: null });
        },
        expected: { status: 'blocked', category: 'object_missing' },
      },
      {
        name: 'already local',
        apply: async (harness) => {
          const uri = harness.actions.originalUriFor(DIGEST);
          harness.actions.port.files.set(uri, ORIGINAL);
          await harness.actions.protection.setResidency(DIGEST, 'local-original', uri);
        },
        expected: { status: 'noop', reason: 'already-satisfied' },
      },
    ];

    for (const entry of cases) {
      const shared = createTransferCoalescer<LibraryRoleFetch>();
      const { harness, local } = await cloudOriginalPair(shared);
      const held = holdFirstGet(harness);
      const owner = local.download(DIGEST);
      await held.entered;
      await entry.apply(harness);
      const waiter = local.download(DIGEST);
      await drainJoins();
      held.release();
      await expect(waiter).resolves.toEqual(entry.expected);
      expect(held.calls()).toBe(1);
      await owner.catch(() => undefined);
      await expect(harness.actions.port.listStream()).resolves.toEqual([]);
      harness.close();
    }
  });

  it('a view waiting on a download-owned digest or decrypt failure keeps original integrity', async () => {
    const digestShared = createTransferCoalescer<LibraryRoleFetch>();
    const digestPair = await originalWithThumbnail(digestShared);
    const openToFile = digestPair.harness.actions.decryptor.openToFile.bind(
      digestPair.harness.actions.decryptor,
    );
    jest.spyOn(digestPair.harness.actions.decryptor, 'openToFile')
      .mockImplementation(async (input) => {
        const opened = await openToFile(input);
        return { ...opened, plaintextSha256: '0'.repeat(64) };
      });
    const digestHeld = holdFirstGet(digestPair.harness);
    const digestDownload = digestPair.local.download(DIGEST);
    await digestHeld.entered;
    const digestView = digestPair.harness.resolver.resolve(DIGEST, 'detail');
    await drainJoins();
    digestHeld.release();
    await expect(digestDownload).resolves.toEqual({ status: 'blocked', category: 'integrity' });
    await expect(digestView).resolves.toEqual({
      kind: 'unavailable', category: 'integrity', role: 'original',
    });
    expect(digestHeld.calls()).toBe(1);
    await expect(digestPair.harness.actions.port.listStream()).resolves.toEqual([]);
    digestPair.harness.close();

    const decryptShared = createTransferCoalescer<LibraryRoleFetch>();
    const decryptPair = await originalWithThumbnail(decryptShared);
    jest.spyOn(decryptPair.harness.actions.decryptor, 'openToFile')
      .mockRejectedValue(new Error('bad tag'));
    const decryptHeld = holdFirstGet(decryptPair.harness);
    const decryptDownload = decryptPair.local.download(DIGEST);
    await decryptHeld.entered;
    const decryptView = decryptPair.harness.resolver.resolve(DIGEST, 'detail');
    await drainJoins();
    decryptHeld.release();
    await expect(decryptDownload).resolves.toEqual({ status: 'blocked', category: 'integrity' });
    await expect(decryptView).resolves.toEqual({
      kind: 'unavailable', category: 'integrity', role: 'original',
    });
    expect(decryptHeld.calls()).toBe(1);
    await expect(decryptPair.harness.actions.port.listStream()).resolves.toEqual([]);
    decryptPair.harness.close();
  });

  it('an already-local owner in the recheck window publishes the file and fetches nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let waiters = 0;
    const inFlight = new Map<string, Promise<LibraryRoleFetch>>();
    const coalescer: LibraryTransferCoalescer<LibraryRoleFetch> = {
      run(key, task) {
        return coalescer.runWithOwnership!(key, task).promise;
      },
      runWithOwnership(key, task) {
        const existing = inFlight.get(key);
        if (existing !== undefined) {
          waiters += 1;
          return { promise: existing, owner: false };
        }
        markEntered();
        const promise = gate.then(() => task());
        inFlight.set(key, promise);
        promise.finally(() => {
          if (inFlight.get(key) === promise) inFlight.delete(key);
        }).catch(() => undefined);
        return { promise, owner: true };
      },
    };
    const { harness, local } = await cloudOriginalPair(coalescer);
    const getObject = jest.spyOn(harness.actions.s3, 'getObjectToFile');
    const download = local.download(DIGEST);
    await entered;
    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await drainJoins();
    expect(waiters).toBe(1);
    const uri = harness.actions.originalUriFor(DIGEST);
    harness.actions.port.files.set(uri, ORIGINAL);
    await harness.actions.protection.setResidency(DIGEST, 'local-original', uri);
    release();
    await expect(download).resolves.toEqual({ status: 'noop', reason: 'already-satisfied' });
    await expect(resolved).resolves.toEqual({
      kind: 'file', uri, tier: 'local-original', role: 'original',
    });
    expect(getObject).not.toHaveBeenCalled();
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a residency rejection while a view waits is retryable and does not fetch again', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);
    jest.spyOn(harness.actions.protection, 'setResidency')
      .mockRejectedValueOnce(new Error('residency write failed'));
    const download = local.download(DIGEST);
    await held.entered;
    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await drainJoins();
    held.release();
    await expect(download).rejects.toThrow('residency write failed');
    await expect(resolved).resolves.toEqual({
      kind: 'unavailable', category: 'retryable_transfer',
    });
    expect(held.calls()).toBe(1);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('several waiters share one owner outcome — one GET, both downloads applied, both views render', async () => {
    const shared = createTransferCoalescer<LibraryRoleFetch>();
    const { harness, local } = await cloudOriginalPair(shared);
    const held = holdFirstGet(harness);

    const owner = local.download(DIGEST);
    await held.entered;
    const second = local.download(DIGEST);
    const firstView = harness.resolver.resolve(DIGEST, 'full');
    const secondView = harness.resolver.resolve(DIGEST, 'full');
    await drainJoins();
    expect(held.calls()).toBe(1);
    held.release();

    await expect(owner).resolves.toEqual({ status: 'applied' });
    await expect(second).resolves.toEqual({ status: 'applied' });
    const promoted = {
      kind: 'file',
      uri: harness.actions.originalUriFor(DIGEST),
      tier: 'local-original',
      role: 'original',
    } as const;
    await expect(firstView).resolves.toEqual(promoted);
    await expect(secondView).resolves.toEqual(promoted);
    expect(held.calls()).toBe(1);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a view-owned reserveStreamPath failure is retryable_transfer on the view and local_space on the waiting download', async () => {
    // A coalescer that parks the OWNER's task on a gate, so the view's failed
    // transfer stays in flight until the download has joined it.
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });
    const inFlight = new Map<string, Promise<LibraryRoleFetch>>();
    const gated: LibraryTransferCoalescer<LibraryRoleFetch> = {
      run: (key, task) => gated.runWithOwnership!(key, task).promise,
      runWithOwnership(key, task) {
        const existing = inFlight.get(key);
        if (existing !== undefined) return { promise: existing, owner: false };
        const promise = taskGate.then(() => task());
        inFlight.set(key, promise);
        promise.finally(() => {
          if (inFlight.get(key) === promise) inFlight.delete(key);
        }).catch(() => undefined);
        return { promise, owner: true };
      },
    };
    const { harness } = await cloudOriginalPair(gated);
    // The download's session waits on a second gate, so it cannot even reach
    // the coalescer until the view has registered its transfer as the owner.
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const local = createLibraryLocalActions({
      ...harness.actions.localDependencies,
      transferCoalescer: gated,
      session: {
        current: async () => {
          await downloadGate;
          return harness.actions.session.current();
        },
      },
    });
    const reserve = jest.spyOn(harness.actions.files, 'reserveStreamPath')
      .mockImplementation(() => {
        throw new LibraryLocalStorageError('stream dir unusable');
      });
    const registered = jest.spyOn(gated, 'runWithOwnership');

    const resolved = harness.resolver.resolve(DIGEST, 'full');
    await waitUntilRegistered(() => registered.mock.calls.length);
    releaseDownload();
    const download = local.download(DIGEST);
    await drainJoins();
    releaseTask();

    await expect(resolved).resolves.toEqual({
      kind: 'unavailable', category: 'retryable_transfer',
    });
    await expect(download).resolves.toEqual({
      status: 'blocked', category: 'local_space',
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a missing cloud object falls through to the next available tier', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    const thumbnailUri = harness.actions.files.thumbnailUriFor(DIGEST, 'webp');
    harness.actions.port.files.set(thumbnailUri, THUMB_BYTES);
    await harness.actions.repository.setLocalThumbnail(DIGEST, thumbnailUri);
    await upsertProtected(harness, { previewGenerationId: TEST_PREVIEW_GENERATION_ID });

    const source = await harness.resolver.resolve(DIGEST, 'detail');

    expect(source).toEqual({
      kind: 'file',
      uri: thumbnailUri,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    });
    expect(harness.getObjectCalls).toEqual([{ generationId: TEST_PREVIEW_GENERATION_ID }]);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a non-storage decrypt failure is integrity and stops before the next tier', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);
    jest.spyOn(harness.actions.decryptor, 'openToFile').mockRejectedValueOnce(
      new Error('bad envelope'),
    );

    const source = await harness.resolver.resolve(DIGEST, 'full');

    expect(source).toEqual({ kind: 'unavailable', category: 'integrity', role: 'original' });
    expect(harness.getObjectCalls).toHaveLength(1);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('discards the cipher temp before handing the plaintext file to the cache', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await sealAndStore(harness, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);
    const realPutFromFile = harness.cache.putFromFile.bind(harness.cache);
    jest.spyOn(harness.cache, 'putFromFile').mockImplementation(async (input) => {
      await expect(harness.actions.port.listStream()).resolves.toHaveLength(1);
      return realPutFromFile(input);
    });

    await expect(harness.resolver.resolve(DIGEST, 'grid')).resolves.toMatchObject({
      kind: 'file',
      tier: 'cloud-thumbnail',
    });
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a local storage decrypt failure is retryable and a refused cache write is retryable', async () => {
    const storageFailure = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(storageFailure);
    await upsertProtected(storageFailure, {
      thumbnailGenerationId: TEST_THUMBNAIL_GENERATION_ID,
      previewGenerationId: null,
      originalGenerationId: null,
    });
    await sealAndStore(
      storageFailure,
      'thumbnail',
      THUMB_BYTES,
      TEST_THUMBNAIL_GENERATION_ID,
    );
    jest.spyOn(storageFailure.actions.decryptor, 'openToFile').mockRejectedValueOnce(
      new LibraryLocalStorageError('disk full'),
    );
    await expect(storageFailure.resolver.resolve(DIGEST, 'grid')).resolves.toEqual({
      kind: 'unavailable',
      category: 'retryable_transfer',
    });
    await expect(storageFailure.actions.port.listStream()).resolves.toEqual([]);
    storageFailure.close();

    const refusal = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(refusal);
    await sealAndStore(refusal, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);
    jest.spyOn(refusal.cache, 'putFromFile').mockResolvedValueOnce(null);
    await expect(refusal.resolver.resolve(DIGEST, 'grid')).resolves.toEqual({
      kind: 'unavailable',
      category: 'retryable_transfer',
    });
    await expect(refusal.actions.port.listStream()).resolves.toEqual([]);
    refusal.close();
  });

  it('a rejected putFromFile is retryable and falls through to the next tier', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    const thumbnailUri = harness.actions.files.thumbnailUriFor(DIGEST, 'webp');
    harness.actions.port.files.set(thumbnailUri, THUMB_BYTES);
    await harness.actions.repository.setLocalThumbnail(DIGEST, thumbnailUri);
    await upsertProtected(harness, { previewGenerationId: TEST_PREVIEW_GENERATION_ID });
    await sealAndStore(harness, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);
    jest.spyOn(harness.cache, 'putFromFile').mockRejectedValueOnce(new Error('insert failed'));

    await expect(harness.resolver.resolve(DIGEST, 'detail')).resolves.toEqual({
      kind: 'file',
      uri: thumbnailUri,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    });
    expect(harness.getObjectCalls).toEqual([{ generationId: TEST_PREVIEW_GENERATION_ID }]);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a rejected putFromFile with no fallback returns retryable_transfer', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
      originalGenerationId: TEST_GENERATION_ID,
    });
    await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);
    jest.spyOn(harness.cache, 'putFromFile').mockRejectedValueOnce(new Error('insert failed'));

    await expect(harness.resolver.resolve(DIGEST, 'full')).resolves.toEqual({
      kind: 'unavailable',
      category: 'retryable_transfer',
    });
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('cloud thumbnail and preview tiers use putFromFile with decrypted sizes, never put', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await sealAndStore(harness, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);
    await sealAndStore(harness, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);
    const putFromFile = jest.spyOn(harness.cache, 'putFromFile');
    const put = jest.spyOn(harness.cache, 'put');

    await expect(harness.resolver.resolve(DIGEST, 'grid')).resolves.toMatchObject({
      kind: 'file',
      tier: 'cloud-thumbnail',
      role: 'thumbnail',
    });
    expect(putFromFile).toHaveBeenCalledWith(expect.objectContaining({
      role: 'thumbnail',
      byteSize: THUMB_BYTES.byteLength,
    }));
    expect(put).not.toHaveBeenCalled();

    await harness.cache.clearScope(TEST_ACCOUNT_SCOPE);
    putFromFile.mockClear();
    put.mockClear();
    await expect(harness.resolver.resolve(DIGEST, 'detail')).resolves.toMatchObject({
      kind: 'file',
      tier: 'cloud-preview',
      role: 'preview',
    });
    expect(putFromFile).toHaveBeenCalledWith(expect.objectContaining({
      role: 'preview',
      byteSize: PREVIEW_BYTES.byteLength,
    }));
    expect(put).not.toHaveBeenCalled();
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a reserve stream failure is retryable and falls through to a local thumbnail', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    const thumbnailUri = harness.actions.files.thumbnailUriFor(DIGEST, 'webp');
    harness.actions.port.files.set(thumbnailUri, THUMB_BYTES);
    await harness.actions.repository.setLocalThumbnail(DIGEST, thumbnailUri);
    await upsertProtected(harness, { previewGenerationId: TEST_PREVIEW_GENERATION_ID });
    jest.spyOn(harness.actions.files, 'reserveStreamPath').mockImplementationOnce(() => {
      throw new Error('stream directory unavailable');
    });

    await expect(harness.resolver.resolve(DIGEST, 'detail')).resolves.toEqual({
      kind: 'file',
      uri: thumbnailUri,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    });
    expect(harness.getObjectCalls).toEqual([]);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a reserve stream failure with no fallback returns retryable_transfer', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
      originalGenerationId: TEST_GENERATION_ID,
    });
    jest.spyOn(harness.actions.files, 'reserveStreamPath').mockImplementation(() => {
      throw new Error('stream directory unavailable');
    });

    await expect(harness.resolver.resolve(DIGEST, 'full')).resolves.toEqual({
      kind: 'unavailable',
      category: 'retryable_transfer',
    });
    expect(harness.getObjectCalls).toEqual([]);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a null-only cloud object is object_missing and leaves no stream temp', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
      originalGenerationId: TEST_GENERATION_ID,
    });

    await expect(harness.resolver.resolve(DIGEST, 'full')).resolves.toEqual({
      kind: 'unavailable',
      category: 'object_missing',
    });
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('a cloud decrypt interruption keeps its category and falls through', async () => {
    const interrupted = new LibraryCloudError(
      0,
      'file_decrypt_interrupted',
      'offline',
      'decrypt interrupted',
      false,
    );
    const fallback = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(fallback);
    const thumbnailUri = fallback.actions.files.thumbnailUriFor(DIGEST, 'webp');
    fallback.actions.port.files.set(thumbnailUri, THUMB_BYTES);
    await fallback.actions.repository.setLocalThumbnail(DIGEST, thumbnailUri);
    await upsertProtected(fallback, { previewGenerationId: TEST_PREVIEW_GENERATION_ID });
    await sealAndStore(fallback, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);
    jest.spyOn(fallback.actions.decryptor, 'openToFile').mockRejectedValueOnce(interrupted);

    await expect(fallback.resolver.resolve(DIGEST, 'detail')).resolves.toEqual({
      kind: 'file',
      uri: thumbnailUri,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    });
    await expect(fallback.actions.port.listStream()).resolves.toEqual([]);
    fallback.close();

    const only = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(only);
    await upsertProtected(only, {
      thumbnailGenerationId: null,
      previewGenerationId: TEST_PREVIEW_GENERATION_ID,
      originalGenerationId: null,
    });
    await sealAndStore(only, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);
    jest.spyOn(only.actions.decryptor, 'openToFile').mockRejectedValueOnce(interrupted);

    await expect(only.resolver.resolve(DIGEST, 'detail')).resolves.toEqual({
      kind: 'unavailable',
      category: 'offline',
    });
    await expect(only.actions.port.listStream()).resolves.toEqual([]);
    only.close();
  });

  it('a local-original row whose file is gone still resolves the cloud thumbnail', async () => {
    const harness = await createRenderHarness();
    await harness.actions.seedLocalAsset({
      plaintextSha256: DIGEST,
      bytes: ORIGINAL,
    });
    const uri = harness.actions.originalUriFor(DIGEST);
    harness.actions.port.files.delete(uri);
    await upsertProtected(harness);
    await sealAndStore(
      harness,
      'thumbnail',
      THUMB_BYTES,
      TEST_THUMBNAIL_GENERATION_ID,
    );

    await expect(harness.resolver.resolve(DIGEST, 'grid')).resolves.toMatchObject({
      kind: 'file',
      tier: 'cloud-thumbnail',
    });
    harness.close();
  });

  it('cloud tier while unreachable resolves offline and issues no fetch', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await sealAndStore(
      harness,
      'thumbnail',
      THUMB_BYTES,
      TEST_THUMBNAIL_GENERATION_ID,
    );
    harness.reachability.value = false;

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source).toEqual({ kind: 'unavailable', category: 'offline' });
    expect(harness.getObjectCalls).toEqual([]);
    expect(await cacheRowCount(harness)).toBe(0);
    harness.close();
  });

  it('fetch failing with LibraryCloudError.category offline resolves offline unavailable', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await sealAndStore(
      harness,
      'thumbnail',
      THUMB_BYTES,
      TEST_THUMBNAIL_GENERATION_ID,
    );
    harness.actions.cloud.offlineOnGetOnce = true;

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source).toEqual({ kind: 'unavailable', category: 'offline' });
    expect(harness.getObjectCalls).toHaveLength(1);
    expect(await cacheRowCount(harness)).toBe(0);
    harness.close();
  });

  it('AEAD failure on any role resolves integrity, caches nothing, and leaves every library_asset_protection column byte-identical', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    // Ciphertext that cannot authenticate under the scoped AEAD.
    harness.actions.cloud.blobs.set(
      TEST_THUMBNAIL_GENERATION_ID,
      Uint8Array.from({ length: 64 }, (_, index) => index + 7),
    );
    const before = await protectionSnapshot(harness);

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source).toEqual({ kind: 'unavailable', category: 'integrity', role: 'thumbnail' });
    expect(await cacheRowCount(harness)).toBe(0);
    expect(await protectionSnapshot(harness)).toEqual(before);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('original plaintext digest mismatch resolves integrity and caches nothing', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    await sealAndStore(harness, 'original', WRONG_ORIGINAL, TEST_GENERATION_ID);
    const before = await protectionSnapshot(harness);

    const source = await harness.resolver.resolve(DIGEST, 'full');

    expect(source).toEqual({ kind: 'unavailable', category: 'integrity', role: 'original' });
    expect(await cacheRowCount(harness)).toBe(0);
    expect(await protectionSnapshot(harness)).toEqual(before);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('verifies the original tier without the JS-thread hash (K6-1f)', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);

    mockShaCalls.count = 0;
    const source = await harness.resolver.resolve(DIGEST, 'full');

    // A served original tier with zero @noble calls can only have been
    // verified by the native port.
    expect(source.kind).toBe('file');
    if (source.kind === 'file') {
      expect(source.tier).toBe('cloud-original');
      expect(source.role).toBe('original');
    }
    expect(mockShaCalls.count).toBe(0);
    harness.close();
  });

  it('verifies the original through the injected digest port, exactly once', async () => {
    const digestSpy = jest.fn(async (bytes: Uint8Array) =>
      sha256PlaintextHex(bytes));
    const harness = await createRenderHarness({ digest: digestSpy });
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);

    const source = await harness.resolver.resolve(DIGEST, 'full');

    expect(source.kind).toBe('file');
    expect(digestSpy).toHaveBeenCalledTimes(1);
    expect([...digestSpy.mock.calls[0]![0]]).toEqual([...ORIGINAL]);
    harness.close();
  });

  it('thumbnail and preview skip plaintext digest checks but still require AEAD authentication', async () => {
    // Documented limit: only `original` compares sha256PlaintextHex to the
    // digest. Derived roles prove integrity via AEAD auth tags alone, so a
    // correctly sealed thumbnail whose bytes are unrelated to DIGEST still
    // resolves — while garbage ciphertext fails closed as integrity.
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    const unrelated = Uint8Array.from([99, 98, 97, 96]);
    expect(sha256PlaintextHex(unrelated)).not.toBe(DIGEST);
    await sealAndStore(
      harness,
      'thumbnail',
      unrelated,
      TEST_THUMBNAIL_GENERATION_ID,
    );

    const ok = await harness.resolver.resolve(DIGEST, 'grid');
    expect(ok.kind).toBe('file');
    if (ok.kind === 'file') {
      expect(ok.tier).toBe('cloud-thumbnail');
    }

    await harness.cache.clearScope(TEST_ACCOUNT_SCOPE);
    harness.getObjectCalls.length = 0;
    harness.actions.cloud.blobs.set(
      TEST_THUMBNAIL_GENERATION_ID,
      Uint8Array.from({ length: 48 }, () => 0xaa),
    );

    const bad = await harness.resolver.resolve(DIGEST, 'grid');
    expect(bad).toEqual({ kind: 'unavailable', category: 'integrity', role: 'thumbnail' });
    harness.close();
  });

  it('detail on a preview-less asset whose cloud original fails AEAD resolves integrity pinned to the original role', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    // No preview generation → detail falls through to the original tier
    // (library-render-tiers.ts). A corrupt original there is a genuine
    // original-tier integrity failure the repair gate must be able to see.
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    harness.actions.cloud.blobs.set(
      TEST_GENERATION_ID,
      Uint8Array.from({ length: 64 }, (_, index) => index + 11),
    );

    const source = await harness.resolver.resolve(DIGEST, 'detail');

    expect(source).toEqual({ kind: 'unavailable', category: 'integrity', role: 'original' });
    expect(await cacheRowCount(harness)).toBe(0);
    harness.close();
  });

  it('cached thumbnail is never returned for intent full', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await harness.cache.put({
      accountScope: TEST_ACCOUNT_SCOPE,
      plaintextSha256: DIGEST,
      role: 'thumbnail',
      generationId: TEST_THUMBNAIL_GENERATION_ID,
      bytes: THUMB_BYTES,
    });
    await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);

    const source = await harness.resolver.resolve(DIGEST, 'full');

    expect(source.kind).toBe('file');
    if (source.kind === 'file') {
      expect(source.tier).toBe('cloud-original');
      expect(source.role).toBe('original');
    }
    expect(harness.getObjectCalls.map((call) => call.generationId)).toEqual([TEST_GENERATION_ID]);
    harness.close();
  });

  it('K3c: a raw S3TransportError (503) from the cloud tier is transport trouble, not integrity — resolves offline with no role', async () => {
    // Production `cloud.getObject` forwards the S3 transport's raw
    // S3TransportError (never a LibraryCloudError). A 5xx/429/network hiccup
    // must not be mistaken for a corrupt blob.
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    harness.failNextGetObject(new S3TransportError(503, 'rate_limited', 'S3 GET slow down.', true));
    const before = await protectionSnapshot(harness);

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source).toEqual({ kind: 'unavailable', category: 'offline' });
    expect(await cacheRowCount(harness)).toBe(0);
    expect(await protectionSnapshot(harness)).toEqual(before);
    await expect(harness.actions.port.listStream()).resolves.toEqual([]);
    harness.close();
  });

  it('K3c: a timed-out GET on the ORIGINAL tier is offline, never an original-role integrity (so it can never offer repair)', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    harness.failNextGetObject(new S3TransportError(0, 'network', 'S3 GET timed out.', false));

    const source = await harness.resolver.resolve(DIGEST, 'detail');

    expect(source).toEqual({ kind: 'unavailable', category: 'offline' });
    expect(await cacheRowCount(harness)).toBe(0);
    harness.close();
  });

  it('K3c: an unexpected 4xx from the store is a role-less integrity (a client fault, not a corrupt original)', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    harness.failNextGetObject(new S3TransportError(400, 'client', 'S3 GET failed (400).', true));

    const source = await harness.resolver.resolve(DIGEST, 'detail');

    expect(source).toEqual({ kind: 'unavailable', category: 'integrity' });
    harness.close();
  });

  it('K3d: a raw non-transport error from the cloud GET (body read dropped after a 200) is transport trouble, never integrity — resolves role-less retryable_transfer', async () => {
    // s3-transport wraps fetch/timeouts/status codes as S3TransportError but
    // not the body read (res.arrayBuffer()): a connection reset mid-stream
    // surfaces as a platform TypeError. A GET failure of ANY shape can never
    // prove the blob is corrupt, so it must not reach the integrity verdict.
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    harness.failNextGetObject(new TypeError('Network request failed'));

    const source = await harness.resolver.resolve(DIGEST, 'detail');

    expect(source).toEqual({ kind: 'unavailable', category: 'retryable_transfer' });
    expect(await cacheRowCount(harness)).toBe(0);
    harness.close();
  });

  it('K3d: the same raw error on the thumbnail tier at grid is retryable_transfer, not a thumbnail integrity', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    harness.failNextGetObject(new TypeError('Network request failed'));
    const before = await protectionSnapshot(harness);

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source).toEqual({ kind: 'unavailable', category: 'retryable_transfer' });
    expect(await cacheRowCount(harness)).toBe(0);
    expect(await protectionSnapshot(harness)).toEqual(before);
    harness.close();
  });

  it('cloud-only with thumbnailGenerationId null at grid issues no getObject for any role, resolves unavailable, and writes no cache', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: TEST_PREVIEW_GENERATION_ID,
      originalGenerationId: TEST_GENERATION_ID,
    });
    await sealAndStore(
      harness,
      'preview',
      PREVIEW_BYTES,
      TEST_PREVIEW_GENERATION_ID,
    );
    await sealAndStore(harness, 'original', ORIGINAL, TEST_GENERATION_ID);

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source).toEqual({ kind: 'unavailable', category: 'object_missing' });
    expect(harness.getObjectCalls).toEqual([]);
    expect(await cacheRowCount(harness)).toBe(0);
    harness.close();
  });

  it('same asset after authoritative thumbnail_generation_id arrives resolves cloud-thumbnail normally', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await upsertProtected(harness, { thumbnailGenerationId: null });
    expect(await harness.resolver.resolve(DIGEST, 'grid')).toEqual({
      kind: 'unavailable',
      category: 'object_missing',
    });
    expect(harness.getObjectCalls).toEqual([]);

    await upsertProtected(harness, {
      thumbnailGenerationId: TEST_THUMBNAIL_GENERATION_ID,
    });
    await sealAndStore(
      harness,
      'thumbnail',
      THUMB_BYTES,
      TEST_THUMBNAIL_GENERATION_ID,
    );

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source.kind).toBe('file');
    if (source.kind === 'file') {
      expect(source.tier).toBe('cloud-thumbnail');
    }
    expect(harness.getObjectCalls).toEqual([
      { generationId: TEST_THUMBNAIL_GENERATION_ID },
    ]);
    harness.close();
  });

  it('repairDerived is the only regeneration path: evicted cached thumbnail is regained via repairDerived; grid resolve alone never calls derived generator', async () => {
    const harness = await createRenderHarness();
    await harness.actions.seedLocalAsset({
      plaintextSha256: DIGEST,
      bytes: ORIGINAL,
    });
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
      originalGenerationId: null,
    });
    await harness.cache.put({
      accountScope: TEST_ACCOUNT_SCOPE,
      plaintextSha256: DIGEST,
      role: 'thumbnail',
      generationId: null,
      bytes: THUMB_BYTES,
    });
    const entry = await harness.cache.find(
      TEST_ACCOUNT_SCOPE,
      DIGEST,
      'thumbnail',
    );
    expect(entry).not.toBeNull();
    await harness.actions.port.delete(entry!.uri);
    expect(await harness.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'thumbnail'))
      .toBeNull();

    const grid = await harness.resolver.resolve(DIGEST, 'grid');
    expect(grid.kind).toBe('file');
    if (grid.kind === 'file') {
      expect(grid.tier).toBe('local-original');
    }
    expect(harness.deriveCalls).toEqual([]);

    expect(await harness.resolver.repairDerived(DIGEST)).toBe(true);
    expect(harness.deriveCalls).toHaveLength(1);
    expect(
      await harness.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'thumbnail'),
    ).not.toBeNull();
    harness.close();
  });

  it('signed-out resolver returns auth_attention and touches nothing', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await sealAndStore(
      harness,
      'thumbnail',
      THUMB_BYTES,
      TEST_THUMBNAIL_GENERATION_ID,
    );
    const beforeProtection = await protectionSnapshot(harness);
    const beforeCache = await cacheRowCount(harness);
    const beforeSubmitted = harness.actions.cloud.submitted.length;
    harness.actions.session.signOut();

    const source = await harness.resolver.resolve(DIGEST, 'grid');

    expect(source).toEqual({ kind: 'unavailable', category: 'auth_attention' });
    expect(harness.getObjectCalls).toEqual([]);
    expect(harness.deriveCalls).toEqual([]);
    expect(await cacheRowCount(harness)).toBe(beforeCache);
    expect(await protectionSnapshot(harness)).toEqual(beforeProtection);
    expect(harness.actions.cloud.submitted.length).toBe(beforeSubmitted);
    harness.close();
  });

  it('trash and purged assets resolve unavailable and are never fetched', async () => {
    for (const lifecycle of ['trash', 'purged'] as const) {
      const harness = await createRenderHarness();
      await seedCloudOnly(harness);
      await upsertProtected(harness, { lifecycle });
      await sealAndStore(
        harness,
        'thumbnail',
        THUMB_BYTES,
        TEST_THUMBNAIL_GENERATION_ID,
      );

      const source = await harness.resolver.resolve(DIGEST, 'grid');

      expect(source).toEqual({ kind: 'unavailable', category: 'object_missing' });
      expect(harness.getObjectCalls).toEqual([]);
      harness.close();
    }

    const deviceTrash = await createRenderHarness();
    await deviceTrash.actions.seedLocalAsset({
      plaintextSha256: DIGEST,
      bytes: ORIGINAL,
    });
    await upsertProtected(deviceTrash);
    await deviceTrash.actions.protection.setDeviceTrash(
      DIGEST,
      'file:///data/library/trash/x.jpg',
      42,
    );

    const source = await deviceTrash.resolver.resolve(DIGEST, 'grid');
    expect(source).toEqual({ kind: 'unavailable', category: 'object_missing' });
    expect(deviceTrash.getObjectCalls).toEqual([]);
    deviceTrash.close();
  });

  it('repairDerived regenerates and re-caches both derived roles from a verified local original and writes no account mutation', async () => {
    const harness = await createRenderHarness();
    await harness.actions.seedLocalAsset({
      plaintextSha256: DIGEST,
      bytes: ORIGINAL,
    });
    await upsertProtected(harness, {
      thumbnailGenerationId: null,
      previewGenerationId: null,
      originalGenerationId: null,
    });
    const beforeProtection = await protectionSnapshot(harness);
    const beforeSubmitted = harness.actions.cloud.submitted.length;
    const beforePuts = harness.actions.cloud.blobPuts.length;

    expect(await harness.resolver.repairDerived(DIGEST)).toBe(true);

    expect(harness.deriveCalls).toEqual([
      {
        sourceUri: harness.actions.originalUriFor(DIGEST),
        format: 'jpeg',
        width: 10,
        height: 10,
      },
    ]);
    const thumb = await harness.cache.find(
      TEST_ACCOUNT_SCOPE,
      DIGEST,
      'thumbnail',
    );
    const preview = await harness.cache.find(
      TEST_ACCOUNT_SCOPE,
      DIGEST,
      'preview',
    );
    expect(thumb).not.toBeNull();
    expect(preview).not.toBeNull();
    expect([...(await harness.cache.readBytes(thumb!))]).toEqual([...THUMB_BYTES]);
    expect([...(await harness.cache.readBytes(preview!))]).toEqual([...PREVIEW_BYTES]);
    expect(await protectionSnapshot(harness)).toEqual(beforeProtection);
    expect(harness.actions.cloud.submitted.length).toBe(beforeSubmitted);
    expect(harness.actions.cloud.blobPuts.length).toBe(beforePuts);
    expect(harness.getObjectCalls).toEqual([]);
    harness.close();
  });
});

describe('createExpoLibraryReachability', () => {
  it('treats unknown reachability as reachable and false only when known offline', async () => {
    const reachable = createExpoLibraryReachability(() => ({
      getNetworkStateAsync: async () => ({
        isConnected: true,
        isInternetReachable: undefined,
      }),
    }) as never);
    expect(await reachable.isReachable()).toBe(true);

    const offline = createExpoLibraryReachability(() => ({
      getNetworkStateAsync: async () => ({
        isConnected: false,
        isInternetReachable: false,
      }),
    }) as never);
    expect(await offline.isReachable()).toBe(false);

    const boom = createExpoLibraryReachability(() => {
      throw new Error('native module missing');
    });
    expect(await boom.isReachable()).toBe(true);
  });
});

describe('board #27 S2: the local thumbnail tier', () => {
  async function withNamedThumbnail(): Promise<{
    h: RenderHarness;
    thumbnailUri: string;
  }> {
    const h = await createRenderHarness();
    await seedCloudOnly(h);
    const thumbnailUri = h.actions.files.thumbnailUriFor(DIGEST, 'webp');
    h.actions.port.files.set(thumbnailUri, THUMB_BYTES);
    await expect(
      h.actions.repository.setLocalThumbnail(DIGEST, thumbnailUri),
    ).resolves.toBe(true);
    return { h, thumbnailUri };
  }

  it('a row naming no thumbnail never probes one', async () => {
    const h = await createRenderHarness();
    await seedCloudOnly(h);
    await sealAndStore(h, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);
    const probed: unknown[] = [];
    const realExists = h.actions.port.exists.bind(h.actions.port);
    h.actions.port.exists = async (uri: string) => {
      probed.push(uri);
      return realExists(uri);
    };

    await expect(h.resolver.resolve(DIGEST, 'grid')).resolves.toMatchObject({
      kind: 'file',
      tier: 'cloud-thumbnail',
    });
    // On the Expo port a null uri would throw inside `new File(null)`.
    expect(probed.filter((uri) => typeof uri !== 'string')).toEqual([]);
    h.close();
  });

  it('grid serves it before the cloud', async () => {
    const { h, thumbnailUri } = await withNamedThumbnail();
    await sealAndStore(h, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);

    await expect(h.resolver.resolve(DIGEST, 'grid')).resolves.toEqual({
      kind: 'file',
      uri: thumbnailUri,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    });
    expect(h.getObjectCalls).toEqual([]);
    h.close();
  });

  it('detail prefers the cloud preview, and falls to the local thumbnail offline', async () => {
    const { h, thumbnailUri } = await withNamedThumbnail();
    await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);

    const online = await h.resolver.resolve(DIGEST, 'detail');
    expect(online).toMatchObject({ kind: 'file', tier: 'cloud-preview', role: 'preview' });
    await h.actions.database.run('DELETE FROM library_cache_entries');
    h.reachability.value = false;

    await expect(h.resolver.resolve(DIGEST, 'detail')).resolves.toEqual({
      kind: 'file',
      uri: thumbnailUri,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    });
    h.close();
  });

  it('full never serves it', async () => {
    const { h } = await withNamedThumbnail();
    h.reachability.value = false;

    await expect(h.resolver.resolve(DIGEST, 'full')).resolves.toEqual({
      kind: 'unavailable',
      category: 'offline',
    });
    h.close();
  });

  it('a named thumbnail whose file is gone is skipped', async () => {
    const { h, thumbnailUri } = await withNamedThumbnail();
    h.actions.port.files.delete(thumbnailUri);
    await sealAndStore(h, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);

    await expect(h.resolver.resolve(DIGEST, 'grid')).resolves.toMatchObject({
      kind: 'file',
      tier: 'cloud-thumbnail',
    });
    h.close();
  });

  it("a trashed asset's thumbnail is not served", async () => {
    const { h } = await withNamedThumbnail();
    await upsertProtected(h, { lifecycle: 'trash' });

    await expect(h.resolver.resolve(DIGEST, 'grid')).resolves.toEqual({
      kind: 'unavailable',
      category: 'object_missing',
    });
    h.close();
  });

  it('an original-role integrity failure is not hidden behind it', async () => {
    const { h } = await withNamedThumbnail();
    await h.actions.database.run(
      "UPDATE device_library_assets SET format = 'gif' WHERE plaintext_sha256 = ?",
      [DIGEST],
    );
    await sealAndStore(h, 'preview', ORIGINAL, TEST_GENERATION_ID);

    await expect(h.resolver.resolve(DIGEST, 'detail')).resolves.toEqual({
      kind: 'unavailable',
      category: 'integrity',
      role: 'original',
    });
    h.close();
  });

  describe('the role reader', () => {
    it('reads the preview from the cloud, then from the cache', async () => {
      const h = await createRenderHarness();
      await seedCloudOnly(h);
      await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);

      await expect(h.roles.read(DIGEST, 'preview')).resolves.toMatchObject({
        kind: 'file',
        tier: 'cloud-preview',
        role: 'preview',
      });
      await expect(h.roles.read(DIGEST, 'preview')).resolves.toMatchObject({
        kind: 'file',
        tier: 'cached-preview',
        role: 'preview',
      });
      const entry = await h.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'preview');
      expect(entry?.byteSize).toBe(PREVIEW_BYTES.byteLength);
      h.close();
    });

    it('answers object_missing for a role with no generation', async () => {
      const h = await createRenderHarness();
      await seedCloudOnly(h);
      await upsertProtected(h, { previewGenerationId: null });

      await expect(h.roles.read(DIGEST, 'preview')).resolves.toEqual({
        kind: 'unavailable',
        category: 'object_missing',
      });
      expect(h.getObjectCalls).toEqual([]);
      h.close();
    });

    it('reads the original from the cloud even when the phone holds it', async () => {
      const h = await createRenderHarness();
      await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
      await upsertProtected(h);
      await sealAndStore(h, 'original', ORIGINAL, TEST_GENERATION_ID);

      await expect(h.roles.read(DIGEST, 'original')).resolves.toMatchObject({
        kind: 'file',
        tier: 'cloud-original',
        role: 'original',
      });
      h.close();
    });
  });
});

describe('placeholder intent', () => {
  it('returns a cached thumbnail and does not fetch', async () => {
    const harness = await createRenderHarness({ nodeStreamRoot: true });
    await seedCloudOnly(harness);
    await harness.cache.put({
      accountScope: TEST_ACCOUNT_SCOPE,
      plaintextSha256: DIGEST,
      role: 'thumbnail',
      generationId: TEST_THUMBNAIL_GENERATION_ID,
      bytes: THUMB_BYTES,
    });
    const entry = await harness.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'thumbnail');
    const getObject = jest.spyOn(harness.actions.s3, 'getObjectToFile');

    const source = await harness.resolver.resolve(DIGEST, 'placeholder');

    expect(entry).not.toBeNull();
    expect(source).toEqual({
      kind: 'file',
      uri: entry!.uri,
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    });
    expect(harness.getObjectCalls).toEqual([]);
    expect(getObject).not.toHaveBeenCalled();
    harness.close();
  });

  it('with nothing cached and a thumbnail generation, starts no transfer and is unavailable', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await sealAndStore(harness, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);
    const getObject = jest.spyOn(harness.actions.s3, 'getObjectToFile');

    const source = await harness.resolver.resolve(DIGEST, 'placeholder');

    expect(source).toEqual({ kind: 'unavailable', category: 'object_missing' });
    expect(harness.getObjectCalls).toEqual([]);
    expect(getObject).not.toHaveBeenCalled();
    harness.close();
  });

  it('with a local original present, still returns the local thumbnail', async () => {
    const harness = await createRenderHarness();
    await harness.actions.seedLocalAsset({
      plaintextSha256: DIGEST,
      bytes: ORIGINAL,
    });
    await upsertProtected(harness);
    const thumbnailUri = harness.actions.files.thumbnailUriFor(DIGEST, 'webp');
    harness.actions.port.files.set(thumbnailUri, THUMB_BYTES);
    await expect(
      harness.actions.repository.setLocalThumbnail(DIGEST, thumbnailUri),
    ).resolves.toBe(true);
    const getObject = jest.spyOn(harness.actions.s3, 'getObjectToFile');

    const source = await harness.resolver.resolve(DIGEST, 'placeholder');

    expect(source).toEqual({
      kind: 'file',
      uri: thumbnailUri,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    });
    expect(source).not.toMatchObject({ tier: 'local-original' });
    expect(harness.getObjectCalls).toEqual([]);
    expect(getObject).not.toHaveBeenCalled();
    harness.close();
  });

  it('returns the durable local thumbnail when no thumbnail generation exists, and does not fetch', async () => {
    const harness = await createRenderHarness();
    await seedCloudOnly(harness);
    await upsertProtected(harness, { thumbnailGenerationId: null });
    const thumbnailUri = harness.actions.files.thumbnailUriFor(DIGEST, 'webp');
    harness.actions.port.files.set(thumbnailUri, THUMB_BYTES);
    await expect(
      harness.actions.repository.setLocalThumbnail(DIGEST, thumbnailUri),
    ).resolves.toBe(true);
    const getObject = jest.spyOn(harness.actions.s3, 'getObjectToFile');

    const source = await harness.resolver.resolve(DIGEST, 'placeholder');

    expect(source).toEqual({
      kind: 'file',
      uri: thumbnailUri,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    });
    expect(harness.getObjectCalls).toEqual([]);
    expect(getObject).not.toHaveBeenCalled();
    harness.close();
  });
});
