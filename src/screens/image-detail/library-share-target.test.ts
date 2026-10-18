import type { StoredImage } from '@/features/images/image-repository';
import type { LibraryEntry } from '@/features/library/library-view-model';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import {
  resolveEntryShareTarget,
  resolveShareTarget,
} from '@/screens/image-detail/library-share-target';

const image = (o: Partial<StoredImage>): StoredImage => ({
  id: 7, downloadState: 'ready', localUri: 'file:///collection/7.jpg', ...o,
} as StoredImage);
const entry = (o: Partial<LibraryEntry> = {}): LibraryEntry => ({
  plaintextSha256: 'd'.repeat(64), sourceImageId: 7, hasLocalOriginal: true, ...o,
} as LibraryEntry);
const fileSource: LibraryRenderSource = {
  kind: 'file', uri: 'file:///library/originals/d.jpg', tier: 'local-original', role: 'original',
};
const cacheSource = (tier: 'cached-original' | 'cloud-original'): LibraryRenderSource => ({
  kind: 'file', uri: 'file:///cache/library-cache/scope-d-original.bin', tier, role: 'original',
});
const stagedUri = (name: string): string => `file:///cache/library-share/${name}`;
const stage = (): jest.Mock<Promise<string>> =>
  jest.fn(async (_sourceUri: string, fileName: string) => stagedUri(fileName));

test('a ready row with its own collection file shares through the collection service', async () => {
  const resolveFull = jest.fn();
  const stageTarget = stage();
  await expect(resolveShareTarget(image({}), entry(), resolveFull, stageTarget))
    .resolves.toEqual({ kind: 'collection', imageId: 7 });
  expect(resolveFull).not.toHaveBeenCalled();
  expect(stageTarget).not.toHaveBeenCalled();
});

test('a mirrored row shares the library file the resolver returns', async () => {
  const resolveFull = jest.fn(async () => fileSource);
  const stageTarget = stage();
  await expect(resolveShareTarget(image({ downloadState: 'mirrored', localUri: null }), entry(), resolveFull, stageTarget))
    .resolves.toEqual({ kind: 'file', uri: 'file:///library/originals/d.jpg' });
  expect(resolveFull).toHaveBeenCalledWith('d'.repeat(64));
  expect(stageTarget).not.toHaveBeenCalled();
});

test('a mirrored row whose resolver says unavailable is unavailable', async () => {
  const resolveFull = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'offline' }));
  const stageTarget = stage();
  await expect(resolveShareTarget(image({ downloadState: 'mirrored', localUri: null }), entry(), resolveFull, stageTarget))
    .resolves.toEqual({ kind: 'unavailable', category: 'offline' });
  expect(stageTarget).not.toHaveBeenCalled();
});

test('no library entry falls back to the collection path (existing error path)', async () => {
  const stageTarget = stage();
  await expect(resolveShareTarget(image({ downloadState: 'pending', localUri: null }), null, jest.fn(), stageTarget))
    .resolves.toEqual({ kind: 'collection', imageId: 7 });
  expect(stageTarget).not.toHaveBeenCalled();
});

// Board row 45: a full source that is not this device's local original is the
// decrypted cache file `<scope>-<sha>-original.bin`; share and export stage a
// native copy named `<sha>.<canonical extension>` instead of handing the
// system the `.bin`.
test.each<[string, LibraryEntry['format'], string]>([
  ['cached-original', 'jpeg', 'jpg'],
  ['cached-original', 'png', 'png'],
  ['cached-original', 'webp', 'webp'],
  ['cached-original', 'gif', 'gif'],
  ['cloud-original', 'jpeg', 'jpg'],
  ['cloud-original', 'png', 'png'],
  ['cloud-original', 'webp', 'webp'],
  ['cloud-original', 'gif', 'gif'],
])('a %s source stages format %s as <sha>.%s', async (tier, format, extension) => {
  const resolveFull = jest.fn(async () => cacheSource(tier as 'cached-original' | 'cloud-original'));
  const stageTarget = stage();
  const result = await resolveShareTarget(
    image({ downloadState: 'mirrored', localUri: null }),
    entry({ format }),
    resolveFull,
    stageTarget,
  );

  expect(stageTarget).toHaveBeenCalledWith(
    'file:///cache/library-cache/scope-d-original.bin',
    `${'d'.repeat(64)}.${extension}`,
  );
  expect(result).toEqual({
    kind: 'file',
    uri: stagedUri(`${'d'.repeat(64)}.${extension}`),
    staged: true,
  });
});

test('a rejecting stage rejects the resolution', async () => {
  const resolveFull = jest.fn(async () => cacheSource('cached-original'));
  const stageTarget = jest.fn(async () => {
    throw new Error('the copy could not be staged');
  });

  await expect(resolveShareTarget(
    image({ downloadState: 'mirrored', localUri: null }),
    entry(),
    resolveFull,
    stageTarget,
  )).rejects.toThrow('the copy could not be staged');
});

describe('resolveEntryShareTarget (N6-C import entries)', () => {
  test('returns local-original directly without staging', async () => {
    const resolveFull = jest.fn(async () => fileSource);
    const stageTarget = stage();
    await expect(resolveEntryShareTarget(entry({ sourceImageId: null }), resolveFull, stageTarget))
      .resolves.toEqual({ kind: 'file', uri: 'file:///library/originals/d.jpg' });
    expect(resolveFull).toHaveBeenCalledWith('d'.repeat(64));
    expect(stageTarget).not.toHaveBeenCalled();
  });

  test.each<[LibraryEntry['format'], string]>([
    ['jpeg', 'jpg'],
    ['png', 'png'],
    ['webp', 'webp'],
    ['gif', 'gif'],
  ])('stages cached/cloud import original for %s as <sha256>.%s', async (format, ext) => {
    const resolveFull = jest.fn(async () => cacheSource('cloud-original'));
    const stageTarget = stage();
    await expect(
      resolveEntryShareTarget(entry({ sourceImageId: null, format }), resolveFull, stageTarget),
    ).resolves.toEqual({
      kind: 'file',
      uri: stagedUri(`${'d'.repeat(64)}.${ext}`),
      staged: true,
    });
  });

  test('propagates unavailable category when original is offline or locked', async () => {
    const resolveFull = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'unavailable',
      category: 'offline',
    }));
    const stageTarget = stage();
    await expect(resolveEntryShareTarget(entry({ sourceImageId: null }), resolveFull, stageTarget))
      .resolves.toEqual({ kind: 'unavailable', category: 'offline' });
    expect(stageTarget).not.toHaveBeenCalled();
  });
});
