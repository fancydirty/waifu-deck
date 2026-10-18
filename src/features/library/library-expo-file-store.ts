import { Platform } from 'react-native';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import type { FileHandle, FileMode } from 'expo-file-system';

import {
  createLibraryFileStore,
  type LibraryFilePort,
  type LibraryFileStore,
} from '@/features/library/library-file-store';
import { LibraryIngestError } from '@/features/library/library-types';

export type ExpoLibraryFileHandle = {
  readonly uri: string;
  readonly exists: boolean;
  readonly size: number | null;
  /** Throws when the path's permission check fails; `exists` answers false. */
  info(): { exists: boolean };
  create(options: { overwrite: boolean; intermediates: boolean }): void;
  write(bytes: Uint8Array): void;
  bytes(): Promise<Uint8Array>;
  /** The native `FileHandle` (read `length` bytes from the cursor, close). */
  open(mode?: FileMode): FileHandle;
  copy(destination: ExpoLibraryFileHandle): void | Promise<void>;
  move(destination: ExpoLibraryFileHandle): void | Promise<void>;
  delete(): void;
};

export type ExpoLibraryDirectoryHandle = {
  readonly uri: string;
  readonly exists: boolean;
  readonly size: number | null;
  create(options: { idempotent: boolean; intermediates: boolean }): void;
  list(): unknown[];
};

export type ExpoLibraryFileAdapter = {
  createLibraryDirectory(): ExpoLibraryDirectoryHandle;
  createOriginalsDirectory(): ExpoLibraryDirectoryHandle;
  createTempDirectory(): ExpoLibraryDirectoryHandle;
  createStreamDirectory(): ExpoLibraryDirectoryHandle;
  createTrashDirectory(): ExpoLibraryDirectoryHandle;
  createCacheDirectory(): ExpoLibraryDirectoryHandle;
  /** Board row 45: the private staging area share and export copy into. */
  createShareDirectory(): ExpoLibraryDirectoryHandle;
  createThumbnailsDirectory(): ExpoLibraryDirectoryHandle;
  /** Ledger N6-B2 (spec §3.1): `expo-image-picker` cache directory. */
  createPickerCacheDirectory?(): ExpoLibraryDirectoryHandle;
  createFile(
    location: ExpoLibraryDirectoryHandle | string,
    name?: string,
  ): ExpoLibraryFileHandle;
  isFile(value: unknown): value is ExpoLibraryFileHandle;
};

