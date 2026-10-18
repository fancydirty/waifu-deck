import { act, renderHook } from '@testing-library/react-native';

import {
  REMOTE_LOAD_RETRY_DELAYS_MS,
  useRemoteLoadRetry,
} from '@/components/use-remote-load-retry';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

type RetryHook = ReturnType<typeof useRemoteLoadRetry>;

async function renderRetry(key: string) {
  return renderHook<RetryHook, { key: string }>(
    ({ key: sourceKey }) => useRemoteLoadRetry(sourceKey),
    { initialProps: { key } },
  );
}

test('increments the attempt only after the scheduled delay', async () => {
  const hook = await renderRetry('https://cdn.example.com/7-sample.jpg');

  expect(hook.result.current.attempt).toBe(0);

  await act(async () => {
    hook.result.current.scheduleRetry();
  });
  expect(hook.result.current.attempt).toBe(0);

  await act(async () => {
    jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[0] - 1);
  });
  expect(hook.result.current.attempt).toBe(0);

  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(hook.result.current.attempt).toBe(1);
});

test('a second schedule while a timer is pending does not double-schedule', async () => {
  const hook = await renderRetry('https://cdn.example.com/7-sample.jpg');

  await act(async () => {
    hook.result.current.scheduleRetry();
    hook.result.current.scheduleRetry();
    hook.result.current.scheduleRetry();
  });

  await act(async () => {
    jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[0]);
  });
  expect(hook.result.current.attempt).toBe(1);

  // The second delay must be the table's next entry, not a queued duplicate.
  await act(async () => {
    hook.result.current.scheduleRetry();
    jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[1] - 1);
  });
  expect(hook.result.current.attempt).toBe(1);

  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(hook.result.current.attempt).toBe(2);
});

test('stops scheduling once the delay table is exhausted', async () => {
  const hook = await renderRetry('https://cdn.example.com/7-sample.jpg');

  for (const delay of REMOTE_LOAD_RETRY_DELAYS_MS) {
    await act(async () => {
      hook.result.current.scheduleRetry();
      jest.advanceTimersByTime(delay);
    });
  }
  expect(hook.result.current.attempt).toBe(REMOTE_LOAD_RETRY_DELAYS_MS.length);

  await act(async () => {
    hook.result.current.scheduleRetry();
    jest.advanceTimersByTime(600_000);
  });
  expect(hook.result.current.attempt).toBe(REMOTE_LOAD_RETRY_DELAYS_MS.length);
});

test('resets the attempt and drops a pending timer when the source key changes', async () => {
  const hook = await renderRetry('https://cdn.example.com/7-sample.jpg');

  await act(async () => {
    hook.result.current.scheduleRetry();
    jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[0]);
  });
  expect(hook.result.current.attempt).toBe(1);

  await act(async () => {
    hook.result.current.scheduleRetry();
  });
  await hook.rerender({ key: 'file:///collection/7.jpg' });
  expect(hook.result.current.attempt).toBe(0);

  // The timer scheduled for the previous source must never land on the new one.
  await act(async () => {
    jest.advanceTimersByTime(600_000);
  });
  expect(hook.result.current.attempt).toBe(0);

  // A fresh source starts with the full budget again.
  await act(async () => {
    hook.result.current.scheduleRetry();
    jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[0]);
  });
  expect(hook.result.current.attempt).toBe(1);
});
