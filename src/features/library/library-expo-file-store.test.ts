import { Directory, File, Paths } from 'expo-file-system';
import type { FileHandle } from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';

import {
  createExpoLibraryFilePort,
  type ExpoLibraryDirectoryHandle,
  type ExpoLibraryFileAdapter,
  type ExpoLibraryFileHandle,
} from '@/features/library/library-expo-file-store';
import {
  createLibraryFileStore,
  isInOriginalsDirectory,
} from '@/features/library/library-file-store';

describe('expo library file port', () => {
  test('durableBytes is one walk of Paths.document/library — originals, device trash and anything else there, never the cache or staging', async () => {
    // jest-expo's in-memory filesystem is shared by the tests in this file.
    // Drop any library an earlier test created so the first read is the
    // missing-directory case.
    const library = new Directory(Paths.document, 'library');
    if (library.exists) library.delete();
    const port = createExpoLibraryFilePort();

    await expect(port.durableBytes()).resolves.toBe(0);

    await port.ensureDirectories();
    await port.writeBytes(port.resolveOriginal('a.jpg'), new Uint8Array(100));
    await port.writeBytes(port.resolveTrash('b.jpg'), new Uint8Array(20));
    await port.writeBytes(port.resolveCache('c.bin'), new Uint8Array(7));
    await port.writeBytes(port.resolveTemp('d.tmp'), new Uint8Array(5));
    await port.writeBytes(port.resolveThumbnail('e.webp'), new Uint8Array(3));

    await expect(port.durableBytes()).resolves.toBe(123);
    expect(
      port.thumbnailsRootUri.startsWith(new Directory(Paths.document, 'library').uri),
    ).toBe(true);
    const listed = await port.listThumbnails();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatch(/\/e\.webp$/u);
  });

  test('ensureDirectories creates the thumbnails area', async () => {
    // jest-expo's `move` throws "Parent directory does not exist", and the
    // fake ports accept a move into any path, so only this port sees a
    // thumbnails directory that ensureDirectories forgot to create.
    const library = new Directory(Paths.document, 'library');
    if (library.exists) library.delete();
    const port = createExpoLibraryFilePort();
    const sha = 'b'.repeat(64);
    const bytes = Uint8Array.from([4, 5, 6]);

    const destination = await createLibraryFileStore({ port })
      .promoteThumbnail(bytes, sha, 'webp');

    expect(destination).toBe(port.resolveThumbnail(`${sha}.webp`));
    expect(new File(destination).exists).toBe(true);
    await expect(port.readBytes(destination)).resolves.toEqual(bytes);
  });

  // Board row 45: the share staging area is a cache directory, so the OS may
  // clear it; `ensureDirectories` must bring it back before every stage.
  test('ensureDirectories creates the library-share area in the cache location', async () => {
    const share = new Directory(Paths.cache, 'library-share');
    if (share.exists) share.delete();
    const port = createExpoLibraryFilePort();
    expect(share.exists).toBe(false);

    await port.ensureDirectories();

    expect(port.shareRootUri).toBe(new Directory(Paths.cache, 'library-share').uri);
    expect(new Directory(Paths.cache, 'library-share').exists).toBe(true);
  });

  test('resolveShare names a file inside the share area and listShare lists its files through the adapter double', async () => {
    const files = new Map<string, Uint8Array>();
    const makeHandle = (uri: string): ExpoLibraryFileHandle => ({
      uri,
      get exists() { return files.has(uri); },
      get size() { return files.get(uri)?.byteLength ?? null; },
      info() { return { exists: files.has(uri) }; },
      create() { if (!files.has(uri)) files.set(uri, new Uint8Array()); },
      write(bytes) { files.set(uri, Uint8Array.from(bytes)); },
      bytes() { return Promise.resolve(Uint8Array.from(files.get(uri) ?? [])); },
      copy() { throw new Error('not used'); },
      move() { throw new Error('not used'); },
      delete() { files.delete(uri); },
      open() { throw new Error('not used'); },
    });
    const directory = (name: string): ExpoLibraryDirectoryHandle => ({
      uri: `file:///dirs/${name}`,
      exists: true,
      size: null,
      create() { /* nothing to create in the map. */ },
      list() {
        return [...files.keys()]
          .filter((uri) => uri.startsWith(`file:///dirs/${name}/`))
          .map((uri) => makeHandle(uri));
      },
    });
    const adapter: ExpoLibraryFileAdapter = {
      createLibraryDirectory: () => directory('library'),
      createOriginalsDirectory: () => directory('originals'),
      createTempDirectory: () => directory('temp'),
      createStreamDirectory: () => directory('stream'),
      createTrashDirectory: () => directory('trash'),
      createCacheDirectory: () => directory('cache'),
      createShareDirectory: () => directory('library-share'),
      createThumbnailsDirectory: () => directory('thumbnails'),
      createFile: (location, name) => makeHandle(
        typeof location === 'string' ? location : `${location.uri}/${name ?? ''}`,
      ),
      isFile: (value): value is ExpoLibraryFileHandle =>
        files.has((value as ExpoLibraryFileHandle).uri),
    };
    const port = createExpoLibraryFilePort(adapter);
    const sha = 'c'.repeat(64);

    expect(port.shareRootUri).toBe('file:///dirs/library-share');
    expect(port.resolveShare(`${sha}.png`)).toBe(`file:///dirs/library-share/${sha}.png`);

    await port.writeBytes(port.resolveShare('a.png'), Uint8Array.from([1]));

    await expect(port.listShare()).resolves.toEqual(['file:///dirs/library-share/a.png']);
  });

  test('listOriginalNames returns the directory names from one readDirectoryAsync call and does not list entries', async () => {
    const library = new Directory(Paths.document, 'library');
    if (library.exists) library.delete();
    const port = createExpoLibraryFilePort();
    await port.ensureDirectories();
    await port.writeBytes(port.resolveOriginal('a.jpg'), new Uint8Array([1]));
    await port.writeBytes(port.resolveOriginal('b.png'), new Uint8Array([2]));

    const readDirectory = jest
      .spyOn(FileSystemLegacy, 'readDirectoryAsync')
      .mockResolvedValue(['a.jpg', 'b.png']);
    const list = jest.spyOn(Directory.prototype, 'list');
    try {
      await expect(port.listOriginalNames()).resolves.toEqual(['a.jpg', 'b.png']);
      expect(readDirectory).toHaveBeenCalledTimes(1);
      expect(readDirectory).toHaveBeenCalledWith(port.originalsRootUri);
      expect(list).not.toHaveBeenCalled();
    } finally {
      readDirectory.mockRestore();
      list.mockRestore();
    }
  });

  test('a missing originals directory lists no names', async () => {
    const library = new Directory(Paths.document, 'library');
    if (library.exists) library.delete();
    const port = createExpoLibraryFilePort();
    const readDirectory = jest.spyOn(FileSystemLegacy, 'readDirectoryAsync');
    try {
      await expect(port.listOriginalNames()).resolves.toEqual([]);
      expect(readDirectory).not.toHaveBeenCalled();
    } finally {
      readDirectory.mockRestore();
    }
  });

  test('listOriginalNames rejects when reading an existing directory fails', async () => {
    const library = new Directory(Paths.document, 'library');
    if (library.exists) library.delete();
    const port = createExpoLibraryFilePort();
    await port.ensureDirectories();
    const readDirectory = jest
      .spyOn(FileSystemLegacy, 'readDirectoryAsync')
      .mockRejectedValue(new Error('storage unavailable'));
    try {
      await expect(port.listOriginalNames()).rejects.toThrow('storage unavailable');
    } finally {
      readDirectory.mockRestore();
    }
  });

  test('probe answers through File.info: present, absent, and an error when the path cannot be checked', async () => {
    // On Android `File.info()` runs the path's permission check first and
    // throws when it fails (out of file descriptors, canonicalPath cannot
    // open the path); `File.exists` answers false there instead. Only a
    // checked "absent" may flag an original as missing (S1a Task 7).
    const port = createExpoLibraryFilePort();
    await port.ensureDirectories();
    const uri = port.resolveOriginal('probe.jpg');
    await port.writeBytes(uri, new Uint8Array(4));
    const info = jest.spyOn(File.prototype, 'info');
    try {
      await expect(port.probe(uri)).resolves.toBe('present');
      await expect(port.probe(port.resolveOriginal('gone.jpg'))).resolves.toBe('absent');
      expect(info).toHaveBeenCalledTimes(2);

      info.mockImplementation(() => {
        throw new Error('Missing READ permission');
      });
      await expect(port.probe(uri)).rejects.toThrow('Missing READ permission');
    } finally {
      info.mockRestore();
    }
  });

  test('every original the port resolves lies in its originals directory', async () => {
    // Board #27 S1b Task 2: the missing-originals pass flags a row whose uri
    // lies outside `originalsRootUri` with no probe (only rows the listing
    // misses reach that rule). A root built in another form than the file
    // uris would flag each such row. This pins the adapter's JS-side
    // construction against jest-expo's mock, for a resolved uri and a listed
    // one; the Android forms are the table's rows and the S1b gate's [1.7].
    const port = createExpoLibraryFilePort();
    await port.ensureDirectories();
    const uri = port.resolveOriginal('a.jpg');
    expect(isInOriginalsDirectory(uri, port.originalsRootUri)).toBe(true);

    await port.writeBytes(uri, new Uint8Array(1));
    const listed = (await port.listOriginals())
      .find((listedUri) => listedUri.endsWith('/a.jpg'));
    expect(listed).toBeDefined();
    expect(isInOriginalsDirectory(listed ?? '', port.originalsRootUri)).toBe(true);
  });

  test('readPrefix reads exactly min(length, size) bytes through a file handle, never bytes()', async () => {
    // Board #31 Task 4: the bounded format probe must not buffer the whole
    // object a hostile bucket parked at a thumbnail name.
    const files = new Map<string, Uint8Array>();
    const events: string[] = [];
    let bytesCalls = 0;
    const makeHandle = (uri: string): ExpoLibraryFileHandle => ({
      uri,
      get exists() { return files.has(uri); },
      get size() { return files.get(uri)?.byteLength ?? null; },
      info() { return { exists: files.has(uri) }; },
      create() { /* the write below creates it, like the native call. */ },
      write(bytes) { files.set(uri, Uint8Array.from(bytes)); },
      bytes() {
        bytesCalls += 1;
        return Promise.resolve(Uint8Array.from(files.get(uri) ?? []));
      },
      copy() { throw new Error('not used'); },
      move() { throw new Error('not used'); },
      delete() { files.delete(uri); },
      open(mode) {
        events.push(`open ${String(mode)}`);
        return {
          readBytes(length: number) {
            events.push(`readBytes ${length}`);
            return Uint8Array.from(files.get(uri) ?? []).slice(0, length);
          },
          close() { events.push('close'); },
        } as unknown as FileHandle;
      },
    });
    const directory = (name: string): ExpoLibraryDirectoryHandle => ({
      uri: `file:///dirs/${name}`,
      exists: true,
      size: null,
      create() { /* nothing to create in the map. */ },
      list: () => [],
    });
    const adapter: ExpoLibraryFileAdapter = {
      createLibraryDirectory: () => directory('library'),
      createOriginalsDirectory: () => directory('originals'),
      createTempDirectory: () => directory('temp'),
      createStreamDirectory: () => directory('stream'),
      createTrashDirectory: () => directory('trash'),
      createCacheDirectory: () => directory('cache'),
      createShareDirectory: () => directory('library-share'),
      createThumbnailsDirectory: () => directory('thumbnails'),
      createFile: (location, name) => makeHandle(
        typeof location === 'string' ? location : `${location.uri}/${name ?? ''}`,
      ),
      isFile: (value): value is ExpoLibraryFileHandle => false,
    };
    const port = createExpoLibraryFilePort(adapter);
    const uri = port.resolveOriginal('prefix.bin');
    await port.writeBytes(uri, Uint8Array.from([1, 2, 3, 4, 5]));

    await expect(port.readPrefix(uri, 3)).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(events).toEqual(['open r', 'readBytes 3', 'close']);
    expect(bytesCalls).toBe(0);

    await expect(port.readPrefix(uri, 16)).resolves.toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(events).toEqual(['open r', 'readBytes 3', 'close', 'open r', 'readBytes 16', 'close']);
    expect(bytesCalls).toBe(0);
  });

  test('readPrefix opens read-only and closes the handle even when reading through it throws', async () => {
    const files = new Map<string, Uint8Array>();
    const events: string[] = [];
    const makeHandle = (uri: string): ExpoLibraryFileHandle => ({
      uri,
      get exists() { return files.has(uri); },
      get size() { return files.get(uri)?.byteLength ?? null; },
      info() { return { exists: files.has(uri) }; },
      create() { /* the write below creates it, like the native call. */ },
      write(bytes) { files.set(uri, Uint8Array.from(bytes)); },
      bytes() { return Promise.resolve(Uint8Array.from(files.get(uri) ?? [])); },
      copy() { throw new Error('not used'); },
      move() { throw new Error('not used'); },
      delete() { files.delete(uri); },
      open(mode) {
        events.push(`open ${String(mode)}`);
        return {
          readBytes() {
            events.push('readBytes');
            throw new Error('handle read failed');
          },
          close() { events.push('close'); },
        } as unknown as FileHandle;
      },
    });
    const directory = (name: string): ExpoLibraryDirectoryHandle => ({
      uri: `file:///dirs/${name}`,
      exists: true,
      size: null,
      create() { /* nothing to create in the map. */ },
      list: () => [],
    });
    const adapter: ExpoLibraryFileAdapter = {
      createLibraryDirectory: () => directory('library'),
      createOriginalsDirectory: () => directory('originals'),
      createTempDirectory: () => directory('temp'),
      createStreamDirectory: () => directory('stream'),
      createTrashDirectory: () => directory('trash'),
      createCacheDirectory: () => directory('cache'),
      createShareDirectory: () => directory('library-share'),
      createThumbnailsDirectory: () => directory('thumbnails'),
      createFile: (location, name) => makeHandle(
        typeof location === 'string' ? location : `${location.uri}/${name ?? ''}`,
      ),
      isFile: (value): value is ExpoLibraryFileHandle => false,
    };
    const port = createExpoLibraryFilePort(adapter);
    const uri = port.resolveOriginal('throwing.bin');
    await port.writeBytes(uri, Uint8Array.from([1, 2, 3]));

    await expect(port.readPrefix(uri, 16)).rejects.toThrow('handle read failed');
    expect(events).toEqual(['open r', 'readBytes', 'close']);
  });

  test('readPrefix rejects with the open error and never closes what it did not open', async () => {
    // Android throws inside `RandomAccessFile(…, "r")` for a missing file: the
    // open itself fails, and with no handle there is nothing to close.
    const events: string[] = [];
    const makeHandle = (uri: string): ExpoLibraryFileHandle => ({
      uri,
      get exists() { return false; },
      get size() { return null; },
      info() { return { exists: false }; },
      create() { throw new Error('not used'); },
      write() { throw new Error('not used'); },
      bytes() { throw new Error('not used'); },
      copy() { throw new Error('not used'); },
      move() { throw new Error('not used'); },
      delete() { throw new Error('not used'); },
      open() { throw new Error('open refused'); },
    });
    const directory = (name: string): ExpoLibraryDirectoryHandle => ({
      uri: `file:///dirs/${name}`,
      exists: true,
      size: null,
      create() { /* nothing to create in the map. */ },
      list: () => [],
    });
    const adapter: ExpoLibraryFileAdapter = {
      createLibraryDirectory: () => directory('library'),
      createOriginalsDirectory: () => directory('originals'),
      createTempDirectory: () => directory('temp'),
      createStreamDirectory: () => directory('stream'),
      createTrashDirectory: () => directory('trash'),
      createCacheDirectory: () => directory('cache'),
      createShareDirectory: () => directory('library-share'),
      createThumbnailsDirectory: () => directory('thumbnails'),
      createFile: (location, name) => makeHandle(
        typeof location === 'string' ? location : `${location.uri}/${name ?? ''}`,
      ),
      isFile: (value): value is ExpoLibraryFileHandle => false,
    };
    const port = createExpoLibraryFilePort(adapter);
    const uri = port.resolveOriginal('missing.bin');

    await expect(port.readPrefix(uri, 16)).rejects.toThrow('open refused');
    expect(events).toEqual([]);
  });
});
