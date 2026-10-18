import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { createElement } from 'react';

import {
  createLibraryTransferProgress,
  libraryTransferProgress,
  useTransferProgress,
} from './library-transfer-progress';

describe('createLibraryTransferProgress', () => {
  test('get returns null for a digest with no transfer in flight', () => {
    const store = createLibraryTransferProgress();
    expect(store.get('sha-a')).toBeNull();
  });

  test('K6-3: subscribeInFlight reports every digest currently transferring', () => {
    const store = createLibraryTransferProgress();
    const seen: string[][] = [];
    store.subscribeInFlight((digests) => seen.push([...digests].sort()));

    store.set('sha-a', { sent: 0, total: 100 });
    store.set('sha-b', { sent: 0, total: 100 });
    // K6-3 device finding: a byte report on an already-in-flight digest must
    // NOT fire — the guard posts a notification per callback, and per-64 KiB
    // progress made Android shed our notifications ("Package enqueue rate is
    // 6.4"). Membership changes only.
    store.set('sha-a', { sent: 50, total: 100 });
    store.set('sha-b', { sent: 99, total: 100 });
    store.clear('sha-a');
    store.clear('sha-b');

    expect(seen).toEqual([
      ['sha-a'],
      ['sha-a', 'sha-b'],
      ['sha-b'],
      [],
    ]);
  });

  test('K6-3: subscribeInFlight unsubscribes', () => {
    const store = createLibraryTransferProgress();
    const listener = jest.fn();
    const unsubscribe = store.subscribeInFlight(listener);
    store.set('sha-a', { sent: 0, total: 100 });
    unsubscribe();
    store.clear('sha-a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('K6-3: clearing a digest that is not in flight announces nothing', () => {
    const store = createLibraryTransferProgress();
    const listener = jest.fn();
    store.subscribeInFlight(listener);
    store.clear('sha-a');
    expect(listener).not.toHaveBeenCalled();
  });

  test('set then get returns the exact byte counts, not a ratio', () => {
    const store = createLibraryTransferProgress();
    store.set('sha-a', { sent: 300, total: 1200 });
    expect(store.get('sha-a')).toEqual({ sent: 300, total: 1200 });
  });

  test('set replaces the previous counts for the same digest', () => {
    const store = createLibraryTransferProgress();
    store.set('sha-a', { sent: 300, total: 1200 });
    store.set('sha-a', { sent: 900, total: 1200 });
    expect(store.get('sha-a')).toEqual({ sent: 900, total: 1200 });
  });

  test('digests are independent', () => {
    const store = createLibraryTransferProgress();
    store.set('sha-a', { sent: 1, total: 2 });
    store.set('sha-b', { sent: 3, total: 4 });
    store.clear('sha-a');
    expect(store.get('sha-a')).toBeNull();
    expect(store.get('sha-b')).toEqual({ sent: 3, total: 4 });
  });

  test('subscribe fires on set and on clear for that digest only', () => {
    const store = createLibraryTransferProgress();
    const a = jest.fn();
    const b = jest.fn();
    store.subscribe('sha-a', a);
    store.subscribe('sha-b', b);

    store.set('sha-a', { sent: 1, total: 2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    store.clear('sha-a');
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).not.toHaveBeenCalled();
  });

  test('clearing a digest that has no entry notifies nobody', () => {
    const store = createLibraryTransferProgress();
    const listener = jest.fn();
    store.subscribe('sha-a', listener);
    store.clear('sha-a');
    expect(listener).not.toHaveBeenCalled();
  });

  test('unsubscribe stops further notifications', () => {
    const store = createLibraryTransferProgress();
    const listener = jest.fn();
    const unsubscribe = store.subscribe('sha-a', listener);
    store.set('sha-a', { sent: 1, total: 2 });
    unsubscribe();
    store.set('sha-a', { sent: 2, total: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('the snapshot identity is stable between sets, so a hook does not loop', () => {
    const store = createLibraryTransferProgress();
    store.set('sha-a', { sent: 1, total: 2 });
    expect(store.get('sha-a')).toBe(store.get('sha-a'));
  });
});

function ProgressProbe({ digest }: { digest: string | null }) {
  const progress = useTransferProgress(digest);
  return createElement(Text, { testID: 'value' }, String(progress));
}

describe('useTransferProgress', () => {
  beforeEach(() => {
    libraryTransferProgress.clear('sha-a');
  });

  test('is null while nothing is transferring', async () => {
    await render(createElement(ProgressProbe, { digest: 'sha-a' }));
    expect(screen.getByTestId('value')).toHaveTextContent('null');
  });

  test('re-renders with the real ratio when the store is set', async () => {
    await render(createElement(ProgressProbe, { digest: 'sha-a' }));
    await act(async () => {
      libraryTransferProgress.set('sha-a', { sent: 600, total: 1200 });
    });
    expect(screen.getByTestId('value')).toHaveTextContent('0.5');
  });

  test('goes back to null after clear', async () => {
    await render(createElement(ProgressProbe, { digest: 'sha-a' }));
    await act(async () => {
      libraryTransferProgress.set('sha-a', { sent: 600, total: 1200 });
    });
    await act(async () => {
      libraryTransferProgress.clear('sha-a');
    });
    expect(screen.getByTestId('value')).toHaveTextContent('null');
  });

  test('a null digest never subscribes and always reads null', async () => {
    await render(createElement(ProgressProbe, { digest: null }));
    expect(screen.getByTestId('value')).toHaveTextContent('null');
  });

  test('a zero total reads 0, never NaN', async () => {
    await render(createElement(ProgressProbe, { digest: 'sha-a' }));
    await act(async () => {
      libraryTransferProgress.set('sha-a', { sent: 0, total: 0 });
    });
    expect(screen.getByTestId('value')).toHaveTextContent('0');
  });

  test('more bytes sent than expected still clamps to 1', async () => {
    await render(createElement(ProgressProbe, { digest: 'sha-a' }));
    await act(async () => {
      libraryTransferProgress.set('sha-a', { sent: 1300, total: 1200 });
    });
    expect(screen.getByTestId('value')).toHaveTextContent('1');
  });

  test("a null total reads 'indeterminate' — the bytes are moving but no percentage is honest", async () => {
    const store = createLibraryTransferProgress();
    // A local component reassigning an outer `let` during render trips the
    // react-hooks purity rule; read the value back through the same
    // testID-driven pattern the other tests in this describe block already
    // use instead.
    function Probe() {
      const progress = useTransferProgress('sha-a', store);
      return createElement(Text, { testID: 'value' }, String(progress));
    }
    await render(createElement(Probe));
    await act(async () => { store.set('sha-a', { sent: 0, total: null }); });
    expect(screen.getByTestId('value')).toHaveTextContent('indeterminate');
    await act(async () => { store.set('sha-a', { sent: 512, total: 1024 }); });
    expect(screen.getByTestId('value')).toHaveTextContent('0.5');
  });
});
