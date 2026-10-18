import { fetch as expoFetch } from 'expo/fetch';

import { DANBOORU_HEADERS } from '@/features/danbooru/danbooru-client';
import { normalizeProviderTag } from '@/features/providers/candidate-filter';
import { isBlockableTagSlug } from '@/features/settings/settings';

/** `value` is Danbooru's spelling, shown and stored; `key` is for matching. */
export type TagSuggestion = Readonly<{ value: string; key: string; postCount: number }>;
export type TagSuggestionFetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class TagSuggestionTimeoutError extends Error {
  constructor() {
    super('Tag suggestions timed out');
    this.name = 'TagSuggestionTimeoutError';
  }
}

export const TAG_SUGGESTION_TIMEOUT_MS = 5_000;
export const TAG_SUGGESTION_LIMIT = 10;

function callerAbort(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('Tag suggestions cancelled'), { name: 'AbortError' });
}

export async function fetchDanbooruTagSuggestions(
  query: string,
  signal: AbortSignal,
  fetcher: TagSuggestionFetcher = expoFetch as unknown as TagSuggestionFetcher,
): Promise<TagSuggestion[]> {
  if (signal.aborted) throw callerAbort(signal);
  const params = new URLSearchParams({
    'search[query]': query,
    'search[type]': 'tag_query',
    version: '1',
    limit: String(TAG_SUGGESTION_LIMIT),
  });
  const controller = new AbortController();
  let timedOut = false;
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const onAbort = () => {
    rejectCancellation(callerAbort(signal));
    controller.abort();
  };
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    rejectCancellation(new TagSuggestionTimeoutError());
    controller.abort();
  }, TAG_SUGGESTION_TIMEOUT_MS);

  try {
    // Race the complete operation: native fetch/body readers may ignore abort.
    const request = async () => {
      const response = await fetcher(`https://danbooru.donmai.us/autocomplete.json?${params}`, {
        headers: DANBOORU_HEADERS,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Tag suggestions HTTP ${response.status}`);
      return response.json();
    };
    const body = await Promise.race([request(), cancellation]);
    if (!Array.isArray(body)) throw new Error('Invalid tag suggestions response');
    const keys = new Set<string>();
    const suggestions: TagSuggestion[] = [];
    for (const row of body) {
      if (row === null || typeof row !== 'object' || typeof row.value !== 'string') continue;
      const value = row.value.trim().toLowerCase();
      if (!isBlockableTagSlug(value)) continue;
      const key = normalizeProviderTag(value);
      if (keys.has(key)) continue;
      keys.add(key);
      const count = Number(row.post_count);
      suggestions.push({ value, key, postCount: Number.isFinite(count) && count >= 0 ? count : 0 });
    }
    return suggestions;
  } catch (error) {
    if (signal.aborted) throw callerAbort(signal);
    if (timedOut) throw new TagSuggestionTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
