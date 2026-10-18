import { DatabaseSync } from 'node:sqlite';
import { runInThisContext } from 'node:vm';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  CollectionServiceError,
  createCollectionFileRepository,
  type CollectionDownloadOptions,
  type CollectionFilePort,
  type CollectionFileRepository,
  type DownloadedCollectionFile,
} from '@/features/collection/file-repository';
import {
  createCollectionService as createCollectionServiceWithCoordinator,
} from '@/features/collection/collection-service';
import { createDataResetCoordinator } from '@/features/data-reset/data-reset-coordinator';
import { createImageRepository } from '@/features/images/image-repository';
import type { WaifuImage } from '@/features/waifu/types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

type CollectionServiceDependencies = Omit<
  Parameters<typeof createCollectionServiceWithCoordinator>[0],
  'coordinator'
>;

function createCollectionService(
  dependencies: CollectionServiceDependencies,
  coordinator = createDataResetCoordinator(),
) {
  return createCollectionServiceWithCoordinator({ ...dependencies, coordinator });
}

const candidate = (id: number, extension = '.webp'): WaifuImage => ({
  id,
  providerKey: 'waifu_im',
  providerItemId: String(id),
  canonicalSourceKey: null,
  perceptualHash: null,
  md5: null,
  remoteUrl: `https://cdn.example.com/${id}${extension}`,
  sourceUrl: null,
  artistName: null,
  artistUrl: null,
  width: 1200,
  height: 1800,
  byteSize: 100 + id,
  extension,
  dominantColor: '#aabbcc',
  isNsfw: false,
  isAnimated: false,
  tags: ['waifu'],
});

class MemoryFilePort implements CollectionFilePort {
  readonly rootUri = 'file:///documents/collection';
  readonly files = new Map<string, number>();
  readonly operations: string[] = [];
  readonly failedDeletes = new Set<string>();
  existsCalls = 0;
  downloadError: unknown = null;
  downloadErrors: unknown[] = [];
  strandPartialOnDownloadError = false;
  writePartialBeforeDownloadGate = false;
  downloadGate: Promise<void> | null = null;
  sizeError: unknown = null;
  shareError: unknown = null;
  exportError: unknown = null;
  shareGate: Promise<void> | null = null;
  removeFileOnShareError = false;
  removeFileOnExportError = false;
  sharingAvailable = true;
  photoPermissionGranted = true;
  deleteGate: Promise<void> | null = null;
  listGate: Promise<void> | null = null;

  resolve(name: string): string {
    return `${this.rootUri}/${name}`;
  }

  async ensureDirectory(): Promise<void> {
    this.operations.push('ensure-directory');
  }

  async exists(uri: string): Promise<boolean> {
    this.existsCalls += 1;
    return this.files.has(uri);
  }

  async download(
    remoteUrl: string,
    destinationUri: string,
    options?: CollectionDownloadOptions,
  ): Promise<void> {
    this.operations.push(`download:${remoteUrl}->${destinationUri}`);
    if (this.writePartialBeforeDownloadGate) this.files.set(destinationUri, 5);
    if (this.downloadGate) await this.downloadGate;
    if (this.downloadErrors.length > 0 || this.downloadError !== null) {
      const error = this.downloadErrors.length > 0
        ? this.downloadErrors.shift()
        : this.downloadError;
      this.downloadError = null;
      if (this.strandPartialOnDownloadError) {
        this.files.set(destinationUri, 5);
        this.failedDeletes.add(destinationUri);
      }
      throw error;
    }
    this.files.set(destinationUri, 42);
  }

  async move(sourceUri: string, destinationUri: string): Promise<void> {
    this.operations.push(`move:${sourceUri}->${destinationUri}`);
    const size = this.files.get(sourceUri);
    if (size === undefined) throw new Error('missing source');
    this.files.delete(sourceUri);
    this.files.set(destinationUri, size);
  }

  async delete(uri: string): Promise<void> {
    this.operations.push(`delete:${uri}`);
    if (this.deleteGate) await this.deleteGate;
    if (this.failedDeletes.has(uri)) throw new Error('delete failed');
    this.files.delete(uri);
  }

  async size(uri: string): Promise<number> {
    if (this.sizeError !== null) throw this.sizeError;
    return this.files.get(uri) ?? 0;
  }

  async directorySize(): Promise<number> {
    if (this.sizeError !== null) throw this.sizeError;
    let total = 0;
    for (const [uri, size] of this.files) if (uri.startsWith(`${this.rootUri}/`)) total += size;
    return total;
  }

  async list(): Promise<string[]> {
    if (this.listGate) await this.listGate;
    return [...this.files.keys()]
      .filter((uri) => uri.startsWith(`${this.rootUri}/`))
      .sort();
  }

  async isSharingAvailable(): Promise<boolean> {
    return this.sharingAvailable;
  }

  async share(uri: string): Promise<void> {
    this.operations.push(`share:${uri}`);
    if (this.shareGate) await this.shareGate;
    if (this.shareError !== null) {
      if (this.removeFileOnShareError) this.files.delete(uri);
      throw this.shareError;
    }
  }

  async requestPhotoPermission(): Promise<boolean> {
    return this.photoPermissionGranted;
  }

  async exportToPhotos(uri: string): Promise<void> {
    this.operations.push(`export:${uri}`);
    if (this.exportError !== null) {
      if (this.removeFileOnExportError) this.files.delete(uri);
      throw this.exportError;
    }
  }
}

function countingDatabase(
  port: SqlDatabasePort,
  statements: string[],
): SqlDatabasePort {
  return {
    exec(source) {
      statements.push(source);
      return port.exec(source);
    },
    run(source, params) {
      statements.push(source);
      return port.run(source, params);
    },
    getFirst(source, params) {
      statements.push(source);
      return port.getFirst(source, params);
    },
    getAll(source, params) {
      statements.push(source);
      return port.getAll(source, params);
    },
    transaction(task) {
      return port.transaction((inner) => task(countingDatabase(inner, statements)));
    },
  };
}

async function openRepository() {
  const nativeDatabase = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(nativeDatabase);
  await migrateDatabase(database);
  return {
    nativeDatabase,
    database,
    repository: createImageRepository(database),
  };
}

async function savePending(
  repository: ReturnType<typeof createImageRepository>,
  image: WaifuImage,
  timestamp = 100,
) {
  await repository.insertCandidates([image]);
  await repository.activateNext(timestamp);
  await repository.decide(image.id, 'saved', timestamp + 1);
  return (await repository.getById(image.id))!;
}

