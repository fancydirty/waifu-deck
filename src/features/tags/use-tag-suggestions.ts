import { useEffect, useRef, useState } from 'react';

import { fetchDanbooruTagSuggestions, type TagSuggestion, type TagSuggestionFetcher } from './danbooru-tag-suggestions';

type TagSuggestionsState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  suggestions: TagSuggestion[];
};

export function useTagSuggestions(
  search: string,
  options: { enabled: boolean; fetch?: TagSuggestionFetcher; debounceMs?: number },
): TagSuggestionsState {
  const { enabled, fetch: fetcher, debounceMs = 250 } = options;
  const generation = useRef(0);
  const [state, setState] = useState<TagSuggestionsState>({ status: 'idle', suggestions: [] });

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    const query = search.trim();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!enabled || query.length < 2) {
      // Idle is a cancellation transition: discard old suggestions immediately.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the async request state when input becomes ineligible
      setState({ status: 'idle', suggestions: [] });
    } else {
      timer = setTimeout(() => {
        setState((previous) => ({ ...previous, status: 'loading' }));
        void fetchDanbooruTagSuggestions(query, controller.signal, fetcher).then(
          (suggestions) => {
            if (generation.current !== requestGeneration) return;
            setState({ status: 'ready', suggestions });
          },
          () => {
            if (generation.current !== requestGeneration || controller.signal.aborted) return;
            setState({ status: 'error', suggestions: [] });
          },
        );
      }, debounceMs);
    }
    return () => {
      generation.current = requestGeneration + 1;
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, enabled, fetcher, debounceMs]);

  return state;
}
