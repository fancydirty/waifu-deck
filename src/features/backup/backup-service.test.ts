import { DatabaseSync } from 'node:sqlite';

import { APP_DATABASE_NAME } from '@/db/database';
import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import * as backupServiceModule from '@/features/backup/backup-service';
import {
  archiveName,
  backupSnapshotName,
  createAppBackupService,
  restoreImportName,
  RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL,
  sweepBackupArtifacts,
  RESTORE_SAVED_IMAGES_SQL,
  RESTORED_LIBRARY_FILE_URIS_SQL,
} from '@/features/backup/backup-service';
import type { CollectionFileRepository } from '@/features/collection/file-repository';
import { createImageRepository } from '@/features/images/image-repository';
import {
  createLibraryFileStore,
  type LibraryFileStore,
} from '@/features/library/library-file-store';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import { createLibraryRepository } from '@/features/library/library-repository';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';
import {
  seedLibraryProtection,
  seedDeviceLibraryAsset,
  VIEW_TEST_ACCOUNT_SCOPE,
  viewDigest,
} from '@/features/library/library-view-test-support';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { SettingsRepository } from '@/features/settings/settings-repository';
import type { AppSettings, ImageCandidate } from '@/features/waifu/types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

jest.mock('expo-file-system', () => {
  const fileState = new Map<string, { bytes: Uint8Array; exists: boolean }>();
  const events: string[] = [];
  const directoryCreate = jest.fn();
  const fileDelete = jest.fn();
  const fileWrite = jest.fn();
  const pickFileAsync = jest.fn();

  class MockDirectory {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    create(options?: unknown) {
      events.push(`directory:create:${this.uri}`);
      directoryCreate(options);
    }

    get exists() {
      return true;
    }

    list() {
      const prefix = `${this.uri.replace(/\/$/u, '')}/`;
      return [...fileState.entries()]
        .filter(([uri, state]) => (
          state.exists
          && uri.startsWith(prefix)
          && !uri.slice(prefix.length).includes('/')
        ))
        .map(([uri]) => new MockFile(uri));
    }
  }

  class MockFile {
    readonly uri: string;
    readonly parentDirectory: MockDirectory;

    constructor(pathOrDirectory: string | MockDirectory, name?: string) {
      this.uri = typeof pathOrDirectory === 'string'
        ? pathOrDirectory
        : `${pathOrDirectory.uri.replace(/\/$/, '')}/${name ?? ''}`;
      this.parentDirectory = new MockDirectory(
        this.uri.slice(0, Math.max(0, this.uri.lastIndexOf('/'))) || '/',
      );
    }

    get exists() {
      return fileState.get(this.uri)?.exists === true;
    }

    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }

    create() {
      events.push(`file:create:${this.uri}`);
      fileState.set(this.uri, { bytes: new Uint8Array(), exists: true });
    }

    write(bytes: Uint8Array) {
      events.push(`file:write:${this.uri}`);
      fileWrite(this.uri, bytes);
      fileState.set(this.uri, { bytes: Uint8Array.from(bytes), exists: true });
    }

    async bytes() {
      return fileState.get(this.uri)?.bytes ?? new Uint8Array();
    }

    async copy(destination: MockFile) {
      events.push(`file:copy:${this.uri}:${destination.uri}`);
      const source = fileState.get(this.uri);
      if (source?.exists !== true) throw new Error('source file is missing');
      fileState.set(destination.uri, {
        bytes: Uint8Array.from(source.bytes),
        exists: true,
      });
    }

    delete() {
      events.push(`file:delete:${this.uri}`);
      fileDelete(this.uri);
      const current = fileState.get(this.uri);
      fileState.set(this.uri, {
        bytes: current?.bytes ?? new Uint8Array(),
        exists: false,
      });
    }
  }

  return {
    Directory: MockDirectory,
    File: Object.assign(MockFile, { pickFileAsync }),
    __mock: {
      directoryCreate,
      events,
      fileDelete,
      fileState,
      fileWrite,
      pickFileAsync,
    },
  };
});

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

type FakeDatabase = {
  name: string;
  closeAsync: jest.Mock<Promise<void>, []>;
  execAsync: jest.Mock<Promise<void>, [string]>;
  getAllAsync: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
  getFirstAsync: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  runAsync: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  serializeAsync: jest.Mock<Promise<Uint8Array>, []>;
  withTransactionAsync: jest.Mock<Promise<void>, [() => Promise<void>]>;
};

jest.mock('expo-sqlite', () => {
  const state = {
    archive: null as FakeDatabase | null,
    restored: null as FakeDatabase | null,
    original: null as FakeDatabase | null,
    liveDatabases: [] as FakeDatabase[],
  };
  const openDatabaseAsync = jest.fn(async (name: string) => {
    if (name.startsWith('restore-import-')) return state.archive;
    return state.liveDatabases.shift();
  });
  const deserializeDatabaseAsync = jest.fn(async (bytes: Uint8Array) => {
    return bytes[0] === 9 ? state.restored : state.original;
  });
  const backupDatabaseAsync = jest.fn(async () => undefined);

  return {
    defaultDatabaseDirectory: '/database',
    openDatabaseAsync,
    deserializeDatabaseAsync,
    backupDatabaseAsync,
    __mock: {
      backupDatabaseAsync,
      deserializeDatabaseAsync,
      openDatabaseAsync,
      state,
    },
  };
});

const mockFileSystem = jest.requireMock('expo-file-system').__mock as {
  directoryCreate: jest.Mock;
  events: string[];
  fileDelete: jest.Mock;
  fileState: Map<string, { bytes: Uint8Array; exists: boolean }>;
  fileWrite: jest.Mock;
  pickFileAsync: jest.Mock;
};
const mockSQLite = jest.requireMock('expo-sqlite').__mock as {
  backupDatabaseAsync: jest.Mock;
  deserializeDatabaseAsync: jest.Mock;
  openDatabaseAsync: jest.Mock;
  state: {
    archive: FakeDatabase | null;
    restored: FakeDatabase | null;
    original: FakeDatabase | null;
    liveDatabases: FakeDatabase[];
  };
};
const mockSharing = jest.requireMock('expo-sharing') as {
  isAvailableAsync: jest.Mock;
  shareAsync: jest.Mock;
};

const manifestRow = {
  format_version: 1,
  application_id: 'app.waifudeck.mobile',
  app_version: '1.2.3',
  created_at: 123,
  image_count: 2,
  file_count: 2,
  total_file_bytes: 5,
};

const restoredSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  language: 'ja',
};

function fakeDatabase(name: string): FakeDatabase {
  return {
    name,
    closeAsync: jest.fn(async () => undefined),
    execAsync: jest.fn(async (_query: string) => undefined),
    getAllAsync: jest.fn(async (_query: string, _params?: unknown[]) => []),
    getFirstAsync: jest.fn(async (_query: string, _params?: unknown[]) => null),
    runAsync: jest.fn(async (_query: string, _params?: unknown[]) => undefined),
    serializeAsync: jest.fn(async () => Uint8Array.from([7])),
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => task()),
  };
}

function selectedBackup() {
  return {
    canceled: false,
    result: {
      copy: jest.fn(async (destination: { uri: string }) => {
        mockFileSystem.events.push(`selection:copy:${destination.uri}`);
        mockFileSystem.fileState.set(destination.uri, {
          bytes: Uint8Array.from([1]),
          exists: true,
        });
      }),
    },
  };
}

function createHarness(options: {
  adultCount?: number;
  allowsAdultContent?: boolean;
  archiveFileCount?: number;
  archivedFiles?: Record<number, { data: Uint8Array; byteSize?: number }>;
  copier?: (archiveUri: string, imageId: number, destinationUri: string) => Promise<number>;
  currentSettings?: AppSettings;
  databaseVersion?: number;
  exportImageCount?: number;
  exportSavedImageCount?: number;
  exportSavedImages?: { id: number; extension: string; local_uri: string | null }[];
  hasContentRating?: boolean;
  manifest?: typeof manifestRow;
  restoredSettings?: AppSettings;
  savedImages?: {
    id: number;
    extension: string;
    local_uri: string | null;
    download_state?: string;
  }[];
  database?: SqlDatabasePort;
  libraryFiles?: Pick<LibraryFileStore, 'deleteUnnamedFiles'>;
  restoredLibraryUris?: string[];
  restoredLibraryColumns?: string[];
} = {}) {
  const archive = fakeDatabase('archive');
  const restored = fakeDatabase('restored');
  const original = fakeDatabase('original');
  const liveForSnapshot = fakeDatabase('live-snapshot');
  const liveForApply = fakeDatabase('live-apply');
  const liveForRollback = fakeDatabase('live-rollback');
  const savedImages = options.savedImages ?? [{
    id: 41,
    extension: 'jpg',
    local_uri: 'file:///collection/old-41.jpg',
  }];
  const archivedFiles = options.archivedFiles ?? {
    41: { data: Uint8Array.from([1, 2, 3]) },
  };

  archive.getFirstAsync.mockImplementation(async (query, params) => {
    if (query.includes('COUNT(*)') && query.includes('backup_files')) {
      return { count: options.archiveFileCount ?? (options.manifest ?? manifestRow).file_count };
    }
    if (query.includes('backup_manifest')) return options.manifest ?? manifestRow;
    if (query.includes('backup_payload') && params?.[0] === 'settings') {
      return {
        text_value: JSON.stringify(options.restoredSettings ?? restoredSettings),
        blob_value: null,
      };
    }
    if (query.includes('backup_payload') && params?.[0] === 'app-database') {
      return { text_value: null, blob_value: Uint8Array.from([9]) };
    }
    if (query.includes('backup_files')) {
      const file = archivedFiles[Number(params?.[0])];
      if (!file) return null;
      return {
        extension: 'jpg',
        byte_size: file.byteSize ?? file.data.byteLength,
        data: file.data,
      };
    }
    return null;
  });
  restored.getFirstAsync.mockImplementation(async (query) => {
    if (query.includes('PRAGMA quick_check')) return { quick_check: 'ok' };
    if (query.includes('PRAGMA user_version')) {
      return { user_version: options.databaseVersion ?? 8 };
    }
    if (query.includes('SELECT COUNT(*) AS count')) {
      return { count: options.adultCount ?? 0 };
    }
    return null;
  });
  restored.getAllAsync.mockImplementation(async (query) => {
    if (query.includes('PRAGMA table_info(images)')) {
      return options.hasContentRating === false
        ? [{ name: 'id' }, { name: 'is_nsfw' }]
        : [{ name: 'id' }, { name: 'is_nsfw' }, { name: 'content_rating' }];
    }
    if (query.includes('PRAGMA table_info(device_library_assets)')) {
      return (options.restoredLibraryColumns ?? []).map((name) => ({ name }));
    }
    if (query === RESTORE_SAVED_IMAGES_SQL) return savedImages;
    throw new Error(`Restored snapshot double has no rows for query: ${query}`);
  });

  liveForRollback.getAllAsync.mockImplementation(async (query) => {
    if (query === RESTORED_LIBRARY_FILE_URIS_SQL) {
      return (options.restoredLibraryUris ?? []).map((uri) => ({ uri }));
    }
    return [];
  });

  mockSQLite.state.archive = archive;
  mockSQLite.state.restored = restored;
  mockSQLite.state.original = original;
  mockSQLite.state.liveDatabases = [liveForSnapshot, liveForApply, liveForRollback];

  const settingsRepository: SettingsRepository = {
    load: jest.fn(async () => options.currentSettings ?? DEFAULT_SETTINGS),
    save: jest.fn(async (value) => value as AppSettings),
    reset: jest.fn(async () => undefined),
  };
  const fileRepository = {
    pathFor: jest.fn(({ id, extension }: { id: number; extension: string }) =>
      `file:///collection/${id}.${extension}`),
    reconcile: jest.fn(async () => ({ deleted: [], failed: [] })),
  } as unknown as CollectionFileRepository;
  const queryDatabase = {
    getFirst: jest.fn(async (query: string) => ({
      count: query.includes("decision = 'saved'")
        ? options.exportSavedImageCount ?? options.exportSavedImages?.length ?? 0
        : options.exportImageCount ?? 0,
    })),
    getAll: jest.fn(async () => options.exportSavedImages ?? []),
  };
  const database = options.database ?? queryDatabase;

  const backupInput = {
      database: database as never,
      settingsRepository,
      fileRepository,
      appVersion: '1.2.3',
      allowsAdultContent: options.allowsAdultContent,
      libraryFiles: options.libraryFiles,
      ...(options.copier === undefined ? {} : { copyArchivedFile: options.copier }),
    } as Parameters<typeof createAppBackupService>[0];

  return {
    service: createAppBackupService(backupInput),
    archive,
    restored,
    original,
    liveForSnapshot,
    liveForApply,
    liveForRollback,
    settingsRepository,
    fileRepository,
    database: queryDatabase,
  };
}