describe('CollectionFileRepository', () => {
  test('uses an allowlisted deterministic path and atomically moves a partial download', async () => {
    const port = new MemoryFilePort();
    const repository = createCollectionFileRepository(port);

    const downloaded = await repository.download(candidate(7, '.WEBP'));

    expect(downloaded).toEqual({
      uri: 'file:///documents/collection/7.webp',
      reused: false,
    });
    expect(port.operations).toEqual([
      'ensure-directory',
      'delete:file:///documents/collection/7.webp.partial',
      'download:https://cdn.example.com/7.WEBP->file:///documents/collection/7.webp.partial',
      'move:file:///documents/collection/7.webp.partial->file:///documents/collection/7.webp',
    ]);
    expect(port.files.has('file:///documents/collection/7.webp.partial')).toBe(false);
    expect(port.files.has(downloaded.uri)).toBe(true);
  });

  test('R8.28: the durable save sends the provider\'s required image headers', async () => {
    // The save downloads remoteUrl directly (not through expo-image), so it
    // needs the same Referer the render does or Gelbooru returns hotlink.php.
    const port = new MemoryFilePort();
    const download = jest.spyOn(port, 'download');
    const repository = createCollectionFileRepository(port);

    await repository.download({ ...candidate(7), providerKey: 'gelbooru' });

    expect(download).toHaveBeenCalledWith(
      'https://cdn.example.com/7.webp',
      'file:///documents/collection/7.webp.partial',
      expect.objectContaining({ headers: { Referer: 'https://gelbooru.com/' } }),
    );
  });

  test('R8.28: a headerless provider save passes no headers key at all', async () => {
    const port = new MemoryFilePort();
    const download = jest.spyOn(port, 'download');
    const repository = createCollectionFileRepository(port);

    await repository.download({ ...candidate(8), providerKey: 'danbooru' });

    const options = download.mock.calls[0][2];
    expect(options && 'headers' in options).toBe(false);
  });

  test('falls back to jpg, reuses a ready file, and treats missing deletion as success', async () => {
    const port = new MemoryFilePort();
    const repository = createCollectionFileRepository(port);
    const path = 'file:///documents/collection/8.jpg';
    port.files.set(path, 99);

    await expect(repository.download(candidate(8, '.avif'))).resolves.toEqual({
      uri: path,
      reused: true,
    });
    expect(port.operations).toEqual([
      'ensure-directory',
      'delete:file:///documents/collection/8.jpg.partial',
    ]);
    await expect(repository.deleteUri('file:///documents/collection/missing.jpg')).resolves.toBeUndefined();
  });

  test('wraps collection size failures as typed platform errors', async () => {
    const port = new MemoryFilePort();
    const repository = createCollectionFileRepository(port);
    port.sizeError = new Error('native size failure');

    await expect(repository.getCollectionBytes()).rejects.toMatchObject({
      name: 'CollectionServiceError',
      code: 'platform_unavailable',
      message: expect.any(String),
    });
  });

  test('wraps thrown share and export failures while preserving permission denial', async () => {
    const port = new MemoryFilePort();
    const repository = createCollectionFileRepository(port);
    const uri = 'file:///documents/collection/1.webp';
    port.files.set(uri, 42);

    port.shareError = new Error('native share failure');
    await expect(repository.share(uri)).rejects.toMatchObject({ code: 'share_failed' });
    port.shareError = null;
    port.photoPermissionGranted = false;
    await expect(repository.exportToPhotos(uri)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    port.photoPermissionGranted = true;
    port.exportError = new Error('native export failure');
    await expect(repository.exportToPhotos(uri)).rejects.toMatchObject({
      code: 'export_unavailable',
    });
  });

  test('reconciles partials and unreferenced finals while preserving saved-ready files', async () => {
    const port = new MemoryFilePort();
    const repository = createCollectionFileRepository(port);
    const ready = 'file:///documents/collection/1.webp';
    const orphan = 'file:///documents/collection/2.webp';
    const partial = 'file:///documents/collection/3.webp.partial';
    port.files.set(ready, 42);
    port.files.set(orphan, 42);
    port.files.set(partial, 5);

    await expect(repository.reconcile([ready])).resolves.toEqual({
      deleted: [orphan, partial],
      failed: [],
    });
    expect([...port.files.keys()]).toEqual([ready]);
  });

  test('K7 ㉓: sweep keeps every file of a protected image id and reports missing referenced finals', async () => {
    const port = new MemoryFilePort();
    const repository = createCollectionFileRepository(port);
    const ready = 'file:///documents/collection/1.webp';
    const gone = 'file:///documents/collection/4.webp';
    const claimedFinal = 'file:///documents/collection/2.webp';
    const claimedPartial = 'file:///documents/collection/2.webp.partial';
    const lookalike = 'file:///documents/collection/22.webp';
    port.files.set(ready, 42);
    port.files.set(claimedFinal, 42);
    port.files.set(claimedPartial, 5);
    port.files.set(lookalike, 42);

    const claims = new Set<number>();
    port.listGate = Promise.resolve().then(() => { claims.add(2); });

    await expect(repository.sweep([ready, gone], claims)).resolves.toEqual({
      deleted: [lookalike],
      failed: [],
      missing: [gone],
    });
    expect([...port.files.keys()].sort()).toEqual([ready, claimedFinal, claimedPartial].sort());
  });

  test('an abort during download\'s preparation leaves no unhandled rejection', async () => {
    // Jest hands a test a copy of `process` whose listeners never fire; Node
    // reports an unhandled rejection on the real one, which this reaches.
    const realProcess = runInThisContext('process') as NodeJS.Process;
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const port = new MemoryFilePort();
    const finalUri = 'file:///documents/collection/7.webp';
    const partialUri = `${finalUri}.partial`;
    let releaseExists = (): void => undefined;

    try {
      realProcess.on('unhandledRejection', recordUnhandled);
      const existsGate = new Promise<void>((resolve) => {
        releaseExists = resolve;
      });
      let signalExists!: () => void;
      const existsReached = new Promise<void>((resolve) => {
        signalExists = resolve;
      });
      const exists = port.exists.bind(port);
      let parked = false;
      port.exists = async (uri: string) => {
        if (!parked && uri === finalUri) {
          parked = true;
          signalExists();
          await existsGate;
        }
        return exists(uri);
      };
      // Like the Expo port, the transfer fails on an aborted signal; this one
      // leaves its partial behind for `download()` to clean up.
      let startedAborted = false;
      const download = port.download.bind(port);
      port.download = async (remoteUrl, destinationUri, options) => {
        if (options?.signal?.aborted) {
          startedAborted = true;
          port.files.set(destinationUri, 5);
          throw new Error('The transfer saw the aborted signal.');
        }
        return download(remoteUrl, destinationUri, options);
      };
      const controller = new AbortController();

      const pending = createCollectionFileRepository(port).download(
        candidate(7),
        { signal: controller.signal },
      );
      await existsReached;
      controller.abort();
      releaseExists();

      await expect(pending).rejects.toMatchObject({ code: 'download_failed' });
      // Node reports a rejection nobody handled once the turn's microtasks drain.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(startedAborted).toBe(true);
      expect(port.files.has(partialUri)).toBe(false);
    } finally {
      releaseExists();
      realProcess.off('unhandledRejection', recordUnhandled);
    }
  });
});

describe('CollectionService lifecycle', () => {
  // K7 cut 8 (audit ㊳): a completed save must issue the durable write and
  // nothing after it — no read to feed a notification.
  test('a completed save ends at its durable write with no read after it', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);
    await migrateDatabase(database);
    const statements: string[] = [];
    const counted = countingDatabase(database, statements);
    const repository = createImageRepository(counted);
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));
      statements.length = 0;

      await expect(service.retryDownload(1)).resolves.toMatchObject({
        status: 'ready',
      });

      const lastWrite = statements.findLastIndex((statement) => (
        /UPDATE images\s+SET download_state = 'ready'/u.test(statement)
      ));
      expect(lastWrite).toBeGreaterThanOrEqual(0);
      expect(statements.slice(lastWrite + 1)).toEqual([]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a download of a row with no size reports the file\'s size', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, { ...candidate(1), byteSize: 0 });

      await expect(service.retryDownload(1)).resolves.toMatchObject({ status: 'ready' });
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'ready',
        byteSize: 42,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a download whose size cannot be read still completes', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.sizeError = new Error('size unavailable');
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, { ...candidate(2), byteSize: 0 });

      await expect(service.retryDownload(2)).resolves.toMatchObject({ status: 'ready' });
      await expect(repository.getById(2)).resolves.toMatchObject({
        downloadState: 'ready',
        byteSize: 0,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('durably saves before returning a still-pending background download', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let releaseDownload!: () => void;
    port.downloadGate = new Promise((resolve) => {
      releaseDownload = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      clock: () => 200,
    });

    try {
      const saved = await service.saveCandidate(candidate(21));
      let backgroundSettled = false;
      void saved.backgroundDownload.finally(() => {
        backgroundSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(saved.image).toMatchObject({
        decision: 'saved',
        decidedAt: 200,
        downloadState: 'pending',
        localUri: null,
      });
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'pending',
      });
      expect(backgroundSettled).toBe(false);

      releaseDownload();
      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'ready',
        reused: false,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('drains a saved image background download before granting a backup lease', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const coordinator = createDataResetCoordinator();
    let releaseDownload!: () => void;
    port.downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    }, coordinator);

    try {
      const saved = await service.saveCandidate(candidate(22));
      let leaseSettled = false;
      const pendingLease = coordinator.beginReset().then((lease) => {
        leaseSettled = true;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(leaseSettled).toBe(false);

      releaseDownload();
      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'ready',
      });
      const lease = await pendingLease;
      lease.release();
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'ready',
      });
    } finally {
      releaseDownload();
      nativeDatabase.close();
    }
  });

  test('drains startup reconciliation before granting a restore lease', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const coordinator = createDataResetCoordinator();
    let releaseList!: () => void;
    port.listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    }, coordinator);

    try {
      const recovery = service.resumePendingDownloads();
      await new Promise((resolve) => setTimeout(resolve, 0));
      let leaseSettled = false;
      const pendingLease = coordinator.beginReset().then((lease) => {
        leaseSettled = true;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(leaseSettled).toBe(false);

      releaseList();
      await expect(recovery).resolves.toEqual([]);
      const lease = await pendingLease;
      lease.release();
    } finally {
      releaseList();
      nativeDatabase.close();
    }
  });

  test('fails a never-progressing retry after its stall windows and removes its partial', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadGate = new Promise(() => undefined);
    port.writePartialBeforeDownloadGate = true;
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      downloadStallMs: 5,
    });

    try {
      await savePending(repository, candidate(1));

      await expect(service.retryDownload(1)).resolves.toMatchObject({
        status: 'failed',
      });
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'failed',
        localUri: null,
      });
      expect(port.files.has(
        'file:///documents/collection/1.webp.partial',
      )).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('cancels and replaces a pending cross-source download when file metadata changes', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadGate = new Promise(() => undefined);
    port.writePartialBeforeDownloadGate = true;
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      downloadStallMs: 1_000,
    });
    const firstCandidate = {
      ...candidate(24, '.jpg'),
      canonicalSourceKey: 'shared:24',
    };
    const replacementCandidate = {
      ...candidate(240, '.png'),
      providerKey: 'nekos_api' as const,
      providerItemId: 'nekos-24',
      canonicalSourceKey: 'shared:24',
    };

    try {
      const first = await service.saveCandidate(firstCandidate);
      await new Promise((resolve) => setTimeout(resolve, 0));
      port.downloadGate = null;

      const replacement = await service.saveCandidate(replacementCandidate);

      await expect(first.backgroundDownload).resolves.toMatchObject({ status: 'stale' });
      await expect(replacement.backgroundDownload).resolves.toMatchObject({ status: 'ready' });
      await expect(repository.getById(first.image.id)).resolves.toMatchObject({
        remoteUrl: replacementCandidate.remoteUrl,
        extension: '.png',
        downloadState: 'ready',
        localUri: `file:///documents/collection/${first.image.id}.png`,
      });
      expect(port.operations.filter((operation) => operation.startsWith('download:')))
        .toHaveLength(2);
      expect(port.files.has(
        `file:///documents/collection/${first.image.id}.jpg.partial`,
      )).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('cancels a stuck attempt before repair starts a fresh bounded download', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadGate = new Promise(() => undefined);
    port.writePartialBeforeDownloadGate = true;
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      downloadStallMs: 1_000,
    });

    try {
      await savePending(repository, candidate(1));
      const stuck = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      port.downloadGate = null;

      const repair = service.repairDownload(1);

      await expect(stuck).resolves.toMatchObject({ status: 'failed' });
      await expect(repair).resolves.toMatchObject({ status: 'ready' });
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: 'file:///documents/collection/1.webp',
      });
      expect(port.files.has(
        'file:///documents/collection/1.webp.partial',
      )).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('keeps a failed search save in the collection for a later retry', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline'), new Error('offline')];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const saved = await service.saveCandidate(candidate(22));

      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'failed',
      });
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'failed',
        localUri: null,
        downloadError: 'download_failed',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('reuses an existing ready search save without downloading it again', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const first = await service.saveCandidate(candidate(23));
      await expect(first.backgroundDownload).resolves.toMatchObject({
        status: 'ready',
        reused: false,
      });

      const second = await service.saveCandidate(candidate(23));
      expect(second.image).toMatchObject({
        id: first.image.id,
        decision: 'saved',
        downloadState: 'ready',
      });
      await expect(second.backgroundDownload).resolves.toMatchObject({
        status: 'ready',
        reused: true,
      });
      expect(port.operations.filter((operation) => operation.startsWith('download:')))
        .toHaveLength(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('does not revive a durable search save when reset starts before its write finishes', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const guardedRepository = {
      ...repository,
      saveCandidate: jest.fn(async (...args: Parameters<typeof repository.saveCandidate>) => {
        markSaveStarted();
        await saveGate;
        return repository.saveCandidate(...args);
      }),
    };
    const service = createCollectionService({
      repository: guardedRepository,
      files: createCollectionFileRepository(port),
    });

    try {
      const save = service.saveCandidate(candidate(24));
      await saveStarted;
      const reset = service.deleteAllData();
      await new Promise((resolve) => setTimeout(resolve, 0));

      releaseSave();
      const saved = await save;
      await expect(saved.backgroundDownload).rejects.toMatchObject({
        code: 'operation_blocked',
      });
      await expect(reset).resolves.toMatchObject({ ok: true, remaining: [] });
      await expect(repository.listCollection()).resolves.toEqual([]);
      expect(port.files.size).toBe(0);
    } finally {
      nativeDatabase.close();
    }
  });

  test('rejects a search save queued during reset instead of replaying it after release', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const coordinator = createDataResetCoordinator();
    let releaseActiveMutation!: () => void;
    const activeMutationGate = new Promise<void>((resolve) => {
      releaseActiveMutation = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    }, coordinator);

    try {
      const activeMutation = coordinator.runMutation(() => activeMutationGate);
      const resetLease = coordinator.beginReset();
      const save = service.saveCandidate(candidate(25));

      releaseActiveMutation();
      await activeMutation;
      const lease = await resetLease;
      lease.release();

      await expect(save).rejects.toMatchObject({
        code: 'operation_blocked',
      });
      await expect(repository.listCollection()).resolves.toEqual([]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('rejects a download retry queued during reset instead of mutating restored data', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const coordinator = createDataResetCoordinator();
    let releaseActiveMutation!: () => void;
    const activeMutationGate = new Promise<void>((resolve) => {
      releaseActiveMutation = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    }, coordinator);

    try {
      await savePending(repository, candidate(1));
      const activeMutation = coordinator.runMutation(() => activeMutationGate);
      const resetLease = coordinator.beginReset();
      const retry = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(port.operations.filter((operation) => operation.startsWith('download:')))
        .toHaveLength(0);

      releaseActiveMutation();
      await activeMutation;
      const lease = await resetLease;
      lease.release();

      await expect(retry).rejects.toMatchObject({
        code: 'operation_blocked',
      });
      expect(port.files.size).toBe(0);
    } finally {
      releaseActiveMutation();
      nativeDatabase.close();
    }
  });

  test('retains a saved failure and retries it to ready without duplicating ready work', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const files = createCollectionFileRepository(port);
    const service = createCollectionService({
      repository,
      files,
      clock: () => 500,
    });

    try {
      await savePending(repository, candidate(1));
      port.downloadErrors = [new Error('offline internals'), new Error('offline internals')];

      await expect(service.retryDownload(1)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'download_failed' },
      });
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'failed',
        downloadError: 'download_failed',
      });

      await expect(service.retryDownload(1)).resolves.toEqual({
        status: 'ready',
        uri: 'file:///documents/collection/1.webp',
        reused: false,
      });
      const downloadCount = port.operations.filter((operation) => operation.startsWith('download:')).length;
      await expect(service.retryDownload(1)).resolves.toEqual({
        status: 'ready',
        uri: 'file:///documents/collection/1.webp',
        reused: true,
      });
      expect(port.operations.filter((operation) => operation.startsWith('download:'))).toHaveLength(
        downloadCount,
      );
    } finally {
      nativeDatabase.close();
    }
  });

  test('repairs a ready record whose private file is missing', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      clock: () => 500,
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      port.files.delete('file:///documents/collection/1.webp');

      await expect(service.retryDownload(1)).resolves.toEqual({
        status: 'ready',
        uri: 'file:///documents/collection/1.webp',
        reused: false,
      });
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'ready',
        localUri: 'file:///documents/collection/1.webp',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('force repairs a corrupt ready file even when the deterministic final exists', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      clock: () => 500,
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      const finalUri = 'file:///documents/collection/1.webp';
      const partialUri = `${finalUri}.partial`;
      port.files.set(finalUri, 1);
      port.files.set(partialUri, 1);
      port.operations.length = 0;

      await expect(service.repairDownload(1)).resolves.toEqual({
        status: 'ready',
        uri: finalUri,
        reused: false,
      });

      expect(port.operations).toEqual(expect.arrayContaining([
        `delete:${finalUri}`,
        `delete:${partialUri}`,
        `download:https://cdn.example.com/1.webp->${partialUri}`,
        `move:${partialUri}->${finalUri}`,
      ]));
      expect(port.operations.indexOf(`delete:${finalUri}`)).toBeLessThan(
        port.operations.indexOf(`download:https://cdn.example.com/1.webp->${partialUri}`),
      );
      expect(port.files.get(finalUri)).toBe(42);
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'ready',
        localUri: finalUri,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('resume detects and repairs missing ready files as well as pending downloads', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      clock: () => 500,
    });

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      await repository.activateNext(100);
      await repository.decide(1, 'saved', 101);
      await service.retryDownload(1);
      port.files.delete('file:///documents/collection/1.webp');
      await repository.activateNext(102);
      await repository.decide(2, 'saved', 103);

      await expect(service.resumePendingDownloads()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'ready', uri: expect.stringContaining('/1.webp') }),
          expect.objectContaining({ status: 'ready', uri: expect.stringContaining('/2.webp') }),
        ]),
      );
    } finally {
      nativeDatabase.close();
    }
  });

  test('a fresh service retries private orphan cleanup after an earlier resume delete failure', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const orphan = 'file:///documents/collection/91.webp';
    const partial = 'file:///documents/collection/92.webp.partial';
    port.files.set(orphan, 42);
    port.files.set(partial, 5);
    port.failedDeletes.add(orphan);
    port.failedDeletes.add(partial);

    try {
      const first = createCollectionService({
        repository,
        files: createCollectionFileRepository(port),
      });
      await expect(first.resumePendingDownloads()).resolves.toEqual([]);
      expect([...port.files.keys()].sort()).toEqual([orphan, partial]);

      port.failedDeletes.clear();
      const restarted = createCollectionService({
        repository,
        files: createCollectionFileRepository(port),
      });
      await expect(restarted.resumePendingDownloads()).resolves.toEqual([]);
      expect(port.files.size).toBe(0);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a failed saved download cannot strand its partial across service restart', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const partial = 'file:///documents/collection/1.webp.partial';
    const first = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));
      port.downloadError = new CollectionServiceError(
        'platform_unavailable',
        'offline after partial write',
      );
      port.strandPartialOnDownloadError = true;

      await expect(first.retryDownload(1)).resolves.toMatchObject({ status: 'failed' });
      expect(port.files.has(partial)).toBe(true);
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'failed',
      });

      port.failedDeletes.clear();
      const restarted = createCollectionService({
        repository,
        files: createCollectionFileRepository(port),
      });
      // Board #5 §6: the strand is gone either way, and the transient failure
      // the strand came from is now retried by the same sweep.
      await expect(restarted.resumePendingDownloads()).resolves.toEqual([
        { status: 'ready', uri: 'file:///documents/collection/1.webp', reused: false },
      ]);
      expect(port.files.has(partial)).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('deletes a saved file to dismissed and only returns saved rows to discovery', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      await expect(service.deleteSaved(1)).resolves.toMatchObject({
        id: 1,
        decision: 'dismissed',
      });
      expect(port.files.has('file:///documents/collection/1.webp')).toBe(false);
      await expect(service.returnToDiscovery(1)).rejects.toMatchObject({
        code: 'not_saved',
      });

      await savePending(repository, candidate(2), 200);
      await service.retryDownload(2);
      await expect(service.returnToDiscovery(2)).resolves.toMatchObject({ id: 2 });
      await expect(repository.getById(2)).resolves.toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });

  test('shares and exports only ready local files with typed user-safe errors', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));
      await expect(service.share(1)).rejects.toMatchObject({ code: 'not_ready' });
      await service.retryDownload(1);

      port.sharingAvailable = false;
      await expect(service.share(1)).rejects.toEqual(
        expect.objectContaining({
          name: 'CollectionServiceError',
          code: 'share_unavailable',
          message: expect.any(String),
        }),
      );
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: 'file:///documents/collection/1.webp',
      });
      port.sharingAvailable = true;
      await service.share(1);
      expect(port.operations).toContain('share:file:///documents/collection/1.webp');

      port.photoPermissionGranted = false;
      await expect(service.exportToPhotos(1)).rejects.toMatchObject({
        code: 'permission_denied',
      });
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: 'file:///documents/collection/1.webp',
      });
      port.photoPermissionGranted = true;
      await service.exportToPhotos(1);
      expect(port.operations).toContain('export:file:///documents/collection/1.webp');
    } finally {
      nativeDatabase.close();
    }
  });

  test('share and export repair a ready row immediately when its file is missing', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    const markMissing = jest.spyOn(repository, 'markFileMissing');
    const uri = 'file:///documents/collection/1.webp';

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      port.files.delete(uri);

      await expect(service.share(1)).rejects.toMatchObject({ code: 'file_missing' });
      expect(markMissing).toHaveBeenLastCalledWith(1, 'file_missing');
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'failed',
        localUri: null,
      });

      await service.retryDownload(1);
      port.files.delete(uri);
      await expect(service.exportToPhotos(1)).rejects.toMatchObject({ code: 'file_missing' });
      expect(markMissing).toHaveBeenCalledTimes(2);
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'failed',
        localUri: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('repairs a ready row when a native share or export failure removes its file', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    const uri = 'file:///documents/collection/1.webp';

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      port.shareError = new Error('native share failure');
      port.removeFileOnShareError = true;

      await expect(service.share(1)).rejects.toMatchObject({ code: 'share_failed' });
      expect(port.files.has(uri)).toBe(false);
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'failed',
        localUri: null,
      });

      port.shareError = null;
      await service.retryDownload(1);
      port.exportError = new Error('native export failure');
      port.removeFileOnExportError = true;

      await expect(service.exportToPhotos(1)).rejects.toMatchObject({
        code: 'export_unavailable',
      });
      expect(port.files.has(uri)).toBe(false);
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'failed',
        localUri: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('drains an in-flight share before reset deletes collection state', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let releaseShare!: () => void;
    port.shareGate = new Promise<void>((resolve) => {
      releaseShare = resolve;
    });
    const settings = { reset: jest.fn(async () => undefined) };
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      settings,
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      const share = service.share(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const reset = service.deleteAllData();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(settings.reset).not.toHaveBeenCalled();
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'ready',
      });

      releaseShare();
      await expect(share).resolves.toBeUndefined();
      await expect(reset).resolves.toMatchObject({ ok: true, remaining: [] });
      await expect(repository.getById(1)).resolves.toBeNull();
    } finally {
      releaseShare();
      nativeDatabase.close();
    }
  });

  test('drains an in-flight destructive action before granting a reset lease', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const coordinator = createDataResetCoordinator();
    let releaseDelete!: () => void;
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    }, coordinator);

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      port.deleteGate = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const deletion = service.deleteSaved(1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      let resetSettled = false;
      const pendingLease = coordinator.beginReset().then((lease) => {
        resetSettled = true;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resetSettled).toBe(false);

      releaseDelete();
      await expect(deletion).resolves.toMatchObject({ id: 1 });
      const lease = await pendingLease;
      lease.release();
    } finally {
      releaseDelete();
      nativeDatabase.close();
    }
  });

  test('rejects a destructive action queued during reset instead of replaying it', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const coordinator = createDataResetCoordinator();
    let releaseActiveMutation!: () => void;
    const activeMutationGate = new Promise<void>((resolve) => {
      releaseActiveMutation = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    }, coordinator);

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      const activeMutation = coordinator.runMutation(() => activeMutationGate);
      const pendingLease = coordinator.beginReset();
      const deletion = service.deleteSaved(1);

      releaseActiveMutation();
      await activeMutation;
      const lease = await pendingLease;
      lease.release();
      await expect(deletion).rejects.toMatchObject({
        code: 'operation_blocked',
      });
      await expect(repository.getById(1)).resolves.toMatchObject({ id: 1 });
    } finally {
      releaseActiveMutation();
      nativeDatabase.close();
    }
  });

  test('a missing share file reports database failure when row repair fails', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const files = createCollectionFileRepository(port);
    const initial = createCollectionService({ repository, files });

    try {
      await savePending(repository, candidate(1));
      await initial.retryDownload(1);
      port.files.clear();
      const failing = createCollectionService({
        repository: {
          ...repository,
          markFileMissing: jest.fn(async () => {
            throw new Error('database unavailable');
          }),
        },
        files,
      });

      await expect(failing.share(1)).rejects.toMatchObject({ code: 'database_failed' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('reports actual collection bytes and resumes every pending save', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      libraryBytes: async () => 900,
    });

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      await repository.activateNext(100);
      await repository.decide(1, 'saved', 101);
      await repository.activateNext(102);
      await repository.decide(2, 'saved', 103);

      await expect(service.resumePendingDownloads()).resolves.toEqual([
        expect.objectContaining({ status: 'ready' }),
        expect.objectContaining({ status: 'ready' }),
      ]);
      port.files.set('file:///documents/collection/orphan.partial', 16);
      await expect(service.getCollectionBytes()).resolves.toBe(1000);
    } finally {
      nativeDatabase.close();
    }
  });

  test('preserves an active partial while resume waits for the single-flight download', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let releaseDownload!: () => void;
    port.writePartialBeforeDownloadGate = true;
    port.downloadGate = new Promise((resolve) => {
      releaseDownload = resolve;
    });
    const files = createCollectionFileRepository(port);
    const service = createCollectionService({ repository, files });

    try {
      await savePending(repository, candidate(1));
      const partialUri = files.partialPathFor(candidate(1));
      const partialDelete = `delete:${partialUri}`;
      const download = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(port.files.has(partialUri)).toBe(true);
      expect(port.operations.filter((operation) => operation === partialDelete)).toHaveLength(1);

      const resume = service.resumePendingDownloads();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(service.retryDownload(1)).toBe(download);
      expect(port.files.has(partialUri)).toBe(true);
      expect(port.operations.filter((operation) => operation === partialDelete)).toHaveLength(1);

      releaseDownload();
      await expect(download).resolves.toMatchObject({ status: 'ready' });
      await expect(resume).resolves.toEqual([
        expect.objectContaining({ status: 'ready' }),
      ]);
      expect(port.operations.filter((operation) => operation.startsWith('download:'))).toHaveLength(1);
      expect(port.files.has(files.pathFor(candidate(1)))).toBe(true);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a resume queued during reset becomes stale and does not block a later retry', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const coordinator = createDataResetCoordinator();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      downloadStallMs: 25,
    }, coordinator);

    try {
      await savePending(repository, candidate(1));
      let releaseActiveMutation!: () => void;
      const activeMutationGate = new Promise<void>((resolve) => {
        releaseActiveMutation = resolve;
      });
      const activeMutation = coordinator.runMutation(() => activeMutationGate);
      const pendingLease = coordinator.beginReset();
      const resume = service.resumePendingDownloads();

      releaseActiveMutation();
      await activeMutation;
      const lease = await pendingLease;
      lease.release();

      await expect(resume).rejects.toMatchObject({
        code: 'operation_blocked',
      });
      await expect(service.retryDownload(1)).resolves.toMatchObject({
        status: 'ready',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('attempts database and settings after a partial file reset and reports only what remains', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const settings = { reset: jest.fn(async () => undefined) };
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      settings,
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      const path = 'file:///documents/collection/1.webp';
      port.failedDeletes.add(path);

      await expect(service.deleteAllData()).resolves.toEqual({
        ok: false,
        files: {
          deleted: [],
          failed: [{ uri: path, error: { code: 'delete_failed', message: expect.any(String) } }],
        },
        database: { status: 'deleted', deletedRows: 1, error: null },
        settings: { status: 'deleted', error: null },
        library: { status: 'skipped', cloud: 'skipped', disconnected: false, error: null },
        remaining: ['files'],
      });
      await expect(repository.getById(1)).resolves.toBeNull();
      expect(settings.reset).toHaveBeenCalledTimes(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('reports database failure after file deletion and still attempts settings', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const settings = { reset: jest.fn(async () => undefined) };
    const databaseError = new Error('database delete failed');
    const failingRepository = {
      ...repository,
      deleteAll: jest.fn(async () => {
        throw databaseError;
      }),
    };
    const service = createCollectionService({
      repository: failingRepository,
      files: createCollectionFileRepository(port),
      settings,
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);

      await expect(service.deleteAllData()).resolves.toMatchObject({
        ok: false,
        files: { failed: [] },
        database: { status: 'failed', error: { code: 'database_failed' } },
        settings: { status: 'deleted', error: null },
        remaining: ['database'],
      });
      expect(port.files.size).toBe(0);
      expect(settings.reset).toHaveBeenCalledTimes(1);
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'saved' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('performs a final private-file sweep after settings before releasing reset', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const lateUri = 'file:///documents/collection/late.webp';
    const settings = {
      reset: jest.fn(async () => {
        port.files.set(lateUri, 7);
      }),
    };
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      settings,
    });

    try {
      await expect(service.deleteAllData()).resolves.toMatchObject({
        ok: true,
        files: { failed: [] },
        remaining: [],
      });
      expect(port.files.has(lateUri)).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('reports every still-existing queued cleanup URI in reset file failures', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const legacyUri = 'file:///legacy/1.webp';
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const pending = await savePending(repository, candidate(1));
      port.files.set(legacyUri, 42);
      port.failedDeletes.add(legacyUri);
      await service.revertPendingSave({ ...pending, localUri: legacyUri });

      await expect(service.deleteAllData()).resolves.toEqual({
        ok: false,
        files: {
          deleted: [],
          failed: [{
            uri: legacyUri,
            error: { code: 'delete_failed', message: expect.any(String) },
          }],
        },
        database: { status: 'deleted', deletedRows: 1, error: null },
        settings: { status: 'skipped', error: null },
        library: { status: 'skipped', cloud: 'skipped', disconnected: false, error: null },
        remaining: ['files'],
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('does not report a queued cleanup URI that no longer exists', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const legacyUri = 'file:///legacy/1.webp';
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const pending = await savePending(repository, candidate(1));
      port.files.set(legacyUri, 42);
      port.failedDeletes.add(legacyUri);
      await service.revertPendingSave({ ...pending, localUri: legacyUri });
      port.files.delete(legacyUri);

      await expect(service.deleteAllData()).resolves.toMatchObject({
        ok: true,
        files: { failed: [] },
        remaining: [],
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('cancels a never-settling download before deleting its saved row', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadGate = new Promise(() => undefined);
    port.writePartialBeforeDownloadGate = true;
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));
      const download = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      let deletionSettled = false;
      const deletion = service.deleteSaved(1).finally(() => {
        deletionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(deletionSettled).toBe(true);
      await expect(download).resolves.toMatchObject({ status: 'failed' });
      await expect(deletion).resolves.toMatchObject({ decision: 'dismissed' });
      expect(port.files.size).toBe(0);
    } finally {
      nativeDatabase.close();
    }
  });

  test('global reset cancels never-settling downloads before deleting every stage', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadGate = new Promise(() => undefined);
    port.writePartialBeforeDownloadGate = true;
    const settings = { reset: jest.fn(async () => undefined) };
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      settings,
    });

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      await repository.activateNext(100);
      await repository.decide(1, 'saved', 101);
      await repository.activateNext(102);
      await repository.decide(2, 'saved', 103);
      const download = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const reset = service.deleteAllData();
      await expect(service.retryDownload(2)).rejects.toMatchObject({
        code: 'operation_blocked',
      });

      await expect(download).resolves.toMatchObject({ status: 'failed' });
      await expect(reset).resolves.toMatchObject({ ok: true, remaining: [] });
      expect(port.files.size).toBe(0);
      await expect(repository.listCollection()).resolves.toEqual([]);
      expect(settings.reset).toHaveBeenCalledTimes(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('types a per-image database transition failure after deleting the file', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const failingRepository = {
      ...repository,
      deleteFromCollection: jest.fn(async () => {
        throw new Error('database transition failed');
      }),
    };
    const service = createCollectionService({
      repository: failingRepository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);

      await expect(service.deleteSaved(1)).rejects.toMatchObject({
        code: 'database_failed',
      });
      expect(port.files.size).toBe(0);
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'failed',
        localUri: null,
        downloadError: 'file_missing',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('cleans a downloaded final and throws typed database failure when ready marking throws', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const failingRepository = {
      ...repository,
      markDownloadReady: jest.fn(async () => {
        throw new Error('ready write failed');
      }),
    };
    const service = createCollectionService({
      repository: failingRepository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));

      await expect(service.retryDownload(1)).rejects.toMatchObject({
        code: 'database_failed',
      });
      expect(port.files.size).toBe(0);
    } finally {
      nativeDatabase.close();
    }
  });

  test('throws typed database failure when failed-download marking throws', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline'), new Error('offline')];
    const failingRepository = {
      ...repository,
      markDownloadFailed: jest.fn(async () => {
        throw new Error('failed write failed');
      }),
    };
    const service = createCollectionService({
      repository: failingRepository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));
      await expect(service.retryDownload(1)).rejects.toMatchObject({
        code: 'database_failed',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('K6-5 A: a late download after undo keeps its file until revert reclaims it', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let releaseDownload!: () => void;
    port.downloadGate = new Promise((resolve) => {
      releaseDownload = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const pending = await savePending(repository, candidate(1));
      const download = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await repository.rewindDecision(1, { decision: 'saved', decidedAt: pending.decidedAt! });
      releaseDownload();

      await expect(download).resolves.toEqual({ status: 'stale' });
      // K6-5 A: a superseded attempt has no authority over the id-derived path,
      // so it deletes nothing. `revertPendingSave` — what the real undo path in
      // `discovery-service` calls — is what reclaims the file.
      expect(port.files.has('file:///documents/collection/1.webp')).toBe(true);
      expect(port.files.has('file:///documents/collection/1.webp.partial')).toBe(false);

      port.files.set('file:///documents/collection/1.webp.partial', 5);
      await service.revertPendingSave(pending);
      expect(port.files.has('file:///documents/collection/1.webp')).toBe(false);
      expect(port.files.has('file:///documents/collection/1.webp.partial')).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('never leaks undo cleanup errors and retries queued cleanup during resume', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let releaseDownload!: () => void;
    port.downloadGate = new Promise((resolve) => {
      releaseDownload = resolve;
    });
    const finalUri = 'file:///documents/collection/1.webp';
    port.failedDeletes.add(finalUri);
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const pending = await savePending(repository, candidate(1));
      const download = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await repository.rewindDecision(1, { decision: 'saved', decidedAt: pending.decidedAt! });
      releaseDownload();

      await expect(download).resolves.toEqual({ status: 'stale' });
      expect(port.files.has(finalUri)).toBe(true);
      // The undo path owns the cleanup (K6-5 A), and its delete fails here: the
      // URI must stay queued without the call rejecting.
      await expect(service.revertPendingSave(pending)).resolves.toBeUndefined();
      expect(port.files.has(finalUri)).toBe(true);
      port.failedDeletes.clear();
      await expect(service.resumePendingDownloads()).resolves.toEqual([]);
      expect(port.files.has(finalUri)).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('queues undo cleanup failures without rejecting and retries them during delete-all', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const finalUri = 'file:///documents/collection/1.webp';
    const settings = { reset: jest.fn(async () => undefined) };
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      settings,
    });

    try {
      const pending = await savePending(repository, candidate(1));
      port.files.set(finalUri, 42);
      port.failedDeletes.add(finalUri);

      await expect(service.revertPendingSave(pending)).resolves.toBeUndefined();
      expect(port.files.has(finalUri)).toBe(true);
      port.failedDeletes.clear();
      await expect(service.deleteAllData()).resolves.toMatchObject({
        ok: true,
        remaining: [],
      });
      expect(port.files.size).toBe(0);
    } finally {
      nativeDatabase.close();
    }
  });

  test('uses typed errors rather than raw platform failures', () => {
    const error = new CollectionServiceError('platform_unavailable', 'This action is unavailable.');
    expect(error).toMatchObject({
      name: 'CollectionServiceError',
      code: 'platform_unavailable',
      message: 'This action is unavailable.',
    });
  });

  test('notifies once after a download becomes durable and never on failure', async () => {
    const events: { imageId: number; localUri: string }[] = [];
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const firstCandidate = candidate(1);
    const secondCandidate = candidate(2);
    const downloadedUri = 'file:///documents/collection/1.webp';
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      onOriginalReady: (event) => {
        events.push(event);
      },
    });

    try {
      const saved = await service.saveCandidate(firstCandidate);
      await saved.backgroundDownload;

      expect(events).toEqual([
        { imageId: saved.image.id, localUri: downloadedUri },
      ]);

      port.downloadErrors = [new Error('offline'), new Error('offline')];
      const failed = await service.saveCandidate(secondCandidate);
      await failed.backgroundDownload;

      expect(events).toHaveLength(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('rejects an adult candidate before persistence in the Store distribution', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(new MemoryFilePort()),
      allowsAdultContent: false,
    });

    try {
      await expect(service.saveCandidate({
        ...candidate(77),
        contentRating: 'explicit',
        isNsfw: true,
      })).rejects.toMatchObject({
        code: 'operation_blocked',
      });
      await expect(repository.listCollection()).resolves.toEqual([]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('K7 ㉓: a save made while the resume sweep is still listing starts downloading at once', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let releaseList!: () => void;
    port.listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await repository.insertCandidates([candidate(1)]);
      await repository.activateNext(100);
      const resume = service.resumePendingDownloads();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const { backgroundDownload } = await service.saveCandidate(candidate(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Today this is [] — the download is parked behind the sweep's barrier.
      expect(port.operations.filter((op) => op.startsWith('download:'))).toHaveLength(1);

      releaseList();
      await expect(backgroundDownload).resolves.toMatchObject({ status: 'ready' });
      await resume;
    } finally {
      releaseList();
      nativeDatabase.close();
    }
  });

  test('K7 ㉓: the sweep never deletes the partial of a download that began after the sweep started', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let releaseList!: () => void;
    port.listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let releaseDownload!: () => void;
    port.writePartialBeforeDownloadGate = true;
    port.downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const files = createCollectionFileRepository(port);
    const service = createCollectionService({ repository, files });

    try {
      await repository.insertCandidates([candidate(1)]);
      await repository.activateNext(100);
      const resume = service.resumePendingDownloads();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const { backgroundDownload } = await service.saveCandidate(candidate(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const partialUri = files.partialPathFor(candidate(1));
      expect(port.files.has(partialUri)).toBe(true);
      const partialDelete = `delete:${partialUri}`;
      const deletesBeforeSweep = port.operations.filter((op) => op === partialDelete).length;

      releaseList();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The sweep listed the directory with the partial in it and must have left it alone.
      expect(port.files.has(partialUri)).toBe(true);
      expect(port.operations.filter((op) => op === partialDelete)).toHaveLength(deletesBeforeSweep);

      releaseDownload();
      await expect(backgroundDownload).resolves.toMatchObject({ status: 'ready' });
      await resume;
      expect(port.files.has(files.pathFor(candidate(1)))).toBe(true);
    } finally {
      releaseList();
      releaseDownload();
      nativeDatabase.close();
    }
  });

  test('K7 ㉓: the sweep finds missing files from the directory listing, not one stat per image', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await repository.insertCandidates([candidate(1), candidate(2), candidate(3)]);
      for (const [id, at] of [[1, 100], [2, 102], [3, 104]] as const) {
        await repository.activateNext(at);
        await repository.decide(id, 'saved', at + 1);
        await service.retryDownload(id);
      }
      port.files.delete('file:///documents/collection/2.webp');
      port.existsCalls = 0;

      const results = await service.resumePendingDownloads();

      expect(results).toEqual([expect.objectContaining({ status: 'ready', uri: expect.stringContaining('/2.webp') })]);
      // Today: 3 (one `exists` per ready row) + the repair path's own 2 (requireSaved
      // check + download's final-exists check). After: only the repair path's 2.
      expect(port.existsCalls).toBeLessThanOrEqual(2);
      expect(port.files.has('file:///documents/collection/2.webp')).toBe(true);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('board #27: a saved row leaving the collection (spec §5.4)', () => {
  test('a saved row leaving the collection is handed to the library after it has left', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const seen: string[] = [];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      onSavedRowRemoved: async (imageId) => {
        seen.push(`${imageId}:${(await repository.getById(imageId))?.decision ?? 'gone'}`);
      },
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      await service.deleteSaved(1);
      await savePending(repository, candidate(2), 200);
      await service.retryDownload(2);
      await service.returnToDiscovery(2);
      await expect(service.deleteSaved(1)).rejects.toMatchObject({ code: 'not_saved' });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toEqual(['1:dismissed', '2:gone']);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('K2 mirrored rows', () => {
  test('resumePendingDownloads never fetches a mirrored row from the provider', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    try {
      // one ordinary pending row (must download), one mirrored row (must not)
      await repository.insertCandidates([candidate(1)]);
      await repository.activateNext(100);
      await repository.decide(1, 'saved', 101);
      const mirrored = await repository.saveMirroredCandidate(
        { ...candidate(2), id: undefined } as never,
        200,
      );

      const results = await service.resumePendingDownloads();

      expect(results).toEqual([expect.objectContaining({ status: 'ready', uri: expect.stringContaining('/1.webp') })]);
      expect(port.operations.filter((op) => op.startsWith('download:'))).toEqual([
        'download:https://cdn.example.com/1.webp->file:///documents/collection/1.webp.partial',
      ]);
      await expect(repository.getById(mirrored.id)).resolves.toMatchObject({
        downloadState: 'mirrored',
        localUri: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('shareFile and exportFile hand the given uri straight to the file port', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    // K2: shareFile/exportFile skip the images-row `requireReady` lookup but
    // still go through the file repository's existence check (same contract
    // `share`/`exportToPhotos` use for collection files) — the library
    // resolver is expected to have materialized this uri before offering it.
    port.files.set('file:///library/originals/abc.jpg', 42);
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    try {
      await service.shareFile('file:///library/originals/abc.jpg');
      await service.exportFile('file:///library/originals/abc.jpg');
      expect(port.operations).toEqual([
        'share:file:///library/originals/abc.jpg',
        'export:file:///library/originals/abc.jpg',
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('K2b: repairDownload on a mirrored row reclaims it and downloads from the provider', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({ repository, files: createCollectionFileRepository(port) });
    try {
      const m = await repository.saveMirroredCandidate({ ...candidate(5), id: undefined } as never, 100);
      const result = await service.repairDownload(m.id);
      expect(result).toEqual(expect.objectContaining({ status: 'ready', uri: expect.stringContaining(`/${m.id}.webp`) }));
      expect(port.operations.filter((op) => op.startsWith('download:'))).toHaveLength(1);
      await expect(repository.getById(m.id)).resolves.toMatchObject({ downloadState: 'ready' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('K2c: repairDownload reports stale when the mirrored row changed underneath the reclaim', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    // Race stand-in: the row reads as mirrored at requireSaved, but by the time
    // the reclaim UPDATE runs it no longer matches (0 changes → false).
    const racing = { ...repository, reclaimMirroredForDownload: jest.fn(async () => false) };
    const service = createCollectionService({ repository: racing, files: createCollectionFileRepository(port) });
    try {
      const m = await repository.saveMirroredCandidate({ ...candidate(8), id: undefined } as never, 100);
      await expect(service.repairDownload(m.id)).resolves.toEqual({ status: 'stale' });
      expect(port.operations.filter((op) => op.startsWith('download:'))).toHaveLength(0);
      await expect(repository.getById(m.id)).resolves.toMatchObject({ downloadState: 'mirrored' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('K2b discriminator: retryDownload (not an explicit repair) still refuses a mirrored row', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({ repository, files: createCollectionFileRepository(port) });
    try {
      const m = await repository.saveMirroredCandidate({ ...candidate(6), id: undefined } as never, 100);
      await expect(service.retryDownload(m.id)).rejects.toMatchObject({ code: 'not_ready' });
      expect(port.operations.filter((op) => op.startsWith('download:'))).toHaveLength(0);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('K6-4b bounded download concurrency', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  // A file repository whose `download` never resolves on its own: each call
  // parks a deferred keyed by imageId so a test can prove exactly how many
  // provider downloads run at once and hand-release them one at a time.
  function makeControlledFiles(port: MemoryFilePort) {
    const base = createCollectionFileRepository(port);
    const pending = new Map<
      number,
      { resolve: () => void; reject: (error: unknown) => void }
    >();
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    const download = jest.fn(
      async (
        image: Parameters<CollectionFileRepository['download']>[0],
        options?: CollectionDownloadOptions,
      ): Promise<DownloadedCollectionFile> => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(image.id);
            try {
          return await new Promise<DownloadedCollectionFile>((resolve, reject) => {
            pending.set(image.id, {
              resolve: () => resolve({ uri: base.pathFor(image), reused: false }),
              reject,
            });
          });
        } finally {
          active -= 1;
          pending.delete(image.id);
        }
      },
    );

    return {
      files: { ...base, download } as CollectionFileRepository,
      started,
      get inFlight() {
        return active;
      },
      get peak() {
        return peak;
      },
      pendingIds() {
        return [...pending.keys()];
      },
      resolveOne(imageId: number) {
        const waiter = pending.get(imageId);
        if (!waiter) throw new Error(`no in-flight download for ${imageId}`);
        waiter.resolve();
      },
      rejectOne(imageId: number, error: unknown) {
        const waiter = pending.get(imageId);
        if (!waiter) throw new Error(`no in-flight download for ${imageId}`);
        waiter.reject(error);
      },
    };
  }

  type ControlledFiles = ReturnType<typeof makeControlledFiles>;

  async function drain(
    controlled: ControlledFiles,
    backgrounds: Promise<unknown>[],
  ): Promise<void> {
    // Release everything still parked so no download touches the database after
    // the test closes it. Queued downloads start as slots free, so loop.
    for (let i = 0; i < 50; i += 1) {
      for (const id of controlled.pendingIds()) controlled.resolveOne(id);
      await flush();
      if (controlled.pendingIds().length === 0) {
        await flush();
        if (controlled.pendingIds().length === 0) break;
      }
    }
    await Promise.allSettled(backgrounds);
  }

  test('caps concurrent provider downloads at the injected downloadConcurrency', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const controlled = makeControlledFiles(port);
    const service = createCollectionService({
      repository,
      files: controlled.files,
      downloadConcurrency: 3,
    });
    const backgrounds: Promise<unknown>[] = [];

    try {
      for (let id = 1; id <= 10; id += 1) {
        const saved = await service.saveCandidate(candidate(id));
        backgrounds.push(saved.backgroundDownload);
        saved.backgroundDownload.catch(() => undefined);
      }
      await flush();
      await flush();

      // Only the first three saturate the pipe; the rest wait for a slot.
      expect(controlled.inFlight).toBe(3);
      expect(controlled.peak).toBe(3);
      expect(controlled.started).toHaveLength(3);

      // Finishing one download hands its slot to exactly one queued download.
      controlled.resolveOne(controlled.started[0]!);
      await flush();
      await flush();
      expect(controlled.inFlight).toBe(3);
      expect(controlled.peak).toBe(3);
      expect(controlled.started).toHaveLength(4);
    } finally {
      await drain(controlled, backgrounds);
      nativeDatabase.close();
    }
  });

  test('a download that throws after acquiring still releases its slot', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const controlled = makeControlledFiles(port);
    // Force the failure path to throw out of the operation (rather than resolve
    // to a 'failed' result), so only a finally-scoped release keeps the slot
    // from leaking.
    const throwingRepository = {
      ...repository,
      markDownloadFailed: jest.fn(async () => {
        throw new Error('failed-write crashed');
      }),
    };
    const service = createCollectionService({
      repository: throwingRepository,
      files: controlled.files,
      downloadConcurrency: 2,
    });
    const backgrounds: Promise<unknown>[] = [];

    try {
      for (let id = 1; id <= 3; id += 1) {
        const saved = await service.saveCandidate(candidate(id));
        backgrounds.push(saved.backgroundDownload);
        saved.backgroundDownload.catch(() => undefined);
      }
      await flush();
      await flush();
      expect(controlled.started).toHaveLength(2);
      const queued = [1, 2, 3].filter((id) => !controlled.started.includes(id));
      expect(queued).toHaveLength(1);

      // This in-flight download rejects; markDownloadFailed then throws, so the
      // operation rejects. The slot must still free up for the queued download.
      controlled.rejectOne(
        controlled.started[0]!,
        new CollectionServiceError('download_failed', 'gone', { httpStatus: 404 }),
      );
      await flush();
      await flush();

      expect(controlled.started).toContain(queued[0]);
      expect(controlled.started).toHaveLength(3);
    } finally {
      await drain(controlled, backgrounds);
      nativeDatabase.close();
    }
  });

  test('a download aborted while queued frees no slot and never reaches the provider', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const controlled = makeControlledFiles(port);
    const service = createCollectionService({
      repository,
      files: controlled.files,
      downloadConcurrency: 3,
    });
    const backgrounds: Promise<unknown>[] = [];

    try {
      for (let id = 1; id <= 5; id += 1) {
        const saved = await service.saveCandidate(candidate(id));
        backgrounds.push(saved.backgroundDownload);
        saved.backgroundDownload.catch(() => undefined);
      }
      await flush();
      await flush();
      expect(controlled.started).toHaveLength(3);

      const queued = [1, 2, 3, 4, 5].filter((id) => !controlled.started.includes(id));
      expect(queued).toHaveLength(2);
      const [abortId, survivorId] = queued;

      // Cancel a still-queued download: it never acquired a slot.
      await service.deleteSaved(abortId!);
      await flush();
      expect(controlled.started).not.toContain(abortId);

      // Freeing one in-flight slot must wake the survivor, not the cancelled one.
      controlled.resolveOne(controlled.started[0]!);
      await flush();
      await flush();

      expect(controlled.started).toContain(survivorId);
      expect(controlled.started).not.toContain(abortId);
      expect(controlled.inFlight).toBe(3);
    } finally {
      await drain(controlled, backgrounds);
      nativeDatabase.close();
    }
  });
});

describe('K6-4d download stall, not deadline', () => {
  // Drain queued promise continuations (and any 0-delay timers) without
  // advancing the stall clock. Several rounds cover the multi-hop async chain
  // from one download finishing to the next acquiring its slot.
  const flush = async (rounds = 8): Promise<void> => {
    for (let i = 0; i < rounds; i += 1) await jest.advanceTimersByTimeAsync(0);
  };

  // A file repository whose download parks until the test drives it. The test
  // pushes byte progress through the injected onProgress, resolves a download,
  // or lets the service's stall guard abort it via the AbortSignal.
  function makeProgressFiles(port: MemoryFilePort) {
    const base = createCollectionFileRepository(port);
    type Entry = {
      resolve: () => void;
      onProgress?: (received: number) => void;
    };
    const pending = new Map<number, Entry>();
    const starts: number[] = [];

    const download = jest.fn(
      async (
        image: Parameters<CollectionFileRepository['download']>[0],
        options?: CollectionDownloadOptions,
      ): Promise<DownloadedCollectionFile> => {
        starts.push(image.id);
            return await new Promise<DownloadedCollectionFile>((resolve, reject) => {
          pending.set(image.id, {
            resolve: () => resolve({ uri: base.pathFor(image), reused: false }),
            onProgress: options?.onProgress,
          });
          const signal = options?.signal;
          const onAbort = (): void => {
            pending.delete(image.id);
            reject(new CollectionServiceError(
              'download_failed',
              'This image download was cancelled.',
            ));
          };
          if (signal) {
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      },
    );

    return {
      files: { ...base, download } as CollectionFileRepository,
      attempts: () => starts.length,
      inFlight: () => [...pending.keys()],
      progress(imageId: number, received: number): void {
        pending.get(imageId)?.onProgress?.(received);
      },
      resolveOne(imageId: number): void {
        const entry = pending.get(imageId);
        if (!entry) throw new Error(`no in-flight download for ${imageId}`);
        pending.delete(imageId);
        entry.resolve();
      },
      // Tolerant cleanup so no parked promise or armed timer outlives the test.
      settleAll(): void {
        for (const [id, entry] of [...pending.entries()]) {
          pending.delete(id);
          entry.resolve();
        }
      },
    };
  }

  test('a probe that hangs still stalls after one window', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const base = createCollectionFileRepository(port);
    const download = jest.fn(async (
      _image: Parameters<CollectionFileRepository['download']>[0],
      options?: CollectionDownloadOptions,
    ): Promise<DownloadedCollectionFile> => await new Promise<DownloadedCollectionFile>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        reject(new CollectionServiceError('download_failed', 'probe cancelled'));
      }, { once: true });
    }));
    const files = { ...base, download } as CollectionFileRepository;
    jest.useFakeTimers();
    const service = createCollectionService({
      repository,
      files,
      downloadStallMs: 1_000,
    });

    try {
      const saved = await service.saveCandidate(candidate(42));
      saved.backgroundDownload.catch(() => undefined);
      await flush();
      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(download).toHaveBeenCalledTimes(2);

      await expect(service.deleteSaved(saved.image.id)).resolves.toMatchObject({
        decision: 'dismissed',
      });
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      nativeDatabase.close();
    }
  });

  test('a save waiting for a range lease does not stall', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const base = createCollectionFileRepository(port);
    let releaseLease!: () => void;
    const lease = new Promise<void>((resolve) => { releaseLease = resolve; });
    const pending = new Set<{
      resolve: () => void;
      reject: (error: unknown) => void;
    }>();
    const starts: number[] = [];
    const download = jest.fn(async (
      image: Parameters<CollectionFileRepository['download']>[0],
      options?: CollectionDownloadOptions,
    ): Promise<DownloadedCollectionFile> => {
      options?.onLeaseWait?.();
      await lease;
      options?.onLeaseAcquired?.();
      starts.push(image.id);
      return await new Promise<DownloadedCollectionFile>((resolve, reject) => {
        const entry = { resolve: () => resolve({ uri: base.pathFor(image), reused: false }), reject };
        pending.add(entry);
        options?.signal?.addEventListener('abort', () => {
          pending.delete(entry);
          reject(new CollectionServiceError('download_failed', 'cancelled'));
        }, { once: true });
      });
    });
    const files = { ...base, download } as CollectionFileRepository;
    jest.useFakeTimers();
    const service = createCollectionService({
      repository,
      files,
      downloadStallMs: 1_000,
    });

    try {
      const saved = await service.saveCandidate(candidate(41));
      saved.backgroundDownload.catch(() => undefined);
      await flush();
      expect(download).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(download).toHaveBeenCalledTimes(1);
      expect(starts).toHaveLength(0);

      releaseLease();
      await flush();
      expect(starts).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(download).toHaveBeenCalledTimes(2);
      expect(starts).toHaveLength(2);
      for (const entry of pending) entry.resolve();
      await flush();
      await expect(saved.backgroundDownload).resolves.toMatchObject({ status: 'ready' });
    } finally {
      releaseLease();
      for (const entry of pending) entry.resolve();
      await flush();
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      await Promise.allSettled([...pending].map(({ resolve }) => {
        resolve();
        return Promise.resolve();
      }));
      nativeDatabase.close();
    }
  });

  test('(a) a download queued past the stall window still succeeds', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const controlled = makeProgressFiles(port);
    jest.useFakeTimers();
    const service = createCollectionService({
      repository,
      files: controlled.files,
      downloadConcurrency: 1,
      downloadStallMs: 1_000,
    });
    const backgrounds: Promise<unknown>[] = [];

    try {
      const first = await service.saveCandidate(candidate(1));
      backgrounds.push(first.backgroundDownload);
      first.backgroundDownload.catch(() => undefined);
      const second = await service.saveCandidate(candidate(2));
      backgrounds.push(second.backgroundDownload);
      second.backgroundDownload.catch(() => undefined);
      await flush();

      // Only image 1 holds the single slot; image 2 waits in the queue.
      expect(controlled.inFlight()).toEqual([1]);

      // Far more than the 1 s window elapses while image 2 sits queued. image 1
      // keeps making progress, so the in-flight transfer never stalls.
      for (let i = 0; i < 5; i += 1) {
        controlled.progress(1, (i + 1) * 1_000);
        await jest.advanceTimersByTimeAsync(900);
      }
      expect(controlled.inFlight()).toEqual([1]);

      // image 1 finishes; image 2 finally acquires the slot and transfers.
      controlled.resolveOne(1);
      await flush();
      expect(controlled.inFlight()).toEqual([2]);
      controlled.progress(2, 500);
      controlled.resolveOne(2);
      await flush();

      await expect(second.backgroundDownload).resolves.toMatchObject({ status: 'ready' });
      await expect(repository.getById(2)).resolves.toMatchObject({ downloadState: 'ready' });
    } finally {
      controlled.settleAll();
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      await Promise.allSettled(backgrounds);
      nativeDatabase.close();
    }
  });

  test('a started transfer that sends nothing still stalls after one window', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const controlled = makeProgressFiles(port);
    jest.useFakeTimers();
    const service = createCollectionService({
      repository,
      files: controlled.files,
      downloadConcurrency: 4,
      downloadStallMs: 1_000,
    });
    const backgrounds: Promise<unknown>[] = [];

    try {
      const saved = await service.saveCandidate(candidate(1));
      backgrounds.push(saved.backgroundDownload);
      saved.backgroundDownload.catch(() => undefined);
      await flush();
      expect(controlled.attempts()).toBe(1);

      // No bytes arrive for the whole window: the guard aborts the transfer.
      await jest.advanceTimersByTimeAsync(1_000);
      await flush();

      // The stall did not fail the row; it was requeued for a second attempt.
      expect(controlled.attempts()).toBe(2);
      expect(controlled.inFlight()).toEqual([1]);

      controlled.progress(1, 2_048);
      controlled.resolveOne(1);
      await flush();

      await expect(saved.backgroundDownload).resolves.toMatchObject({ status: 'ready' });
      await expect(repository.getById(1)).resolves.toMatchObject({ downloadState: 'ready' });
    } finally {
      controlled.settleAll();
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      await Promise.allSettled(backgrounds);
      nativeDatabase.close();
    }
  });

  test('(c) a slow but continuously progressing download is never aborted', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const controlled = makeProgressFiles(port);
    jest.useFakeTimers();
    const service = createCollectionService({
      repository,
      files: controlled.files,
      downloadConcurrency: 4,
      downloadStallMs: 30_000,
    });
    const backgrounds: Promise<unknown>[] = [];

    try {
      const saved = await service.saveCandidate(candidate(1));
      backgrounds.push(saved.backgroundDownload);
      saved.backgroundDownload.catch(() => undefined);
      await flush();
      expect(controlled.attempts()).toBe(1);

      // 3 minutes of steady progress, one chunk every 5 s — always inside the
      // 30 s window, so the guard re-arms and never fires.
      for (let tick = 0; tick < 36; tick += 1) {
        controlled.progress(1, (tick + 1) * 4_096);
        await jest.advanceTimersByTimeAsync(5_000);
      }

      expect(controlled.attempts()).toBe(1);
      expect(controlled.inFlight()).toEqual([1]);

      controlled.resolveOne(1);
      await flush();
      await expect(saved.backgroundDownload).resolves.toMatchObject({ status: 'ready' });
      await expect(repository.getById(1)).resolves.toMatchObject({ downloadState: 'ready' });
    } finally {
      controlled.settleAll();
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      await Promise.allSettled(backgrounds);
      nativeDatabase.close();
    }
  });

  test('(d) repeated stalls allow one transient retry before failing exactly once', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const controlled = makeProgressFiles(port);
    const markDownloadFailed = jest.fn(repository.markDownloadFailed.bind(repository));
    const trackedRepository = { ...repository, markDownloadFailed } as typeof repository;
    jest.useFakeTimers();
    const service = createCollectionService({
      repository: trackedRepository,
      files: controlled.files,
      downloadConcurrency: 4,
      downloadStallMs: 1_000,
    });
    const backgrounds: Promise<unknown>[] = [];

    try {
      const saved = await service.saveCandidate(candidate(1));
      backgrounds.push(saved.backgroundDownload);
      saved.backgroundDownload.catch(() => undefined);
      await flush();
      expect(controlled.attempts()).toBe(1);

      // First stall → requeue.
      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(controlled.attempts()).toBe(2);

      // Second stall is a transient failure, so the new same-save retry waits 2 s.
      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(controlled.attempts()).toBe(2);
      await jest.advanceTimersByTimeAsync(2_000);
      await flush();
      expect(controlled.attempts()).toBe(3);

      // Third stall → terminal failure, recorded exactly once.
      await jest.advanceTimersByTimeAsync(1_000);
      await flush();

      await expect(saved.backgroundDownload).resolves.toMatchObject({ status: 'failed' });
      await expect(repository.getById(1)).resolves.toMatchObject({ downloadState: 'failed' });
      expect(controlled.attempts()).toBe(3);
      expect(markDownloadFailed).toHaveBeenCalledTimes(1);
    } finally {
      controlled.settleAll();
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      await Promise.allSettled(backgrounds);
      nativeDatabase.close();
    }
  });
});

describe('K6-5 A: a superseded attempt owns no file', () => {
  // The final path is derived from the image id, so every attempt on one image
  // writes the same file. Only the attempt the row currently belongs to may
  // delete it — a superseded one that cleans up is deleting somebody else's
  // durable save. Owner phone 2026-09-14 20:52: three saves, screen locked
  // immediately, and one tile came back 「需修复」 with the bucket holding a
  // complete, protected original and the local file gone.

  test('a late attempt does not delete the file the row already points at', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const finalUri = 'file:///documents/collection/1.webp';
    let releaseFirst!: () => void;
    port.downloadGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(1));
      const late = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The attempt that won: its bytes are at the shared final path and the
      // row points at them (this is exactly what markDownloadReady leaves).
      port.files.set(finalUri, 42);
      await repository.markDownloadReady(1, finalUri);

      port.downloadGate = null;
      releaseFirst();

      await expect(late).resolves.toEqual({ status: 'stale' });
      expect(port.files.has(finalUri)).toBe(true);
      await expect(repository.getById(1)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: finalUri,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('an aborted-and-replaced attempt issues no delete against the shared paths', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadGate = new Promise(() => undefined);
    port.writePartialBeforeDownloadGate = true;
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      downloadStallMs: 1_000,
    });
    const firstCandidate = {
      ...candidate(24),
      canonicalSourceKey: 'shared:24',
    };
    // Same extension, so both attempts resolve to the same final path.
    const replacementCandidate = {
      ...candidate(240),
      providerKey: 'nekos_api' as const,
      providerItemId: 'nekos-24',
      canonicalSourceKey: 'shared:24',
    };

    try {
      const first = await service.saveCandidate(firstCandidate);
      const finalUri = `file:///documents/collection/${first.image.id}.webp`;
      await new Promise((resolve) => setTimeout(resolve, 0));
      port.downloadGate = null;
      const replacement = await service.saveCandidate(replacementCandidate);

      await expect(first.backgroundDownload).resolves.toMatchObject({ status: 'stale' });
      await expect(replacement.backgroundDownload).resolves.toMatchObject({
        status: 'ready',
        uri: finalUri,
      });
      expect(port.files.has(finalUri)).toBe(true);
      // The superseded attempt must not reach for either shared path: both are
      // named from the id it no longer owns.
      expect(port.operations).not.toContain(`delete:${finalUri}`);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('K6-5 B: active downloads are observable', () => {
  // K6-3 keeps the process unfrozen while bytes go UP. The booru download is
  // the first half of the same save, and locking the screen mid-download froze
  // it (emulator-proven), so the foreground guard has to see it too. One count,
  // published synchronously when the map changes — no timer, no second store.

  test('publishes one active download while it runs and zero once it settles', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    let releaseDownload!: () => void;
    port.downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    const counts: number[] = [];

    try {
      const unsubscribe = service.subscribeActiveDownloads((count) => {
        counts.push(count);
      });
      await savePending(repository, candidate(1));
      const download = service.retryDownload(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(counts).toEqual([1]);

      port.downloadGate = null;
      releaseDownload();
      await expect(download).resolves.toMatchObject({ status: 'ready' });
      expect(counts).toEqual([1, 0]);

      unsubscribe();
      await service.retryDownload(1);
      expect(counts).toEqual([1, 0]);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('K6-5 C: the resume sweep asks the library for its missing rows', () => {
  test('runs the re-ingest pass once the resume sweep has settled', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const order: string[] = [];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      onCollectionResumed: () => {
        order.push('reingest');
      },
    });

    try {
      await savePending(repository, candidate(1));
      const results = await service.resumePendingDownloads();

      expect(results).toHaveLength(1);
      // After the sweep, not before: a row still downloading enters the library
      // through the ordinary ready path and needs no backfill.
      expect(order).toEqual(['reingest']);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a re-ingest pass that throws never fails the resume', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      onCollectionResumed: () => {
        throw new Error('library unavailable');
      },
    });

    try {
      await expect(service.resumePendingDownloads()).resolves.toEqual([]);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('N10 T1: the resume sweep repairs dead mirrored rows', () => {
  test('a listed dead row walks the repair path: reclaim, then provider re-download', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const resumed: string[] = [];
    const listMirrorDeadSavedImageIds = jest.fn(
      async (): Promise<readonly number[]> => [],
    );
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      listMirrorDeadSavedImageIds,
      onCollectionResumed: () => {
        resumed.push('resumed');
      },
    });
    try {
      const dead = await repository.saveMirroredCandidate(
        { ...candidate(11), id: undefined } as never,
        100,
      );
      listMirrorDeadSavedImageIds.mockResolvedValue([dead.id]);
      const reclaim = jest.spyOn(repository, 'reclaimMirroredForDownload');

      const results = await service.resumePendingDownloads();

      // One query per pass, and the repair through `repairDownload`'s own
      // reclaim — not `startDownload`, which refuses a mirrored row.
      expect(listMirrorDeadSavedImageIds).toHaveBeenCalledTimes(1);
      expect(reclaim).toHaveBeenCalledTimes(1);
      expect(results).toEqual([
        expect.objectContaining({
          status: 'ready',
          uri: expect.stringContaining(`/${dead.id}.webp`),
        }),
      ]);
      expect(port.operations.filter((op) => op.startsWith('download:'))).toHaveLength(1);
      await expect(repository.getById(dead.id)).resolves.toMatchObject({
        downloadState: 'ready',
      });
      expect(resumed).toEqual(['resumed']);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a row that left mirrored before its repair is skipped as stale, and the pass still completes', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const port = new MemoryFilePort();
    const resumed: string[] = [];
    try {
      const dead = await repository.saveMirroredCandidate(
        { ...candidate(12), id: undefined } as never,
        100,
      );
      const service = createCollectionService({
        repository,
        files: createCollectionFileRepository(port),
        // The hand-over lands between the sweep's listing and the re-read the
        // repair does: resolving the ids is where the row turns `ready` again.
        listMirrorDeadSavedImageIds: async () => {
          await database.run(
            "UPDATE images SET download_state = 'ready', local_uri = ? WHERE id = ?",
            [`file:///documents/collection/${dead.id}.webp`, dead.id],
          );
          return [dead.id];
        },
        onCollectionResumed: () => {
          resumed.push('resumed');
        },
      });

      await expect(service.resumePendingDownloads()).resolves.toEqual([
        { status: 'stale' },
      ]);
      expect(port.operations.filter((op) => op.startsWith('download:'))).toEqual([]);
      await expect(repository.getById(dead.id)).resolves.toMatchObject({
        downloadState: 'ready',
      });
      expect(resumed).toEqual(['resumed']);
    } finally {
      nativeDatabase.close();
    }
  });

  test('each id is repaired once per pass, however often the listing names it', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    try {
      const dead = await repository.saveMirroredCandidate(
        { ...candidate(13), id: undefined } as never,
        100,
      );
      const service = createCollectionService({
        repository,
        files: createCollectionFileRepository(port),
        listMirrorDeadSavedImageIds: async () => [dead.id, dead.id],
      });

      const results = await service.resumePendingDownloads();

      expect(results).toEqual([
        expect.objectContaining({ status: 'ready' }),
      ]);
      expect(port.operations.filter((op) => op.startsWith('download:'))).toHaveLength(1);
      await expect(repository.getById(dead.id)).resolves.toMatchObject({
        downloadState: 'ready',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('without the dependency the sweep leaves mirrored rows exactly as before', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    try {
      const dead = await repository.saveMirroredCandidate(
        { ...candidate(14), id: undefined } as never,
        100,
      );

      await expect(service.resumePendingDownloads()).resolves.toEqual([]);
      expect(port.operations.filter((op) => op.startsWith('download:'))).toEqual([]);
      await expect(repository.getById(dead.id)).resolves.toMatchObject({
        downloadState: 'mirrored',
      });
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('board #5 — download-failure classification', () => {
  const downloadsFor = (port: MemoryFilePort, imageId: number): string[] =>
    port.operations.filter((operation) =>
      operation.startsWith(`download:https://cdn.example.com/${imageId}.`));

  test('a 404 from the source records the failure as source_gone', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadError = new CollectionServiceError('download_failed', 'gone', {
      httpStatus: 404,
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const saved = await service.saveCandidate(candidate(31));

      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'failed',
      });
      expect(downloadsFor(port, 31)).toHaveLength(1);
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'failed',
        downloadErrorKind: 'source_gone',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('an ordinary download error records the failure as transient', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline'), new Error('offline')];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const saved = await service.saveCandidate(candidate(32));

      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'failed',
      });
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'failed',
        downloadErrorKind: 'transient',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a transient failure is retried once during the save and then becomes ready', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline')];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    const resumePendingDownloads = jest.spyOn(service, 'resumePendingDownloads');
    jest.useFakeTimers();

    try {
      const saved = await service.saveCandidate(candidate(37));
      await jest.advanceTimersByTimeAsync(0);
      expect(downloadsFor(port, 37)).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(downloadsFor(port, 37)).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1);
      await expect(saved.backgroundDownload).resolves.toMatchObject({ status: 'ready' });
      expect(downloadsFor(port, 37)).toHaveLength(2);
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'ready',
        downloadErrorKind: null,
      });
      expect(resumePendingDownloads).not.toHaveBeenCalled();
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      nativeDatabase.close();
    }
  });

  test('a transient backoff does not hold a download slot', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline')];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      downloadConcurrency: 1,
    });
    jest.useFakeTimers();

    try {
      const first = await service.saveCandidate(candidate(43));
      first.backgroundDownload.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(0);

      const second = await service.saveCandidate(candidate(44));
      await jest.advanceTimersByTimeAsync(0);
      expect(downloadsFor(port, 43)).toHaveLength(1);
      expect(downloadsFor(port, 44)).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(2_000);
      await expect(first.backgroundDownload).resolves.toMatchObject({ status: 'ready' });
      await expect(second.backgroundDownload).resolves.toMatchObject({ status: 'ready' });
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      nativeDatabase.close();
    }
  });

  test('two transient failures record one terminal failure', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline'), new Error('offline')];
    const markDownloadFailed = jest.fn(repository.markDownloadFailed.bind(repository));
    const trackedRepository = { ...repository, markDownloadFailed } as typeof repository;
    const service = createCollectionService({
      repository: trackedRepository,
      files: createCollectionFileRepository(port),
    });
    jest.useFakeTimers();

    try {
      const saved = await service.saveCandidate(candidate(38));
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(saved.backgroundDownload).resolves.toMatchObject({ status: 'failed' });
      expect(downloadsFor(port, 38)).toHaveLength(2);
      expect(markDownloadFailed).toHaveBeenCalledTimes(1);
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'failed',
        downloadErrorKind: 'transient',
      });
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      nativeDatabase.close();
    }
  });

  test('a 404 is not retried in the save', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new CollectionServiceError('download_failed', 'gone', {
      httpStatus: 404,
    })];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const saved = await service.saveCandidate(candidate(39));
      await expect(saved.backgroundDownload).resolves.toMatchObject({ status: 'failed' });
      expect(downloadsFor(port, 39)).toHaveLength(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a cancelled save is not retried', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline')];
    const files = createCollectionFileRepository(port);
    const download = jest.spyOn(files, 'download');
    const service = createCollectionService({
      repository,
      files,
    });
    jest.useFakeTimers();

    try {
      const saved = await service.saveCandidate(candidate(40));
      await jest.advanceTimersByTimeAsync(0);
      const deletion = service.deleteSaved(saved.image.id);
      await jest.advanceTimersByTimeAsync(0);
      await expect(deletion).resolves.toMatchObject({ decision: 'dismissed' });
      await expect(saved.backgroundDownload).resolves.toMatchObject({ status: 'failed' });
      expect(downloadsFor(port, 40)).toHaveLength(1);
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      nativeDatabase.close();
    }
  });

  test('the resume sweep retries a transient failure until it succeeds', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline'), new Error('offline')];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const saved = await service.saveCandidate(candidate(33));
      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'failed',
      });

      await expect(service.resumePendingDownloads()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'ready',
            uri: expect.stringContaining(`/${saved.image.id}.webp`),
          }),
        ]),
      );
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: `file:///documents/collection/${saved.image.id}.webp`,
        downloadErrorKind: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('the resume sweep never retries a source_gone row', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadError = new CollectionServiceError('download_failed', 'gone', {
      httpStatus: 410,
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const saved = await service.saveCandidate(candidate(34));
      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'failed',
      });
      expect(downloadsFor(port, 34)).toHaveLength(1);

      await expect(service.resumePendingDownloads()).resolves.toEqual([]);
      // The port would have served the bytes — it only throws once — so an
      // unchanged operation log is the proof the sweep never asked.
      expect(downloadsFor(port, 34)).toHaveLength(1);
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'failed',
        downloadErrorKind: 'source_gone',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('the resume sweep retries a failed row that predates the classification', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadErrors = [new Error('offline'), new Error('offline')];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const saved = await service.saveCandidate(candidate(35));
      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'failed',
      });
      // A row written before schema v20 carries no classification at all.
      await database.run(
        'UPDATE images SET download_error_kind = NULL WHERE id = ?',
        [saved.image.id],
      );
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'failed',
        downloadErrorKind: null,
      });

      await expect(service.resumePendingDownloads()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'ready',
            uri: expect.stringContaining(`/${saved.image.id}.webp`),
          }),
        ]),
      );
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'ready',
        downloadErrorKind: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('an explicit retry of a source_gone row still downloads it', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    port.downloadError = new CollectionServiceError('download_failed', 'gone', {
      httpStatus: 404,
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      const saved = await service.saveCandidate(candidate(36));
      await expect(saved.backgroundDownload).resolves.toMatchObject({
        status: 'failed',
      });

      // §7: the user reached the repair path anyway, and the source came back.
      await expect(service.retryDownload(saved.image.id)).resolves.toMatchObject({
        status: 'ready',
      });
      await expect(repository.getById(saved.image.id)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: `file:///documents/collection/${saved.image.id}.webp`,
        downloadErrorKind: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('board #27: 删除全部应用数据 library wiring (spec §5.4)', () => {
  test('删除全部应用数据 stops the library first, finishes it after the collection is gone, and reports each stage', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const order: string[] = [];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(new MemoryFilePort()),
      libraryReset: async () => {
        order.push(`stop:${(await repository.listCollection()).length}`);
        return {
          async finish() {
            order.push(`finish:${(await repository.listCollection()).length}`);
            return {
              rows: 'deleted',
              failedFiles: ['file:///data/library/originals/x.jpg'],
              cloud: 'failed',
              disconnected: false,
              error: new Error('keystore busy'),
            };
          },
          abandon() {},
        };
      },
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);

      const result = await service.deleteAllData();

      expect(order).toEqual(['stop:1', 'finish:0']);
      expect(result.remaining).toEqual(['files', 'cloud']);
      expect(result.files.failed).toEqual([
        expect.objectContaining({ uri: 'file:///data/library/originals/x.jpg' }),
      ]);
      expect(result.library).toMatchObject({
        status: 'deleted',
        cloud: 'failed',
        disconnected: false,
      });
    } finally {
      nativeDatabase.close();
    }

    const second = await openRepository();
    const secondService = createCollectionService({
      repository: second.repository,
      files: createCollectionFileRepository(new MemoryFilePort()),
      libraryReset: async () => ({
        async finish() {
          return {
            rows: 'failed' as const,
            failedFiles: [],
            cloud: 'skipped' as const,
            disconnected: false,
            error: new Error('library rows'),
          };
        },
        abandon() {},
      }),
    });

    try {
      await savePending(second.repository, candidate(2));
      await secondService.retryDownload(2);

      const failedRows = await secondService.deleteAllData();

      expect(failedRows.remaining).toContain('database');
      expect(failedRows.remaining).not.toContain('cloud');
    } finally {
      second.nativeDatabase.close();
    }
  });

  test('a collection stage that throws still ends the library hold', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const finish = jest.fn();
    const abandon = jest.fn();
    const service = createCollectionService({
      repository: {
        ...repository,
        deleteAll: jest.fn(async () => {
          throw new Proxy({}, {
            getPrototypeOf() {
              throw new Error('boom');
            },
          });
        }),
      },
      files: createCollectionFileRepository(new MemoryFilePort()),
      libraryReset: async () => ({ finish, abandon }),
    });

    try {
      await expect(service.deleteAllData()).rejects.toThrow('boom');
      expect(abandon).toHaveBeenCalledTimes(1);
      expect(finish).not.toHaveBeenCalled();
    } finally {
      nativeDatabase.close();
    }
  });

  test('a rejected libraryReset still deletes the collection and reports the library half failed', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const savedPath = 'file:///documents/collection/1.webp';
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      // Rejects before returning a hold, so there is no finish or abandon to call.
      libraryReset: async () => {
        throw new Error('sync lease busy');
      },
    });

    try {
      await savePending(repository, candidate(1));
      await service.retryDownload(1);
      expect(port.files.has(savedPath)).toBe(true);

      const result = await service.deleteAllData();

      expect(result.library).toMatchObject({
        status: 'failed',
        cloud: 'skipped',
        disconnected: false,
      });
      expect(result.remaining).toContain('database');
      expect(result.ok).toBe(false);
      await expect(repository.getById(1)).resolves.toBeNull();
      expect(port.files.has(savedPath)).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('board #27 S1b: the resume sweep survives a row that changes under it', () => {
  // §5.5: the sweep lists the collection once and repairs afterwards. A row
  // handed over to the library in between must not fail the pass, and neither
  // may any single download — `onCollectionResumed` carries the recovery, the
  // missing pass and the backfill, so the pass has to reach it.

  test('a row handed over between the listing and its repair is skipped, and the pass still reaches the library', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const port = new MemoryFilePort();
    const resumed: string[] = [];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      onCollectionResumed: () => {
        resumed.push('resumed');
      },
    });
    let releaseList = (): void => undefined;
    let unsubscribe = (): void => undefined;

    try {
      await savePending(repository, candidate(1));
      await savePending(repository, candidate(2), 200);
      await expect(service.retryDownload(2)).resolves.toMatchObject({
        status: 'ready',
        uri: 'file:///documents/collection/2.webp',
      });
      port.operations.length = 0;
      let largestActive = 0;
      unsubscribe = service.subscribeActiveDownloads((count) => {
        largestActive = Math.max(largestActive, count);
      });
      port.listGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      let signalList!: () => void;
      const listReached = new Promise<void>((resolve) => {
        signalList = resolve;
      });
      const list = port.list.bind(port);
      port.list = () => {
        signalList();
        return list();
      };

      const pass = service.resumePendingDownloads();
      await listReached;
      // The hand-over lands while the sweep is reading the directory: the
      // listing it already holds still says `ready` at 2.webp.
      await database.run(
        "UPDATE images SET download_state = 'mirrored', local_uri = NULL WHERE id = ?",
        [2],
      );
      port.files.delete('file:///documents/collection/2.webp');
      releaseList();

      await expect(pass).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'ready', uri: expect.stringContaining('/1.webp') }),
        { status: 'stale' },
      ]));
      // Row 2 never started an attempt (without the re-check: 2, and
      // `allSettled` hides its `not_ready`).
      expect(largestActive).toBe(1);
      expect(port.operations.filter((op) => (
        op.startsWith('download:') && op.includes('/2.webp')
      ))).toEqual([]);
      await expect(repository.getById(2)).resolves.toMatchObject({
        downloadState: 'mirrored',
        localUri: null,
      });
      expect(resumed).toEqual(['resumed']);
    } finally {
      releaseList();
      unsubscribe();
      nativeDatabase.close();
    }
  });

  test('a row un-saved between the listing and its repair is skipped', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    let releaseList = (): void => undefined;
    let unsubscribe = (): void => undefined;

    try {
      await savePending(repository, candidate(1));
      await savePending(repository, candidate(2), 200);
      await expect(service.retryDownload(2)).resolves.toMatchObject({
        status: 'ready',
        uri: 'file:///documents/collection/2.webp',
      });
      port.operations.length = 0;
      let largestActive = 0;
      unsubscribe = service.subscribeActiveDownloads((count) => {
        largestActive = Math.max(largestActive, count);
      });
      port.listGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      let signalList!: () => void;
      const listReached = new Promise<void>((resolve) => {
        signalList = resolve;
      });
      const list = port.list.bind(port);
      port.list = () => {
        signalList();
        return list();
      };

      const pass = service.resumePendingDownloads();
      await listReached;
      // Un-saved while the sweep reads the directory, its file gone with it:
      // the listing the sweep already holds still says `ready` at 2.webp.
      await expect(repository.deleteFromCollection(2)).resolves.toMatchObject({
        decision: 'dismissed',
      });
      port.files.delete('file:///documents/collection/2.webp');
      releaseList();

      await expect(pass).resolves.toHaveLength(2);
      await expect(pass).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'ready', uri: expect.stringContaining('/1.webp') }),
        { status: 'stale' },
      ]));
      expect(largestActive).toBe(1);
      expect(port.operations.filter((op) => (
        op.startsWith('download:') && op.includes('/2.webp')
      ))).toEqual([]);
    } finally {
      releaseList();
      unsubscribe();
      nativeDatabase.close();
    }
  });

  test('a repair that throws costs the pass nothing', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const firstFileAtResume: boolean[] = [];
    const service = createCollectionService({
      repository: {
        ...repository,
        markDownloadReady: (id, uri, attempt) => (id === 2
          ? Promise.reject(new Error('disk I/O error'))
          : repository.markDownloadReady(id, uri, attempt)),
      },
      files: createCollectionFileRepository(port),
      onCollectionResumed: () => {
        firstFileAtResume.push(port.files.has('file:///documents/collection/1.webp'));
      },
    });

    try {
      await savePending(repository, candidate(1));
      await savePending(repository, candidate(2), 200);

      const pass = service.resumePendingDownloads();

      await expect(pass).resolves.toHaveLength(2);
      await expect(pass).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'ready', uri: expect.stringContaining('/1.webp') }),
        { status: 'stale' },
      ]));
      // The hook ran after the repairs settled: row 1's file was already there.
      expect(firstFileAtResume).toEqual([true]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('an in-flight download that throws costs the pass nothing', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const resumed: string[] = [];
    let releaseDownload!: () => void;
    port.downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const service = createCollectionService({
      repository: {
        ...repository,
        markDownloadReady: (id, uri, attempt) => (id === 3
          ? Promise.reject(new Error('disk I/O error'))
          : repository.markDownloadReady(id, uri, attempt)),
      },
      files: createCollectionFileRepository(port),
      onCollectionResumed: () => {
        resumed.push('resumed');
      },
    });

    try {
      await savePending(repository, candidate(3));
      const retry = service.retryDownload(3);
      const pass = service.resumePendingDownloads();
      // Let the download park at its gate and the sweep reach the settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseDownload();

      await expect(pass).resolves.toEqual(expect.arrayContaining([{ status: 'stale' }]));
      expect(resumed).toEqual(['resumed']);
      // The caller that started the download still hears how it ended.
      await expect(retry).rejects.toMatchObject({ code: 'database_failed' });
    } finally {
      releaseDownload();
      nativeDatabase.close();
    }
  });

  test('a reset that begins while the sweep is listing fails the pass, and no library pass runs', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const resumed: string[] = [];
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      onCollectionResumed: () => {
        resumed.push('resumed');
      },
    });
    let releaseList = (): void => undefined;

    try {
      await savePending(repository, candidate(1));
      port.listGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      const pass = service.resumePendingDownloads();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 删除全部应用数据 begins while the sweep reads the directory, so row 1's
      // repair is refused as `operation_blocked` once the listing returns.
      const reset = service.deleteAllData();
      releaseList();

      await expect(pass).rejects.toMatchObject({ code: 'operation_blocked' });
      expect(resumed).toEqual([]);
      await expect(reset).resolves.toMatchObject({ ok: true, remaining: [] });
    } finally {
      releaseList();
      nativeDatabase.close();
    }
  });

  test('a reset that begins while the pass waits on an in-flight download fails the pass, and no library pass runs', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const resumed: string[] = [];
    let releaseDownload!: () => void;
    port.downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      onCollectionResumed: () => {
        resumed.push('resumed');
      },
    });

    try {
      await savePending(repository, candidate(3));
      const retry = service.retryDownload(3);
      const pass = service.resumePendingDownloads();
      // Let the download park at its gate and the sweep reach the settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 删除全部应用数据 cancels the download, which settles as `failed`.
      const reset = service.deleteAllData();
      releaseDownload();

      await expect(pass).rejects.toMatchObject({ code: 'operation_blocked' });
      expect(resumed).toEqual([]);
      await expect(retry).resolves.toMatchObject({ status: 'failed' });
      await expect(reset).resolves.toMatchObject({ ok: true, remaining: [] });
    } finally {
      releaseDownload();
      nativeDatabase.close();
    }
  });

  test('a reset that begins while a repair is downloading fails the pass, and no library pass runs', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const resumed: string[] = [];
    let releaseDownload!: () => void;
    port.downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
      onCollectionResumed: () => {
        resumed.push('resumed');
      },
    });

    try {
      await savePending(repository, candidate(1));
      const pass = service.resumePendingDownloads();
      // Let the pass list the collection, settle its (empty) in-flight
      // downloads, and park row 1's repair download at its gate.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(port.operations).toContain(
        'download:https://cdn.example.com/1.webp->file:///documents/collection/1.webp.partial',
      );
      // 删除全部应用数据 begins during the repair phase and cancels the repair.
      const reset = service.deleteAllData();
      releaseDownload();

      await expect(pass).rejects.toMatchObject({ code: 'operation_blocked' });
      expect(resumed).toEqual([]);
      await expect(reset).resolves.toMatchObject({ ok: true, remaining: [] });
    } finally {
      releaseDownload();
      nativeDatabase.close();
    }
  });

  test('a collection file left by a hand-over that died before its delete goes with the next sweep', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(4));
      await expect(service.retryDownload(4)).resolves.toMatchObject({ status: 'ready' });
      // The hand-over committed the row and died before deleting the file.
      await database.run(
        "UPDATE images SET download_state = 'mirrored', local_uri = NULL WHERE id = ?",
        [4],
      );
      expect(port.files.has('file:///documents/collection/4.webp')).toBe(true);
      port.operations.length = 0;

      await service.resumePendingDownloads();

      expect(port.files.has('file:///documents/collection/4.webp')).toBe(false);
      expect(port.operations).toContain('delete:file:///documents/collection/4.webp');
      expect(port.operations.filter((op) => op.startsWith('download:'))).toEqual([]);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('board #27 S1b: the automatic repair (spec §5.5 rule 3)', () => {
  // A tile or viewer that fails to load a `ready` row's file asks to repair
  // the file it saw. After a hand-over a stale 收藏 snapshot still says
  // `ready` at L although L is gone: that request must never send the now
  // `mirrored` row back to the booru, nor cancel a download it never saw.
  const L7 = 'file:///documents/collection/7.webp';
  const downloads = (port: MemoryFilePort) => port.operations.filter((op) => op.startsWith('download:'));
  // Parks the next `files.exists(L7)` — a running download's `runDownload`
  // checking row 7's file — until `release()`; the row still reads `ready` at L7.
  const parkExistsCheck = (port: MemoryFilePort) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal!: () => void;
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const exists = port.exists.bind(port);
    let parked = false;
    port.exists = async (uri: string) => {
      if (!parked && uri === L7) {
        parked = true;
        signal();
        await gate;
      }
      return exists(uri);
    };
    return { reached, release };
  };

  test('re-downloads a ready row whose file is gone when the screen saw that file', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      port.files.delete(L7);
      const before = downloads(port).length;

      await expect(service.repairMissingFile(7, L7)).resolves.toEqual({
        status: 'ready',
        uri: L7,
        reused: false,
      });
      expect(downloads(port)).toHaveLength(before + 1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('answers stale for a row handed over since the screen read it', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      // The hand-over: the library holds the bytes and the collection file went.
      await database.run(
        "UPDATE images SET download_state = 'mirrored', local_uri = NULL WHERE id = ?",
        [7],
      );
      port.files.delete(L7);
      const before = downloads(port).length;

      await expect(service.repairMissingFile(7, L7)).resolves.toEqual({ status: 'stale' });
      expect(downloads(port)).toHaveLength(before);
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'mirrored',
        localUri: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('answers stale when the row holds another file', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      const before = downloads(port).length;

      await expect(service.repairMissingFile(7, 'file:///documents/collection/7-old.webp'))
        .resolves.toEqual({ status: 'stale' });
      expect(downloads(port)).toHaveLength(before);
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: L7,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('answers stale for a row handed over while the repair waited for its lease', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const port = new MemoryFilePort();
    let handOverAfterNextRead = false;
    const service = createCollectionService({
      repository: {
        ...repository,
        getById: async (id) => {
          const image = await repository.getById(id);
          if (handOverAfterNextRead) {
            handOverAfterNextRead = false;
            await database.run(
              "UPDATE images SET download_state = 'mirrored', local_uri = NULL WHERE id = ?",
              [id],
            );
          }
          return image;
        },
      },
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      const before = downloads(port).length;
      // The plain read still sees `ready` at L7; the hand-over lands before the
      // lease, so only the re-check inside it can tell.
      handOverAfterNextRead = true;

      await expect(service.repairMissingFile(7, L7)).resolves.toEqual({ status: 'stale' });
      expect(downloads(port)).toHaveLength(before);
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'mirrored',
        localUri: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a hand-over between the in-lease read and markFileMissing answers stale', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const port = new MemoryFilePort();
    let reads = 0;
    let armed = false;
    const service = createCollectionService({
      repository: {
        ...repository,
        getById: async (id) => {
          const image = await repository.getById(id);
          if (armed) {
            reads += 1;
            // Read 1 is the plain read, read 2 the re-check inside the lease:
            // the hand-over lands right after both passed.
            if (reads === 2) {
              await database.run(
                "UPDATE images SET download_state = 'mirrored', local_uri = NULL WHERE id = ?",
                [id],
              );
            }
          }
          return image;
        },
      },
      files: createCollectionFileRepository(port),
    });

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      const before = downloads(port).length;
      armed = true;

      // `markFileMissing` takes only a `ready` or `failed` row, so the
      // `mirrored` row is left alone and the repair answers `stale`.
      await expect(service.repairMissingFile(7, L7)).resolves.toEqual({ status: 'stale' });
      expect(downloads(port)).toHaveLength(before);
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'mirrored',
        localUri: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a stale request cancels no running download', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    let releaseDownload = (): void => undefined;

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      port.files.delete(L7);
      port.downloadGate = new Promise<void>((resolve) => {
        releaseDownload = resolve;
      });
      let signalDownload!: () => void;
      const downloadReached = new Promise<void>((resolve) => {
        signalDownload = resolve;
      });
      const download = port.download.bind(port);
      port.download = (remoteUrl, destinationUri, options) => {
        const started = download(remoteUrl, destinationUri, options);
        signalDownload();
        return started;
      };

      // The file is gone, so the retry marks it missing and downloads it
      // again, held at the gate.
      const retry = service.retryDownload(7);
      await downloadReached;
      // The row is `pending` by now, so the plain read already answers
      // `stale`; a request made while the retry still read `ready` at L7 is the
      // next test's.
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'pending',
        localUri: null,
      });

      await expect(service.repairMissingFile(7, L7)).resolves.toEqual({ status: 'stale' });
      releaseDownload();

      await expect(retry).resolves.toMatchObject({ status: 'ready', uri: L7 });
    } finally {
      releaseDownload();
      nativeDatabase.close();
    }
  });

  test('the automatic repair leaves a running download of its row alone', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    let release = (): void => undefined;

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      port.files.delete(L7);
      const before = downloads(port).length;
      const parked = parkExistsCheck(port);
      release = parked.release;

      // A retry (or the sweep) is checking row 7's file, which still reads
      // `ready` at L7: exactly what the failing screen saw.
      const retry = service.retryDownload(7);
      await parked.reached;
      const repair = service.repairMissingFile(7, L7);
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [repaired, retried] = await Promise.all([repair, retry]);
      // Cancelled by the repair, the retry would have left the row `failed`
      // with nothing downloading it.
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: L7,
        downloadError: null,
        downloadErrorKind: null,
      });
      expect(repaired).toEqual({ status: 'stale' });
      expect(retried).toEqual({ status: 'ready', uri: L7, reused: false });
      expect(downloads(port)).toHaveLength(before + 1);
    } finally {
      release();
      nativeDatabase.close();
    }
  });

  test('a present file that failed to load is repaired even while a download of its row runs', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    let release = (): void => undefined;

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      // Present on disk but undecodable (say a stored hotlink page, R8.28):
      // these bytes are 1, and a fresh download writes 42.
      port.files.set(L7, 1);
      const before = downloads(port).length;
      const parked = parkExistsCheck(port);
      release = parked.release;

      // Re-collecting the saved image starts a download of row 7, which checks
      // L7, finds it present and would reuse the bad bytes.
      const { backgroundDownload } = await service.saveCandidate(candidate(7));
      await parked.reached;
      const repair = service.repairMissingFile(7, L7);
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      await expect(repair).resolves.toEqual({ status: 'ready', uri: L7, reused: false });
      expect(downloads(port)).toHaveLength(before + 1);
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: L7,
      });
      expect(port.files.get(L7)).toBe(42);
      // Cancelled at its check, the re-collect found the file present and
      // ended as it would have anyway.
      await expect(backgroundDownload).resolves.toEqual({ status: 'ready', uri: L7, reused: true });
    } finally {
      release();
      nativeDatabase.close();
    }
  });

  test('a stale request never queues behind an explicit 修复 of its row', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    let releaseDownload = (): void => undefined;

    try {
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      // Handed over; the library could not serve it, so the user taps 修复,
      // which downloads it again, held at the gate.
      await database.run(
        "UPDATE images SET download_state = 'mirrored', local_uri = NULL WHERE id = ?",
        [7],
      );
      port.files.delete(L7);
      const before = downloads(port).length;
      port.downloadGate = new Promise<void>((resolve) => {
        releaseDownload = resolve;
      });
      let signalDownload!: () => void;
      const downloadReached = new Promise<void>((resolve) => {
        signalDownload = resolve;
      });
      const download = port.download.bind(port);
      port.download = (remoteUrl, destinationUri, options) => {
        const started = download(remoteUrl, destinationUri, options);
        signalDownload();
        return started;
      };
      const fix = service.repairDownload(7);
      await downloadReached;

      // A tile still on the pre-hand-over snapshot fails to load L7.
      const repair = service.repairMissingFile(7, L7);
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseDownload();

      // Queued behind the 修复, it would find the fresh file at L7 and
      // download it all over again.
      await expect(repair).resolves.toEqual({ status: 'stale' });
      await expect(fix).resolves.toEqual({ status: 'ready', uri: L7, reused: false });
      expect(downloads(port)).toHaveLength(before + 1);
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: L7,
      });
    } finally {
      releaseDownload();
      nativeDatabase.close();
    }
  });

  test('an explicit 修复 that cancels a download inside runDownload leaves no unhandled rejection', async () => {
    // Jest hands a test a copy of `process` whose listeners never fire; Node
    // reports an unhandled rejection on the real one, which this reaches.
    const realProcess = runInThisContext('process') as NodeJS.Process;
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const { nativeDatabase, repository } = await openRepository();
    const port = new MemoryFilePort();
    const service = createCollectionService({
      repository,
      files: createCollectionFileRepository(port),
    });
    let release = (): void => undefined;

    try {
      realProcess.on('unhandledRejection', recordUnhandled);
      await savePending(repository, candidate(7));
      await expect(service.retryDownload(7)).resolves.toMatchObject({ status: 'ready', uri: L7 });
      port.files.delete(L7);
      const parked = parkExistsCheck(port);
      release = parked.release;

      const retry = service.retryDownload(7);
      await parked.reached;
      // The user's 修复 cancels the retry before the retry starts its transfer.
      const repair = service.repairDownload(7);
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [repaired, retried] = await Promise.all([repair, retry]);
      // Node reports a rejection nobody handled once the turn's microtasks drain.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      // The retry was cancelled inside runDownload, the path this test is about.
      expect(retried).toMatchObject({ status: 'failed', error: { code: 'download_failed' } });
      expect(repaired).toEqual({ status: 'ready', uri: L7, reused: false });
      await expect(repository.getById(7)).resolves.toMatchObject({
        downloadState: 'ready',
        localUri: L7,
      });
    } finally {
      release();
      realProcess.off('unhandledRejection', recordUnhandled);
      nativeDatabase.close();
    }
  });
});
