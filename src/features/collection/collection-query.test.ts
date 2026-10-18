import { QueryClient } from '@tanstack/react-query';

import {
  COLLECTION_QUERY_KEY,
  collectionQueryKey,
  publishCollectionRow,
  publishCollectionSnapshot,
  publishCollectionValue,
} from '@/features/collection/collection-query';
import type { ImageRepository, StoredImage } from '@/features/images/image-repository';

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function image(id: number): StoredImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 900,
    height: 1200,
    byteSize: 500_000,
    extension: 'jpg',
    dominantColor: '#726A7D',
    contentRating: 'safe',
    nativeRating: null,
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
    decision: 'saved',
    presentedAt: 1,
    decidedAt: id * 100,
    queueOrdinal: id,
    decisionOrdinal: id,
    localUri: `file:///collection/${id}.jpg`,
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
  };
}

test('uses one stable key and ignores legacy revision-scoped snapshots', () => {
  const client = queryClient();
  client.setQueryData([...COLLECTION_QUERY_KEY, 1], [image(1)]);
  client.setQueryData(collectionQueryKey(), [image(2)]);

  expect(collectionQueryKey()).toBe(COLLECTION_QUERY_KEY);
  expect(client.getQueryData(collectionQueryKey())).toEqual([image(2)]);
});

test('publishes one repository snapshot under the stable collection key', async () => {
  const client = queryClient();
  const listCollection = jest.fn().mockResolvedValue([image(7)]);
  const repository = { listCollection } as unknown as ImageRepository;

  await expect(publishCollectionSnapshot(client, repository))
    .resolves.toEqual([image(7)]);

  expect(listCollection).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(collectionQueryKey())).toEqual([image(7)]);
});

test('cancels an older query fetch before publishing a newer repository snapshot', async () => {
  const client = queryClient();
  const stale = deferred<StoredImage[]>();
  const staleFetch = client.fetchQuery({
    queryKey: collectionQueryKey(),
    queryFn: () => stale.promise,
  });
  await Promise.resolve();

  await publishCollectionSnapshot(client, {
    listCollection: jest.fn().mockResolvedValue([image(2)]),
  } as unknown as ImageRepository);
  stale.resolve([image(1)]);
  await staleFetch.catch(() => undefined);

  expect(client.getQueryData(collectionQueryKey())).toEqual([image(2)]);
});

test('only publishes the newest overlapping snapshot and can atomically publish empty', async () => {
  const client = queryClient();
  const first = deferred<StoredImage[]>();
  const seen: StoredImage[][] = [];
  client.getQueryCache().subscribe(() => {
    const snapshot = client.getQueryData<StoredImage[]>(collectionQueryKey());
    if (snapshot !== undefined) seen.push(snapshot);
  });

  const oldPublication = publishCollectionSnapshot(client, {
    listCollection: jest.fn(() => first.promise),
  } as unknown as ImageRepository);
  const latestPublication = publishCollectionSnapshot(client, {
    listCollection: jest.fn().mockResolvedValue([image(2)]),
  } as unknown as ImageRepository);
  first.resolve([image(1)]);
  await Promise.all([oldPublication, latestPublication]);

  expect(seen).not.toContainEqual([image(1)]);
  expect(client.getQueryData(collectionQueryKey())).toEqual([image(2)]);

  await publishCollectionValue(client, []);
  expect(client.getQueryData(collectionQueryKey())).toEqual([]);
});

function unsaved(id: number): StoredImage {
  return {
    ...image(id),
    decision: 'active',
    decidedAt: null,
    decisionOrdinal: null,
    localUri: null,
    downloadState: 'none',
  };
}

function rowReader(
  rows: Record<number, StoredImage | Promise<StoredImage | null> | null>,
): Pick<ImageRepository, 'getById'> & { getById: jest.Mock } {
  return {
    getById: jest.fn(async (imageId: number) => rows[imageId] ?? null),
  };
}

describe('publishCollectionRow (board #24)', () => {
  test('is a no-op without a snapshot: it never writes [] over a collection nobody has read', async () => {
    const client = queryClient();
    const repository = rowReader({ 1: image(1) });

    await publishCollectionRow(client, repository, 1);

    expect(client.getQueryData(collectionQueryKey())).toBeUndefined();
    expect(repository.getById).not.toHaveBeenCalled();
  });

  test('always commits: a held removal and a later insert both land, in either order', async () => {
    const heldRemoval = deferred<StoredImage | null>();
    const first = queryClient();
    first.setQueryData(collectionQueryKey(), [image(1), image(3)]);
    const removeThenInsert = [
      publishCollectionRow(first, rowReader({ 1: heldRemoval.promise }), 1),
      publishCollectionRow(first, rowReader({ 2: image(2) }), 2),
    ];
    heldRemoval.resolve(unsaved(1));
    await Promise.all(removeThenInsert);
    expect(first.getQueryData(collectionQueryKey())).toEqual([image(2), image(3)]);

    const heldInsert = deferred<StoredImage | null>();
    const second = queryClient();
    second.setQueryData(collectionQueryKey(), [image(1), image(3)]);
    const insertThenRemove = [
      publishCollectionRow(second, rowReader({ 2: heldInsert.promise }), 2),
      publishCollectionRow(second, rowReader({ 1: unsaved(1) }), 1),
    ];
    heldInsert.resolve(image(2));
    await Promise.all(insertThenRemove);
    expect(second.getQueryData(collectionQueryKey())).toEqual([image(2), image(3)]);
  });

  test('replaces a saved row where it stands and removes a row that left the collection', async () => {
    const client = queryClient();
    client.setQueryData(collectionQueryKey(), [image(2), image(1)]);
    const readyTwo = { ...image(2), localUri: 'file:///collection/2-ready.jpg' };

    await publishCollectionRow(client, rowReader({ 2: readyTwo }), 2);
    expect(client.getQueryData(collectionQueryKey())).toEqual([readyTwo, image(1)]);

    await publishCollectionRow(client, rowReader({}), 1);     // the row is gone
    expect(client.getQueryData(collectionQueryKey())).toEqual([readyTwo]);
  });

  test('a full read queued before a row publication still commits, and the row lands on top of it', async () => {
    const client = queryClient();
    client.setQueryData(collectionQueryKey(), [image(1)]);
    const fullRead = deferred<StoredImage[]>();

    const read = publishCollectionSnapshot(client, {
      listCollection: jest.fn(() => fullRead.promise),
    } as unknown as ImageRepository);
    const row = publishCollectionRow(client, rowReader({ 5: image(5) }), 5);
    fullRead.resolve([image(4), image(1)]);
    await Promise.all([read, row]);

    expect(client.getQueryData(collectionQueryKey())).toEqual([image(5), image(4), image(1)]);
  });

  test('never cancels the collection query\'s in-flight first fetch', async () => {
    const client = queryClient();
    const firstFetch = deferred<StoredImage[]>();
    const fetching = client.fetchQuery({
      queryKey: collectionQueryKey(),
      queryFn: () => firstFetch.promise,
    });
    await Promise.resolve();
    const repository = rowReader({ 1: image(1) });

    await publishCollectionRow(client, repository, 1);
    expect(client.getQueryData(collectionQueryKey())).toBeUndefined();

    firstFetch.resolve([image(7)]);
    await expect(fetching).resolves.toEqual([image(7)]);
    expect(client.getQueryState(collectionQueryKey())?.status).toBe('success');
    expect(client.getQueryData(collectionQueryKey())).toEqual([image(7)]);
  });
});
