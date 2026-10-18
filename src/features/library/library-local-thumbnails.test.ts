jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  TEST_ACCOUNT_SCOPE,
  TEST_GENERATION_ID,
  TEST_MASTER_KEY,
  TEST_PREVIEW_GENERATION_ID,
  TEST_THUMBNAIL_GENERATION_ID,
} from '@/features/library/library-actions-test-support';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import {
  createLibraryLocalThumbnails,
  type LibraryLocalThumbnails,
} from '@/features/library/library-local-thumbnails';
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
import type { LibraryRoleReader } from '@/features/library/library-render-source';
import {
  asciiBytes,
  GIF_FIXTURE,
  JPEG_FIXTURE,
  type FakeLibraryFilePort,
} from '@/features/library/library-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

beforeEach(() => {
  resetExpoCryptoDouble();
});

function build(
  h: RenderHarness,
  options: Readonly<{
    cloud?: boolean;
    roles?: LibraryRoleReader;
    derived?: LibraryDerivedImages;
    originalByteLimit?: number;
  }> = {},
): LibraryLocalThumbnails {
  return createLibraryLocalThumbnails({
    repository: h.actions.repository,
    files: h.actions.files,
    port: h.actions.port,
    derived: options.derived ?? h.derived,
    ...(options.originalByteLimit === undefined ? {} : { originalByteLimit: options.originalByteLimit }),
    ...(options.cloud === false
      ? {}
      : {
          cloud: {
            session: h.actions.session,
            roles: options.roles ?? h.roles,
            cache: h.cache,
          },
        }),
  });
}

function recordingRoles(h: RenderHarness, readRoles: string[]): LibraryRoleReader {
  return {
    read: (sha, role) => {
      readRoles.push(role);
      return h.roles.read(sha, role);
    },
  };
}

async function thumbnailUriOf(h: RenderHarness): Promise<string | null> {
  return (await h.actions.repository.findLocalAsset(DIGEST))?.localThumbnailUri ?? null;
}

function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const identity = jest.requireActual('@/features/library/library-identity') as
  typeof import('@/features/library/library-identity');
const SECOND: string = identity.sha256PlaintextHex(WRONG_ORIGINAL);
const SECOND_GENERATION_ID = 'second-original-gen';
const THIRD_ORIGINAL = Uint8Array.from([7, 7, 7, 7, 7, 7, 7, 7]);
const THIRD: string = identity.sha256PlaintextHex(THIRD_ORIGINAL);
const THIRD_GENERATION_ID = 'third-original-gen';

/** Another cloud-only digest with only an original, told apart from DIGEST (width 10) by its width. */
async function seedOriginalOnly(h: RenderHarness, digest: string, plaintext: Uint8Array,
  generationId: string, width: number): Promise<void> {
  await h.actions.seedProjectedAsset({
    plaintextSha256: digest,
    protection: 'protected',
    originalGenerationId: generationId,
  });
  const assetId = h.actions.assetIdFor(digest);
  await h.actions.protection.upsertProtection({
    accountScope: TEST_ACCOUNT_SCOPE,
    assetId,
    plaintextSha256: digest,
    lifecycle: 'active',
    protection: 'protected',
    generation: 1,
    revision: 1,
    originalGenerationId: generationId,
    originalCiphertextBytes: 128,
    thumbnailGenerationId: null,
    previewGenerationId: null,
    verifiedAt: 1,
    failureCategory: null,
    trashedAt: null,
  });
  await h.actions.database.run(
    'UPDATE device_library_assets SET width = ? WHERE plaintext_sha256 = ?',
    [width, digest],
  );
  h.actions.cloud.blobs.set(generationId, await h.actions.cipher.seal({
    masterKey: TEST_MASTER_KEY,
    assetId,
    scope: 'original',
    plaintext,
  }));
}

const seedSecondOriginalOnly = (h: RenderHarness) => (
  seedOriginalOnly(h, SECOND, WRONG_ORIGINAL, SECOND_GENERATION_ID, 20)
);

async function seedFirstOriginalOnly(h: RenderHarness): Promise<void> {
  await seedCloudOnly(h);
  await upsertProtected(h, { thumbnailGenerationId: null, previewGenerationId: null });
  await sealAndStore(h, 'original', ORIGINAL, TEST_GENERATION_ID);
}

