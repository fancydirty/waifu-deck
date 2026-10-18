import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createNodeBlobStaging,
  withNodeStreamRoot,
} from '@/test/node-file-transfer';
import {
  createLibraryFileStore,
} from '@/features/library/library-file-store';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('expo-crypto', () => require('./expo-crypto-double'));

const PAYLOAD = Uint8Array.from([4, 5, 6, 7]);
const DIGEST = 'a'.repeat(64);

describe('Node stream-root file port', () => {
  // Node 26 kills the process when it garbage-collects an open FileHandle, so
  // every handle the port opens through `fs.open` is pinned per test and
  // closed again in afterEach: a port that leaks fails its test's close
  // assertion instead of crashing the worker before it can report.
  let pinned: { handle: Awaited<ReturnType<typeof fs.open>>; closes: number }[] = [];
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    pinned = [];
    const realOpen = fs.open.bind(fs);
    openSpy = jest.spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        // `close` is an own property of each FileHandle instance; `read` is on
        // the prototype and can be made to reject (the close test below).
        const entry = { handle, closes: 0 };
        pinned.push(entry);
        const nativeClose = handle.close.bind(handle);
        handle.close = async () => {
          entry.closes += 1;
          return nativeClose();
        };
        return handle;
      });
  });

  afterEach(async () => {
    openSpy.mockRestore();
    for (const { handle } of pinned) {
      await handle.close().catch(() => undefined);
    }
  });

  test('reserves under a real directory and adopts bytes written by blob staging', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const staging = createNodeBlobStaging();
    const reserved = store.reserveStreamPath();

    expect(reserved.startsWith(`${port.streamRootUri}/`)).toBe(true);
    expect(await port.exists(reserved)).toBe(false);
    await staging.writeBytes(reserved, PAYLOAD);

    const temp = await store.adoptStreamFile(reserved);
    expect(temp.byteSize).toBe(PAYLOAD.byteLength);
    const promoted = await store.promoteToOriginal(temp, DIGEST, 'jpg');

    expect(port.files.get(promoted.uri)).toEqual(PAYLOAD);
    expect(await fs.access(fileURLToPath(reserved)).then(() => true, () => false)).toBe(false);
  });

  test('adopts plain filesystem writes, discard removes them, and sweep counts real files', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const first = store.reserveStreamPath();
    const second = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(first), PAYLOAD);
    await fs.writeFile(fileURLToPath(second), PAYLOAD);

    const adopted = await store.adoptStreamFile(first);
    await adopted.discard();
    expect(await port.exists(first)).toBe(false);
    await expect(store.sweepStreamDir()).resolves.toBe(1);
    expect(await port.exists(second)).toBe(false);
  });

  test('rejects fake-root and traversal paths before touching the real root', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const paths = [
      'file:///cache/library-stream/old.part',
      `${port.streamRootUri}/../outside.part`,
      `${port.streamRootUri}/%2e%2e`,
    ];
    for (const uri of paths) {
      await expect(store.adoptStreamFile(uri)).rejects.toThrow(/stream directory/u);
      expect(port.files.has(uri)).toBe(false);
    }
  });

  test('delegates non-stream file operations to the fake map', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const uri = port.resolveTemp('delegated.tmp');

    await port.writeBytes(uri, PAYLOAD);
    expect(await port.exists(uri)).toBe(true);
    expect(await port.probe(uri)).toBe('present');
    expect(await port.size(uri)).toBe(PAYLOAD.byteLength);
    expect(await port.readBytes(uri)).toEqual(PAYLOAD);
    await port.delete(uri);
    expect(port.files.has(uri)).toBe(false);
  });

  test('delegates non-stream copy and move while stream listing stays on disk', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const source = port.resolveTemp('source.tmp');
    const copied = port.resolveCache('copied.tmp');
    const moved = port.resolveCache('moved.tmp');
    await port.writeBytes(source, PAYLOAD);
    await port.copyFrom(source, copied);
    await port.move(copied, moved);
    port.files.set('file:///cache/library-stream/fake.part', PAYLOAD);

    expect(await port.readBytes(moved)).toEqual(PAYLOAD);
    expect(await port.listStream()).toEqual([]);
    expect(port.files.has(source)).toBe(true);
    expect(port.files.has(copied)).toBe(false);
  });

  test('ensureDirectories recreates a removed real stream root', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    await fs.rm(fileURLToPath(port.streamRootUri), { recursive: true, force: true });
    await port.ensureDirectories();

    const uri = port.resolveStream('00000000-0000-4000-8000-000000000001.part');
    await port.writeBytes(uri, PAYLOAD);
    expect(await port.readBytes(uri)).toEqual(PAYLOAD);
  });

  test('cross-root move honours fake write failures and keeps the source', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const source = port.resolveStream('00000000-0000-4000-8000-000000000002.part');
    const destination = port.resolveOriginal('failed.jpg');
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    port.failWrites = true;

    await expect(port.move(source, destination)).rejects.toThrow('disk full');
    expect(await port.exists(source)).toBe(true);
    expect(port.files.has(destination)).toBe(false);
  });

  test('wrapped failMoves controls delegated fake moves and shares with the base', async () => {
    const base = createFakeLibraryFilePort();
    const port = withNodeStreamRoot(base);
    expect(Object.getOwnPropertyDescriptor(port, 'failMoves'))
      .toEqual(expect.objectContaining({ get: expect.any(Function), set: expect.any(Function) }));
    const source = port.resolveTemp('flagged-source.tmp');
    const destination = port.resolveOriginal('flagged.jpg');
    await port.writeBytes(source, PAYLOAD);
    port.failMoves = true;

    expect(base.failMoves).toBe(true);
    await expect(port.move(source, destination)).rejects.toThrow('rename failed');
    expect(port.files.has(source)).toBe(true);
  });

  test('wrapped failWrites controls delegated fake writes and shares with the base', async () => {
    const base = createFakeLibraryFilePort();
    const port = withNodeStreamRoot(base);
    const destination = port.resolveTemp('flagged-write.tmp');
    port.failWrites = true;

    expect(base.failWrites).toBe(true);
    await expect(port.writeBytes(destination, PAYLOAD)).rejects.toThrow('disk full');
    expect(port.files.has(destination)).toBe(false);
  });

  test('base failMoves controls a stream-to-fake move and preserves the real source', async () => {
    const base = createFakeLibraryFilePort();
    const port = withNodeStreamRoot(base);
    const source = port.resolveStream('00000000-0000-4000-8000-000000000004.part');
    const destination = port.resolveOriginal('base-flagged.jpg');
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    base.failMoves = true;

    expect(port.failMoves).toBe(true);
    await expect(port.move(source, destination)).rejects.toThrow('rename failed');
    expect(await port.exists(source)).toBe(true);
  });

  test('real stream deletion is idempotent', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const uri = port.resolveStream('00000000-0000-4000-8000-000000000003.part');
    await fs.writeFile(fileURLToPath(uri), PAYLOAD);
    await port.delete(uri);
    await expect(port.delete(uri)).resolves.toBeUndefined();
  });

  test('readPrefix answers exactly min(length, size) bytes of a real stream file', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const uri = port.resolveStream('00000000-0000-4000-8000-000000000005.part');
    await fs.writeFile(fileURLToPath(uri), PAYLOAD);

    await expect(port.readPrefix(uri, 16)).resolves.toEqual(PAYLOAD);
    await expect(port.readPrefix(uri, 2)).resolves.toEqual(PAYLOAD.slice(0, 2));
  });

  test('readPrefix delegates files outside the stream root to the fake map', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const uri = port.resolveTemp('prefixed.tmp');
    await port.writeBytes(uri, PAYLOAD);

    await expect(port.readPrefix(uri, 3)).resolves.toEqual(PAYLOAD.slice(0, 3));
  });

  test('readPrefix closes the handle it opened, even when the read rejects', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const uri = port.resolveStream('00000000-0000-4000-8000-000000000006.part');
    await fs.writeFile(fileURLToPath(uri), PAYLOAD);

    await expect(port.readPrefix(uri, 2)).resolves.toEqual(PAYLOAD.slice(0, 2));
    expect(pinned.map((entry) => entry.closes)).toEqual([1]);

    const readSpy = jest.spyOn(Object.getPrototypeOf(pinned[0]!.handle), 'read')
      .mockRejectedValueOnce(new Error('read failed'));
    try {
      await expect(port.readPrefix(uri, 2)).rejects.toThrow('read failed');
    } finally {
      readSpy.mockRestore();
    }
    expect(pinned.map((entry) => entry.closes)).toEqual([1, 1]);
  });

  test('readPrefix fills the prefix across short reads before EOF', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const uri = port.resolveStream('00000000-0000-4000-8000-000000000007.part');
    await fs.writeFile(fileURLToPath(uri), PAYLOAD);
    // Each underlying read answers at most one byte, before EOF.
    const probe = await fs.open(fileURLToPath(uri), 'r');
    const handlePrototype = Object.getPrototypeOf(probe);
    const realRead = handlePrototype.read;
    const readSpy = jest.spyOn(handlePrototype, 'read').mockImplementation(
      async function (this: unknown, buffer: unknown, offset: unknown,
        length: unknown, position: unknown) {
        return realRead.call(
          this,
          buffer as Uint8Array,
          offset as number | undefined,
          Math.min(1, typeof length === 'number' ? length : 0),
          (position ?? null) as number | null,
        );
      },
    );
    try {
      await expect(port.readPrefix(uri, 2)).resolves.toEqual(PAYLOAD.slice(0, 2));
      await expect(port.readPrefix(uri, 16)).resolves.toEqual(PAYLOAD);
    } finally {
      readSpy.mockRestore();
      await probe.close();
    }
  });
});

