import { useLocalSearchParams } from 'expo-router';

import { SearchScreen } from '@/screens/search/search-screen';

export default function SearchRoute() {
  // R8.31: a search link carries only the query. A stale `provider` param from
  // an older link is ignored; sources are whatever Settings enables.
  const { query, focus } = useLocalSearchParams<{
    query?: string;
    focus?: string;
  }>();
  return (
    <SearchScreen
      key={`${focus ?? ''}|${query ?? ''}`}
      initialQuery={query}
    />
  );
}
