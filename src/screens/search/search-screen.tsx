import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Keyboard, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  collectionQueryKey,
  publishCollectionSnapshot,
} from '@/features/collection/collection-query';
import type { StoredImage } from '@/features/images/image-repository';
import type { SearchHit } from '@/features/search/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppServices } from '@/providers/app-services';

import { SearchDetailModal } from './search-detail-modal';
import {
  buildSavedIdentityIndex,
  buildSearchRequest,
  isSearchHitSaved,
} from './search-screen-model';
import { SearchView, type SearchViewStatus } from './search-view';
import { useSearch } from './use-search';

const DISCOVERY_DECK_QUERY_KEY = ['discovery', 'deck'] as const;
const DISCOVERY_REFILL_QUERY_KEY = ['discovery', 'refill'] as const;

type DetailSession = {
  hits: SearchHit[];
  index: number;
};

export function SearchScreen({
  initialQuery = '',
}: {
  initialQuery?: string;
} = {}) {
  const { t } = useAppTranslation();
  const {
    settings,
    collectionService,
    discoveryService,
    imageRepository,
    providerRequestGovernor,
    providerCredentials,
  } = useAppServices();
  const queryClient = useQueryClient();
  const safeInsets = useSafeAreaInsets();
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(
    initialQuery.trim() || null,
  );
  const [detailSession, setDetailSession] = useState<DetailSession | null>(null);
  const [savingKeys, setSavingKeys] = useState<string[]>([]);

  const request = useMemo(
    () => submittedQuery === null
      ? null
      : buildSearchRequest(submittedQuery, settings),
    [settings, submittedQuery],
  );
  const search = useSearch(
    request,
    settings.providers,
    providerRequestGovernor,
    providerCredentials.snapshot(),
  );
  const collectionQuery = useQuery({
    queryKey: collectionQueryKey(),
    queryFn: () => imageRepository.listCollection(),
    staleTime: Infinity,
  });
  const collection = useMemo(
    () => collectionQuery.data ?? [],
    [collectionQuery.data],
  );
  // K7 cut 5b (audit ㉙): built once per collection instead of re-walking every
  // saved row for every hit on every render.
  const savedIdentities = useMemo(
    () => buildSavedIdentityIndex(collection),
    [collection],
  );
  const favoriteKeys = useMemo(
    () => search.hits
      .filter((hit) => isSearchHitSaved(hit, savedIdentities))
      .map((hit) => hit.key),
    [savedIdentities, search.hits],
  );
  const detailFavoriteKeys = useMemo(
    () => (detailSession?.hits ?? [])
      .filter((hit) => isSearchHitSaved(hit, savedIdentities))
      .map((hit) => hit.key),
    [savedIdentities, detailSession?.hits],
  );
  const favoriteKeySet = useMemo(() => new Set(favoriteKeys), [favoriteKeys]);
  const submit = useCallback(() => {
    const next = query.trim();
    if (next.length === 0) return;
    Keyboard.dismiss();
    if (submittedQuery === next) {
      void search.refetch();
      return;
    }
    setSubmittedQuery(next);
  }, [query, search, submittedQuery]);

  const publishSavedState = useCallback(async () => {
    await publishCollectionSnapshot(queryClient, imageRepository);
  }, [imageRepository, queryClient]);

  const synchronizeDiscovery = useCallback(() => {
    void discoveryService.restore()
      .then((deck) => {
        queryClient.setQueryData(DISCOVERY_DECK_QUERY_KEY, deck);
        return queryClient.invalidateQueries({
          queryKey: DISCOVERY_REFILL_QUERY_KEY,
        });
      })
      .catch(() => undefined);
  }, [discoveryService, queryClient]);

  const saveHit = useCallback(async (hit: SearchHit) => {
    if (favoriteKeySet.has(hit.key) || savingKeys.includes(hit.key)) return;

    setSavingKeys((current) => [...current, hit.key]);
    try {
      const result = await collectionService.saveCandidate(hit.image);
      queryClient.setQueryData<StoredImage[]>(
        collectionQueryKey(),
        (current = []) => [
          result.image,
          ...current.filter((image) => image.id !== result.image.id),
        ],
      );
      void result.backgroundDownload
        .catch(() => undefined)
        .then(publishSavedState)
        .catch(() => undefined);
      void publishSavedState().catch(() => undefined);
      synchronizeDiscovery();
      void Haptics.selectionAsync().catch(() => undefined);
    } catch {
      Alert.alert(
        t('search.alerts.saveFailedTitle'),
        t('search.alerts.saveFailedMessage'),
      );
    } finally {
      setSavingKeys((current) => current.filter((key) => key !== hit.key));
    }
  }, [
    collectionService,
    favoriteKeySet,
    publishSavedState,
    queryClient,
    savingKeys,
    synchronizeDiscovery,
    t,
  ]);

  const openSource = useCallback((hit: SearchHit) => {
    if (!hit.image.sourceUrl) return;
    void Linking.openURL(hit.image.sourceUrl).catch(() => {
      Alert.alert(
        t('search.alerts.sourceFailedTitle'),
        t('search.alerts.sourceFailedMessage'),
      );
    });
  }, [t]);

  let status: SearchViewStatus = search.status === 'success'
    ? 'ready'
    : search.status;
  let errorMessage: string | null = null;
  if (submittedQuery !== null && search.enabledProviderCount === 0) {
    status = 'error';
    errorMessage = t('search.errors.noProviders');
  } else if (search.status === 'error') {
    errorMessage = t('search.errors.providerConfirmation');
  }

  return (
    <>
      <SearchView
        query={query}
        hits={search.hits}
        status={status}
        errorMessage={errorMessage}
        submittedQuery={submittedQuery}
        favoriteKeys={favoriteKeys}
        blurNsfwThumbnails={
          settings.nsfwMode === 'mixed' && settings.blurNsfwThumbnails
        }
        hasNextPage={search.hasNextPage}
        isLoadingMore={search.isFetchingNextPage}
        onQueryChange={setQuery}
        onSubmit={submit}
        onOpen={(_hit, index) => setDetailSession({
          hits: [...search.hits],
          index,
        })}
        onLoadMore={() => void search.fetchNextPage()}
        onSeenThrough={search.noteSeen}
      />
      <SearchDetailModal
        visible={detailSession !== null}
        hits={detailSession?.hits ?? []}
        initialIndex={detailSession?.index ?? 0}
        favoriteKeys={detailFavoriteKeys}
        savingKeys={savingKeys}
        safeInsets={safeInsets}
        onClose={() => setDetailSession(null)}
        onToggleFavorite={(hit) => void saveHit(hit)}
        onOpenSource={openSource}
        onIndexChange={(index) => setDetailSession((current) => current
          ? { ...current, index }
          : null)}
      />
    </>
  );
}