// Board row 45: the share staging area is a second real directory, so the
// store's stage/release/sweep run against bytes on disk exactly like the
// device's native `File.copy`.
describe('library share staging (real files)', () => {
  const onDisk = async (uri: string): Promise<boolean> => {
    try {
      return (await fs.stat(fileURLToPath(uri))).isFile();
    } catch {
      return false;
    }
  };

  test('stageShareCopy copies the source bytes to <sha>.<ext> as a real file in the share area', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);

    const staged = await store.stageShareCopy(source, `${DIGEST}.png`);

    expect(staged).toBe(port.resolveShare(`${DIGEST}.png`));
    expect(staged.startsWith(`${port.shareRootUri}/`)).toBe(true);
    expect(await onDisk(staged)).toBe(true);
    // A real file on disk, not a fake-map entry. The Node test port itself
    // copies through a buffer (it is a test double); on the device the copy
    // is the expo port's native `File.copy`.
    expect(port.files.has(staged)).toBe(false);
    await expect(fs.readFile(fileURLToPath(staged))).resolves.toEqual(Buffer.from(PAYLOAD));
  });

  test('a second stage removes the first copy: one staged copy at a time', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);

    const first = await store.stageShareCopy(source, `${DIGEST}.png`);
    const second = await store.stageShareCopy(source, `${'b'.repeat(64)}.jpg`);

    expect(await onDisk(first)).toBe(false);
    expect(await onDisk(second)).toBe(true);
    await expect(port.listShare()).resolves.toEqual([second]);
  });

  test('an existing destination is replaced', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    const destination = port.resolveShare(`${DIGEST}.png`);
    await fs.mkdir(fileURLToPath(port.shareRootUri), { recursive: true });
    await fs.writeFile(fileURLToPath(destination), Buffer.from([0]));

    const staged = await store.stageShareCopy(source, `${DIGEST}.png`);

    expect(staged).toBe(destination);
    await expect(fs.readFile(fileURLToPath(destination))).resolves.toEqual(Buffer.from(PAYLOAD));
  });

  test('a bad name rejects with nothing written and the area untouched', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    const kept = await store.stageShareCopy(source, `${DIGEST}.png`);

    for (const name of [
      'short.png',
      `${DIGEST}.bin`,
      `${'A'.repeat(64)}.jpg`,
      `${DIGEST}.jpeg`,
      `${DIGEST}.png/sibling.png`,
      `../escape.png`,
    ]) {
      await expect(store.stageShareCopy(source, name)).rejects.toThrow(/share file name/u);
    }

    await expect(port.listShare()).resolves.toEqual([kept]);
  });

  test('a failing copy leaves no destination and rejects with the storage error', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    port.unreadableSources.add(source);

    await expect(store.stageShareCopy(source, `${DIGEST}.png`))
      .rejects.toMatchObject({ code: 'storage_failed' });
    await expect(port.listShare()).resolves.toEqual([]);
  });

  // Review fix 1: a copy that fails AFTER writing the destination (a partial
  // copy) must not leave the half-staged file behind.
  test('a copy that wrote the destination and then threw still leaves nothing behind', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    const realCopyFrom = port.copyFrom.bind(port);
    port.copyFrom = async (sourceUri: string, destinationUri: string) => {
      await realCopyFrom(sourceUri, destinationUri);
      throw new Error('the copy failed after writing');
    };

    await expect(store.stageShareCopy(source, `${DIGEST}.png`))
      .rejects.toMatchObject({ code: 'storage_failed' });
    await expect(port.listShare()).resolves.toEqual([]);
  });

  // Review fix 2: on a device the OS may clear the cache directory between
  // stages; a stage must bring the area back, not fail on the missing root.
  test('a stage recreates the share area the OS cleared', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    await fs.rm(fileURLToPath(port.shareRootUri), { recursive: true, force: true });

    const staged = await store.stageShareCopy(source, `${DIGEST}.png`);

    expect(await onDisk(staged)).toBe(true);
    await expect(port.listShare()).resolves.toEqual([staged]);
  });

  // Review fix 3: release is best effort — a failing delete never rejects.
  test('releaseShareCopy resolves even when deleting the copy throws', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    const staged = await store.stageShareCopy(source, `${DIGEST}.png`);
    port.delete = async () => {
      throw new Error('the delete failed');
    };

    await expect(store.releaseShareCopy(staged)).resolves.toBeUndefined();
  });

  test('releaseShareCopy deletes a staged copy and ignores a uri outside the area', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);

    const staged = await store.stageShareCopy(source, `${DIGEST}.png`);
    await expect(store.releaseShareCopy(staged)).resolves.toBeUndefined();
    expect(await onDisk(staged)).toBe(false);

    const elsewhere = port.resolveTemp('kept.tmp');
    await port.writeBytes(elsewhere, PAYLOAD);
    await expect(store.releaseShareCopy(elsewhere)).resolves.toBeUndefined();
    expect(await port.exists(elsewhere)).toBe(true);
    expect(port.deletedFiles).not.toContain(elsewhere);

    await expect(store.releaseShareCopy(`${port.shareRootUri}/absent.png`))
      .resolves.toBeUndefined();
  });

  test('sweepShareDir empties the area and answers how many files it removed', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    await store.stageShareCopy(source, `${DIGEST}.png`);
    await fs.writeFile(fileURLToPath(port.resolveShare('extra.png')), Buffer.from([1]));

    await expect(store.sweepShareDir()).resolves.toBe(2);
    await expect(port.listShare()).resolves.toEqual([]);
    await expect(store.sweepShareDir()).resolves.toBe(0);
  });

  test('deleteAllDeviceFiles removes staged copies with the rest of the device files', async () => {
    const port = withNodeStreamRoot(createFakeLibraryFilePort());
    const store = createLibraryFileStore({ port });
    const source = store.reserveStreamPath();
    await fs.writeFile(fileURLToPath(source), PAYLOAD);
    const staged = await store.stageShareCopy(source, `${DIGEST}.png`);
    await port.writeBytes(port.resolveOriginal('a.jpg'), PAYLOAD);

    await expect(store.deleteAllDeviceFiles()).resolves.toEqual([]);
    expect(await onDisk(staged)).toBe(false);
    expect(await port.exists(port.resolveOriginal('a.jpg'))).toBe(false);
  });
});
