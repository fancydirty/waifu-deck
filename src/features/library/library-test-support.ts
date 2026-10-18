import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  createLibraryDecodeGate,
  type LibraryDecodeGate,
} from '@/features/library/library-decode-gate';
import {
  createLibraryFileStore,
  type LibraryFilePort,
  type LibraryFileStore,
} from '@/features/library/library-file-store';
import { deriveLibraryAccountScope } from '@/features/library/library-identity';
import type { LibraryAccountPort } from '@/features/library/library-ingest';
import type {
  LibraryRemoteStateCacheRow,
  LibraryRemoteStateIndex,
} from '@/features/library/library-remote-state-cache';
import {
  createLibraryRepository,
  type LibraryRepository,
} from '@/features/library/library-repository';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

export function asciiBytes(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

export const JPEG_FIXTURE = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

export const PNG_FIXTURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

export const GIF_FIXTURE = Uint8Array.from([
  ...asciiBytes('GIF89a'), 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
]);

export const CORRUPT_JPEG_FIXTURE = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00,
]);

export const NOT_AN_IMAGE_FIXTURE = Uint8Array.from(
  asciiBytes('this is a text file pretending to be art'),
);

export type FakeLibraryFilePort = LibraryFilePort & {
  files: Map<string, Uint8Array>;
  unreadableSources: Set<string>;
  failWrites: boolean;
  failMoves: boolean;
  /** Every uri this port was asked to delete, so a test can prove none was. */
  deletedFiles: string[];
};

/**
 * The reconciliation port's ETag index, held in memory.
 *
 * For the suites that wire a transport and a port but no device database (the
 * protocol, encrypted-round-trip, and ETag-reconciliation integration gates):
 * they are about what the bucket does, not about what survives a relaunch, and
 * the durable half is proven by `library-remote-state-cache.test.ts` and by the
 * two suites that DO build a real device database. Behaviourally identical to
 * the SQLite repository, so a port over this one diffs exactly as production's
 * does within a single process.
 */
export function createMemoryLibraryRemoteStateIndex(): LibraryRemoteStateIndex {
  const rows = new Map<string, LibraryRemoteStateCacheRow>();
  return {
    async getAll() { return [...rows.values()]; },
    async upsertMany(incoming) {
      for (const row of incoming) rows.set(row.key, row);
    },
    async deleteMissing(presentKeys) {
      const present = new Set(presentKeys);
      for (const key of [...rows.keys()]) {
        if (!present.has(key)) rows.delete(key);
      }
    },
    async deleteKeys(keys) {
      for (const key of keys) rows.delete(key);
    },
  };
}

export function createFakeLibraryFilePort(): FakeLibraryFilePort {
  const files = new Map<string, Uint8Array>();
  const unreadableSources = new Set<string>();
  const deletedFiles: string[] = [];
  const originalsRootUri = 'file:///data/library/originals';
  const tempRootUri = 'file:///cache/library-temp';
  const streamRootUri = 'file:///cache/library-stream';
  const trashRootUri = 'file:///data/library/trash';
  const cacheRootUri = 'file:///cache/library-cache';
  const shareRootUri = 'file:///cache/library-share';
  const thumbnailsRootUri = 'file:///data/library/thumbnails';
  const pickerCacheRootUri = 'file:///cache/ImagePicker';

  const read = (uri: string): Uint8Array => {
    const value = files.get(uri);
    if (value === undefined) throw new Error(`missing file ${uri}`);
    return value;
  };

  const port: FakeLibraryFilePort = {
    files,
    unreadableSources,
    failWrites: false,
    failMoves: false,
    deletedFiles,
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
      if (port.failWrites) throw new Error('disk full');
      files.set(uri, Uint8Array.from(bytes));
    },
    async readBytes(uri) {
      return Uint8Array.from(read(uri));
    },
    async readPrefix(uri, length) {
      return Uint8Array.from(read(uri).slice(0, length));
    },
    async copyFrom(sourceUri, destinationUri) {
      if (unreadableSources.has(sourceUri)) {
        throw new Error(`permission revoked for ${sourceUri}`);
      }
      files.set(destinationUri, Uint8Array.from(read(sourceUri)));
    },
    async move(sourceUri, destinationUri) {
      if (port.failMoves) throw new Error('rename failed');
      files.set(destinationUri, Uint8Array.from(read(sourceUri)));
      files.delete(sourceUri);
    },
    async delete(uri) {
      deletedFiles.push(uri);
      files.delete(uri);
    },
    async size(uri) {
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

  return port;
}

export function createFakeDecodeGate(
  rejectedUriMatcher: (bytes: Uint8Array) => boolean = () => false,
  readBytes: (uri: string) => Uint8Array = () => new Uint8Array(),
): LibraryDecodeGate {
  return createLibraryDecodeGate({
    async decode({ uri }) {
      if (rejectedUriMatcher(readBytes(uri))) {
        throw new Error('Unable to decode image');
      }
      return { width: 320, height: 240 };
    },
  });
}

/** Layer A only: exactly what a Store build, or a signed-out Direct build, has. */
export const LOCAL_ONLY_ACCOUNT_PORT: LibraryAccountPort = {
  async vaultMasterKey() {
    return null;
  },
  async deviceId() {
    return null;
  },
  async accountScope() {
    return null;
  },
};

export type LibraryTestHarness = Readonly<{
  nativeDatabase: DatabaseSync;
  database: SqlDatabasePort;
  port: FakeLibraryFilePort;
  files: LibraryFileStore;
  repository: LibraryRepository;
  decodeGate: LibraryDecodeGate;
  masterKey: Uint8Array;
  deviceId: string;
  /** Layer A + Layer B: a signed-in Direct build with a registered device. */
  signedInAccount: LibraryAccountPort;
  mutationIds: string[];
  newMutationId: () => string;
  clock: () => number;
  close(): void;
}>;

export async function createLibraryTestHarness(
  options: { masterKeyFill?: number; deviceId?: string } = {},
): Promise<LibraryTestHarness> {
  const nativeDatabase = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(nativeDatabase);
  await migrateDatabase(database);

  const port = createFakeLibraryFilePort();
  let ticks = 1_000;
  const clock = () => (ticks += 1);
  const files = createLibraryFileStore({ port, clock });

  const mutationIds: string[] = [];
  let mutationSequence = 0;
  const newMutationId = () => {
    mutationSequence += 1;
    const suffix = mutationSequence.toString().padStart(12, '0');
    const id = `00000000-0000-4000-8000-${suffix}`;
    mutationIds.push(id);
    return id;
  };

  const decodeGate = createFakeDecodeGate(
    (bytes) => bytes.byteLength > 0
      && bytes.byteLength === CORRUPT_JPEG_FIXTURE.byteLength
      && bytes.every((byte, index) => byte === CORRUPT_JPEG_FIXTURE[index]),
    (uri) => port.files.get(uri) ?? new Uint8Array(),
  );

  const masterKey = new Uint8Array(32).fill(options.masterKeyFill ?? 3);
  const deviceId = options.deviceId ?? 'device-test-1';

  return {
    nativeDatabase,
    database,
    port,
    files,
    repository: createLibraryRepository(database),
    decodeGate,
    masterKey,
    deviceId,
    signedInAccount: {
      async vaultMasterKey() {
        return masterKey;
      },
      async deviceId() {
        return deviceId;
      },
      async accountScope() {
        return deriveLibraryAccountScope(masterKey);
      },
    },
    mutationIds,
    newMutationId,
    clock,
    close() {
      nativeDatabase.close();
    },
  };
}