const macrotask = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/** Bounded wait: at most 200 macrotasks, never Jest's timeout. */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await macrotask();
}

/** Flush until `size()` has not grown for 5 consecutive macrotasks (at most 200). */
async function flushUntilStable(size: () => number): Promise<void> {
  let last = size();
  let stable = 0;
  for (let i = 0; i < 200 && stable < 5; i += 1) {
    await macrotask();
    const now = size();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

describe('ensureLocalThumbnail', () => {
  let h: RenderHarness;
  let T: string;

  beforeEach(async () => {
    h = await createRenderHarness();
    T = h.actions.files.thumbnailUriFor(DIGEST, 'webp');
  });

  afterEach(() => {
    h.close();
  });

  it('makes a local original into the thumbnail role only', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toEqual({ status: 'ensured', uri: T, source: 'local-original' });
    expect(h.deriveCalls).toEqual([expect.objectContaining({
      sourceUri: h.actions.originalUriFor(DIGEST),
      roles: ['thumbnail'],
    })]);
    expect([...h.actions.port.files.get(T)!]).toEqual([...THUMB_BYTES]);
    expect(await thumbnailUriOf(h)).toBe(T);
    expect(h.getObjectCalls).toEqual([]);
  });

  it('does nothing when the named file is present', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    const ensure = build(h);
    await ensure.ensureLocalThumbnail(DIGEST);

    const again = await ensure.ensureLocalThumbnail(DIGEST);

    expect(again).toEqual({ status: 'ensured', uri: T, source: 'existing' });
    expect(h.deriveCalls).toHaveLength(1);
  });

  it('makes a named file that is gone again', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    const ensure = build(h);
    await ensure.ensureLocalThumbnail(DIGEST);
    h.actions.port.files.delete(T);

    const again = await ensure.ensureLocalThumbnail(DIGEST);

    expect(again).toEqual({ status: 'ensured', uri: T, source: 'local-original' });
    expect(h.deriveCalls).toHaveLength(2);
  });

  it('answers unchecked when the probe throws, never a guess', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    const ensure = build(h);
    await ensure.ensureLocalThumbnail(DIGEST);
    jest.spyOn(h.actions.port, 'probe').mockRejectedValue(new Error('too many open files'));

    const again = await ensure.ensureLocalThumbnail(DIGEST);

    expect(again).toEqual({ status: 'failed', reason: 'unchecked' });
    expect(h.deriveCalls).toHaveLength(1);
  });

  it('keeps a cloud thumbnail as it is, the extension from its bytes', async () => {
    await seedCloudOnly(h);
    await sealAndStore(h, 'thumbnail', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result.status).toBe('ensured');
    if (result.status !== 'ensured') return;
    expect(result.uri.endsWith(`/${DIGEST}.jpg`)).toBe(true);
    expect(result.source).toBe('cloud-thumbnail');
    expect([...h.actions.port.files.get(result.uri)!]).toEqual([...JPEG_FIXTURE]);
    expect(h.deriveCalls).toEqual([]);
  });

  it('resizes the preview when the asset has no cloud thumbnail', async () => {
    await seedCloudOnly(h);
    await upsertProtected(h, { thumbnailGenerationId: null });
    await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
    expect(h.deriveCalls[0].sourceUri.startsWith(h.actions.port.cacheRootUri)).toBe(true);
    expect(await cacheRowCount(h)).toBe(1);
  });

  it('resizes the original and then discards it when nothing smaller exists', async () => {
    await seedCloudOnly(h);
    await upsertProtected(h, { thumbnailGenerationId: null, previewGenerationId: null });
    await sealAndStore(h, 'original', ORIGINAL, TEST_GENERATION_ID);

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-original' });
    expect(await h.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'original')).toBeNull();
    expect([...h.actions.port.files.keys()].some((key) => key.endsWith('-original.bin')))
      .toBe(false);
  });

  it('leaves an original that was already cached', async () => {
    await seedCloudOnly(h);
    await upsertProtected(h, { thumbnailGenerationId: null, previewGenerationId: null });
    await sealAndStore(h, 'original', ORIGINAL, TEST_GENERATION_ID);
    await h.cache.put({
      accountScope: TEST_ACCOUNT_SCOPE,
      plaintextSha256: DIGEST,
      role: 'original',
      generationId: TEST_GENERATION_ID,
      bytes: ORIGINAL,
    });

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-original' });
    expect(await h.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'original')).not.toBeNull();
  });

  it('stops on a transient failure and never requests a larger role', async () => {
    await seedCloudOnly(h);
    await sealAndStore(h, 'thumbnail', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
    await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);
    h.failNextGetObject(new Error('socket closed'));

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toEqual({ status: 'failed', reason: 'cloud', category: 'retryable_transfer' });
    expect(h.getObjectCalls).toEqual([{ generationId: TEST_THUMBNAIL_GENERATION_ID }]);
    expect(await h.actions.port.listThumbnails()).toEqual([]);
  });

  it('stops offline at the first role', async () => {
    await seedCloudOnly(h);
    await sealAndStore(h, 'thumbnail', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
    h.reachability.value = false;
    const readRoles: string[] = [];

    const result = await build(h, { roles: recordingRoles(h, readRoles) })
      .ensureLocalThumbnail(DIGEST);

    expect(result).toEqual({ status: 'failed', reason: 'cloud', category: 'offline' });
    expect(readRoles).toEqual(['thumbnail']);
  });

  it('falls to the preview when the cloud thumbnail is corrupt', async () => {
    await seedCloudOnly(h);
    // Sealed for the wrong role: the AEAD check fails as an integrity failure.
    await sealAndStore(h, 'preview', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
    await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
  });

  it('has no source without a cloud dependency', async () => {
    await seedCloudOnly(h);

    const result = await build(h, { cloud: false }).ensureLocalThumbnail(DIGEST);

    expect(result).toEqual({ status: 'failed', reason: 'no-source' });
  });

  it('shares one run per digest', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    const gate = deferred();
    let calls = 0;
    const derived: LibraryDerivedImages = {
      async derive() {
        calls += 1;
        await gate.promise;
        return {
          thumbnail: { role: 'thumbnail', bytes: THUMB_BYTES, width: 8, height: 8, format: 'webp' },
          preview: null,
          animated: false,
          failed: false,
        };
      },
    };
    const ensure = build(h, { derived });

    const first = ensure.ensureLocalThumbnail(DIGEST);
    const second = ensure.ensureLocalThumbnail(DIGEST);
    gate.release();

    const [a, b] = [await first, await second];
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.status).toBe('ensured');
  });

  it('keeps no file for a row that vanishes before the update', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    const derived: LibraryDerivedImages = {
      async derive() {
        await h.actions.database.run('DELETE FROM device_library_assets');
        return {
          thumbnail: { role: 'thumbnail', bytes: THUMB_BYTES, width: 8, height: 8, format: 'webp' },
          preview: null,
          animated: false,
          failed: false,
        };
      },
    };

    const result = await build(h, { derived }).ensureLocalThumbnail(DIGEST);

    expect(result).toEqual({ status: 'failed', reason: 'no-asset' });
    expect(h.actions.port.files.has(T)).toBe(false);
  });

  it('names nothing when the move fails', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    h.actions.port.failMoves = true;

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toEqual({ status: 'failed', reason: 'write-failed' });
    expect(await thumbnailUriOf(h)).toBeNull();
    expect(h.actions.port.files.has(T)).toBe(false);
  });

  it('falls to the preview when the cloud thumbnail is a gif', async () => {
    await seedCloudOnly(h);
    await sealAndStore(h, 'thumbnail', GIF_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
    await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
  });

  it('falls to the cloud when the local original cannot be resized', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    await upsertProtected(h);
    await sealAndStore(h, 'thumbnail', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
    const derived: LibraryDerivedImages = {
      async derive() {
        return { thumbnail: null, preview: null, animated: false, failed: true };
      },
    };

    const result = await build(h, { derived }).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-thumbnail' });
  });

  it('checks the session before asking the cloud for any role', async () => {
    await seedCloudOnly(h);
    h.actions.session.value = null;
    const readRoles: string[] = [];

    const result = await build(h, { roles: recordingRoles(h, readRoles) })
      .ensureLocalThumbnail(DIGEST);

    expect(result).toEqual({ status: 'failed', reason: 'cloud', category: 'auth_attention' });
    expect(readRoles).toEqual([]);
    expect(h.getObjectCalls).toEqual([]);
  });

  it.each([
    ['its file is gone', 'gone'],
    ['it is flagged missing', 'flagged'],
    ['the row is not local-original', 'cloud-only'],
  ] as const)('never resizes a local original when %s: the cloud thumbnail instead', async (_name, mode) => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    await upsertProtected(h);
    await sealAndStore(h, 'thumbnail', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
    if (mode === 'gone') {
      h.actions.port.files.delete(h.actions.originalUriFor(DIGEST));
    } else if (mode === 'flagged') {
      await h.actions.database.run(
        'UPDATE device_library_assets SET missing_original_since = 1 WHERE plaintext_sha256 = ?',
        [DIGEST],
      );
    } else {
      await h.actions.database.run(
        "UPDATE device_library_assets SET residency = 'cloud-only' WHERE plaintext_sha256 = ?",
        [DIGEST],
      );
    }

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-thumbnail' });
    expect(h.deriveCalls).toEqual([]);
  });

  it('answers unsupported_image when the last source, the original, cannot be resized', async () => {
    await seedCloudOnly(h);
    await upsertProtected(h, { thumbnailGenerationId: null, previewGenerationId: null });
    await sealAndStore(h, 'original', ORIGINAL, TEST_GENERATION_ID);
    const derived: LibraryDerivedImages = {
      async derive() {
        return { thumbnail: null, preview: null, animated: false, failed: true };
      },
    };

    await expect(build(h, { derived }).ensureLocalThumbnail(DIGEST)).resolves.toEqual({
      status: 'failed',
      reason: 'cloud',
      category: 'unsupported_image',
    });
    // The original fetched for it is discarded even though the resize failed.
    expect(await h.cache.find(TEST_ACCOUNT_SCOPE, DIGEST, 'original')).toBeNull();
    expect([...h.actions.port.files.keys()].some((key) => key.endsWith('-original.bin')))
      .toBe(false);
  });

  it('falls to the preview when the cloud thumbnail bytes are not an image it knows', async () => {
    await seedCloudOnly(h);
    await sealAndStore(h, 'thumbnail', THUMB_BYTES, TEST_THUMBNAIL_GENERATION_ID);
    await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
  });

  it('falls to the preview when the cached thumbnail cannot be read', async () => {
    await seedCloudOnly(h);
    await sealAndStore(h, 'thumbnail', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
    await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);
    const realRead = h.actions.port.readBytes.bind(h.actions.port);
    h.actions.port.readBytes = async (uri: string) => {
      if (uri.endsWith('-thumbnail.bin')) throw new Error('read failed');
      return realRead(uri);
    };

    const result = await build(h).ensureLocalThumbnail(DIGEST);

    expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
  });

  it('never rejects: a thrown error answers error, and the next call runs again', async () => {
    await h.actions.seedLocalAsset({ plaintextSha256: DIGEST, bytes: ORIGINAL });
    let throws = true;
    const derived: LibraryDerivedImages = {
      async derive(input) {
        if (throws) throw new Error('decoder crashed');
        return h.derived.derive(input);
      },
    };
    const ensure = build(h, { derived, cloud: false });

    await expect(ensure.ensureLocalThumbnail(DIGEST)).resolves.toEqual({
      status: 'failed',
      reason: 'error',
    });
    throws = false;
    await expect(ensure.ensureLocalThumbnail(DIGEST)).resolves.toMatchObject({
      status: 'ensured',
      source: 'local-original',
    });
  });
  describe('board #31: the original role', () => {
    const setSize = (bytes: number) => h.actions.database.run(
      'UPDATE device_library_assets SET byte_size = ? WHERE plaintext_sha256 = ?',
      [bytes, DIGEST],
    );

    it('is never fetched past the limit', async () => {
      await seedFirstOriginalOnly(h);
      await setSize(17);

      const result = await build(h, { originalByteLimit: 16 }).ensureLocalThumbnail(DIGEST);

      expect(result).toEqual({ status: 'failed', reason: 'too-large' });
      expect(h.getObjectCalls).toEqual([]);
    });

    it('is fetched at the limit', async () => {
      await seedFirstOriginalOnly(h);
      await setSize(16);

      const result = await build(h, { originalByteLimit: 16 }).ensureLocalThumbnail(DIGEST);

      expect(result).toMatchObject({ status: 'ensured', source: 'cloud-original' });
    });

    it('does not limit a cloud thumbnail', async () => {
      await seedCloudOnly(h);
      await sealAndStore(h, 'thumbnail', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
      await setSize(17);

      const result = await build(h, { originalByteLimit: 16 }).ensureLocalThumbnail(DIGEST);

      expect(result).toMatchObject({ status: 'ensured', source: 'cloud-thumbnail' });
    });
  });

  describe('board #31: one cloud original at a time', () => {
    const labelOf = (width: number) => (width === 10 ? 'first' : 'second');

    it('reads and resizes the second original only after the first is done', async () => {
      await seedFirstOriginalOnly(h);
      await seedSecondOriginalOnly(h);
      const reads: string[] = [];
      const roles: LibraryRoleReader = {
        read: (sha, role) => {
          reads.push(`${sha === DIGEST ? 'first' : 'second'}:${role}`);
          return h.roles.read(sha, role);
        },
      };
      const gate = deferred();
      const log: string[] = [];
      let held = false;
      const derived: LibraryDerivedImages = {
        async derive(input) {
          log.push(`start:${labelOf(input.width)}`);
          if (!held) {
            held = true;
            await gate.promise;
          }
          const made = await h.derived.derive(input);
          log.push(`end:${labelOf(input.width)}`);
          return made;
        },
      };
      const ensure = build(h, { roles, derived });

      const a = ensure.ensureLocalThumbnail(DIGEST);
      const b = ensure.ensureLocalThumbnail(SECOND);
      await waitUntil(() => log.length >= 1);
      await flushUntilStable(() => reads.length);

      const holder = log[0]!.slice('start:'.length);
      const other = holder === 'first' ? 'second' : 'first';
      expect(log).toEqual([`start:${holder}`]);
      expect(reads.filter((entry) => entry.endsWith(':original'))).toEqual([`${holder}:original`]);

      gate.release();
      const results = [await a, await b];

      expect(log).toEqual([`start:${holder}`, `end:${holder}`, `start:${other}`, `end:${other}`]);
      expect(results.map((r) => r.status)).toEqual(['ensured', 'ensured']);
    });

    it('never holds a cloud thumbnail behind an original in flight', async () => {
      await seedCloudOnly(h);
      await sealAndStore(h, 'thumbnail', JPEG_FIXTURE, TEST_THUMBNAIL_GENERATION_ID);
      await seedSecondOriginalOnly(h);
      const gate = deferred();
      let secondDeriving = false;
      const derived: LibraryDerivedImages = {
        async derive(input) {
          if (input.width === 20) {
            secondDeriving = true;
            await gate.promise;
          }
          return h.derived.derive(input);
        },
      };
      const ensure = build(h, { derived });

      const second = ensure.ensureLocalThumbnail(SECOND);
      await waitUntil(() => secondDeriving);
      let firstSettled = false;
      const first = ensure.ensureLocalThumbnail(DIGEST).finally(() => { firstSettled = true; });
      await waitUntil(() => firstSettled);

      expect(firstSettled).toBe(true);
      expect(await first).toMatchObject({ status: 'ensured', source: 'cloud-thumbnail' });
      gate.release();
      expect((await second).status).toBe('ensured');
    });

    it('lets one waiting original through at a time, however many wait', async () => {
      await seedFirstOriginalOnly(h);
      await seedSecondOriginalOnly(h);
      await seedOriginalOnly(h, THIRD, THIRD_ORIGINAL, THIRD_GENERATION_ID, 30);
      const holds: (() => void)[] = [];
      let resizing = 0;
      let peak = 0;
      const derived: LibraryDerivedImages = {
        async derive(input) {
          resizing += 1;
          peak = Math.max(peak, resizing);
          await new Promise<void>((resolve) => { holds.push(resolve); });
          try {
            return await h.derived.derive(input);
          } finally {
            resizing -= 1;
          }
        },
      };
      const ensure = build(h, { derived });

      const runs = [DIGEST, SECOND, THIRD].map((digest) => ensure.ensureLocalThumbnail(digest));
      for (let released = 0; released < 3; released += 1) {
        await waitUntil(() => holds.length > released);
        await flushUntilStable(() => holds.length);
        // Exactly one more original is resizing: the other waiters still wait.
        expect(holds.length).toBe(released + 1);
        holds[released]!();
      }

      expect((await Promise.all(runs)).map((result) => result.status))
        .toEqual(['ensured', 'ensured', 'ensured']);
      expect(peak).toBe(1);
    });

    it('frees the slot when a resize throws', async () => {
      await seedFirstOriginalOnly(h);
      await seedSecondOriginalOnly(h);
      let firstDeriveCalled = false;
      const derived: LibraryDerivedImages = {
        async derive(input) {
          if (input.width === 10) {
            firstDeriveCalled = true;
            throw new Error('decoder crashed');
          }
          return h.derived.derive(input);
        },
      };
      const ensure = build(h, { derived });

      const first = ensure.ensureLocalThumbnail(DIGEST);
      await waitUntil(() => firstDeriveCalled);
      let secondSettled = false;
      const second = ensure.ensureLocalThumbnail(SECOND).finally(() => { secondSettled = true; });
      await flushUntilStable(() => (secondSettled ? 1 : 0));
      await waitUntil(() => secondSettled);

      expect(await first).toEqual({ status: 'failed', reason: 'error' });
      expect(secondSettled).toBe(true);
      expect((await second).status).toBe('ensured');
    });
  });

  describe('row 31 Task 4: a cloud thumbnail is probed before it is read', () => {
    /** A JPEG longer than the 16-byte probe, so keeping only the prefix is observable. */
    const LONG_JPEG = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
    ]);
    const MIB = 1024 * 1024;
    const isThumb = (uri: string): boolean => uri.endsWith('-thumbnail.bin');

    const seedThumbnailAndPreview = async (h: RenderHarness, thumbnail: Uint8Array) => {
      await seedCloudOnly(h);
      await sealAndStore(h, 'thumbnail', thumbnail, TEST_THUMBNAIL_GENERATION_ID);
      await sealAndStore(h, 'preview', PREVIEW_BYTES, TEST_PREVIEW_GENERATION_ID);
    };

    type RecordedRead = Readonly<{
      op: 'readBytes' | 'readPrefix';
      uri: string;
      /** Present only on readPrefix: the length the pass asked for. */
      length?: number;
    }>;

    /** A port over the harness's map that records whole and prefix reads. */
    const recordingPort = (
      base: FakeLibraryFilePort,
      sizeFor?: (uri: string) => number | undefined,
    ): { port: Parameters<typeof createLibraryLocalThumbnails>[0]['port']; reads: RecordedRead[] } => {
      const reads: RecordedRead[] = [];
      return {
        reads,
        port: {
          probe: (uri) => base.probe(uri),
          readBytes: async (uri) => {
            reads.push({ op: 'readBytes', uri });
            return base.readBytes(uri);
          },
          size: async (uri) => {
            const overridden = sizeFor?.(uri);
            return overridden === undefined ? base.size(uri) : overridden;
          },
          readPrefix: async (uri, length) => {
            reads.push({ op: 'readPrefix', uri, length });
            return base.readPrefix(uri, length);
          },
        },
      };
    };

    const buildWithPort = (h: RenderHarness,
      port: Parameters<typeof createLibraryLocalThumbnails>[0]['port']): LibraryLocalThumbnails => (
      createLibraryLocalThumbnails({
        repository: h.actions.repository,
        files: h.actions.files,
        port,
        derived: h.derived,
        cloud: { session: h.actions.session, roles: h.roles, cache: h.cache },
      })
    );

    it('never reads an oversized thumbnail and tries the preview next', async () => {
      await seedThumbnailAndPreview(h, JPEG_FIXTURE);
      const { port, reads } = recordingPort(
        h.actions.port,
        (uri) => (isThumb(uri) ? 2 * MIB + 1 : undefined),
      );

      const result = await buildWithPort(h, port).ensureLocalThumbnail(DIGEST);

      expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
      expect(reads.filter((read) => isThumb(read.uri))).toEqual([]);
    });

    it('moves on from a gif detected from the prefix without reading it whole', async () => {
      await seedThumbnailAndPreview(h, GIF_FIXTURE);
      const { port, reads } = recordingPort(h.actions.port);

      const result = await buildWithPort(h, port).ensureLocalThumbnail(DIGEST);

      expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
      expect(reads.filter((read) => isThumb(read.uri) && read.op === 'readBytes')).toEqual([]);
      expect(reads.some((read) => isThumb(read.uri) && read.op === 'readPrefix')).toBe(true);
    });

    it('keeps a normal thumbnail whole, once, after the prefix check', async () => {
      await seedThumbnailAndPreview(h, LONG_JPEG);
      const { port, reads } = recordingPort(h.actions.port);

      const result = await buildWithPort(h, port).ensureLocalThumbnail(DIGEST);

      expect(result.status).toBe('ensured');
      if (result.status !== 'ensured') return;
      expect(result.source).toBe('cloud-thumbnail');
      expect([...h.actions.port.files.get(result.uri)!]).toEqual([...LONG_JPEG]);
      const prefixAt = reads.findIndex((read) => isThumb(read.uri) && read.op === 'readPrefix');
      const wholeAt = reads.findIndex((read) => isThumb(read.uri) && read.op === 'readBytes');
      expect(prefixAt).toBeGreaterThanOrEqual(0);
      expect(wholeAt).toBeGreaterThan(prefixAt);
      expect(reads.filter((read) => isThumb(read.uri) && read.op === 'readBytes')).toHaveLength(1);
    });

    it('probes 16 bytes and keeps a webp whose tag sits past byte 4', async () => {
      const LONG_WEBP = Uint8Array.from([
        ...asciiBytes('RIFF'), 0x24, 0x00, 0x00, 0x00,
        ...asciiBytes('WEBP'), ...asciiBytes('VP8 '),
        0x01, 0x02, 0x03, 0x04,
      ]);
      await seedThumbnailAndPreview(h, LONG_WEBP);
      const { port, reads } = recordingPort(h.actions.port);

      const result = await buildWithPort(h, port).ensureLocalThumbnail(DIGEST);

      expect(result.status).toBe('ensured');
      if (result.status !== 'ensured') return;
      expect(result.source).toBe('cloud-thumbnail');
      expect([...h.actions.port.files.get(result.uri)!]).toEqual([...LONG_WEBP]);
      expect(reads.find((read) => isThumb(read.uri) && read.op === 'readPrefix')?.length)
        .toBe(16);
    });

    it('tries the preview when the prefix read rejects', async () => {
      await seedThumbnailAndPreview(h, JPEG_FIXTURE);
      const base = h.actions.port;
      const { port } = recordingPort(base);
      const failing: Parameters<typeof createLibraryLocalThumbnails>[0]['port'] = {
        ...port,
        readPrefix: async (uri, length) => {
          if (isThumb(uri)) throw new Error('prefix read failed');
          return base.readPrefix(uri, length);
        },
      };

      const result = await buildWithPort(h, failing).ensureLocalThumbnail(DIGEST);

      expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
    });

    it('tries the preview when the size check rejects, before any read', async () => {
      await seedThumbnailAndPreview(h, JPEG_FIXTURE);
      const base = h.actions.port;
      const { port, reads } = recordingPort(base);
      const failing: Parameters<typeof createLibraryLocalThumbnails>[0]['port'] = {
        ...port,
        size: async (uri) => {
          if (isThumb(uri)) throw new Error('size failed');
          return base.size(uri);
        },
      };

      const result = await buildWithPort(h, failing).ensureLocalThumbnail(DIGEST);

      expect(result).toMatchObject({ status: 'ensured', source: 'cloud-preview' });
      expect(reads.filter((read) => isThumb(read.uri))).toEqual([]);
    });

    it('keeps a thumbnail at exactly the bound, decided by the size check', async () => {
      await seedThumbnailAndPreview(h, JPEG_FIXTURE);
      const { port, reads } = recordingPort(
        h.actions.port,
        (uri) => (isThumb(uri) ? 2 * MIB : undefined),
      );

      const result = await buildWithPort(h, port).ensureLocalThumbnail(DIGEST);

      expect(result).toMatchObject({ status: 'ensured', source: 'cloud-thumbnail' });
      expect(reads.some((read) => isThumb(read.uri) && read.op === 'readPrefix')).toBe(true);
    });
  });
});
