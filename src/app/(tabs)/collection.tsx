import { useLocalSearchParams } from 'expo-router';

import type {
  CollectionBrowserQuery,
  CollectionProvider,
  CollectionSearchField,
  CollectionSort,
} from '@/features/collection/collection-filter';
import { allowedNsfwMode } from '@/features/distribution/distribution-policy';
import { isImageProviderKey, type NsfwMode } from '@/features/waifu/types';
import { CollectionScreen } from '@/screens/collection/collection-screen';

function mode(value: string | undefined): NsfwMode | undefined {
  return value === 'sfw' || value === 'mixed' || value === 'nsfw'
    ? allowedNsfwMode(value)
    : undefined;
}

function field(value: string | undefined): CollectionSearchField | undefined {
  return value === 'all' || value === 'artist' || value === 'tag' ? value : undefined;
}

// Whitelist derives from the ImageProviderKey union (via isImageProviderKey)
// instead of a hand-maintained literal list, so new sources are accepted here
// automatically without touching this file.
function provider(value: string | undefined): CollectionProvider | undefined {
  return value === 'all' || (typeof value === 'string' && isImageProviderKey(value))
    ? value
    : undefined;
}

function sort(value: string | undefined): CollectionSort | undefined {
  return value === 'newest' || value === 'oldest' || value === 'resolution'
    || value === 'fileSize' ? value : undefined;
}

export default function CollectionRoute() {
  const params = useLocalSearchParams<{
    query?: string;
    field?: string;
    mode?: string;
    provider?: string;
    sort?: string;
    focus?: string;
  }>();
  const initialQuery: Partial<CollectionBrowserQuery> = {
    text: params.query ?? '',
    field: field(params.field),
    mode: mode(params.mode),
    provider: provider(params.provider),
    sort: sort(params.sort),
  };
  return (
    <CollectionScreen
      key={[
        params.focus ?? '',
        params.query ?? '',
        params.field ?? '',
        params.mode ?? '',
        params.provider ?? '',
        params.sort ?? '',
      ].join('|')}
      initialQuery={initialQuery}
    />
  );
}