function createSdk56LibraryAdapter(): ExpoLibraryFileAdapter {
  // Lazy native import keeps web and Store bundles independent of the module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system');

  return {
    createLibraryDirectory() {
      return new Directory(
        Paths.document,
        'library',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createOriginalsDirectory() {
      return new Directory(
        Paths.document,
        'library',
        'originals',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createTempDirectory() {
      return new Directory(
        Paths.cache,
        'library-temp',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createStreamDirectory() {
      return new Directory(
        Paths.cache,
        'library-stream',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createTrashDirectory() {
      return new Directory(
        Paths.document,
        'library',
        'trash',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createCacheDirectory() {
      return new Directory(
        Paths.cache,
        'library-cache',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createShareDirectory() {
      return new Directory(
        Paths.cache,
        'library-share',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createThumbnailsDirectory() {
      return new Directory(
        Paths.document,
        'library',
        'thumbnails',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createPickerCacheDirectory() {
      return new Directory(
        Paths.cache,
        'ImagePicker',
      ) as unknown as ExpoLibraryDirectoryHandle;
    },
    createFile(location, name) {
      if (typeof location === 'string') {
        return new File(location) as unknown as ExpoLibraryFileHandle;
      }
      return new File(
        location as unknown as import('expo-file-system').Directory,
        name ?? '',
      ) as unknown as ExpoLibraryFileHandle;
    },
    isFile(value): value is ExpoLibraryFileHandle {
      return value instanceof File;
    },
  };
}

export function createExpoLibraryFilePort(
  adapter: ExpoLibraryFileAdapter = createSdk56LibraryAdapter(),
): LibraryFilePort {
  const library = adapter.createLibraryDirectory();
  const originals = adapter.createOriginalsDirectory();
  const temp = adapter.createTempDirectory();
  const stream = adapter.createStreamDirectory();
  const trash = adapter.createTrashDirectory();
  const cache = adapter.createCacheDirectory();
  const share = adapter.createShareDirectory();
  const thumbnails = adapter.createThumbnailsDirectory();
  const pickerCache = adapter.createPickerCacheDirectory?.() ?? null;

  const listIn = (directory: ExpoLibraryDirectoryHandle): string[] => {
    if (!directory.exists) return [];
    return directory.list().filter(adapter.isFile).map((file) => file.uri);
  };

  return {
    originalsRootUri: originals.uri,
    tempRootUri: temp.uri,
    streamRootUri: stream.uri,
    trashRootUri: trash.uri,
    cacheRootUri: cache.uri,
    shareRootUri: share.uri,
    thumbnailsRootUri: thumbnails.uri,
    ...(pickerCache !== null ? { pickerCacheRootUri: pickerCache.uri } : {}),
    async ensureDirectories() {
      originals.create({ idempotent: true, intermediates: true });
      temp.create({ idempotent: true, intermediates: true });
      stream.create({ idempotent: true, intermediates: true });
      trash.create({ idempotent: true, intermediates: true });
      cache.create({ idempotent: true, intermediates: true });
      share.create({ idempotent: true, intermediates: true });
      thumbnails.create({ idempotent: true, intermediates: true });
    },
    resolveOriginal(name) {
      return adapter.createFile(originals, name).uri;
    },
    resolveTemp(name) {
      return adapter.createFile(temp, name).uri;
    },
    resolveStream(name) {
      return adapter.createFile(stream, name).uri;
    },
    resolveTrash(name) {
      return adapter.createFile(trash, name).uri;
    },
    resolveCache(name) {
      return adapter.createFile(cache, name).uri;
    },
    resolveShare(name) {
      return adapter.createFile(share, name).uri;
    },
    resolveThumbnail(name) {
      return adapter.createFile(thumbnails, name).uri;
    },
    async exists(uri) {
      return adapter.createFile(uri).exists;
    },
    async probe(uri) {
      return adapter.createFile(uri).info().exists ? 'present' : 'absent';
    },
    async writeBytes(uri, bytes) {
      const file = adapter.createFile(uri);
      file.create({ overwrite: true, intermediates: true });
      file.write(bytes);
    },
    async readBytes(uri) {
      return await adapter.createFile(uri).bytes();
    },
    async readPrefix(uri, length) {
      const file = adapter.createFile(uri);
      // 'r' is FileMode.ReadOnly's value; the literal keeps the native module
      // import lazy, the same rule as the adapter's require.
      const handle = file.open('r' as FileMode);
      try {
        return handle.readBytes(length);
      } finally {
        handle.close();
      }
    },
    async copyFrom(sourceUri, destinationUri) {
      await adapter.createFile(sourceUri).copy(
        adapter.createFile(destinationUri),
      );
    },
    async move(sourceUri, destinationUri) {
      await adapter.createFile(sourceUri).move(
        adapter.createFile(destinationUri),
      );
    },
    async delete(uri) {
      const file = adapter.createFile(uri);
      if (file.exists) file.delete();
    },
    async size(uri) {
      const file = adapter.createFile(uri);
      if (!file.exists) return 0;
      return file.size ?? 0;
    },
    async listOriginals() {
      return listIn(originals);
    },
    async listOriginalNames() {
      if (!originals.exists) return [];
      return await FileSystemLegacy.readDirectoryAsync(originals.uri);
    },
    async listTemp() {
      return listIn(temp);
    },
    async listStream() {
      return listIn(stream);
    },
    async listTrash() {
      return listIn(trash);
    },
    async listCache() {
      return listIn(cache);
    },
    async listShare() {
      return listIn(share);
    },
    async listThumbnails() {
      return listIn(thumbnails);
    },
    ...(pickerCache !== null
      ? {
        async listPickerCache() {
          return listIn(pickerCache);
        },
      }
      : {}),
    // K7 ㉖: one native walk of the library root, not a stat per file.
    async durableBytes() {
      return library.exists ? library.size ?? 0 : 0;
    },
  };
}

export function createExpoLibraryFileStore(
  options: {
    platform?: typeof Platform.OS;
    adapter?: ExpoLibraryFileAdapter;
    /** Shared port for Direct builds that also construct cache and resizer. */
    port?: LibraryFilePort;
  } = {},
): LibraryFileStore {
  const platform = options.platform ?? Platform.OS;
  if (platform === 'web') {
    throw new LibraryIngestError(
      'storage_failed',
      'Private library storage is unavailable on this platform.',
    );
  }
  return createLibraryFileStore({
    port: options.port ?? createExpoLibraryFilePort(
      options.adapter ?? createSdk56LibraryAdapter(),
    ),
  });
}