function ownedCandidate(tag: string): ImageCandidate {
  return {
    providerKey: 'waifu_im',
    providerItemId: `library-owned-${tag}`,
    canonicalSourceKey: `url:https://example.com/library-owned/${tag}`,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/library-owned/${tag}.jpg`,
    sourceUrl: `https://example.com/library-owned/${tag}`,
    artistName: null,
    artistUrl: null,
    width: 800,
    height: 600,
    byteSize: 100,
    extension: 'jpg',
    dominantColor: '#000000',
    isNsfw: false,
    isAnimated: false,
    tags: [],
  };
}

async function libraryOwnedFixture() {
  const nativeDatabase = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(nativeDatabase);
  await migrateDatabase(database);
  const images = createImageRepository(database);

  const ready = await images.saveCandidate(ownedCandidate('ready'), 1_000);
  const readyUri = `file:///collection/${ready.id}.jpg`;
  if (!await images.markDownloadReady(ready.id, readyUri)) {
    throw new Error('ready row did not become ready');
  }
  mockFileSystem.fileState.set(readyUri, {
    bytes: Uint8Array.from([1, 2]),
    exists: true,
  });

  const onDevice = await images.saveMirroredCandidate(ownedCandidate('on-device'), 1_001);
  const onDeviceDigest = viewDigest('on-device');
  await seedDeviceLibraryAsset(database, {
    plaintextSha256: onDeviceDigest,
    origin: 'provider',
    sourceImageId: onDevice.id,
    createdAt: 2_000,
  });
  mockFileSystem.fileState.set(
    `file:///data/library/originals/${onDeviceDigest}.jpg`,
    { bytes: Uint8Array.from([3, 4, 5]), exists: true },
  );
  // Older original of the same image, other bytes. The archive keeps the newest.
  const olderDigest = viewDigest('on-device-older');
  const olderUri = `file:///data/library/originals/${olderDigest}.jpg`;
  await seedDeviceLibraryAsset(database, {
    plaintextSha256: olderDigest,
    origin: 'provider',
    sourceImageId: onDevice.id,
    createdAt: 1_000,
    localOriginalUri: olderUri,
  });
  mockFileSystem.fileState.set(olderUri, {
    bytes: Uint8Array.from([4, 4, 4, 4]),
    exists: true,
  });

  const cloudOnly = await images.saveMirroredCandidate(ownedCandidate('cloud-only'), 1_002);
  await seedDeviceLibraryAsset(database, {
    plaintextSha256: viewDigest('cloud-only'),
    origin: 'provider',
    sourceImageId: cloudOnly.id,
    residency: 'cloud-only',
  });

  const fileGone = await images.saveMirroredCandidate(ownedCandidate('file-gone'), 1_003);
  await seedDeviceLibraryAsset(database, {
    plaintextSha256: viewDigest('file-gone'),
    origin: 'provider',
    sourceImageId: fileGone.id,
  });

  const flagged = await images.saveMirroredCandidate(ownedCandidate('flagged'), 1_004);
  const flaggedDigest = viewDigest('flagged');
  await seedDeviceLibraryAsset(database, {
    plaintextSha256: flaggedDigest,
    origin: 'provider',
    sourceImageId: flagged.id,
    missingOriginalSince: 1,
  });
  mockFileSystem.fileState.set(
    `file:///data/library/originals/${flaggedDigest}.jpg`,
    { bytes: Uint8Array.from([6, 7, 8, 9, 10]), exists: true },
  );

  return {
    database,
    close: () => nativeDatabase.close(),
    ids: {
      ready: ready.id,
      onDevice: onDevice.id,
      cloudOnly: cloudOnly.id,
      fileGone: fileGone.id,
      flagged: flagged.id,
    },
  };
}

function stagedUris(id = 41): string[] {
  const suffix = `-restore-123-${id}.jpg`;
  const writes = mockFileSystem.events
    .filter((event) => event.startsWith('file:write:file:///collection/restore-stage-'))
    .map((event) => event.slice('file:write:'.length))
    .filter((uri) => uri.endsWith(suffix));
  if (writes.length > 0) return writes;
  return mockFileSystem.events
    .filter((event) => event.startsWith('file:create:file:///collection/restore-stage-'))
    .map((event) => event.slice('file:create:'.length))
    .filter((uri) => uri.endsWith(suffix));
}

function stagedUri(id = 41, occurrence = 0): string {
  const uri = stagedUris(id)[occurrence];
  if (!uri) throw new Error(`Missing staged URI for image ${id} at ${occurrence}.`);
  return uri;
}

describe('backup artifact cleanup', () => {
  beforeEach(() => {
    mockFileSystem.fileState.clear();
    mockFileSystem.events.length = 0;
    mockFileSystem.fileDelete.mockReset();
  });

  test('the sweep deletes exactly the leftover backup files', async () => {
    const names = [
      'waifu-deck-2026-10-01-1790850945745.waifudeck',
      'waifu-deck-2026-10-01-1790850945745.waifudeck-journal',
      'restore-import-1790850945725.waifudeck',
      'restore-import-1790850945725.waifudeck-wal',
      'restore-import-1790850945725.waifudeck-shm',
      'backup-snapshot-1790850945700.db',
      'backup-snapshot-1790850945700.db-wal',
      'waifu-deck.db',
      'waifu-deck.db-wal',
      'waifu-deck.db-shm',
      'ExpoSQLiteStorage',
      'restore-import-notes.txt',
      'backup-snapshot-x.db',
      'x-restore-import-1790850945725.waifudeck',
      'restore-import-1790850945725.waifudeck.bak',
    ];
    for (const name of names) {
      mockFileSystem.fileState.set(`file:///database/${name}`, {
        bytes: new Uint8Array(),
        exists: true,
      });
    }

    await expect(sweepBackupArtifacts()).resolves.toEqual(expect.objectContaining({
      deleted: expect.arrayContaining(names.slice(0, 7).map((name) => `file:///database/${name}`)),
      failed: [],
    }));

    const remaining = [...mockFileSystem.fileState.entries()]
      .filter(([, state]) => state.exists)
      .map(([uri]) => uri.slice(uri.lastIndexOf('/') + 1))
      .sort();
    expect(remaining).toEqual([
      'ExpoSQLiteStorage',
      'backup-snapshot-x.db',
      'restore-import-1790850945725.waifudeck.bak',
      'restore-import-notes.txt',
      'waifu-deck.db',
      'waifu-deck.db-shm',
      'waifu-deck.db-wal',
      'x-restore-import-1790850945725.waifudeck',
    ]);
  });

  test('the sweep matches names produced by the backup builders', async () => {
    const names = [
      archiveName(1790850945745),
      restoreImportName(1790850945725),
      backupSnapshotName(1790850945700),
    ];
    for (const name of names) {
      mockFileSystem.fileState.set(`file:///database/${name}`, {
        bytes: new Uint8Array(),
        exists: true,
      });
    }

    await expect(sweepBackupArtifacts()).resolves.toEqual(expect.objectContaining({
      deleted: expect.arrayContaining(names.map((name) => `file:///database/${name}`)),
      failed: [],
    }));
  });

  test('a file that cannot be deleted does not stop the rest, and is reported', async () => {
    const failedUri = 'file:///database/restore-import-1790850945725.waifudeck-wal';
    const otherUri = 'file:///database/backup-snapshot-1790850945700.db';
    for (const uri of [failedUri, otherUri]) {
      mockFileSystem.fileState.set(uri, { bytes: new Uint8Array(), exists: true });
    }
    mockFileSystem.fileDelete.mockImplementation((uri: string) => {
      if (uri === failedUri) throw new Error('busy');
    });

    await expect(sweepBackupArtifacts()).resolves.toEqual({
      deleted: [otherUri],
      failed: [{
        uri: failedUri,
        error: { code: 'delete_failed', message: 'busy' },
      }],
    });
    expect(mockFileSystem.fileState.get(otherUri)?.exists).toBe(false);
    expect(mockFileSystem.fileState.get(failedUri)?.exists).toBe(true);
  });
});

