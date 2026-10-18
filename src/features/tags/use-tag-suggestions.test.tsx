import { act, renderHook } from '@testing-library/react-native';
import { fetchDanbooruTagSuggestions, type TagSuggestionFetcher } from './danbooru-tag-suggestions';
import { useTagSuggestions } from './use-tag-suggestions';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('./danbooru-tag-suggestions', () => ({
  ...jest.requireActual('./danbooru-tag-suggestions'),
  fetchDanbooruTagSuggestions: jest.fn(),
}));

const client = jest.mocked(fetchDanbooruTagSuggestions);
const realClient = jest.requireActual<typeof import('./danbooru-tag-suggestions')>('./danbooru-tag-suggestions').fetchDanbooruTagSuggestions;

function deferredFetch() {
  const calls: {
    query: string; signal: AbortSignal;
    resolve: (rows: { value: string; post_count: number }[]) => void;
  }[] = [];
  const fetcher = jest.fn<ReturnType<TagSuggestionFetcher>, Parameters<TagSuggestionFetcher>>()
    .mockImplementation((url, { signal }) => new Promise((resolve) => {
      calls.push({
        query: new URL(url).searchParams.get('search[query]')!, signal,
        resolve: (rows) => resolve({ ok: true, status: 200, json: async () => rows }),
      });
    }));
  return { calls, fetcher };
}

// A transport cancellation cannot retract an answer already queued at the hook
// boundary. Let that answer settle to independently exercise generation guards.
function allowQueuedReplies() {
  client.mockImplementation(async (query, signal, fetcher) => {
    const response = await fetcher!(`https://test.invalid/?search[query]=${query}`, { headers: {}, signal });
    const rows = await response.json() as { value: string; post_count: number }[];
    return rows.map((row) => ({ value: row.value, key: row.value, postCount: row.post_count }));
  });
}

async function advance(ms: number) {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  jest.useFakeTimers();
  client.mockReset().mockImplementation(realClient);
});
afterEach(() => jest.useRealTimers());

test.each(['', ' ', 'f', ' f '])('input %p is idle without fetching', async (search) => {
  const { fetcher } = deferredFetch();
  const { result } = await renderHook(() => useTagSuggestions(search, { enabled: true, fetch: fetcher }));
  await advance(1000);
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.current).toEqual({ status: 'idle', suggestions: [] });
});

test('f → fu → fur within 250 ms makes only one request for the trimmed final query', async () => {
  const { fetcher, calls } = deferredFetch();
  const { rerender, result, unmount } = await renderHook(
    ({ search }: { search: string }) => useTagSuggestions(search, { enabled: true, fetch: fetcher }),
    { initialProps: { search: 'f' } },
  );
  await rerender({ search: 'fu' });
  await advance(100);
  expect(fetcher).not.toHaveBeenCalled();
  await rerender({ search: ' fur ' });
  await advance(249);
  expect(fetcher).not.toHaveBeenCalled();
  await advance(1);
  expect(calls.map((call) => call.query)).toEqual(['fur']);
  expect(result.current.status).toBe('loading');
  await act(async () => calls[0].resolve([{ value: 'furry', post_count: 146890 }]));
  expect(result.current).toEqual({ status: 'ready', suggestions: [{ value: 'furry', key: 'furry', postCount: 146890 }] });
  await unmount();
  await advance(0);
  expect(jest.getTimerCount()).toBe(0);
});

test('a queued fu answer arriving during fur debounce is ignored; loading keeps the last accepted suggestions', async () => {
  allowQueuedReplies();
  const { fetcher, calls } = deferredFetch();
  const { rerender, result } = await renderHook(
    ({ search }: { search: string }) => useTagSuggestions(search, { enabled: true, fetch: fetcher }),
    { initialProps: { search: 'fu' } },
  );
  await advance(250);
  await rerender({ search: 'fur' });
  expect(calls[0].signal.aborted).toBe(true);
  const beforeReply = result.current;
  await act(async () => calls[0].resolve([{ value: 'old', post_count: 1 }]));
  expect(result.current).toEqual(beforeReply);
  expect(result.current.suggestions).toEqual([]);
  await advance(250);
  await act(async () => calls[1].resolve([{ value: 'furry', post_count: 146890 }]));
  await rerender({ search: 'furr' });
  await advance(250);
  expect(result.current.status).toBe('loading');
  expect(result.current.suggestions[0].value).toBe('furry');
});

