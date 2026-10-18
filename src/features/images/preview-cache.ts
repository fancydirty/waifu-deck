import { Directory, Paths } from 'expo-file-system';
import { Image } from 'expo-image';

type ImageCachePort = {
  clearMemoryCache(): Promise<boolean>;
  clearDiskCache(): Promise<boolean>;
};

export interface ManagedPreviewCache {
  getBytes(): Promise<number>;
  clear(): Promise<void>;
}

type ManagedPreviewCacheDependencies = {
  imageCache?: ImageCachePort;
  cacheDirectorySize?: () => Promise<number>;
};

/**
 * expo-image on Android caches through Glide, whose disk cache lives at
 * `<cacheDir>/image_manager_disk_cache` (`DiskCache.Factory.DEFAULT_DISK_CACHE_DIR`);
 * expo-image's `AppGlideModule` does not override it. `Paths.cache` is that
 * `cacheDir`. K7 ㉖: the previous readout asked Glide for one path per
 * historical `remote_url` (20k native calls on a long-lived install) and was
 * wrong by construction — the deck caches under `sample_url` — so it printed
 * 0 B over a 24 MB cache on the emulator. One native directory size is both
 * correct and O(1) in JS.
 */
const EXPO_IMAGE_DISK_CACHE_DIR = 'image_manager_disk_cache';

async function expoImageDiskCacheSize(): Promise<number> {
  const directory = new Directory(Paths.cache, EXPO_IMAGE_DISK_CACHE_DIR);
  if (!directory.exists) return 0;
  return directory.size ?? 0;
}

export function createManagedPreviewCache({
  imageCache = Image,
  cacheDirectorySize = expoImageDiskCacheSize,
}: ManagedPreviewCacheDependencies = {}): ManagedPreviewCache {
  return {
    getBytes() {
      return cacheDirectorySize();
    },
    async clear() {
      const [memory, disk] = await Promise.all([
        imageCache.clearMemoryCache(),
        imageCache.clearDiskCache(),
      ]);
      if (!memory || !disk) {
        throw new Error('Managed preview cache could not be completely cleared.');
      }
    },
  };
}