describe('backup service destructive restore safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFileSystem.fileState.clear();
    mockFileSystem.events.length = 0;
    mockFileSystem.fileDelete.mockReset();
    mockFileSystem.fileWrite.mockReset();
    mockSQLite.state.archive = null;
    mockSQLite.state.restored = null;
    mockSQLite.state.original = null;
    mockSQLite.state.liveDatabases = [];
    mockFileSystem.pickFileAsync.mockResolvedValue({ canceled: true });
    mockSharing.isAvailableAsync.mockResolvedValue(true);
    mockSharing.shareAsync.mockResolvedValue(undefined);
  });

  // K7 cut 8 (audit ㊲): Cloud Vault v2 is rescinded and its Worker is gone, so
  // the temporary-archive subsystem that only ever fed it must not exist.
  it('carries no Cloud-Vault-v2 temporary-archive subsystem', () => {
    const exported = Object.keys(backupServiceModule);

    expect(exported.filter((name) => name.startsWith('VAULT_V2_'))).toEqual([]);
    expect(exported).not.toContain('createPreparedAppBackupArchivePort');
    expect(exported).not.toContain('createTemporaryAppBackupArchiveCleanupPort');
    expect(createHarness().service).not.toHaveProperty('createVaultArchive');
  });

  it('exports only strict-safe rows and normalized settings from the Store distribution', async () => {
    const harness = createHarness({
      allowsAdultContent: false,
      currentSettings: {
        ...DEFAULT_SETTINGS,
        nsfwMode: 'nsfw',
        nsfwConfirmed: true,
        blurNsfwThumbnails: false,
      },
      exportImageCount: 1,
      exportSavedImages: [],
    });

    await expect(harness.service.createAndShare()).resolves.toMatchObject({
      imageCount: 1,
      fileCount: 0,
      missingFileCount: 0,
    });

    expect(harness.liveForApply.runAsync).toHaveBeenCalledWith(
      expect.stringContaining(
        "is_nsfw = 0 AND content_rating = 'safe'",
      ),
    );
    expect(harness.database.getFirst).toHaveBeenCalledWith(
      expect.stringContaining(
        "is_nsfw = 0 AND content_rating = 'safe'",
      ),
    );
    expect(harness.database.getAll).toHaveBeenCalledWith(
      expect.stringContaining(
        "is_nsfw = 0 AND content_rating = 'safe'",
      ),
    );
    expect(harness.liveForRollback.runAsync).toHaveBeenCalledWith(
      'INSERT INTO backup_payload (key, text_value) VALUES (?, ?)',
      ['settings', JSON.stringify({
        ...DEFAULT_SETTINGS,
        nsfwMode: 'sfw',
        nsfwConfirmed: false,
        blurNsfwThumbnails: true,
      })],
    );
    expect(mockSharing.shareAsync).toHaveBeenCalledWith(
      expect.stringMatching(/waifu-deck-.*\.waifudeck$/),
      expect.objectContaining({ mimeType: 'application/octet-stream' }),
    );
  });

  it('keeps a prepared archive until its owner disposes it', async () => {
    const harness = createHarness({
      exportImageCount: 1,
      exportSavedImages: [],
    });

    const prepared = await harness.service.createArchive();

    expect(prepared.uri).toMatch(/\/waifu-deck-\d{4}-\d{2}-\d{2}-/u);
    expect(prepared.summary).toMatchObject({
      imageCount: 1,
      fileCount: 0,
      missingFileCount: 0,
    });
    expect(mockSharing.shareAsync).not.toHaveBeenCalled();
    expect(mockFileSystem.events).not.toContain(`file:delete:${prepared.uri}`);
    mockFileSystem.fileState.set(prepared.uri, {
      bytes: Uint8Array.from([1]),
      exists: true,
    });

    await prepared.dispose();
    await prepared.dispose();

    expect(mockFileSystem.fileState.get(prepared.uri)?.exists).toBe(false);
    expect(
      mockFileSystem.events.filter((event) => event === `file:delete:${prepared.uri}`),
    ).toHaveLength(1);
  });

  it('wraps an export failure and removes the partial archive file', async () => {
    const harness = createHarness({
      exportImageCount: 1,
      exportSavedImages: [],
    });
    let archiveUri = '';
    harness.liveForRollback.runAsync.mockImplementationOnce(async () => {
      const archiveName = mockSQLite.openDatabaseAsync.mock.calls
        .map(([name]) => name as string)
        .find((name) => name.startsWith('waifu-deck-'));
      archiveUri = `file:///database/${archiveName}`;
      mockFileSystem.fileState.set(archiveUri, {
        bytes: Uint8Array.from([1]),
        exists: true,
      });
      throw new Error('archive write failed');
    });

    await expect(harness.service.createArchive()).rejects.toThrow(
      'Backup failed while creating the backup archive: archive write failed',
    );

    expect(harness.liveForRollback.closeAsync).toHaveBeenCalledTimes(1);
    expect(mockFileSystem.events).toContain(`file:delete:${archiveUri}`);
    expect(mockFileSystem.fileState.get(archiveUri)?.exists).toBe(false);
  });

  it('retries prepared archive deletion after a transient filesystem failure', async () => {
    const harness = createHarness({
      exportImageCount: 1,
      exportSavedImages: [],
    });
    const prepared = await harness.service.createArchive();
    mockFileSystem.fileState.set(prepared.uri, {
      bytes: Uint8Array.from([1]),
      exists: true,
    });
    mockFileSystem.fileDelete.mockImplementationOnce(() => {
      throw new Error('filesystem busy');
    });

    await expect(prepared.dispose()).rejects.toThrow('filesystem busy');
    await expect(prepared.dispose()).resolves.toBeUndefined();

    expect(mockFileSystem.fileDelete).toHaveBeenCalledTimes(2);
    expect(mockFileSystem.fileState.get(prepared.uri)?.exists).toBe(false);
  });

  it('reports saved rows whose private originals are not ready for the archive', async () => {
    const harness = createHarness({
      exportImageCount: 3,
      exportSavedImageCount: 2,
      exportSavedImages: [],
    });

    const prepared = await harness.service.createArchive();

    expect(prepared.summary).toMatchObject({
      imageCount: 3,
      fileCount: 0,
      missingFileCount: 2,
    });
    await prepared.dispose();
  });

  it('archives a mirrored row from its library original; omitted cloud rows are missing until the cloud projection proves otherwise', async () => {
    const fixture = await libraryOwnedFixture();
    try {
      const harness = createHarness({
        database: fixture.database,
        allowsAdultContent: true,
      });
      const inserted: unknown[][] = [];
      harness.liveForRollback.runAsync.mockImplementation(async (query: string, params?: unknown[]) => {
        if (query.includes('INSERT INTO backup_files')) inserted.push(params ?? []);
      });

      const prepared = await harness.service.createArchive();

      // [image id, byte size]: the collection file (2 bytes) and the library original (3 bytes).
      expect(inserted.map((params) => [params[0], params[2]])).toEqual([
        [fixture.ids.ready, 2],
        [fixture.ids.onDevice, 3],
      ]);
      // Archivable per the database: ready, onDevice, fileGone (whose file is absent → missing 1).
      expect(prepared.summary).toMatchObject({
        imageCount: 5,
        fileCount: 2,
        missingFileCount: 3,
        cloudOnlyCount: 0,
      });
      await prepared.dispose();
    } finally {
      fixture.close();
    }
  });

  test.each([
    {
      name: 'none seeded',
      seed: async (_database: SqlDatabasePort) => undefined,
      expected: { cloudOnlyCount: 0, missingFileCount: 4 },
    },
    {
      name: 'cloud-only and flagged originals in the last scope',
      seed: async (database: SqlDatabasePort) => {
        await seedLibraryProtection(database, {
          plaintextSha256: viewDigest('cloud-only'),
          accountScope: VIEW_TEST_ACCOUNT_SCOPE,
          originalGenerationId: 'g1',
        });
        await seedLibraryProtection(database, {
          plaintextSha256: viewDigest('flagged'),
          accountScope: VIEW_TEST_ACCOUNT_SCOPE,
          originalGenerationId: 'g1',
        });
      },
      expected: { cloudOnlyCount: 2, missingFileCount: 2 },
    },
    {
      name: 'flagged original has no cloud generation',
      seed: async (database: SqlDatabasePort) => {
        await seedLibraryProtection(database, {
          plaintextSha256: viewDigest('cloud-only'),
          accountScope: VIEW_TEST_ACCOUNT_SCOPE,
          originalGenerationId: 'g1',
        });
        await seedLibraryProtection(database, {
          plaintextSha256: viewDigest('flagged'),
          accountScope: VIEW_TEST_ACCOUNT_SCOPE,
          originalGenerationId: null,
        });
      },
      expected: { cloudOnlyCount: 1, missingFileCount: 3 },
    },
    {
      name: 'the newest account scope decides',
      seed: async (database: SqlDatabasePort) => {
        await seedLibraryProtection(database, {
          plaintextSha256: viewDigest('cloud-only'),
          accountScope: 'old',
          originalGenerationId: 'g1',
          updatedAt: 1_000,
        });
        await seedLibraryProtection(database, {
          plaintextSha256: viewDigest('flagged'),
          accountScope: 'old',
          originalGenerationId: 'g1',
          updatedAt: 1_000,
        });
        await seedLibraryProtection(database, {
          plaintextSha256: viewDigest('cloud-only'),
          accountScope: 'new',
          originalGenerationId: 'g1',
          updatedAt: 2_000,
        });
      },
      expected: { cloudOnlyCount: 1, missingFileCount: 3 },
    },
  ])('only the omitted rows the cloud holds are cloud-only; the rest are missing: $name', async ({ seed, expected }) => {
    const fixture = await libraryOwnedFixture();
    try {
      const images = createImageRepository(fixture.database);
      await images.saveMirroredCandidate(ownedCandidate('no-library-row'), 1_005);
      await seed(fixture.database);

      const harness = createHarness({
        database: fixture.database,
        allowsAdultContent: true,
      });
      const prepared = await harness.service.createArchive();

      expect(prepared.summary).toMatchObject({
        imageCount: 6,
        fileCount: 2,
        missingFileCount: expected.missingFileCount,
        cloudOnlyCount: expected.cloudOnlyCount,
      });
      await prepared.dispose();
    } finally {
      fixture.close();
    }
  });

  it('the restore selection returns every saved row with its download state', async () => {
    const fixture = await libraryOwnedFixture();
    try {
      const rows = await fixture.database.getAll<{ id: number; download_state: string }>(
        RESTORE_SAVED_IMAGES_SQL,
      );
      expect(rows.map((row) => [row.id, row.download_state])).toEqual([
        [fixture.ids.ready, 'ready'],
        [fixture.ids.onDevice, 'mirrored'],
        [fixture.ids.cloudOnly, 'mirrored'],
        [fixture.ids.fileGone, 'mirrored'],
        [fixture.ids.flagged, 'mirrored'],
      ]);
    } finally {
      fixture.close();
    }
  });

  it('prepares a restore from a caller-provided file URI without opening the picker', async () => {
    const harness = createHarness();
    const sourceUri = 'file:///cloud/decrypted.waifudeck';
    mockFileSystem.fileState.set(sourceUri, {
      bytes: Uint8Array.from([1]),
      exists: true,
    });

    const prepared = await harness.service.prepareRestoreFromUri(sourceUri);

    expect(prepared.summary).toMatchObject({
      restoredFileCount: 1,
      missingFileCount: 0,
    });
    expect(mockFileSystem.pickFileAsync).not.toHaveBeenCalled();
    expect(mockFileSystem.events).toContainEqual(
      expect.stringMatching(
        /^file:copy:file:\/\/\/cloud\/decrypted\.waifudeck:file:\/\/\/database\/restore-import-/,
      ),
    );

    await prepared.dispose();
  });

  it('treats picker cancellation as a complete no-op', async () => {
    const harness = createHarness();

    await expect(harness.service.pickAndPrepareRestore()).resolves.toBeNull();

    expect(mockSQLite.openDatabaseAsync).not.toHaveBeenCalled();
    expect(mockSQLite.deserializeDatabaseAsync).not.toHaveBeenCalled();
    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.load).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();
    expect(mockFileSystem.events).toEqual([]);
  });

  it('removes a partial imported file when the system copy fails', async () => {
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue({
      canceled: false,
      result: {
        copy: jest.fn(async (destination: { uri: string }) => {
          mockFileSystem.fileState.set(destination.uri, {
            bytes: Uint8Array.from([1]),
            exists: true,
          });
          throw new Error('copy interrupted');
        }),
      },
    });

    await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
      'Restore failed while copying the selected backup: copy interrupted',
    );

    const imported = [...mockFileSystem.fileState.entries()].find(([uri]) => (
      uri.includes('restore-import-')
    ));
    expect(imported?.[1].exists).toBe(false);
    expect(mockSQLite.openDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();
  });

  it('rejects a damaged archive without touching live data or collection files', async () => {
    const harness = createHarness();
    const answer = harness.archive.getFirstAsync.getMockImplementation()!;
    harness.archive.getFirstAsync.mockImplementation(async (query, params) => {
      if (query.includes('FROM backup_files') && query.includes('WHERE image_id')) {
        throw new Error('database disk image is malformed');
      }
      return answer(query, params);
    });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
      'Restore failed while restoring collection image 41: database disk image is malformed',
    );

    expect(mockSQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.load).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();
    expect(harness.fileRepository.pathFor).not.toHaveBeenCalled();
    expect(mockFileSystem.events.filter((event) => event.startsWith('file:write:'))).toEqual([]);
    expect(mockFileSystem.events.at(-1)).toMatch(/^file:delete:file:\/\/\/database\/restore-import-/);
  });

  it('rejects a foreign backup before reading payloads or live state', async () => {
    const harness = createHarness({
      manifest: {
        ...manifestRow,
        application_id: 'example.other.app',
      },
    });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
      'Restore failed while reading the backup manifest: This backup belongs to a different application.',
    );

    expect(harness.archive.getFirstAsync).toHaveBeenCalledTimes(1);
    expect(mockSQLite.deserializeDatabaseAsync).not.toHaveBeenCalled();
    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.load).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();
    expect(harness.fileRepository.pathFor).not.toHaveBeenCalled();
    expect(mockFileSystem.events.filter((event) => event.startsWith('file:write:'))).toEqual([]);
  });

  it('fully validates and stages a restore before apply mutates live state', async () => {
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    const prepared = await harness.service.pickAndPrepareRestore();

    expect(prepared).not.toBeNull();
    expect(harness.restored.getFirstAsync).toHaveBeenCalledWith('PRAGMA quick_check');
    expect(harness.restored.getFirstAsync).toHaveBeenCalledWith('PRAGMA user_version');
    expect(mockFileSystem.fileState.get(stagedUri())).toEqual({
      bytes: Uint8Array.from([1, 2, 3]),
      exists: true,
    });
    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();

    await expect(prepared!.apply()).resolves.toEqual(restoredSettings);

    expect(mockSQLite.backupDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(mockSQLite.backupDatabaseAsync).toHaveBeenCalledWith(expect.objectContaining({
      sourceDatabase: harness.restored,
      destDatabase: harness.liveForApply,
    }));
    expect(harness.settingsRepository.save).toHaveBeenCalledWith(restoredSettings);
    expect(harness.fileRepository.reconcile).toHaveBeenCalledWith([stagedUri()]);
    expect(mockFileSystem.fileState.get(stagedUri())?.exists).toBe(true);
  });

  it('rejects external full restores before opening the picker in the Store distribution', async () => {
    const harness = createHarness({
      allowsAdultContent: false,
    });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
      'Full backup restore is unavailable in the Store distribution.',
    );
    expect(mockFileSystem.pickFileAsync).not.toHaveBeenCalled();
    expect(mockSQLite.openDatabaseAsync).not.toHaveBeenCalled();
    expect(mockSQLite.deserializeDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.load).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();
  });

  it('disposes a prepared restore without committing and removes staged files', async () => {
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
    const prepared = await harness.service.pickAndPrepareRestore();

    await prepared!.dispose();
    await prepared!.dispose();

    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();
    expect(mockFileSystem.fileState.get(stagedUri())?.exists).toBe(false);
    expect(mockFileSystem.events.filter((event) => event === `file:delete:${stagedUri()}`)).toHaveLength(1);
  });

  it('uses a fresh staging namespace when the same backup is imported again', async () => {
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
    const firstPrepared = await harness.service.pickAndPrepareRestore();

    await firstPrepared!.apply();
    const firstUri = stagedUri(41, 0);
    expect(mockFileSystem.fileState.get(firstUri)?.exists).toBe(true);

    const secondPrepared = await harness.service.pickAndPrepareRestore();
    const secondUri = stagedUri(41, 1);
    expect(secondUri).not.toBe(firstUri);

    await secondPrepared!.dispose();

    expect(mockFileSystem.fileState.get(firstUri)).toEqual({
      bytes: Uint8Array.from([1, 2, 3]),
      exists: true,
    });
    expect(mockFileSystem.fileState.get(secondUri)?.exists).toBe(false);
  });

  it('registers and removes a staged file when writing it fails partially', async () => {
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
    mockFileSystem.fileWrite.mockImplementationOnce((uri: string) => {
      mockFileSystem.fileState.set(uri, {
        bytes: Uint8Array.from([1]),
        exists: true,
      });
      throw new Error('write interrupted');
    });

    await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
      'Restore failed while restoring collection image 41: write interrupted',
    );

    const partialUri = stagedUri();
    expect(mockFileSystem.fileState.get(partialUri)).toEqual({
      bytes: Uint8Array.from([1]),
      exists: false,
    });
    expect(mockFileSystem.events).toContain(`file:delete:${partialUri}`);
    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
  });

  it('cleans earlier staged files when a later archived image is incomplete', async () => {
    const harness = createHarness({
      savedImages: [
        { id: 41, extension: 'jpg', local_uri: null },
        { id: 42, extension: 'jpg', local_uri: null },
      ],
      archivedFiles: {
        41: { data: Uint8Array.from([1, 2, 3]) },
        42: { data: Uint8Array.from([4]), byteSize: 2 },
      },
    });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
      'Restore failed while restoring collection image 42: Backup image 42 is incomplete.',
    );

    expect(mockFileSystem.fileState.get(stagedUri(41))?.exists).toBe(false);
    expect(stagedUris(42)).toEqual([]);
    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.load).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();
  });

  it('rolls database and settings back and cleans staged files when apply fails', async () => {
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
    const prepared = await harness.service.pickAndPrepareRestore();
    (harness.settingsRepository.save as jest.Mock)
      .mockRejectedValueOnce(new Error('settings write failed'))
      .mockResolvedValueOnce(DEFAULT_SETTINGS);

    await expect(prepared!.apply()).rejects.toThrow('settings write failed');

    expect(mockSQLite.backupDatabaseAsync).toHaveBeenCalledTimes(2);
    expect(mockSQLite.backupDatabaseAsync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceDatabase: harness.restored,
      destDatabase: harness.liveForApply,
    }));
    expect(mockSQLite.backupDatabaseAsync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceDatabase: harness.original,
      destDatabase: harness.liveForRollback,
    }));
    expect(harness.settingsRepository.save).toHaveBeenNthCalledWith(1, restoredSettings);
    expect(harness.settingsRepository.save).toHaveBeenNthCalledWith(2, DEFAULT_SETTINGS);
    expect(harness.fileRepository.reconcile).not.toHaveBeenCalled();
    expect(mockFileSystem.fileState.get(stagedUri())?.exists).toBe(false);
  });

  it('captures rollback data at apply time after live data changes', async () => {
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
    const prepared = await harness.service.pickAndPrepareRestore();
    const changedSettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      prefetchDepth: 60,
    };

    expect(harness.settingsRepository.load).not.toHaveBeenCalled();
    expect(harness.liveForSnapshot.serializeAsync).not.toHaveBeenCalled();
    harness.liveForSnapshot.serializeAsync.mockResolvedValue(Uint8Array.from([8]));
    (harness.settingsRepository.load as jest.Mock).mockResolvedValue(changedSettings);
    (harness.settingsRepository.save as jest.Mock)
      .mockRejectedValueOnce(new Error('settings write failed'))
      .mockResolvedValueOnce(changedSettings);

    await expect(prepared!.apply()).rejects.toThrow('settings write failed');

    expect(harness.liveForSnapshot.serializeAsync).toHaveBeenCalledTimes(1);
    expect(mockSQLite.deserializeDatabaseAsync).toHaveBeenNthCalledWith(
      2,
      Uint8Array.from([8]),
    );
    expect(harness.settingsRepository.save).toHaveBeenNthCalledWith(2, changedSettings);
    expect(mockFileSystem.fileState.get(stagedUri())?.exists).toBe(false);
  });

  it('an archived file restores a mirrored row as a ready collection file', async () => {
    const harness = createHarness({
      savedImages: [{
        id: 41,
        extension: 'jpg',
        local_uri: null,
        download_state: 'mirrored',
      }],
    });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    const prepared = await harness.service.pickAndPrepareRestore();

    expect(prepared).not.toBeNull();
    expect(prepared!.summary).toMatchObject({
      restoredFileCount: 1,
      missingFileCount: 0,
    });
    expect(harness.restored.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("download_state = 'ready'"),
      [stagedUri(41), 41],
    );
    await prepared!.dispose();
  });

  describe('Final F3: a restore copies archived files natively (board row 29)', () => {
    function nativeCopier(
      archivedFiles: Record<number, { data: Uint8Array; byteSize?: number }>,
      calls: [string, number, string][],
    ) {
      return jest.fn(async (archiveUri: string, imageId: number, destinationUri: string) => {
        calls.push([archiveUri, imageId, destinationUri]);
        const data = archivedFiles[imageId]?.data;
        if (data === undefined) throw new Error(`missing archived fixture ${imageId}`);
        mockFileSystem.events.push(`file:write:${destinationUri}`);
        mockFileSystem.fileState.set(destinationUri, {
          bytes: Uint8Array.from(data),
          exists: true,
        });
        return data.byteLength;
      });
    }

    it('with a native copier the restore never selects the data column and copies each archived file through it', async () => {
      const archivedFiles: Record<number, { data: Uint8Array; byteSize?: number }> = {
        41: { data: Uint8Array.from([1, 2, 3]) },
        42: { data: Uint8Array.from([4, 5]) },
      };
      const calls: [string, number, string][] = [];
      const harness = createHarness({
        savedImages: [
          { id: 41, extension: 'jpg', local_uri: null },
          { id: 42, extension: 'jpg', local_uri: null },
        ],
        archivedFiles,
        copier: nativeCopier(archivedFiles, calls),
      });
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

      const prepared = await harness.service.pickAndPrepareRestore();

      expect(prepared!.summary).toMatchObject({
        restoredFileCount: 2,
        missingFileCount: 0,
      });
      const fileQueries = harness.archive.getFirstAsync.mock.calls
        .map(([query]) => query)
        .filter((query) => query.includes('FROM backup_files') && query.includes('WHERE image_id'));
      expect(fileQueries).toHaveLength(2);
      expect(fileQueries.every((query) => !/\bdata\b/u.test(query))).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls.map(([, imageId]) => imageId)).toEqual([41, 42]);
      expect(calls.every(([archiveUri]) => /\/database\/restore-import-.*\.waifudeck$/u.test(archiveUri))).toBe(true);
      expect(calls.map(([, , destinationUri]) => destinationUri)).toEqual([
        stagedUri(41),
        stagedUri(42),
      ]);
      expect(harness.restored.runAsync).toHaveBeenCalledWith(
        expect.stringContaining("download_state = 'ready'"),
        [stagedUri(41), 41],
      );
      expect(harness.restored.runAsync).toHaveBeenCalledWith(
        expect.stringContaining("download_state = 'ready'"),
        [stagedUri(42), 42],
      );

      await prepared!.dispose();
    });

    it('a copier byte count that differs from byte_size fails the restore as incomplete and deletes the staged file', async () => {
      const calls: [string, number, string][] = [];
      const archivedFiles = { 41: { data: Uint8Array.from([1, 2, 3]) } };
      const copier = nativeCopier(archivedFiles, calls);
      copier.mockImplementationOnce(async (...args) => {
        await nativeCopier(archivedFiles, calls)(...args);
        return 2;
      });
      const harness = createHarness({ archivedFiles, copier });
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

      await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
        'Restore failed while restoring collection image 41: Backup image 41 is incomplete.',
      );

      expect(mockFileSystem.fileState.get(stagedUri())?.exists).toBe(false);
      expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    });

    it('a copier byte count larger than byte_size also fails the restore as incomplete', async () => {
      const calls: [string, number, string][] = [];
      const archivedFiles = { 41: { data: Uint8Array.from([1, 2, 3]) } };
      const copier = nativeCopier(archivedFiles, calls);
      copier.mockImplementationOnce(async (...args) => {
        await nativeCopier(archivedFiles, calls)(...args);
        return 4;
      });
      const harness = createHarness({ archivedFiles, copier });
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

      await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
        'Restore failed while restoring collection image 41: Backup image 41 is incomplete.',
      );

      expect(mockFileSystem.fileState.get(stagedUri())?.exists).toBe(false);
    });

    it("a copier rejection fails the restore at that image with its message and deletes every staged file", async () => {
      const calls: [string, number, string][] = [];
      const archivedFiles: Record<number, { data: Uint8Array; byteSize?: number }> = {
        41: { data: Uint8Array.from([1, 2, 3]) },
        42: { data: Uint8Array.from([4, 5]) },
      };
      const copier = nativeCopier(archivedFiles, calls);
      copier.mockImplementationOnce(async (...args) => {
        await nativeCopier(archivedFiles, calls)(...args);
        return archivedFiles[args[1]].data.byteLength;
      });
      copier.mockImplementationOnce(async (...args) => {
        await nativeCopier(archivedFiles, calls)(...args);
        throw new Error('native copy failed');
      });
      const harness = createHarness({
        savedImages: [
          { id: 41, extension: 'jpg', local_uri: null },
          { id: 42, extension: 'jpg', local_uri: null },
        ],
        archivedFiles,
        copier,
      });
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

      await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
        'Restore failed while restoring collection image 42: native copy failed',
      );

      expect(mockFileSystem.fileState.get(stagedUri(41))?.exists).toBe(false);
      expect(mockFileSystem.fileState.get(stagedUri(42))?.exists).toBe(false);
    });

    it('an empty archived file restores as an empty file without calling the copier', async () => {
      const archivedFiles = { 41: { data: new Uint8Array(0) } };
      const calls: [string, number, string][] = [];
      const copier = nativeCopier(archivedFiles, calls);
      const harness = createHarness({ archivedFiles, copier });
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

      const prepared = await harness.service.pickAndPrepareRestore();

      expect(copier).not.toHaveBeenCalled();
      expect(prepared!.summary.restoredFileCount).toBe(1);
      expect(harness.restored.runAsync).toHaveBeenCalledWith(
        expect.stringContaining("download_state = 'ready'"),
        [stagedUri(41), 41],
      );
      expect(mockFileSystem.fileState.get(stagedUri(41))).toEqual({
        bytes: new Uint8Array(0),
        exists: true,
      });

      await prepared!.dispose();
    });

    it('without a copier the restore still reads the data column', async () => {
      const harness = createHarness();
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

      const prepared = await harness.service.pickAndPrepareRestore();

      expect(harness.archive.getFirstAsync.mock.calls.some(([query]) => (
        query.includes('FROM backup_files')
        && query.includes('WHERE image_id')
        && /\bdata\b/u.test(query)
      ))).toBe(true);
      await prepared!.dispose();
    });
  });

  it('a mirrored row the archive has no file for keeps its state and is not missing', async () => {
    const harness = createHarness({
      archivedFiles: {},
      savedImages: [{
        id: 42,
        extension: 'jpg',
        local_uri: null,
        download_state: 'mirrored',
      }],
    });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    const prepared = await harness.service.pickAndPrepareRestore();

    expect(prepared).not.toBeNull();
    expect(prepared!.summary).toMatchObject({
      restoredFileCount: 0,
      missingFileCount: 0,
    });
    expect(harness.restored.runAsync.mock.calls.filter(([query]) => (
      String(query).includes('backup_file_missing')
    ))).toHaveLength(0);
    await prepared!.dispose();
  });

  it('board #5: a restored row with a missing archived file is classified transient, not source_gone', async () => {
    // WHY: the backup carried no file for this saved row, so the failure is a
    // backup problem, not a dead source. It must read as 'transient' so the
    // sweep gives the source one more attempt (spec §5, drift finding 1).
    const harness = createHarness({ archivedFiles: {} });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    const prepared = await harness.service.pickAndPrepareRestore();
    expect(prepared).not.toBeNull();

    const missingRewrite = harness.restored.runAsync.mock.calls
      .map(([query]) => query)
      .find((query) => query.includes('backup_file_missing'));
    expect(missingRewrite).toBeDefined();
    expect(missingRewrite).toMatch(/download_error_kind\s*=\s*'transient'/);

    await prepared!.dispose();
  });

  it('board #5: the restore-ready path clears download_error_kind together with download_error', async () => {
    // WHY: §4 invariant — every write that clears download_error must also
    // clear download_error_kind, or a stale kind survives the ready transition.
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    const prepared = await harness.service.pickAndPrepareRestore();
    expect(prepared).not.toBeNull();

    const readyWrite = harness.restored.runAsync.mock.calls
      .map(([query]) => query)
      .find((query) => query.includes("download_state = 'ready'") && query.includes('download_error = NULL'));
    expect(readyWrite).toBeDefined();
    expect(readyWrite).toMatch(/download_error_kind\s*=\s*NULL/);

    await prepared!.dispose();
  });

  it('K7 ㉛: packs every image in one transaction and never VACUUMs the fresh archive', async () => {
    const harness = createHarness({
      exportImageCount: 2,
      exportSavedImages: [
        { id: 41, extension: 'jpg', local_uri: 'file:///collection/41.jpg' },
        { id: 42, extension: 'jpg', local_uri: 'file:///collection/42.jpg' },
      ],
    });
    mockFileSystem.fileState.set('file:///collection/41.jpg', { bytes: Uint8Array.from([1, 2]), exists: true });
    mockFileSystem.fileState.set('file:///collection/42.jpg', { bytes: Uint8Array.from([3]), exists: true });
    const order: string[] = [];
    harness.liveForRollback.withTransactionAsync.mockImplementation(async (task) => {
      order.push('txn:begin');
      await task();
      order.push('txn:end');
    });
    harness.liveForRollback.runAsync.mockImplementation(async (query: string) => {
      if (query.includes('INSERT INTO backup_files')) order.push('insert');
    });

    const prepared = await harness.service.createArchive();

    expect(prepared.summary).toMatchObject({ fileCount: 2, totalFileBytes: 3 });
    expect(order).toEqual(['txn:begin', 'insert', 'insert', 'txn:end']);
    expect(harness.liveForRollback.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(harness.liveForRollback.execAsync.mock.calls.map(([sql]) => sql)).not.toContainEqual(
      expect.stringMatching(/VACUUM/i),
    );
    await prepared.dispose();
  });

  it('K7 ㉜: restore does not quick_check the archive; it compares the archive row count with its manifest', async () => {
    const harness = createHarness();
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    const prepared = await harness.service.pickAndPrepareRestore();

    expect(prepared).not.toBeNull();
    expect(harness.archive.getFirstAsync).not.toHaveBeenCalledWith('PRAGMA quick_check');
    expect(harness.archive.getFirstAsync).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT COUNT\(\*\) AS count FROM backup_files/),
    );
    // The app-database snapshot is still checked: it is page-copied into live storage.
    expect(harness.restored.getFirstAsync).toHaveBeenCalledWith('PRAGMA quick_check');
    await prepared!.dispose();
  });

  it('K7 ㉜: an archive whose row count disagrees with its manifest is refused before any staging', async () => {
    const harness = createHarness({ archiveFileCount: 1 });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());

    await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
      'Restore failed while checking the backup archive: Backup archive is incomplete (1 of 2 images).',
    );

    expect(mockSQLite.deserializeDatabaseAsync).not.toHaveBeenCalled();
    expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
    expect(harness.settingsRepository.save).not.toHaveBeenCalled();
    expect(mockFileSystem.events.filter((event) => event.startsWith('file:write:'))).toEqual([]);
    expect(mockFileSystem.events.at(-1)).toMatch(/^file:delete:file:\/\/\/database\/restore-import-/);
  });

  describe('board #27 S1b Task 8: a restore deletes the library files the restored rows do not name', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const c = 'c'.repeat(64);

    function libraryHarness(
      options: { restoredLibraryUris?: string[] } = {},
    ) {
      const port = createFakeLibraryFilePort();
      const held = [
        port.resolveOriginal(`${a}.jpg`),
        port.resolveOriginal(`${b}.jpg`),
        port.resolveTrash(`${c}.jpg`),
      ];
      for (const uri of held) port.files.set(uri, Uint8Array.from([1]));
      const harness = createHarness({
        libraryFiles: createLibraryFileStore({ port }),
        restoredLibraryUris: options.restoredLibraryUris ?? [
          `file:///data/user/0/app.waifudeck.mobile/files/library/originals/${a}.jpg`,
          port.resolveTrash(`${c}.jpg`),
        ],
      });
      return { harness, port };
    }

    it('RESTORED_LIBRARY_FILE_URIS_SQL names every file a library row can point at', async () => {
      const nativeDatabase = new DatabaseSync(':memory:');
      const database = createNodeSqliteAdapter(nativeDatabase);
      try {
        await migrateDatabase(database);
        const digests = ['local', 'flagged', 'cloud', 'trashed'].map(viewDigest);
        const [local, flagged, cloud, trashed] = digests;
        const u1 = 'file:///data/library/originals/u1.jpg';
        const u2 = 'file:///data/library/originals/u2.jpg';
        const t = 'file:///data/library/trash/t.jpg';
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: local, localOriginalUri: u1,
        });
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: flagged, localOriginalUri: u2, missingOriginalSince: 7,
        });
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: cloud, residency: 'cloud-only',
        });
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: trashed, residency: 'cached',
        });
        await database.run(
          `INSERT INTO library_device_asset_state
             (plaintext_sha256, device_trash_uri, device_trashed_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          [trashed, t, 5, 5],
        );
        await database.run(
          `INSERT INTO library_device_asset_state
             (plaintext_sha256, device_trash_uri, device_trashed_at, updated_at)
           VALUES (?, NULL, NULL, ?)`,
          [local, 5],
        );

        const rows = await database.getAll<{ uri: string }>(
          RESTORED_LIBRARY_FILE_URIS_SQL,
        );

        expect(new Set(rows.map((row) => row.uri))).toEqual(new Set([u1, u2, t]));
        expect(rows).toHaveLength(3);
      } finally {
        nativeDatabase.close();
      }
    });

    it('RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL clears every row\'s thumbnail and nothing else', async () => {
      const nativeDatabase = new DatabaseSync(':memory:');
      const database = createNodeSqliteAdapter(nativeDatabase);
      try {
        await migrateDatabase(database);
        const repository = createLibraryRepository(database);
        const [first, second] = ['thumb-a', 'thumb-b'].map(viewDigest);
        await seedDeviceLibraryAsset(database, { plaintextSha256: first });
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: second, residency: 'cloud-only',
        });
        await expect(
          repository.setLocalThumbnail(first, `file:///data/library/thumbnails/${first}.webp`),
        ).resolves.toBe(true);
        await expect(
          repository.setLocalThumbnail(second, `file:///data/library/thumbnails/${second}.jpg`),
        ).resolves.toBe(true);
        // Every nullable column holds a value, so an UPDATE that also nulled
        // one of them would show.
        await database.run(
          'UPDATE device_library_assets SET missing_original_since = 7, import_deleted_at = 11, source_image_id = COALESCE(source_image_id, 9), local_original_uri = COALESCE(local_original_uri, ?)',
          ['file:///data/library/originals/x.jpg'],
        );
        const snapshot = () => database.getAll<Record<string, unknown>>(
          'SELECT * FROM device_library_assets ORDER BY plaintext_sha256',
        );
        const before = await snapshot();
        expect(before.map((row) => row.local_thumbnail_uri)).not.toContain(null);
        for (const row of before) {
          expect(Object.values(row)).not.toContain(null);
        }

        await database.run(RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL);

        const after = await snapshot();
        expect(after).toHaveLength(2);
        expect(after).toEqual(
          before.map((row) => ({ ...row, local_thumbnail_uri: null })),
        );
      } finally {
        nativeDatabase.close();
      }
    });

    it('a restore clears the thumbnails before it replaces the database', async () => {
      const harness = createHarness({
        restoredLibraryColumns: ['plaintext_sha256', 'local_thumbnail_uri'],
      });
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
      const prepared = await harness.service.pickAndPrepareRestore();
      await expect(prepared!.apply()).resolves.toEqual(restoredSettings);

      const clearCalls = harness.restored.runAsync.mock.calls.filter(
        ([query]) => query === RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL,
      );
      expect(clearCalls).toEqual([[RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL]]);
      const clearOrder = harness.restored.runAsync.mock.invocationCallOrder[
        harness.restored.runAsync.mock.calls.findIndex(
          ([query]) => query === RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL,
        )
      ];
      expect(clearOrder).toBeLessThan(
        mockSQLite.backupDatabaseAsync.mock.invocationCallOrder[0],
      );
    });

    it('an archive from before the thumbnail column is not asked to clear it', async () => {
      const harness = createHarness();
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
      const prepared = await harness.service.pickAndPrepareRestore();
      await expect(prepared!.apply()).resolves.toEqual(restoredSettings);

      expect(harness.restored.runAsync).not.toHaveBeenCalledWith(
        RESTORE_CLEAR_LOCAL_THUMBNAILS_SQL,
      );
    });

    it('a committed restore deletes every thumbnail', async () => {
      const { harness, port } = libraryHarness();
      const thumbnail = port.resolveThumbnail(`${a}.webp`);
      port.files.set(thumbnail, Uint8Array.from([7]));
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
      const prepared = await harness.service.pickAndPrepareRestore();

      await expect(prepared!.apply()).resolves.toEqual(restoredSettings);

      expect(port.files.has(thumbnail)).toBe(false);
    });

    it('a restore that rolls back keeps every thumbnail', async () => {
      const { harness, port } = libraryHarness();
      const thumbnail = port.resolveThumbnail(`${a}.webp`);
      port.files.set(thumbnail, Uint8Array.from([7]));
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
      const prepared = await harness.service.pickAndPrepareRestore();
      (harness.settingsRepository.save as jest.Mock)
        .mockRejectedValueOnce(new Error('settings write failed'))
        .mockResolvedValueOnce(DEFAULT_SETTINGS);

      await expect(prepared!.apply()).rejects.toThrow('settings write failed');

      expect(port.files.has(thumbnail)).toBe(true);
    });

    it('a committed restore deletes the library files the restored rows do not name', async () => {
      const { harness, port } = libraryHarness();
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
      const prepared = await harness.service.pickAndPrepareRestore();

      await expect(prepared!.apply()).resolves.toEqual(restoredSettings);

      expect(port.deletedFiles).toEqual([port.resolveOriginal(`${b}.jpg`)]);
      expect(mockFileSystem.fileState.get(stagedUri())?.exists).toBe(true);
      expect(harness.liveForRollback.closeAsync).toHaveBeenCalled();
      // The names come from the file the reload opens, on a fresh connection.
      const opened = await Promise.all(
        mockSQLite.openDatabaseAsync.mock.results.map((result) => result.value),
      );
      const namesOpens = mockSQLite.openDatabaseAsync.mock.calls.filter(
        (_call, index) => opened[index] === harness.liveForRollback,
      );
      expect(namesOpens).toEqual([
        [APP_DATABASE_NAME, { useNewConnection: true }],
      ]);
    });

    it('a restore that rolls back deletes no library file', async () => {
      const { harness, port } = libraryHarness();
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
      const prepared = await harness.service.pickAndPrepareRestore();
      (harness.settingsRepository.save as jest.Mock)
        .mockRejectedValueOnce(new Error('settings write failed'))
        .mockResolvedValueOnce(DEFAULT_SETTINGS);

      await expect(prepared!.apply()).rejects.toThrow('settings write failed');

      expect(port.deletedFiles).toEqual([]);
    });

    it('an unreadable restored database deletes nothing, and the restore still succeeds', async () => {
      const { harness, port } = libraryHarness();
      harness.liveForRollback.getAllAsync.mockRejectedValue(
        new Error('no such table: device_library_assets'),
      );
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
      const prepared = await harness.service.pickAndPrepareRestore();

      await expect(prepared!.apply()).resolves.toEqual(restoredSettings);

      expect(port.deletedFiles).toEqual([]);
      expect(mockSQLite.backupDatabaseAsync).toHaveBeenCalledTimes(1);
      // A committed apply uses the third live double only for the names, so
      // its one close is the names connection's, even though the read threw.
      expect(harness.liveForRollback.closeAsync).toHaveBeenCalledTimes(1);
    });

    it('a delete that throws costs the restore nothing', async () => {
      const { harness, port } = libraryHarness();
      const b1 = port.resolveOriginal(`${b}.jpg`);
      port.delete = async (uri) => {
        if (uri === b1) throw new Error('delete failed');
        port.files.delete(uri);
      };
      mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
      const prepared = await harness.service.pickAndPrepareRestore();

      await expect(prepared!.apply()).resolves.toEqual(restoredSettings);

      expect(mockSQLite.backupDatabaseAsync).toHaveBeenCalledTimes(1);
      expect(port.files.has(b1)).toBe(true);
    });
  });

  it("export and restore never share the app's connection", async () => {
    const exportHarness = createHarness({
      exportImageCount: 1,
      exportSavedImages: [],
    });
    await exportHarness.service.createArchive();
    const exportCalls = mockSQLite.openDatabaseAsync.mock.calls.slice();

    mockSQLite.openDatabaseAsync.mockClear();
    const restoreHarness = createHarness({
      libraryFiles: createLibraryFileStore({ port: createFakeLibraryFilePort() }),
    });
    mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
    const prepared = await restoreHarness.service.pickAndPrepareRestore();
    await prepared!.apply();
    const restoreCalls = mockSQLite.openDatabaseAsync.mock.calls.slice();

    const appDatabaseOpens = (calls: readonly unknown[][]) => calls.filter(
      ([name]) => name === APP_DATABASE_NAME,
    );
    const exportOpens = appDatabaseOpens(exportCalls);
    const restoreOpens = appDatabaseOpens(restoreCalls);

    expect(exportOpens.length).toBeGreaterThan(0);
    expect(restoreOpens.length).toBeGreaterThan(0);
    expect(exportOpens.map((call) => call[1])).toEqual(
      exportOpens.map(() => expect.objectContaining({ useNewConnection: true })),
    );
    expect(restoreOpens.map((call) => call[1])).toEqual(
      restoreOpens.map(() => expect.objectContaining({ useNewConnection: true })),
    );
  });

  describe('Ledger N6-D: portable full backup v2 and native streaming restore for imports', () => {
    it('exports v2 backup_import_files with safe/adult/unknown, legacy over-cap, two-member shared digest, and cloud-only summary counts', async () => {
      const nativeDatabase = new DatabaseSync(':memory:');
      const database = createNodeSqliteAdapter(nativeDatabase);
      try {
        await migrateDatabase(database);
        const images = createImageRepository(database);

        const safeBytes = Uint8Array.from([10, 20, 30, 40]);
        const safeDigest = sha256PlaintextHex(safeBytes);
        const safeUri = `file:///data/library/originals/${safeDigest}.jpg`;
        mockFileSystem.fileState.set(safeUri, { bytes: safeBytes, exists: true });
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: safeDigest,
          origin: 'import',
          importClassification: 'safe',
          localOriginalUri: safeUri,
          byteSize: safeBytes.byteLength,
          createdAt: 1_791_288_000_000,
        });

        const adultBytes = Uint8Array.from([50, 60, 70]);
        const adultDigest = sha256PlaintextHex(adultBytes);
        const adultUri = `file:///data/library/originals/${adultDigest}.png`;
        mockFileSystem.fileState.set(adultUri, { bytes: adultBytes, exists: true });
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: adultDigest,
          origin: 'import',
          importClassification: 'adult',
          format: 'png',
          canonicalExtension: 'png',
          localOriginalUri: adultUri,
          byteSize: adultBytes.byteLength,
          createdAt: 1_791_361_800_000,
        });

        const overCapBytes = Uint8Array.from([80, 90, 100, 110, 120]);
        const overCapDigest = sha256PlaintextHex(overCapBytes);
        const overCapUri = `file:///data/library/originals/${overCapDigest}.webp`;
        mockFileSystem.fileState.set(overCapUri, { bytes: overCapBytes, exists: true });
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: overCapDigest,
          origin: 'import',
          importClassification: 'unknown',
          format: 'webp',
          canonicalExtension: 'webp',
          localOriginalUri: overCapUri,
          byteSize: 67_108_800,
          protectEligible: false,
          createdAt: 1_791_100_000_000,
        });

        // Two-member shared digest: provider mirrored save + active import.
        const sharedProvider = await images.saveMirroredCandidate(ownedCandidate('shared'), 2_000);
        const sharedBytes = Uint8Array.from([1, 3, 5, 7, 9, 11]);
        const sharedDigest = sha256PlaintextHex(sharedBytes);
        const sharedUri = `file:///data/library/originals/${sharedDigest}.jpg`;
        mockFileSystem.fileState.set(sharedUri, { bytes: sharedBytes, exists: true });
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: sharedDigest,
          origin: 'import',
          importClassification: 'safe',
          sourceImageId: null,
          localOriginalUri: sharedUri,
          byteSize: sharedBytes.byteLength,
          createdAt: 1_791_400_000_000,
        });
        await database.run(
          `INSERT INTO library_provider_image_assets (image_id, plaintext_sha256, updated_at)
           VALUES (?, ?, ?)`,
          [sharedProvider.id, sharedDigest, 2_000],
        );

        // Cloud-only import: omitted from backup_import_files, counted in cloudOnlyCount.
        const cloudOnlyImportDigest = viewDigest('import-cloud-only');
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: cloudOnlyImportDigest,
          origin: 'import',
          importClassification: 'adult',
          residency: 'cloud-only',
          localOriginalUri: null,
          createdAt: 1_791_500_000_000,
        });
        await seedLibraryProtection(database, {
          plaintextSha256: cloudOnlyImportDigest,
          accountScope: VIEW_TEST_ACCOUNT_SCOPE,
          originalGenerationId: 'gen-cloud-import-1',
        });

        // Missing local import without cloud protection: counted in missingFileCount.
        const missingImportDigest = viewDigest('import-missing-local');
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: missingImportDigest,
          origin: 'import',
          importClassification: 'safe',
          residency: 'local-original',
          localOriginalUri: `file:///data/library/originals/${missingImportDigest}.jpg`,
          createdAt: 1_791_600_000_000,
        });

        // Deleted import membership: excluded from importCount and backup_import_files.
        const deletedImportDigest = viewDigest('import-deleted');
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: deletedImportDigest,
          origin: 'import',
          importClassification: 'safe',
          importDeletedAt: 1_791_700_000_000,
          localOriginalUri: `file:///data/library/originals/${deletedImportDigest}.jpg`,
        });

        const harness = createHarness({
          database,
          allowsAdultContent: true,
        });
        const providerInserts: unknown[][] = [];
        const importInserts: unknown[][] = [];
        let manifestInsert: unknown[] = [];
        harness.liveForRollback.runAsync.mockImplementation(async (query: string, params?: unknown[]) => {
          if (query.includes('INSERT INTO backup_files')) providerInserts.push(params ?? []);
          if (query.includes('INSERT INTO backup_import_files')) importInserts.push(params ?? []);
          if (query.includes('INSERT INTO backup_manifest')) manifestInsert = params ?? [];
        });

        const prepared = await harness.service.createArchive();

        expect(providerInserts.map((p) => [p[0], p[2]])).toEqual([
          [sharedProvider.id, sharedBytes.byteLength],
        ]);
        expect(importInserts.map((p) => [p[0], p[1], p[2]])).toEqual([
          [sharedDigest, 'jpg', sharedBytes.byteLength],
          [adultDigest, 'png', adultBytes.byteLength],
          [safeDigest, 'jpg', safeBytes.byteLength],
          [overCapDigest, 'webp', overCapBytes.byteLength],
        ]);
        const expectedBytes =
          sharedBytes.byteLength
          + sharedBytes.byteLength
          + adultBytes.byteLength
          + safeBytes.byteLength
          + overCapBytes.byteLength;
        expect(prepared.summary).toEqual({
          formatVersion: 2,
          applicationId: 'waifu-deck-backup',
          appVersion: '1.2.3',
          createdAt: expect.any(Number),
          imageCount: 1,
          fileCount: 5,
          totalFileBytes: expectedBytes,
          importCount: 6,
          missingFileCount: 1,
          cloudOnlyCount: 1,
        });
        expect(manifestInsert[0]).toBe(2);
        expect(manifestInsert[7]).toBe(6);
        await prepared.dispose();
      } finally {
        nativeDatabase.close();
      }
    });

    it('restores v2 backup_import_files via native copyArchivedImportFile into staging and promotes on apply without touching live originals on cancel or rollback', async () => {
      const nativeDatabase = new DatabaseSync(':memory:');
      const restoredAdapter = createNodeSqliteAdapter(nativeDatabase);
      try {
        await migrateDatabase(restoredAdapter);
        const safeBytes = Uint8Array.from([11, 22, 33, 44, 55]);
        const safeDigest = sha256PlaintextHex(safeBytes);
        const foreignUri = `file:///data/user/10/app.waifudeck.mobile/files/library/originals/${safeDigest}.jpg`;
        await seedDeviceLibraryAsset(restoredAdapter, {
          plaintextSha256: safeDigest,
          origin: 'import',
          importClassification: 'safe',
          localOriginalUri: foreignUri,
          byteSize: safeBytes.byteLength,
          createdAt: 1_791_288_000_000,
        });

        const cloudOnlyDigest = viewDigest('v2-restore-cloud-only');
        const staleCloudForeignUri = `file:///data/user/10/app.waifudeck.mobile/files/library/originals/${cloudOnlyDigest}.png`;
        await seedDeviceLibraryAsset(restoredAdapter, {
          plaintextSha256: cloudOnlyDigest,
          origin: 'import',
          importClassification: 'adult',
          format: 'png',
          canonicalExtension: 'png',
          residency: 'local-original',
          localOriginalUri: staleCloudForeignUri,
          createdAt: 1_791_361_800_000,
        });
        await seedLibraryProtection(restoredAdapter, {
          plaintextSha256: cloudOnlyDigest,
          accountScope: VIEW_TEST_ACCOUNT_SCOPE,
          originalGenerationId: 'gen-cloud-2',
        });

        const port = createFakeLibraryFilePort();
        const libraryFiles = createLibraryFileStore({ port });
        const finalSafeUri = libraryFiles.originalUriFor(safeDigest, 'jpg');

        // Pre-seed a live original with the same digest to prove prepare/cancel/rollback safety.
        const existingLiveBytes = Uint8Array.from([99, 99, 99]);
        mockFileSystem.fileState.set(finalSafeUri, {
          bytes: existingLiveBytes,
          exists: true,
        });

        const importCopierCalls: [string, string, string][] = [];
        const copyArchivedImportFile = jest.fn(async (
          archiveUri: string,
          plaintextSha256: string,
          destinationUri: string,
        ) => {
          importCopierCalls.push([archiveUri, plaintextSha256, destinationUri]);
          mockFileSystem.events.push(`file:write:${destinationUri}`);
          mockFileSystem.fileState.set(destinationUri, {
            bytes: Uint8Array.from(safeBytes),
            exists: true,
          });
          return {
            bytesWritten: safeBytes.byteLength,
            plaintextSha256: safeDigest,
          };
        });

        const harness = createHarness({
          manifest: {
            ...manifestRow,
            format_version: 2,
            image_count: 0,
            file_count: 1,
            total_file_bytes: safeBytes.byteLength,
            import_count: 2,
          } as unknown as typeof manifestRow,
          savedImages: [],
          archivedFiles: {},
          libraryFiles,
          restoredLibraryUris: [finalSafeUri],
        });

        // Rewire restored double to execute real SQL against `restoredAdapter`.
        harness.restored.getFirstAsync.mockImplementation(async (query, params) => (
          restoredAdapter.getFirst(query, (params ?? []) as never)
        ));
        harness.restored.getAllAsync.mockImplementation(async (query, params) => (
          restoredAdapter.getAll(query, (params ?? []) as never)
        ));
        harness.restored.runAsync.mockImplementation(async (query, params) => (
          restoredAdapter.run(query, (params ?? []) as never)
        ));

        harness.archive.getFirstAsync.mockImplementation(async (query, params) => {
          if (query.includes('backup_manifest')) {
            return {
              ...manifestRow,
              format_version: 2,
              image_count: 0,
              file_count: 1,
              total_file_bytes: safeBytes.byteLength,
              import_count: 2,
            };
          }
          if (query.includes('COUNT(*)') && query.includes('backup_files')) {
            return { count: 0 };
          }
          if (query.includes("sqlite_master") && query.includes("backup_import_files")) {
            return { name: 'backup_import_files' };
          }
          if (query.includes('COUNT(*)') && query.includes('backup_import_files')) {
            return { count: 1 };
          }
          if (query.includes('backup_payload') && params?.[0] === 'settings') {
            return {
              text_value: JSON.stringify(restoredSettings),
              blob_value: null,
            };
          }
          if (query.includes('backup_payload') && params?.[0] === 'app-database') {
            return { text_value: null, blob_value: Uint8Array.from([9]) };
          }
          if (query.includes('FROM backup_import_files')) {
            expect(query).not.toMatch(/\bdata\b/u);
            if (params?.[0] === safeDigest) {
              return {
                extension: 'jpg',
                byte_size: safeBytes.byteLength,
              };
            }
            return null;
          }
          return null;
        });

        const serviceWithImportCopier = createAppBackupService({
          database: harness.database as never,
          settingsRepository: harness.settingsRepository,
          fileRepository: harness.fileRepository,
          libraryFiles,
          copyArchivedImportFile,
          appVersion: '1.2.3',
          allowsAdultContent: true,
        });

        mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
        const preparedCancel = await serviceWithImportCopier.pickAndPrepareRestore();
        expect(preparedCancel).not.toBeNull();
        expect(preparedCancel!.summary).toMatchObject({
          formatVersion: 2,
          importCount: 2,
          restoredFileCount: 1,
          missingFileCount: 0,
        });
        expect(importCopierCalls).toHaveLength(1);
        expect(importCopierCalls[0][1]).toBe(safeDigest);
        expect(importCopierCalls[0][2]).not.toBe(finalSafeUri);
        // Live original is untouched during prepare and after cancel/dispose.
        expect(mockFileSystem.fileState.get(finalSafeUri)).toEqual({
          bytes: existingLiveBytes,
          exists: true,
        });
        await preparedCancel!.dispose();
        expect(mockFileSystem.fileState.get(finalSafeUri)).toEqual({
          bytes: existingLiveBytes,
          exists: true,
        });
        expect(mockFileSystem.fileState.get(importCopierCalls[0][2])?.exists).toBe(false);

        // Now prepare again and apply: finalSafeUri is updated to safeBytes, and
        // cloudOnlyDigest's foreign local_original_uri is cleared to NULL with residency='cloud-only'.
        mockSQLite.state.liveDatabases = [
          harness.liveForSnapshot,
          harness.liveForApply,
          harness.liveForRollback,
        ];
        const preparedApply = await serviceWithImportCopier.pickAndPrepareRestore();
        await expect(preparedApply!.apply()).resolves.toEqual(restoredSettings);

        expect(mockFileSystem.fileState.get(finalSafeUri)).toEqual({
          bytes: safeBytes,
          exists: true,
        });
        const safeRow = await restoredAdapter.getFirst<{
          local_original_uri: string | null;
          residency: string;
          import_classification: string;
        }>(
          'SELECT local_original_uri, residency, import_classification FROM device_library_assets WHERE plaintext_sha256 = ?',
          [safeDigest],
        );
        expect(safeRow).toEqual({
          local_original_uri: finalSafeUri,
          residency: 'local-original',
          import_classification: 'safe',
        });

        const cloudRow = await restoredAdapter.getFirst<{
          local_original_uri: string | null;
          residency: string;
          import_classification: string;
        }>(
          'SELECT local_original_uri, residency, import_classification FROM device_library_assets WHERE plaintext_sha256 = ?',
          [cloudOnlyDigest],
        );
        expect(cloudRow).toEqual({
          local_original_uri: null,
          residency: 'cloud-only',
          import_classification: 'adult',
        });
      } finally {
        nativeDatabase.close();
      }
    });

    it('rejects a v2 archive whose import blob SHA-256 disagrees with plaintext_sha256 before apply', async () => {
      const nativeDatabase = new DatabaseSync(':memory:');
      const restoredAdapter = createNodeSqliteAdapter(nativeDatabase);
      try {
        await migrateDatabase(restoredAdapter);
        const realBytes = Uint8Array.from([1, 2, 3, 4]);
        const expectedDigest = sha256PlaintextHex(realBytes);
        await seedDeviceLibraryAsset(restoredAdapter, {
          plaintextSha256: expectedDigest,
          origin: 'import',
          importClassification: 'safe',
          byteSize: realBytes.byteLength,
        });

        const harness = createHarness({
          savedImages: [],
          archivedFiles: {},
        });
        harness.restored.getFirstAsync.mockImplementation(async (query, params) => (
          restoredAdapter.getFirst(query, (params ?? []) as never)
        ));
        harness.restored.getAllAsync.mockImplementation(async (query, params) => (
          restoredAdapter.getAll(query, (params ?? []) as never)
        ));
        harness.restored.runAsync.mockImplementation(async (query, params) => (
          restoredAdapter.run(query, (params ?? []) as never)
        ));
        harness.archive.getFirstAsync.mockImplementation(async (query, params) => {
          if (query.includes('backup_manifest')) {
            return {
              ...manifestRow,
              format_version: 2,
              image_count: 0,
              file_count: 1,
              total_file_bytes: 4,
              import_count: 1,
            };
          }
          if (query.includes('COUNT(*)') && query.includes('backup_files')) return { count: 0 };
          if (query.includes("sqlite_master") && query.includes("backup_import_files")) {
            return { name: 'backup_import_files' };
          }
          if (query.includes('COUNT(*)') && query.includes('backup_import_files')) return { count: 1 };
          if (query.includes('backup_payload') && params?.[0] === 'settings') {
            return { text_value: JSON.stringify(restoredSettings), blob_value: null };
          }
          if (query.includes('backup_payload') && params?.[0] === 'app-database') {
            return { text_value: null, blob_value: Uint8Array.from([9]) };
          }
          if (query.includes('FROM backup_import_files')) {
            return {
              extension: 'jpg',
              byte_size: 4,
              data: Uint8Array.from([9, 9, 9, 9]), // wrong bytes -> wrong SHA-256
            };
          }
          return null;
        });

        mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
        await expect(harness.service.pickAndPrepareRestore()).rejects.toThrow(
          `Restore failed while restoring imported image ${expectedDigest}: Backup imported image ${expectedDigest} failed integrity verification.`,
        );
        expect(mockSQLite.backupDatabaseAsync).not.toHaveBeenCalled();
      } finally {
        nativeDatabase.close();
      }
    });

    it('accepts a v1 archive without backup_import_files and migrates pre-N6 device_library_assets to import_classification = unknown', async () => {
      const nativeDatabase = new DatabaseSync(':memory:');
      const restoredAdapter = createNodeSqliteAdapter(nativeDatabase);
      try {
        // Simulate a v21 database snapshot (before N6-A1 added import_classification / import_deleted_at).
        await restoredAdapter.exec(`
          CREATE TABLE images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            extension TEXT NOT NULL,
            local_uri TEXT,
            download_state TEXT NOT NULL,
            download_error TEXT,
            download_error_kind TEXT,
            decision TEXT NOT NULL,
            is_nsfw INTEGER NOT NULL DEFAULT 0,
            content_rating TEXT NOT NULL DEFAULT 'safe'
          );
          CREATE TABLE device_library_assets (
            plaintext_sha256 TEXT NOT NULL PRIMARY KEY,
            format TEXT NOT NULL,
            canonical_extension TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            origin TEXT NOT NULL,
            source_image_id INTEGER,
            local_original_uri TEXT,
            residency TEXT NOT NULL,
            protect_eligible INTEGER NOT NULL DEFAULT 1,
            missing_original_since INTEGER,
            local_thumbnail_uri TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE library_asset_protection (
            account_scope TEXT NOT NULL,
            plaintext_sha256 TEXT NOT NULL,
            lifecycle TEXT NOT NULL DEFAULT 'active',
            protection TEXT NOT NULL DEFAULT 'protected',
            original_generation_id TEXT,
            updated_at INTEGER NOT NULL
          );
          PRAGMA user_version = 21;
        `);
        const legacyDigest = viewDigest('v1-legacy-import');
        await restoredAdapter.run(
          `INSERT INTO device_library_assets (
             plaintext_sha256, format, canonical_extension, byte_size, width, height,
             origin, source_image_id, local_original_uri, residency, protect_eligible,
             missing_original_since, local_thumbnail_uri, created_at, updated_at
           ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, 'file:///foreign/path.jpg', 'local-original', 1, NULL, 'file:///foreign/thumb.webp', 1000, 1000)`,
          [legacyDigest],
        );

        const harness = createHarness({
          manifest: {
            ...manifestRow,
            format_version: 1,
            image_count: 0,
            file_count: 0,
            total_file_bytes: 0,
          },
          savedImages: [],
          archivedFiles: {},
        });
        harness.restored.getFirstAsync.mockImplementation(async (query, params) => (
          restoredAdapter.getFirst(query, (params ?? []) as never)
        ));
        harness.restored.getAllAsync.mockImplementation(async (query, params) => (
          restoredAdapter.getAll(query, (params ?? []) as never)
        ));
        harness.restored.runAsync.mockImplementation(async (query, params) => (
          restoredAdapter.run(query, (params ?? []) as never)
        ));

        mockFileSystem.pickFileAsync.mockResolvedValue(selectedBackup());
        const prepared = await harness.service.pickAndPrepareRestore();
        expect(prepared).not.toBeNull();
        expect(prepared!.summary).toMatchObject({
          formatVersion: 1,
          importCount: 0,
          restoredFileCount: 0,
          missingFileCount: 0,
        });
        await expect(prepared!.apply()).resolves.toEqual(restoredSettings);

        const migratedRow = await restoredAdapter.getFirst<{
          import_classification: string;
          import_deleted_at: number | null;
          local_original_uri: string | null;
          local_thumbnail_uri: string | null;
          missing_original_since: number | null;
        }>(
          `SELECT import_classification, import_deleted_at, local_original_uri, local_thumbnail_uri, missing_original_since
             FROM device_library_assets WHERE plaintext_sha256 = ?`,
          [legacyDigest],
        );
        expect(migratedRow).toEqual({
          import_classification: 'unknown',
          import_deleted_at: null,
          local_original_uri: null,
          local_thumbnail_uri: null,
          missing_original_since: 1000,
        });
      } finally {
        nativeDatabase.close();
      }
    });
  });
});
