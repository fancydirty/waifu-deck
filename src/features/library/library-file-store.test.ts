import {
  createLibraryFileStore,
  isInOriginalsDirectory,
  type LibraryFilePort,
} from '@/features/library/library-file-store';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';
import { LibraryIngestError } from '@/features/library/library-types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

type FakeFileSystem = LibraryFilePort & {
  files: Map<string, Uint8Array>;
  sizeCalls: string[];
  failCopyFor: Set<string>;
  readBytesCalls: string[];
};

function fakeFileSystem(): FakeFileSystem {
  const files = new Map<string, Uint8Array>();
  const sizeCalls: string[] = [];
  const failCopyFor = new Set<string>();
  const readBytesCalls: string[] = [];
  const originalsRootUri = 'file:///data/library/originals';
  const tempRootUri = 'file:///cache/library-temp';
  const streamRootUri = 'file:///cache/library-stream';
  const trashRootUri = 'file:///data/library/trash';
  const cacheRootUri = 'file:///cache/library-cache';
  const shareRootUri = 'file:///cache/library-share';
  const thumbnailsRootUri = 'file:///data/library/thumbnails';
  const pickerCacheRootUri = 'file:///cache/ImagePicker';

  const require = (uri: string): Uint8Array => {
    const value = files.get(uri);
    if (value === undefined) throw new Error(`missing file ${uri}`);
    return value;
  };

  return {
    files,
    sizeCalls,
    failCopyFor,
    readBytesCalls,
    originalsRootUri,
    tempRootUri,
    streamRootUri,
    trashRootUri,
    cacheRootUri,
    shareRootUri,
    thumbnailsRootUri,
    pickerCacheRootUri,
    async ensureDirectories() {},
    resolveOriginal: (name) => `${originalsRootUri}/${name}`,
    resolveTemp: (name) => `${tempRootUri}/${name}`,
    resolveStream: (name) => `${streamRootUri}/${name}`,
    resolveTrash: (name) => `${trashRootUri}/${name}`,
    resolveCache: (name) => `${cacheRootUri}/${name}`,
    resolveShare: (name) => `${shareRootUri}/${name}`,
    resolveThumbnail: (name) => `${thumbnailsRootUri}/${name}`,
    async exists(uri) {
      return files.has(uri);
    },
    async probe(uri) {
      return files.has(uri) ? 'present' : 'absent';
    },
    async writeBytes(uri, bytes) {
      files.set(uri, Uint8Array.from(bytes));
    },
    async readBytes(uri) {
      readBytesCalls.push(uri);
      return Uint8Array.from(require(uri));
    },
    async readPrefix(uri, length) {
      return Uint8Array.from(require(uri).slice(0, length));
    },
    async copyFrom(sourceUri, destinationUri) {
      if (failCopyFor.has(sourceUri)) {
        throw new Error(`permission revoked for ${sourceUri}`);
      }
      files.set(destinationUri, Uint8Array.from(require(sourceUri)));
    },
    async move(sourceUri, destinationUri) {
      if (files.has(destinationUri)) {
        throw new Error(`destination already exists: ${destinationUri}`);
      }
      files.set(destinationUri, Uint8Array.from(require(sourceUri)));
      files.delete(sourceUri);
    },
    async delete(uri) {
      files.delete(uri);
    },
    async size(uri) {
      sizeCalls.push(uri);
      return files.get(uri)?.byteLength ?? 0;
    },
    async listOriginals() {
      return [...files.keys()].filter((uri) => uri.startsWith(originalsRootUri));
    },
    async listOriginalNames() {
      return [...files.keys()]
        .filter((uri) => uri.startsWith(`${originalsRootUri}/`))
        .map((uri) => uri.slice(uri.lastIndexOf('/') + 1));
    },
    async listTemp() {
      return [...files.keys()].filter((uri) => uri.startsWith(tempRootUri));
    },
    async listStream() {
      return [...files.keys()].filter((uri) => uri.startsWith(`${streamRootUri}/`));
    },
    async listTrash() {
      return [...files.keys()].filter((uri) => uri.startsWith(trashRootUri));
    },
    async listCache() {
      return [...files.keys()].filter((uri) => uri.startsWith(cacheRootUri));
    },
    async listShare() {
      return [...files.keys()].filter((uri) => uri.startsWith(`${shareRootUri}/`));
    },
    async listThumbnails() {
      return [...files.keys()].filter((uri) => uri.startsWith(thumbnailsRootUri));
    },
    async listPickerCache() {
      return [...files.keys()].filter((uri) => uri.startsWith(`${pickerCacheRootUri}/`));
    },
    async durableBytes() {
      let total = 0;
      for (const [uri, bytes] of files) {
        if (uri.startsWith('file:///data/library/')) total += bytes.byteLength;
      }
      return total;
    },
  };
}

