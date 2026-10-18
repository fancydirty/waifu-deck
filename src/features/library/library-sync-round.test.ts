import type { LibraryMirrorDown } from '@/features/library/library-mirror-down';
import type { LibraryMirrorUp } from '@/features/library/library-mirror-up';
import { createLibrarySyncRound } from '@/features/library/library-sync-round';
import type { LibraryEvictionResult } from '@/features/library/library-eviction';
import type { TransferPoolResult } from '@/features/library/library-transfer-pool';

const UP: TransferPoolResult = { total: 1, done: 1, failed: 0 };
const DOWN: TransferPoolResult = { total: 2, done: 2, failed: 0 };
const THUMBS: TransferPoolResult = { total: 3, done: 3, failed: 0 };
const NONE: TransferPoolResult = { total: 0, done: 0, failed: 0 };

type Options = Readonly<{
  cloudOnly?: boolean | Error;
  upError?: Error;
  passError?: Error;
  thumbnailResult?: TransferPoolResult;
  evictError?: Error;
  evictionResult?: LibraryEvictionResult;
  scope?: string | null;
}>;

function build(options: Options = {}) {
  const log: string[] = [];
  const {
    cloudOnly = false,
    upError,
    passError,
    thumbnailResult = THUMBS,
    evictError,
    evictionResult = { reclaimed: 0, evicted: 0, kept: 0 },
    scope = 'S',
  } = options;
  const mirrorUp = {
    mirrorUp: jest.fn(async () => {
      log.push('up');
      if (upError !== undefined) throw upError;
      return UP;
    }),
  } as unknown as LibraryMirrorUp;
  const mirrorDown = {
    mirrorDown: jest.fn(async () => {
      log.push('down');
      return DOWN;
    }),
  } as unknown as LibraryMirrorDown;
  const thumbnailPass = {
    run: jest.fn(async (s: string) => {
      log.push(`thumbs:${s}`);
      if (passError !== undefined) throw passError;
      return thumbnailResult;
    }),
  };
  const eviction = {
    evict: jest.fn(async (s: string) => {
      log.push(`evict:${s}`);
      if (evictError !== undefined) throw evictError;
      return evictionResult;
    }),
  };
  const round = createLibrarySyncRound({
    mirrorUp,
    mirrorDown,
    thumbnailPass,
    eviction,
    isCloudOnly: async () => {
      log.push('mode');
      if (cloudOnly instanceof Error) throw cloudOnly;
      return cloudOnly;
    },
    getAccountScope: async () => {
      log.push('scope');
      return scope;
    },
  });
  return { round, log, mirrorDown, thumbnailPass, eviction };
}

describe('createLibrarySyncRound', () => {
  test('本地+云端: up, then down; nothing is evicted', async () => {
    const { round, log, eviction, thumbnailPass } = build();
    await expect(round()).resolves.toEqual({ up: UP, down: DOWN });
    expect(log).toEqual(['up', 'mode', 'down']);
    expect(eviction.evict).not.toHaveBeenCalled();
    expect(thumbnailPass.run).not.toHaveBeenCalled();
  });

  test('仅云端: up, thumbnails, eviction — never a download', async () => {
    const { round, log, mirrorDown } = build({ cloudOnly: true });
    await expect(round()).resolves.toEqual({ up: UP, down: THUMBS });
    expect(log).toEqual(['up', 'mode', 'scope', 'thumbs:S', 'evict:S']);
    expect(mirrorDown.mirrorDown).not.toHaveBeenCalled();
  });

  test('仅云端: the eviction pass counts in down', async () => {
    const { round } = build({
      cloudOnly: true,
      thumbnailResult: { total: 2, done: 1, failed: 1 },
      evictionResult: { reclaimed: 3, evicted: 5, kept: 2 },
    });
    await expect(round()).resolves.toEqual({
      up: UP,
      down: { total: 9, done: 6, failed: 3 },
    });
  });

  test('an eviction that evicts and keeps nothing adds nothing', async () => {
    const { round } = build({
      cloudOnly: true,
      evictionResult: { reclaimed: 0, evicted: 0, kept: 0 },
    });
    await expect(round()).resolves.toEqual({ up: UP, down: THUMBS });
  });

  test.each([
    ['本地+云端', false, 'down'],
    ['仅云端', true, 'evict:S'],
  ])('an upload fault costs neither mode the rest: %s', async (_name, cloudOnly, last) => {
    const { round, log } = build({ cloudOnly, upError: new Error('up') });
    const result = await round();
    expect(result.up).toEqual(NONE);
    expect(log).toContain(last);
  });

  test('a mode that cannot be read decides nothing', async () => {
    const { round, log, mirrorDown, eviction, thumbnailPass } = build({
      cloudOnly: new Error('kv'),
    });
    await expect(round()).resolves.toEqual({ up: UP, down: NONE });
    expect(log).toEqual(['up', 'mode']);
    expect(mirrorDown.mirrorDown).not.toHaveBeenCalled();
    expect(thumbnailPass.run).not.toHaveBeenCalled();
    expect(eviction.evict).not.toHaveBeenCalled();
  });

  test('a thumbnail pass fault still evicts, then fails the round', async () => {
    const failure = new Error('pass');
    const { round, log } = build({ cloudOnly: true, passError: failure });
    await expect(round()).rejects.toBe(failure);
    expect(log).toContain('evict:S');
  });

  test('an eviction fault does not fail the round', async () => {
    const { round } = build({ cloudOnly: true, evictError: new Error('evict') });
    await expect(round()).resolves.toEqual({ up: UP, down: THUMBS });
  });

  test('no account scope in 仅云端: neither pass', async () => {
    const { round, log, thumbnailPass, eviction } = build({ cloudOnly: true, scope: null });
    await expect(round()).resolves.toEqual({ up: UP, down: NONE });
    expect(log).toEqual(['up', 'mode', 'scope']);
    expect(thumbnailPass.run).not.toHaveBeenCalled();
    expect(eviction.evict).not.toHaveBeenCalled();
  });
});
