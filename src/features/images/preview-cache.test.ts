import { createManagedPreviewCache } from '@/features/images/preview-cache';

describe('managed preview cache', () => {
  test('K7 ㉖: measures the expo-image disk cache directory with one native size read', async () => {
    const cacheDirectorySize = jest.fn(async () => 24_571_904);
    const cache = createManagedPreviewCache({
      imageCache: {
        clearMemoryCache: jest.fn(),
        clearDiskCache: jest.fn(),
      },
      cacheDirectorySize,
    });

    await expect(cache.getBytes()).resolves.toBe(24_571_904);
    expect(cacheDirectorySize).toHaveBeenCalledTimes(1);
  });

  test('clears Expo Image memory and disk caches without repository mutation', async () => {
    const clearMemoryCache = jest.fn(async () => true);
    const clearDiskCache = jest.fn(async () => true);
    const cache = createManagedPreviewCache({
      imageCache: {
        clearMemoryCache,
        clearDiskCache,
      },
    });

    await cache.clear();

    expect(clearMemoryCache).toHaveBeenCalledTimes(1);
    expect(clearDiskCache).toHaveBeenCalledTimes(1);
  });
});