function createPort(): { port: FakeFileSystem; store: ReturnType<typeof createLibraryFileStore> } {
  const port = fakeFileSystem();
  return { port, store: createLibraryFileStore({ port }) };
}

const digest = 'a'.repeat(64);
const payload = Uint8Array.from([9, 8, 7]);

describe('library file store', () => {
  test('deleteAllDeviceFiles deletes every file under originals, trash, thumbnails, cache and staging, and reports what it could not delete', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port });
    const bytes = Uint8Array.from([1]);
    const stuck = `${port.originalsRootUri}/b.png`;
    const collection = 'file:///documents/collection/kept.jpg';
    for (const uri of [
      `${port.originalsRootUri}/a.png`,
      stuck,
      `${port.trashRootUri}/t.jpg`,
      `${port.cacheRootUri}/c.bin`,
      `${port.tempRootUri}/s.tmp`,
      `${port.thumbnailsRootUri}/x.webp`,
      collection,
    ]) {
      port.files.set(uri, bytes);
    }
    const realDelete = port.delete.bind(port);
    port.delete = async (uri: string) => {
      if (uri === stuck) throw new Error('busy');
      await realDelete(uri);
    };

    await expect(store.deleteAllDeviceFiles()).resolves.toEqual([stuck]);
    expect([...port.files.keys()].sort()).toEqual([collection, stuck].sort());

    // A failed thumbnails listing reports that area's root; the others still go.
    port.files.set(`${port.thumbnailsRootUri}/y.webp`, bytes);
    port.files.set(`${port.trashRootUri}/u.jpg`, bytes);
    port.listThumbnails = async () => {
      throw new Error('listing failed');
    };
    await expect(store.deleteAllDeviceFiles()).resolves.toEqual([stuck, port.thumbnailsRootUri]);
    expect(port.files.has(`${port.thumbnailsRootUri}/y.webp`)).toBe(true);
    expect(port.files.has(`${port.trashRootUri}/u.jpg`)).toBe(false);
  });

  test('promoteThumbnail stages the bytes, then moves them to thumbnails/<sha>.<ext>', async () => {
    const { port, store } = createPort();
    const log: string[] = [];
    const realWrite = port.writeBytes.bind(port);
    const realMove = port.move.bind(port);
    port.writeBytes = async (uri, bytes) => {
      log.push(`write:${uri}`);
      await realWrite(uri, bytes);
    };
    port.move = async (from, to) => {
      log.push(`move:${from}->${to}`);
      await realMove(from, to);
    };
    const destination = `${port.thumbnailsRootUri}/${digest}.webp`;

    await expect(store.promoteThumbnail(payload, digest, 'webp'))
      .resolves.toBe(destination);

    expect(log).toHaveLength(2);
    const staged = log[0].slice('write:'.length);
    expect(staged).toMatch(/wd-lib-\d+-\d+\.tmp$/u);
    expect(staged.startsWith(`${port.tempRootUri}/`)).toBe(true);
    expect(log).toEqual([`write:${staged}`, `move:${staged}->${destination}`]);
    expect(port.files.get(destination)).toEqual(payload);
    expect([...port.files.keys()].filter((uri) => uri.startsWith(port.tempRootUri)))
      .toEqual([]);
  });

  test('promoteThumbnail: a file already at the name is replaced', async () => {
    const { port, store } = createPort();
    const destination = `${port.thumbnailsRootUri}/${digest}.jpg`;
    port.files.set(destination, Uint8Array.from([0]));

    await expect(store.promoteThumbnail(payload, digest, 'jpg'))
      .resolves.toBe(destination);

    expect(port.files.get(destination)).toEqual(payload);
  });

  test('promoteThumbnail: a failed move leaves nothing at the name and no staging file', async () => {
    const { port, store } = createPort();
    const destination = `${port.thumbnailsRootUri}/${digest}.png`;
    port.move = async () => {
      throw new Error('rename failed');
    };

    await expect(store.promoteThumbnail(payload, digest, 'png'))
      .rejects.toMatchObject({ code: 'storage_failed' });

    expect(port.files.has(destination)).toBe(false);
    expect([...port.files.keys()].filter((uri) => uri.startsWith(port.tempRootUri)))
      .toEqual([]);
  });

  test('thumbnailUriFor names the file in the thumbnails area', () => {
    const { port, store } = createPort();
    expect(store.thumbnailUriFor(digest, 'webp'))
      .toBe(`${port.thumbnailsRootUri}/${digest}.webp`);
    expect(store.thumbnailUriFor(digest, 'jpg'))
      .toBe(`${port.thumbnailsRootUri}/${digest}.jpg`);
  });

  test('acquires bytes into a unique temporary file and promotes atomically', async () => {
    const port = fakeFileSystem();
    let ticks = 1_000;
    const store = createLibraryFileStore({
      port,
      clock: () => (ticks += 1),
    });

    const first = await store.acquireFromBytes(payload);
    const second = await store.acquireFromBytes(payload);
    expect(first.uri).not.toBe(second.uri);
    expect(first.byteSize).toBe(3);
    await second.discard();
    expect(await port.exists(second.uri)).toBe(false);

    const promoted = await store.promoteToOriginal(first, digest, 'png');
    expect(promoted).toEqual({
      uri: `${port.originalsRootUri}/${digest}.png`,
      reused: false,
    });
    expect(await port.exists(first.uri)).toBe(false);
    expect(await port.readBytes(promoted.uri)).toEqual(payload);

    await first.discard();
    expect(await port.exists(promoted.uri)).toBe(true);
  });

  test('reserves and adopts dedicated stream files without creating them', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port });

    const first = store.reserveStreamPath();
    const second = store.reserveStreamPath();
    expect(first).not.toBe(second);
    expect(first.startsWith(`${port.streamRootUri}/`)).toBe(true);
    expect(first.endsWith('.part')).toBe(true);
    expect(await port.exists(first)).toBe(false);

    port.files.set(first, payload);
    const temp = await store.adoptStreamFile(first);
    expect(temp).toEqual(expect.objectContaining({ uri: first, byteSize: payload.byteLength }));
    await temp.discard();
    expect(await port.exists(first)).toBe(false);
  });

  test('rejects stream adoption outside the stream root before touching the file', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port });
    const outside = `${port.tempRootUri}/outside.part`;
    const traversal = `${port.streamRootUri}/../outside.part`;
    port.files.set(outside, payload);
    port.files.set(traversal, payload);

    await expect(store.adoptStreamFile(outside)).rejects.toThrow(/stream directory/u);
    await expect(store.adoptStreamFile(traversal)).rejects.toThrow(/stream directory/u);
    expect(port.files.has(outside)).toBe(true);
    expect(port.files.has(traversal)).toBe(true);
  });

  test('rejects dot, encoded traversal, backslash, and empty stream names before measuring', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port });
    const names = ['..', '.', '%2e%2e', 'has\\backslash', ''];
    for (const name of names) {
      const uri = `${port.streamRootUri}/${name}`;
      port.files.set(uri, payload);
      await expect(store.adoptStreamFile(uri)).rejects.toThrow(/stream directory/u);
    }
    expect(port.sizeCalls).toEqual([]);
    expect(names.map((name) => `${port.streamRootUri}/${name}`))
      .toEqual(expect.arrayContaining([...port.files.keys()]));
  });

  test('promotes adopted stream files and sweeps only the stream directory', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port });
    const stream = store.reserveStreamPath();
    const otherStream = store.reserveStreamPath();
    port.files.set(stream, payload);
    port.files.set(otherStream, Uint8Array.from([4]));
    const ingest = await store.acquireFromBytes(Uint8Array.from([5]));

    const temp = await store.adoptStreamFile(stream);
    const promoted = await store.promoteToOriginal(temp, digest, 'png');
    expect(promoted.uri).toBe(`${port.originalsRootUri}/${digest}.png`);
    expect(await port.exists(stream)).toBe(false);
    expect(await store.sweepStreamDir()).toBe(1);
    expect(await port.exists(otherStream)).toBe(false);
    expect(await port.exists(ingest.uri)).toBe(true);
  });

  test('reuses an existing original instead of overwriting durable bytes', async () => {
    const port = fakeFileSystem();
    let ticks = 2_000;
    const store = createLibraryFileStore({ port, clock: () => (ticks += 1) });

    const first = await store.acquireFromBytes(payload);
    await store.promoteToOriginal(first, digest, 'png');

    const second = await store.acquireFromBytes(Uint8Array.from([1]));
    const promoted = await store.promoteToOriginal(second, digest, 'png');

    expect(promoted.reused).toBe(true);
    expect(await port.readBytes(promoted.uri)).toEqual(payload);
    expect(await port.exists(second.uri)).toBe(false);
  });

  test('copies a source uri immediately and survives later revocation', async () => {
    const port = fakeFileSystem();
    let ticks = 3_000;
    const store = createLibraryFileStore({ port, clock: () => (ticks += 1) });
    const pickerUri = 'content://media/picker/42';
    port.files.set(pickerUri, payload);

    const temp = await store.acquireFromUri(pickerUri);

    port.files.delete(pickerUri);
    port.failCopyFor.add(pickerUri);

    expect(await store.readTemp(temp)).toEqual(payload);
    const promoted = await store.promoteToOriginal(temp, digest, 'jpg');
    expect(await port.readBytes(promoted.uri)).toEqual(payload);
  });

  test('reports an unreadable source as a typed ingest error', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port, clock: () => 4_000 });
    port.failCopyFor.add('content://revoked');
    port.files.set('content://revoked', payload);

    await expect(store.acquireFromUri('content://revoked'))
      .rejects.toBeInstanceOf(LibraryIngestError);
    await expect(store.acquireFromUri('content://revoked'))
      .rejects.toMatchObject({ code: 'unreadable_source' });
  });

  test('reconciles temporary leftovers, orphan originals, and missing originals', async () => {
    const port = fakeFileSystem();
    let ticks = 5_000;
    const store = createLibraryFileStore({ port, clock: () => (ticks += 1) });

    const kept = await store.acquireFromBytes(payload);
    const keptOriginal = await store.promoteToOriginal(kept, digest, 'png');

    const orphanOriginalUri = `${port.originalsRootUri}/${'b'.repeat(64)}.jpg`;
    port.files.set(orphanOriginalUri, payload);

    const staleTemp = await store.acquireFromBytes(payload);
    const freshTemp = await store.acquireFromBytes(payload);

    const result = await store.reconcileOrphans({
      referencedOriginalUris: [
        keptOriginal.uri,
        `${port.originalsRootUri}/${'c'.repeat(64)}.gif`,
      ],
      now: 5_010 + 60_000,
      temporaryGraceMs: 60_000,
    });

    expect(result.deletedTemporary).toEqual([staleTemp.uri, freshTemp.uri]);
    expect(result.deletedOrphanOriginals).toEqual([orphanOriginalUri]);
    expect(result.missingOriginals).toEqual([
      `${port.originalsRootUri}/${'c'.repeat(64)}.gif`,
    ]);
    expect(result.failed).toEqual([]);
    expect(await port.exists(keptOriginal.uri)).toBe(true);
  });

  test('reuses the winning original when concurrent promotions race', async () => {
    const port = fakeFileSystem();
    let ticks = 7_000;
    const store = createLibraryFileStore({ port, clock: () => (ticks += 1) });

    const first = await store.acquireFromBytes(payload);
    const second = await store.acquireFromBytes(payload);
    const destination = `${port.originalsRootUri}/${digest}.png`;

    let destinationExistsChecks = 0;
    let releaseMoves: (() => void) | undefined;
    const moveGate = new Promise<void>((resolve) => {
      releaseMoves = resolve;
    });

    const originalExists = port.exists.bind(port);
    port.exists = async (uri) => {
      const result = await originalExists(uri);
      if (uri === destination) {
        destinationExistsChecks += 1;
        if (destinationExistsChecks === 2) {
          releaseMoves?.();
        }
      }
      return result;
    };

    const originalMove = port.move.bind(port);
    port.move = async (sourceUri, destinationUri) => {
      if (destinationUri === destination) {
        await moveGate;
      }
      return originalMove(sourceUri, destinationUri);
    };

    const [firstResult, secondResult] = await Promise.all([
      store.promoteToOriginal(first, digest, 'png'),
      store.promoteToOriginal(second, digest, 'png'),
    ]);

    const reusedResults = [firstResult, secondResult].filter((r) => r.reused);
    const createdResults = [firstResult, secondResult].filter((r) => !r.reused);

    expect(firstResult.uri).toBe(destination);
    expect(secondResult.uri).toBe(destination);
    expect(reusedResults).toHaveLength(1);
    expect(createdResults).toHaveLength(1);
    expect(await port.exists(first.uri)).toBe(false);
    expect(await port.exists(second.uri)).toBe(false);
    expect(await port.readBytes(destination)).toEqual(payload);
    expect(await port.listOriginals()).toEqual([destination]);
  });

  test('keeps temporary files that are still inside the grace window', async () => {
    const port = fakeFileSystem();
    let ticks = 6_000;
    const store = createLibraryFileStore({ port, clock: () => (ticks += 1) });
    const inFlight = await store.acquireFromBytes(payload);

    const result = await store.reconcileOrphans({
      referencedOriginalUris: [],
      now: 6_005,
      temporaryGraceMs: 60_000,
    });

    expect(result.deletedTemporary).toEqual([]);
    expect(await port.exists(inFlight.uri)).toBe(true);
  });

  test('moves an original into device trash and restores it', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port, clock: () => 8_000 });
    const content = Uint8Array.from([1, 2, 3, 4]);
    const contentDigest = sha256PlaintextHex(content);
    const originalUri = `${port.originalsRootUri}/${contentDigest}.png`;
    const trashUri = `${port.trashRootUri}/${contentDigest}.png`;
    port.files.set(originalUri, content);

    expect(await store.moveOriginalToDeviceTrash(originalUri, contentDigest, 'png'))
      .toBe(trashUri);
    expect(await port.exists(originalUri)).toBe(false);
    expect(await port.readBytes(trashUri)).toEqual(content);

    expect(await store.restoreOriginalFromDeviceTrash(trashUri, contentDigest, 'png'))
      .toBe(originalUri);
    expect(await port.exists(trashUri)).toBe(false);
    expect(await port.readBytes(originalUri)).toEqual(content);
  });

  test('K7 ㉝: move-to-trash over a stale trash copy replaces it with the live original, reading nothing', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port, clock: () => 9_100 });
    const content = Uint8Array.from([5, 6, 7]);
    const contentDigest = sha256PlaintextHex(content);
    const originalUri = `${port.originalsRootUri}/${contentDigest}.png`;
    const trashUri = `${port.trashRootUri}/${contentDigest}.png`;
    port.files.set(originalUri, Uint8Array.from(content));
    port.files.set(trashUri, Uint8Array.from([9, 9, 9]));
    port.readBytesCalls.length = 0;

    expect(await store.moveOriginalToDeviceTrash(originalUri, contentDigest, 'png'))
      .toBe(trashUri);
    expect(await port.exists(originalUri)).toBe(false);
    expect(await port.readBytes(trashUri)).toEqual(content);
    expect(port.readBytesCalls.filter((uri) => uri !== trashUri)).toEqual([]);
  });

  test('K7 ㉝: restore onto an existing original reuses it, keeps the trash copy, and reads nothing', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port, clock: () => 9_200 });
    const content = Uint8Array.from([8, 1, 2]);
    const contentDigest = sha256PlaintextHex(content);
    const originalUri = `${port.originalsRootUri}/${contentDigest}.jpg`;
    const trashUri = `${port.trashRootUri}/${contentDigest}.jpg`;
    port.files.set(originalUri, Uint8Array.from(content));
    port.files.set(trashUri, Uint8Array.from(content));
    port.readBytesCalls.length = 0;

    expect(await store.restoreOriginalFromDeviceTrash(trashUri, contentDigest, 'jpg'))
      .toBe(originalUri);
    expect(await port.exists(trashUri)).toBe(true);
    expect(port.readBytesCalls).toEqual([]);
  });

  it('exposes a cache root that is distinct from originals, temp, and trash', () => {
    const { port } = createPort();
    const roots = new Set([
      port.originalsRootUri,
      port.tempRootUri,
      port.trashRootUri,
      port.cacheRootUri,
    ]);
    expect(roots.size).toBe(4);
    expect(port.resolveCache('x.bin').startsWith(port.cacheRootUri)).toBe(true);
  });

  it('never deletes a cached role file during orphan reconciliation', async () => {
    const { port, store } = createPort();
    await port.ensureDirectories();
    const cached = port.resolveCache('cached-preview.bin');
    await port.writeBytes(cached, new Uint8Array([1, 2, 3]));
    const orphan = port.resolveOriginal('orphan.jpg');
    await port.writeBytes(orphan, new Uint8Array([4, 5, 6]));

    const result = await store.reconcileOrphans({ referencedOriginalUris: [] });

    expect(result.deletedOrphanOriginals).toEqual([orphan]);
    expect(await port.exists(cached)).toBe(true);
    expect(result.deletedTemporary).not.toContain(cached);
  });

  // Board #27 S1b Task 2 (spec R25): a restored row may name another Android
  // user's path; `/data/data/<pkg>/` is user 0's `/data/user/0/<pkg>/`.
  const R = 'file:///data/user/0/app.waifudeck.mobile/files/library/originals';
  test.each<[string, string, boolean]>([
    [`${R}/a.jpg`, R, true],
    ['file:///data/data/app.waifudeck.mobile/files/library/originals/a.jpg', R, true],
    [`${R}/a.jpg`, 'file:///data/data/app.waifudeck.mobile/files/library/originals/', true],
    ['file:///data/user/10/app.waifudeck.mobile/files/library/originals/a.jpg', R, false],
    ['file:///data/user/0/other.app/files/library/originals/a.jpg', R, false],
    [`${R}-old/a.jpg`, R, false],
    ['file:///data/user/0/app.waifudeck.mobile/files/library/trash/a.jpg', R, false],
    // The fake port's root.
    ['file:///data/library/originals/a.jpg', 'file:///data/library/originals', true],
  ])('isInOriginalsDirectory(%s, %s) → %s', (uri, root, answer) => {
    expect(isInOriginalsDirectory(uri, root)).toBe(answer);
  });

  // Board #27 S1b Task 3 (spec §5.6): a usable original lies inside this
  // device's originals directory and is on disk.
  test('hasOwnOriginal: its own file, a missing one, a foreign path, a failing check', async () => {
    const port = createFakeLibraryFilePort();
    const store = createLibraryFileStore({ port });
    const own = port.resolveOriginal(`${digest}.jpg`);
    const notHeld = port.resolveOriginal(`${'c'.repeat(64)}.jpg`);
    const foreign =
      'file:///data/user/10/app.waifudeck.mobile/files/library/originals/x.jpg';
    port.files.set(own, payload);
    port.files.set(foreign, payload);

    await expect(store.hasOwnOriginal(own)).resolves.toBe(true);
    await expect(store.hasOwnOriginal(notHeld)).resolves.toBe(false);
    // Held by the port: only the directory rule refuses it.
    await expect(store.hasOwnOriginal(foreign)).resolves.toBe(false);

    const failing = createFakeLibraryFilePort();
    failing.files.set(own, payload);
    failing.exists = async () => {
      throw new Error('Missing READ permission');
    };
    await expect(
      createLibraryFileStore({ port: failing }).hasOwnOriginal(own),
    ).resolves.toBe(false);
  });

  // Board #27 S1b Task 8 (spec R26): a restore deletes the originals and
  // device-trash files no restored row names, by file name.
  test('deleteUnnamedFiles keeps each file a uri names, by file name', async () => {
    const port = createFakeLibraryFilePort();
    const store = createLibraryFileStore({ port });
    const held = [
      port.resolveOriginal('a.jpg'),
      port.resolveOriginal('b.png'),
      port.resolveOriginal('c.gif'),
      port.resolveTrash('d.webp'),
      port.resolveTrash('e.jpg'),
      port.resolveCache('cached.jpg'),
      port.resolveTemp('wd-lib-1-1.tmp'),
      'file:///documents/collection/7.jpg',
    ];
    for (const uri of held) port.files.set(uri, payload);

    const failed = await store.deleteUnnamedFiles([
      'file:///data/data/app.waifudeck.mobile/files/library/originals/a.jpg',
      'file:///data/user/10/app.waifudeck.mobile/files/library/originals/b.png',
      `${port.trashRootUri}/d.webp`,
      'file:///data/user/0/app.waifudeck.mobile/files/library/originals/xc.gif',
    ]);

    expect(failed).toEqual([]);
    expect([...port.deletedFiles].sort()).toEqual([
      port.resolveOriginal('c.gif'),
      port.resolveTrash('e.jpg'),
    ].sort());
    expect([...port.files.keys()].sort()).toEqual(
      held
        .filter((uri) => !port.deletedFiles.includes(uri))
        .sort(),
    );
  });

  // OQ-8a: one set of names serves both areas.
  test('deleteUnnamedFiles: a name keeps its file in either area, whichever column named it', async () => {
    const port = createFakeLibraryFilePort();
    const store = createLibraryFileStore({ port });
    const x = `${'1'.repeat(64)}.jpg`;
    const y = `${'2'.repeat(64)}.jpg`;
    const trashX = port.resolveTrash(x);
    const originalY = port.resolveOriginal(y);
    const unnamedOriginal = port.resolveOriginal(`${'3'.repeat(64)}.jpg`);
    const unnamedTrash = port.resolveTrash(`${'4'.repeat(64)}.jpg`);
    for (const uri of [trashX, originalY, unnamedOriginal, unnamedTrash]) {
      port.files.set(uri, payload);
    }

    await expect(store.deleteUnnamedFiles([
      `file:///data/user/0/app.waifudeck.mobile/files/library/originals/${x}`,
      `file:///data/user/0/app.waifudeck.mobile/files/library/trash/${y}`,
    ])).resolves.toEqual([]);

    expect(port.files.has(trashX)).toBe(true);
    expect(port.files.has(originalY)).toBe(true);
    expect([...port.deletedFiles].sort()).toEqual(
      [unnamedOriginal, unnamedTrash].sort(),
    );
  });

  test('deleteUnnamedFiles: a failed listing deletes nothing in its area; a failed delete is reported and the rest still go', async () => {
    const port = createFakeLibraryFilePort();
    const store = createLibraryFileStore({ port });
    const u = port.resolveOriginal('u.jpg');
    const v = port.resolveOriginal('v.jpg');
    const w = port.resolveTrash('w.jpg');
    for (const uri of [u, v, w]) port.files.set(uri, payload);

    const listOriginals = port.listOriginals;
    port.listOriginals = async () => {
      throw new Error('listing failed');
    };
    await expect(store.deleteUnnamedFiles([])).resolves.toEqual([
      port.originalsRootUri,
    ]);
    expect(port.files.has(w)).toBe(false);
    expect(port.files.has(u)).toBe(true);
    expect(port.files.has(v)).toBe(true);

    port.listOriginals = listOriginals;
    const remove = port.delete;
    port.delete = async (uri) => {
      if (uri === u) throw new Error('delete failed');
      await remove(uri);
    };
    await expect(store.deleteUnnamedFiles([])).resolves.toEqual([u]);
    expect(port.files.has(u)).toBe(true);
    expect(port.files.has(v)).toBe(false);
  });

  test('deleteUnnamedFiles empties the thumbnails area whatever the names', async () => {
    const port = createFakeLibraryFilePort();
    const store = createLibraryFileStore({ port });
    const originalA = port.resolveOriginal('a.jpg');
    const thumbA = port.resolveThumbnail('a.jpg');
    const thumbB = port.resolveThumbnail('b.webp');
    for (const uri of [originalA, thumbA, thumbB]) port.files.set(uri, payload);

    await expect(store.deleteUnnamedFiles([
      originalA,
      `${port.thumbnailsRootUri}/b.webp`,
    ])).resolves.toEqual([]);

    expect(port.files.has(thumbA)).toBe(false);
    expect(port.files.has(thumbB)).toBe(false);
    expect(port.files.has(originalA)).toBe(true);

    // A thumbnail that cannot be deleted is reported; the rest still go.
    port.files.set(thumbA, payload);
    port.files.set(thumbB, payload);
    const realDelete = port.delete.bind(port);
    port.delete = async (uri: string) => {
      if (uri === thumbA) throw new Error('busy');
      await realDelete(uri);
    };
    await expect(store.deleteUnnamedFiles([originalA])).resolves.toEqual([thumbA]);
    expect(port.files.has(thumbA)).toBe(true);
    expect(port.files.has(thumbB)).toBe(false);
    port.delete = realDelete;

    // A failed listing deletes nothing in the area and reports its root.
    port.files.set(thumbA, payload);
    port.listThumbnails = async () => {
      throw new Error('listing failed');
    };
    await expect(store.deleteUnnamedFiles([originalA])).resolves.toEqual([
      port.thumbnailsRootUri,
    ]);
    expect(port.files.has(thumbA)).toBe(true);
  });

  test('N6-B2: deletePickerCacheUri and sweepPickerCacheDir clean only ImagePicker/temp/stream files, never originals or gallery URIs', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port });
    const pickerFile = `${port.pickerCacheRootUri}/pick-1.jpg`;
    const tempFile = `${port.tempRootUri}/temp-1.jpg`;
    const originalFile = `${port.originalsRootUri}/${digest}.jpg`;
    const galleryUri = 'content://media/external/images/media/42';
    port.files.set(pickerFile, payload);
    port.files.set(tempFile, payload);
    port.files.set(originalFile, payload);
    port.files.set(galleryUri, payload);

    await store.deletePickerCacheUri?.(galleryUri);
    await store.deletePickerCacheUri?.(originalFile);
    expect(port.files.has(galleryUri)).toBe(true);
    expect(port.files.has(originalFile)).toBe(true);

    await store.deletePickerCacheUri?.(pickerFile);
    expect(port.files.has(pickerFile)).toBe(false);

    // Put two more files in ImagePicker and sweep
    const orphan1 = `${port.pickerCacheRootUri}/orphan-1.jpg`;
    const orphan2 = `${port.pickerCacheRootUri}/orphan-2.png`;
    port.files.set(orphan1, payload);
    port.files.set(orphan2, payload);

    await expect(store.sweepPickerCacheDir?.()).resolves.toBe(2);
    expect(port.files.has(orphan1)).toBe(false);
    expect(port.files.has(orphan2)).toBe(false);
    expect(port.files.has(originalFile)).toBe(true);

    // adoptTempUri does not adopt an original in place; it copies to temp and leaves the original untouched
    const staged = await store.adoptTempUri(originalFile);
    expect(staged.uri).toMatch(/^file:\/\/\/cache\/library-temp\//u);
    await staged.discard();
    expect(port.files.has(originalFile)).toBe(true);
  });

  test('readTempPrefix reads only the requested prefix without calling readBytes', async () => {
    const port = fakeFileSystem();
    const store = createLibraryFileStore({ port });
    const tempUri = `${port.tempRootUri}/prefix.png`;
    port.files.set(tempUri, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    port.readBytesCalls.length = 0;

    const prefix = await store.readTempPrefix!(
      { uri: tempUri, byteSize: 8, async discard() {} },
      4,
    );
    expect(prefix).toEqual(Uint8Array.from([1, 2, 3, 4]));
    expect(port.readBytesCalls).toEqual([]);
  });
});
