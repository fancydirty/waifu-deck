import {
  acquireLibrarySyncLease,
  holdLibrarySync,
  onLibrarySyncLeaseReleased,
} from '@/features/library/library-background-sync-slot';
import {
  createLibraryBackgroundSync,
  LIBRARY_BG_SYNC_TASK,
  type BackgroundTaskApi,
} from '@/features/library/library-background-sync';

function api(): BackgroundTaskApi {
  return {
    registerTaskAsync: jest.fn(async () => undefined),
    unregisterTaskAsync: jest.fn(async () => undefined),
    isTaskRegisteredAsync: jest.fn(async () => false),
    BackgroundTaskResult: { Success: 1, Failed: 2 } as const,
  };
}

test('C12 ensureRegistered registers once with a 15-minute floor', async () => {
  const a = api();
  const bg = createLibraryBackgroundSync({ api: a, getRound: () => null });
  await bg.ensureRegistered();
  (a.isTaskRegisteredAsync as jest.Mock).mockResolvedValue(true);
  await bg.ensureRegistered();
  expect(a.registerTaskAsync).toHaveBeenCalledTimes(1);
  expect(a.registerTaskAsync).toHaveBeenCalledWith(
    LIBRARY_BG_SYNC_TASK,
    { minimumInterval: 15 },
  );
});

test('C13 ensureUnregistered only when registered', async () => {
  const a = api();
  const bg = createLibraryBackgroundSync({ api: a, getRound: () => null });
  await bg.ensureUnregistered();
  expect(a.unregisterTaskAsync).not.toHaveBeenCalled();
  (a.isTaskRegisteredAsync as jest.Mock).mockResolvedValue(true);
  await bg.ensureUnregistered();
  expect(a.unregisterTaskAsync).toHaveBeenCalledWith(LIBRARY_BG_SYNC_TASK);
});

test('C14 executor: no round → Success; round throws → Failed; normal → bounded runToEmpty → Success', async () => {
  const a = api();
  expect(
    await createLibraryBackgroundSync({ api: a, getRound: () => null }).execute(),
  ).toBe(1);
  expect(
    await createLibraryBackgroundSync({
      api: a,
      getRound: () => async () => {
        throw new Error('x');
      },
    }).execute(),
  ).toBe(2);
  const round = jest.fn(async () => ({
    up: { total: 0, done: 0, failed: 0 },
    down: { total: 0, done: 0, failed: 0 },
  }));
  expect(
    await createLibraryBackgroundSync({
      api: a,
      getRound: () => round,
      maxRounds: 3,
    }).execute(),
  ).toBe(1);
  expect(round).toHaveBeenCalledTimes(1);
});

test('C15 (#6 mutex): the executor skips (Success, no round) while the foreground trigger holds the sync lease', async () => {
  const a = api();
  const round = jest.fn(async () => ({ up: { total: 0, done: 0, failed: 0 }, down: { total: 0, done: 0, failed: 0 } }));
  const release = acquireLibrarySyncLease();
  expect(release).not.toBeNull();
  const bg = createLibraryBackgroundSync({ api: a, getRound: () => round });
  expect(await bg.execute()).toBe(1);
  expect(round).not.toHaveBeenCalled();
  release?.();
  expect(await bg.execute()).toBe(1);
  expect(round).toHaveBeenCalledTimes(1);
});

test('C16 (#6 mutex): the executor holds the lease while running and releases it after', async () => {
  const a = api();
  let releaseSeen: (() => void) | null = null;
  const round = jest.fn(async () => {
    releaseSeen = acquireLibrarySyncLease(); // must be null: executor holds it
    return { up: { total: 0, done: 0, failed: 0 }, down: { total: 0, done: 0, failed: 0 } };
  });
  await createLibraryBackgroundSync({ api: a, getRound: () => round }).execute();
  expect(releaseSeen).toBeNull();
  const after = acquireLibrarySyncLease(); expect(after).not.toBeNull(); after?.();
});

test('a hold takes the lease ahead of every waiting start, and the waiters run once it is released', async () => {
  // Spec §5.4 step 1: a running round finishes, then the hold keeps the lease
  // so a waiting start does not run until the hold itself releases.
  const round = acquireLibrarySyncLease();
  expect(round).not.toBeNull();
  let runs = 0;
  const unsubscribe = onLibrarySyncLeaseReleased(() => {
    runs += 1;
  });
  let releaseHold: (() => void) | null = null;
  let holdReleased = false;
  const holding = holdLibrarySync().then((release) => {
    releaseHold = release;
    return release;
  });
  try {
    expect(acquireLibrarySyncLease()).toBeNull();

    round!();
    await holding;

    expect(runs).toBe(0);
    expect(acquireLibrarySyncLease()).toBeNull();
    expect(releaseHold).not.toBeNull();
    releaseHold!();
    holdReleased = true;
    expect(runs).toBe(1);
    const freed = acquireLibrarySyncLease();
    expect(freed).not.toBeNull();
    freed!();
  } finally {
    unsubscribe();
    if (!holdReleased) {
      if (releaseHold === null && round !== null) round();
      const release = releaseHold ?? await holding;
      release();
    }
  }
});

test('calling one release twice grants only the first queued hold', async () => {
  // Task 3c ends the reset from a finally, so the same release can run twice.
  // A second call must not hand the lease to the next hold or free it early.
  const round = acquireLibrarySyncLease();
  expect(round).not.toBeNull();
  const releases: (() => void)[] = [];
  const first = holdLibrarySync().then((release) => {
    releases.push(release);
    return release;
  });
  let secondSettled = false;
  const second = holdLibrarySync().then((release) => {
    secondSettled = true;
    releases.push(release);
    return release;
  });
  try {
    round!();
    round!();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(releases).toHaveLength(1);
    expect(secondSettled).toBe(false);
    expect(acquireLibrarySyncLease()).toBeNull();
  } finally {
    round?.();
    const firstRelease = releases[0] ?? await first;
    firstRelease();
    const secondRelease = await second;
    secondRelease();
    const leftover = acquireLibrarySyncLease();
    leftover?.();
  }
});
