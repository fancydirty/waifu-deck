import type { QueryClient } from '@tanstack/react-query';

import type { ImageRepository, StoredImage } from '@/features/images/image-repository';

export const COLLECTION_QUERY_KEY = ['collection'] as const;

type CollectionPublicationState = {
  latest: number;
  tail: Promise<void>;
};

const publicationStates = new WeakMap<QueryClient, CollectionPublicationState>();

export function collectionQueryKey() {
  return COLLECTION_QUERY_KEY;
}

function publicationState(queryClient: QueryClient): CollectionPublicationState {
  let state = publicationStates.get(queryClient);
  if (!state) {
    state = { latest: 0, tail: Promise.resolve() };
    publicationStates.set(queryClient, state);
  }
  return state;
}

function enqueueCollectionPublication(
  queryClient: QueryClient,
  readSnapshot: () => Promise<StoredImage[]>,
): Promise<StoredImage[]> {
  const state = publicationState(queryClient);
  const publication = ++state.latest;
  const operation = state.tail.then(async () => {
    await queryClient.cancelQueries({
      queryKey: collectionQueryKey(),
      exact: true,
    });
    const snapshot = await readSnapshot();
    if (state.latest === publication) {
      queryClient.setQueryData(collectionQueryKey(), snapshot);
    }
    return snapshot;
  });
  state.tail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function publishCollectionSnapshot(
  queryClient: QueryClient,
  repository: ImageRepository,
): Promise<StoredImage[]> {
  return enqueueCollectionPublication(
    queryClient,
    () => repository.listCollection(),
  );
}

export async function publishCollectionValue(
  queryClient: QueryClient,
  snapshot: StoredImage[],
): Promise<StoredImage[]> {
  return enqueueCollectionPublication(
    queryClient,
    async () => snapshot,
  );
}

/**
 * K7 cut 5b (audit ⑧) + board #24: publish one row's current state into the
 * snapshot the screens already hold, instead of re-reading and re-mapping every
 * saved row. The row is read inside the publication queue: a `saved` row is
 * inserted (at the front — the newest decision, the order `listCollection`
 * returns) or replaced where it stands, so a download completing later never
 * reorders the grid; any other row (a rewound or deleted save) is removed, so a
 * download settling after a rewind can never bring the row back.
 *
 * It rides the same queue as the full reads, so it never interleaves with one,
 * but it always commits: it applies to whatever the cache holds when it runs
 * and takes no part in the full reads' latest-only rule (it never bumps
 * `latest`). Without a snapshot it does nothing: the 收藏 tab's own query reads
 * the database when it mounts, and writing `[]` here would show an empty 收藏
 * under `staleTime: Infinity`. It never cancels the collection query either —
 * a cancel followed by this no-op would strand that query's first fetch.
 */
export function publishCollectionRow(
  queryClient: QueryClient,
  repository: Pick<ImageRepository, 'getById'>,
  imageId: number,
): Promise<void> {
  const state = publicationState(queryClient);
  const operation = state.tail.then(async () => {
    if (queryClient.getQueryData(collectionQueryKey()) === undefined) return;
    const row = await repository.getById(imageId);
    queryClient.setQueryData<StoredImage[]>(collectionQueryKey(), (current) => {
      if (current === undefined) return undefined;
      const index = current.findIndex((image) => image.id === imageId);
      if (row === null || row.decision !== 'saved') {
        return index === -1 ? undefined : current.filter((image) => image.id !== imageId);
      }
      if (index === -1) return [row, ...current];
      const next = [...current];
      next[index] = row;
      return next;
    });
  });
  state.tail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