test('clearing to one character aborts immediately and a late answer cannot leave idle', async () => {
  allowQueuedReplies();
  const { fetcher, calls } = deferredFetch();
  const { rerender, result } = await renderHook(
    ({ search }: { search: string }) => useTagSuggestions(search, { enabled: true, fetch: fetcher }),
    { initialProps: { search: 'fur' } },
  );
  await advance(250);
  await rerender({ search: 'f' });
  expect(calls[0].signal.aborted).toBe(true);
  await act(async () => calls[0].resolve([{ value: 'furry', post_count: 1 }]));
  expect(result.current).toEqual({ status: 'idle', suggestions: [] });
});

test('disabled input never fetches, and disabling before the debounce cancels it', async () => {
  const { fetcher } = deferredFetch();
  const { rerender, result } = await renderHook(
    ({ enabled }: { enabled: boolean }) => useTagSuggestions('fur', { enabled, fetch: fetcher }),
    { initialProps: { enabled: false } },
  );
  await advance(1000);
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.current.status).toBe('idle');
  await rerender({ enabled: true });
  await advance(249);
  await rerender({ enabled: false });
  await advance(1000);
  expect(fetcher).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('disabling during fetch aborts immediately and discards a queued answer', async () => {
  allowQueuedReplies();
  const { fetcher, calls } = deferredFetch();
  const { rerender, result } = await renderHook(
    ({ enabled }: { enabled: boolean }) => useTagSuggestions('fur', { enabled, fetch: fetcher }),
    { initialProps: { enabled: true } },
  );
  await advance(250);
  await rerender({ enabled: false });
  expect(calls[0].signal.aborted).toBe(true);
  await act(async () => calls[0].resolve([{ value: 'furry', post_count: 1 }]));
  expect(result.current).toEqual({ status: 'idle', suggestions: [] });
});

test('a deadline is an error, including when the transport rejects with AbortError', async () => {
  const fetcher: TagSuggestionFetcher = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
  });
  const { result } = await renderHook(() => useTagSuggestions('fur', { enabled: true, fetch: fetcher }));
  await advance(250);
  await advance(5000);
  expect(result.current.status).toBe('error');
  await advance(0);
  expect(jest.getTimerCount()).toBe(0);
});

test('a non-abort failure is an error', async () => {
  const fetcher: TagSuggestionFetcher = async () => { throw new Error('offline'); };
  const { result } = await renderHook(() => useTagSuggestions('fur', { enabled: true, fetch: fetcher }));
  await advance(250);
  expect(result.current.status).toBe('error');
});

test('a self-caused cancellation changes no state to error', async () => {
  const { fetcher, calls } = deferredFetch();
  const { rerender, result } = await renderHook(
    ({ search }: { search: string }) => useTagSuggestions(search, { enabled: true, fetch: fetcher }),
    { initialProps: { search: 'fur' } },
  );
  await advance(250);
  await rerender({ search: 'f' });
  await advance(0);
  expect(calls[0].signal.aborted).toBe(true);
  expect(result.current).toEqual({ status: 'idle', suggestions: [] });
  expect(jest.getTimerCount()).toBe(0);
});

test('unmount aborts fetch and clears its deadline; unmount during debounce clears the timer', async () => {
  const { fetcher, calls } = deferredFetch();
  const active = await renderHook(() => useTagSuggestions('fur', { enabled: true, fetch: fetcher }));
  await advance(250);
  await active.unmount();
  await advance(0);
  expect(calls[0].signal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
  const pending = await renderHook(() => useTagSuggestions('fu', { enabled: true, fetch: fetcher }));
  await pending.unmount();
  await advance(1000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
