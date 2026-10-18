import { DANBOORU_HEADERS } from '@/features/danbooru/danbooru-client';
import {
  fetchDanbooruTagSuggestions,
  TAG_SUGGESTION_TIMEOUT_MS,
  TagSuggestionTimeoutError,
  type TagSuggestionFetcher,
} from './danbooru-tag-suggestions';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const probe = [
  ['fur', 5579], ['fur_trim', 237991], ['furry', 146890],
  ['furrowed_brow', 71363], ['furry_female', 70329], ['furry_male', 67701],
  ['fur-trimmed_jacket', 40336], ['fur_collar', 37548],
].map(([value, post_count]) => ({ type: 'tag-word', value, post_count }));

function fetcherFor(body: unknown) {
  return jest.fn<ReturnType<TagSuggestionFetcher>, Parameters<TagSuggestionFetcher>>()
    .mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('uses autocomplete parameters and the shared Danbooru headers; preserves probe order and spelling', async () => {
  const fetcher = fetcherFor(probe);
  await expect(fetchDanbooruTagSuggestions('fur', new AbortController().signal, fetcher))
    .resolves.toEqual(probe.map(({ value, post_count }) => ({
      value, key: String(value).replace(/-/g, '_'), postCount: post_count,
    })));
  const [url, init] = fetcher.mock.calls[0];
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe('https://danbooru.donmai.us/autocomplete.json');
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    'search[query]': 'fur', 'search[type]': 'tag_query', version: '1', limit: '10',
  });
  expect(init.headers).toBe(DANBOORU_HEADERS);
  expect(init.headers['User-Agent']).toBe('WaifuDeck/1.0 (Expo; https://github.com/fancydirty)');
});

test('drops invalid values, normalizes matching keys, deduplicates first wins and sanitizes counts', async () => {
  const fetcher = fetcherFor([
    null, { value: 42 }, { value: 'bad tag!!' }, { value: 'waifu' },
    { value: ' FUR-TRIMMED_JACKET ', post_count: '40336' },
    { value: 'fur_trimmed_jacket', post_count: 999 },
    { value: 'furry', post_count: -1 }, { value: 'comic', post_count: 'nope' },
    { value: '3d', post_count: Infinity },
  ]);
  await expect(fetchDanbooruTagSuggestions('fur', new AbortController().signal, fetcher)).resolves.toEqual([
    { value: 'fur-trimmed_jacket', key: 'fur_trimmed_jacket', postCount: 40336 },
    { value: 'furry', key: 'furry', postCount: 0 },
    { value: 'comic', key: 'comic', postCount: 0 },
    { value: '3d', key: '3d', postCount: 0 },
  ]);
});

test.each([null, {}, 'not an array'])('rejects a non-array body: %p', async (body) => {
  await expect(fetchDanbooruTagSuggestions('fur', new AbortController().signal, fetcherFor(body)))
    .rejects.toThrow();
});

test('rejects a non-OK response without parsing it', async () => {
  const json = jest.fn();
  const fetcher: TagSuggestionFetcher = async () => ({ ok: false, status: 503, json });
  await expect(fetchDanbooruTagSuggestions('fur', new AbortController().signal, fetcher)).rejects.toThrow('503');
  expect(json).not.toHaveBeenCalled();
});

test('a fetch that ignores abort still times out at exactly 5 seconds and aborts its controller', async () => {
  const fetcher = jest.fn<ReturnType<TagSuggestionFetcher>, Parameters<TagSuggestionFetcher>>()
    .mockImplementation(() => new Promise(() => {}));
  const result = fetchDanbooruTagSuggestions('fur', new AbortController().signal, fetcher);
  const assertion = expect(result).rejects.toBeInstanceOf(TagSuggestionTimeoutError);
  expect(TAG_SUGGESTION_TIMEOUT_MS).toBe(5000);
  await jest.advanceTimersByTimeAsync(4999);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await assertion;
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});

test('one deadline covers fetch plus a stalled json() that ignores abort', async () => {
  const json = jest.fn(() => new Promise<unknown>(() => {}));
  const fetcher: TagSuggestionFetcher = () => new Promise((resolve) => {
    setTimeout(() => resolve({ ok: true, status: 200, json }), 2000);
  });
  const result = fetchDanbooruTagSuggestions('fur', new AbortController().signal, fetcher);
  const assertion = expect(result).rejects.toBeInstanceOf(TagSuggestionTimeoutError);
  await jest.advanceTimersByTimeAsync(2000);
  expect(json).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(3000);
  await assertion;
});

test('classifies timeout itself even when fetch rejects with AbortError', async () => {
  const fetcher: TagSuggestionFetcher = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const assertion = expect(fetchDanbooruTagSuggestions('fur', new AbortController().signal, fetcher))
    .rejects.toBeInstanceOf(TagSuggestionTimeoutError);
  await jest.advanceTimersByTimeAsync(5000);
  await assertion;
});

test.each(['fetch', 'json'] as const)('caller abort during %s settles promptly with caller reason and removes the listener', async (stage) => {
  const caller = new AbortController();
  const reason = new Error('caller cancelled');
  const remove = jest.spyOn(caller.signal, 'removeEventListener');
  const fetcher = fetcherFor([]);
  if (stage === 'fetch') fetcher.mockImplementation(() => new Promise(() => {}));
  else fetcher.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
  const result = fetchDanbooruTagSuggestions('fur', caller.signal, fetcher);
  const assertion = expect(result).rejects.toBe(reason);
  await jest.advanceTimersByTimeAsync(0);
  caller.abort(reason);
  await assertion;
  expect(reason).not.toBeInstanceOf(TagSuggestionTimeoutError);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

test('a caller abort wins even if the fetcher throws a different error', async () => {
  const caller = new AbortController();
  const reason = new Error('closed');
  const fetcher: TagSuggestionFetcher = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('transport failure')));
  });
  const assertion = expect(fetchDanbooruTagSuggestions('fur', caller.signal, fetcher)).rejects.toBe(reason);
  caller.abort(reason);
  await assertion;
});

test('an already-aborted caller makes no request', async () => {
  const caller = new AbortController();
  caller.abort();
  const fetcher = fetcherFor([]);
  await expect(fetchDanbooruTagSuggestions('fur', caller.signal, fetcher)).rejects.not.toBeInstanceOf(TagSuggestionTimeoutError);
  expect(fetcher).not.toHaveBeenCalled();
});

test('success removes the caller listener and deadline', async () => {
  const caller = new AbortController();
  const remove = jest.spyOn(caller.signal, 'removeEventListener');
  await fetchDanbooruTagSuggestions('fur', caller.signal, fetcherFor([]));
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
