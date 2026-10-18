import { act, renderHook } from '@testing-library/react-native';

import type { GifStillResult, GifStillStore } from '@/features/images/gif-first-frame';
import { useGifStill } from '@/features/images/use-gif-still';

type Pending = { uri: string; resolve: (result: GifStillResult) => void };

function controlledStore() {
  const pending: Pending[] = [];
  const store: GifStillStore & { stillFor: jest.Mock } = {
    stillFor: jest.fn((uri: string) => new Promise<GifStillResult>((resolve) => {
      pending.push({ uri, resolve });
    })),
  };
  const settle = async (at: number, result: GifStillResult) => {
    await act(async () => pending[at]!.resolve(result));
  };
  return { store, pending, settle };
}

const HUGE = 50_278_178;

test('no source: idle, and the store is never asked', async () => {
  const { store } = controlledStore();
  const { result } = await renderHook(() => useGifStill(null, HUGE, store));

  expect(result.current).toEqual({ uri: null, pending: false, missing: false });
  expect(store.stillFor).not.toHaveBeenCalled();
});

test('pending until the store answers, then the still uri', async () => {
  const { store, settle } = controlledStore();
  const { result } = await renderHook(() => useGifStill('file:///collection/44.gif', HUGE, store));

  expect(result.current).toEqual({ uri: null, pending: true, missing: false });
  expect(store.stillFor).toHaveBeenCalledWith('file:///collection/44.gif', HUGE);

  await settle(0, { uri: 'file:///cache/gif-still/a.png', missing: false });
  expect(result.current).toEqual({ uri: 'file:///cache/gif-still/a.png', pending: false, missing: false });
});

test('a new source is pending at once, and a late answer for the old one is ignored', async () => {
  const { store, settle } = controlledStore();
  const { result, rerender } = await renderHook(
    ({ uri }: { uri: string }) => useGifStill(uri, HUGE, store),
    { initialProps: { uri: 'file:///a.gif' } },
  );
  await settle(0, { uri: 'file:///cache/gif-still/a.png', missing: false });

  await rerender({ uri: 'file:///b.gif' });
  expect(result.current).toEqual({ uri: null, pending: true, missing: false });

  await rerender({ uri: 'file:///c.gif' });
  await settle(1, { uri: 'file:///cache/gif-still/b.png', missing: false });
  expect(result.current.uri).toBeNull();

  await settle(2, { uri: 'file:///cache/gif-still/c.png', missing: false });
  expect(result.current.uri).toBe('file:///cache/gif-still/c.png');
});

test('an answer for an earlier request of the same uri never lands (A → B → A)', async () => {
  const { store, settle } = controlledStore();
  const { result, rerender } = await renderHook(
    ({ uri }: { uri: string }) => useGifStill(uri, HUGE, store),
    { initialProps: { uri: 'file:///a.gif' } },
  );
  await rerender({ uri: 'file:///b.gif' });
  await rerender({ uri: 'file:///a.gif' });
  await settle(2, { uri: 'file:///cache/gif-still/a2.png', missing: false });

  await settle(0, { uri: null, missing: true });
  expect(result.current).toEqual({ uri: 'file:///cache/gif-still/a2.png', pending: false, missing: false });
});

test('source → none → the same source asks again and never replays the old "missing"', async () => {
  // The viewer's repair loop: missing → the page drops its local file → the
  // repair restores the same uri. A replayed stale `missing` would repair twice.
  const { store, settle } = controlledStore();
  const { result, rerender } = await renderHook(
    ({ uri }: { uri: string | null }) => useGifStill(uri, HUGE, store),
    { initialProps: { uri: 'file:///collection/44.gif' as string | null } },
  );
  await settle(0, { uri: null, missing: true });
  expect(result.current.missing).toBe(true);

  await rerender({ uri: null });
  await rerender({ uri: 'file:///collection/44.gif' });

  expect(result.current).toEqual({ uri: null, pending: true, missing: false });
  expect(store.stillFor).toHaveBeenCalledTimes(2);
});

test('a changed byte size is a new source', async () => {
  const { store, settle } = controlledStore();
  const { result, rerender } = await renderHook(
    ({ size }: { size: number }) => useGifStill('file:///a.gif', size, store),
    { initialProps: { size: HUGE } },
  );
  await settle(0, { uri: 'file:///cache/gif-still/a.png', missing: false });

  await rerender({ size: HUGE + 1 });
  expect(result.current.pending).toBe(true);
  expect(store.stillFor).toHaveBeenLastCalledWith('file:///a.gif', HUGE + 1);
});

test('a rejected store call settles as "no still", not a crash', async () => {
  const store: GifStillStore = { stillFor: jest.fn().mockRejectedValue(new Error('io')) };
  const { result } = await renderHook(() => useGifStill('file:///a.gif', HUGE, store));
  await act(async () => undefined);

  expect(result.current).toEqual({ uri: null, pending: false, missing: false });
});
