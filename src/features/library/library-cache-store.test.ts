import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  createLibraryCacheStore,
  type LibraryCacheStore,
} from '@/features/library/library-cache-store';
import { createLibraryFileStore } from '@/features/library/library-file-store';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-A';
const OTHER = 'scope-B';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

type Harness = {
  native: DatabaseSync;
  database: SqlDatabasePort;
  cache: LibraryCacheStore;
  port: ReturnType<typeof createFakeLibraryFilePort>;
  now: { value: number };
  statements: string[];
};

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

async function harness(budgetBytes: number): Promise<Harness> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  const statements: string[] = [];
  const port = createFakeLibraryFilePort();
  const now = { value: 1_000 };
  const cache = createLibraryCacheStore({
    database: countingDatabase(database, statements),
    files: createLibraryFileStore({ port }),
    port,
    budgetBytes,
    clock: () => now.value,
  });
  await port.ensureDirectories();
  return { native, database, cache, port, now, statements };
}

describe('library cache store', () => {
  it('round-trips a cached role', async () => {
    const { native, cache } = await harness(1_000);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'preview',
      generationId: 'gen-a',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const found = await cache.find(SCOPE, A, 'preview');
    expect(found?.byteSize).toBe(4);
    expect([...(await cache.readBytes(found!))]).toEqual([1, 2, 3, 4]);
    native.close();
  });

  // K7 cut 8 (audit ㉞): a cache write cost one INSERT plus a full-table SUM,
  // a re-SELECT of the row just written and an UPDATE of it — 4 statements on
  // the FIFO SQL queue for every cloud tile that renders.
  it('costs one statement per cache put and never re-reads the row it wrote', async () => {
    const { native, database, cache, statements, now } = await harness(1_000);
    const put = (digest: string, bytes: Uint8Array) => cache.put({
      accountScope: SCOPE,
      plaintextSha256: digest,
      role: 'thumbnail',
      generationId: 'gen-1',
      bytes,
    });

    // First use of a scope may learn the current total once.
    statements.length = 0;
    await put(A, new Uint8Array(4));
    expect(
      statements.filter((statement) => /SUM\(byte_size\)/u.test(statement)),
    ).toHaveLength(1);

    now.value = 2_000;
    statements.length = 0;
    const stored = await put(B, new Uint8Array(6));

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*INSERT INTO library_cache_entries/u);
    // The returned entry is the one that was written, not a re-read of it.
    expect(stored).toMatchObject({
      accountScope: SCOPE,
      plaintextSha256: B,
      role: 'thumbnail',
      byteSize: 6,
      generationId: 'gen-1',
      lastUsedAt: 2_000,
    });
    expect(stored?.uri).toBe((await cache.find(SCOPE, B, 'thumbnail'))?.uri);

    // Overwriting a cached role stays a single statement too, and the entry it
    // returns still describes the row on disk.
    now.value = 3_000;
    statements.length = 0;
    const overwritten = await put(B, new Uint8Array(8));
    expect(statements).toHaveLength(1);
    expect(await database.getFirst(
      `SELECT byte_size, created_at, last_used_at FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, B, 'thumbnail'],
    )).toEqual({
      byte_size: overwritten?.byteSize,
      created_at: overwritten?.createdAt,
      last_used_at: overwritten?.lastUsedAt,
    });

    // The reported total is still exact.
    expect(await cache.usageBytes(SCOPE)).toBe(12);
    native.close();
  });

  it('stays one statement per put after the OS reclaimed a cached file', async () => {
    const { native, cache, port, statements } = await harness(12);
    const put = (digest: string) => cache.put({
      accountScope: SCOPE,
      plaintextSha256: digest,
      role: 'thumbnail',
      generationId: null,
      bytes: new Uint8Array(8),
    });
    await put(A);
    const entry = await cache.find(SCOPE, A, 'thumbnail');
    await port.delete(entry!.uri);
    expect(await cache.find(SCOPE, A, 'thumbnail')).toBeNull();

    statements.length = 0;
    await put(B);

    // Those 8 bytes are gone, so this write is nowhere near the 12-byte budget
    // and must not pay for an eviction pass.
    expect(statements).toHaveLength(1);
    expect(await cache.usageBytes(SCOPE)).toBe(8);
    native.close();
  });

  const fromFileInput = (overrides: Partial<{
    accountScope: string;
    plaintextSha256: string;
    role: 'thumbnail' | 'preview' | 'original';
    generationId: string | null;
    sourceUri: string;
    byteSize: number;
  }> = {}) => ({
    accountScope: SCOPE,
    plaintextSha256: A,
    role: 'thumbnail' as const,
    generationId: 'gen-file',
    sourceUri: 'file:///cache/library-stream/plain.bin',
    byteSize: 4,
    ...overrides,
  });

  it('adopts a plaintext source file and registers the supplied size and generation', async () => {
    const { native, database, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    port.files.set(input.sourceUri, bytes);

    const entry = await cache.putFromFile(input);
    const row = await database.getFirst<{
      account_scope: string;
      plaintext_sha256: string;
      role: string;
      uri: string;
      byte_size: number;
      generation_id: string | null;
      created_at: number;
      last_used_at: number;
    }>(
      `SELECT account_scope, plaintext_sha256, role, uri, byte_size, generation_id,
              created_at, last_used_at
         FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    );

    expect(port.files.has(input.sourceUri)).toBe(false);
    expect(port.files.get(destination)).toEqual(bytes);
    expect(entry).toEqual({
      accountScope: row!.account_scope,
      plaintextSha256: row!.plaintext_sha256,
      role: row!.role,
      uri: row!.uri,
      byteSize: row!.byte_size,
      generationId: row!.generation_id,
      createdAt: row!.created_at,
      lastUsedAt: row!.last_used_at,
    });
    native.close();
  });

  it('replaces an existing file and row for the same cache identity', async () => {
    const { native, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    const old = await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: 'old-generation',
      bytes: Uint8Array.from([9, 9]),
    });
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    const realMove = port.move.bind(port);
    port.move = async (sourceUri, destinationUri) => {
      if (port.files.has(destinationUri)) throw new Error('destination exists');
      await realMove(sourceUri, destinationUri);
    };

    const entry = await cache.putFromFile(input);

    expect(old?.uri).toBe(destination);
    expect(port.deletedFiles).toContain(destination);
    expect(port.files.get(destination)).toEqual(Uint8Array.from([1, 2, 3, 4]));
    expect(port.files.has(input.sourceUri)).toBe(false);
    await expect(cache.find(SCOPE, A, 'thumbnail')).resolves.toMatchObject({
      generationId: 'gen-file',
      byteSize: 4,
    });
    expect(entry?.generationId).toBe('gen-file');
    native.close();
  });

  it.each([
    ['zero bytes', 0, 4],
    ['larger than the budget', 5, 4],
  ])('refuses %s by deleting the source without registering a row', async (_label, byteSize, budget) => {
    const { native, cache, port } = await harness(budget);
    const input = fromFileInput({ byteSize });
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));

    await expect(cache.putFromFile(input)).resolves.toBeNull();

    expect(port.files.has(input.sourceUri)).toBe(false);
    expect(await cache.find(SCOPE, A, 'thumbnail')).toBeNull();
    expect(port.files.has(port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`))).toBe(false);
    native.close();
  });

  it('falls back to copying when move rejects and still consumes the source', async () => {
    const { native, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    port.files.set(input.sourceUri, bytes);
    port.failMoves = true;

    const entry = await cache.putFromFile(input);

    expect(entry).not.toBeNull();
    expect(port.files.get(destination)).toEqual(bytes);
    expect(port.files.has(input.sourceUri)).toBe(false);
    native.close();
  });

  it('cleans up and returns null when both move and copy reject', async () => {
    const { native, database, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    port.failMoves = true;
    port.unreadableSources.add(input.sourceUri);

    await expect(cache.putFromFile(input)).resolves.toBeNull();

    expect(port.files.has(input.sourceUri)).toBe(false);
    expect(port.files.has(destination)).toBe(false);
    await expect(database.getFirst(
      `SELECT 1 AS present FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    )).resolves.toBeNull();
    native.close();
  });

  it('deletes the adopted destination and rethrows when row registration fails', async () => {
    const { native, database: raw, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    const failingCache = createLibraryCacheStore({
      database: {
        ...raw,
        async run(source, params) {
          if (/^\s*INSERT INTO library_cache_entries/u.test(source)) {
            throw new Error('database is busy');
          }
          return await raw.run(source, params);
        },
      },
      files: createLibraryFileStore({ port }),
      port,
    });

    await expect(failingCache.putFromFile(input)).rejects.toThrow('database is busy');

    expect(port.files.has(input.sourceUri)).toBe(false);
    expect(port.files.has(destination)).toBe(false);
    await expect(raw.getFirst(
      `SELECT 1 AS present FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    )).resolves.toBeNull();
    native.close();
  });

  it('keeps the destination named while a move is pending and a sweep runs', async () => {
    const { native, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    let releaseMove!: () => void;
    const moveGate = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    let moveReached!: () => void;
    const moveReachedSignal = new Promise<void>((resolve) => {
      moveReached = resolve;
    });
    const realMove = port.move.bind(port);
    port.move = async (sourceUri, destinationUri) => {
      await realMove(sourceUri, destinationUri);
      moveReached();
      await moveGate;
    };

    const putting = cache.putFromFile(input);
    await moveReachedSignal;
    await expect(cache.sweepOrphans()).resolves.toBe(0);
    expect(port.files.has(destination)).toBe(true);

    releaseMove();
    await expect(putting).resolves.toMatchObject({ uri: destination });
    native.close();
  });

  it('runs the same oldest-first eviction pass when an adopted file exceeds budget', async () => {
    const { native, cache, port, now } = await harness(10);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: null,
      bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]),
    });
    now.value = 2_000;
    const input = fromFileInput({
      plaintextSha256: B,
      byteSize: 6,
      sourceUri: 'file:///cache/library-stream/plain-b.bin',
      generationId: 'new-generation',
    });
    port.files.set(input.sourceUri, Uint8Array.from([7, 8, 9, 10, 11, 12]));

    const entry = await cache.putFromFile(input);

    expect(entry).not.toBeNull();
    await expect(cache.find(SCOPE, A, 'thumbnail')).resolves.toBeNull();
    await expect(cache.find(SCOPE, B, 'thumbnail')).resolves.toMatchObject({
      byteSize: 6,
      generationId: 'new-generation',
    });
    expect(await cache.usageBytes(SCOPE)).toBe(6);
    native.close();
  });

  it('records the caller-supplied byteSize even when it differs from source length', async () => {
    const { native, database, cache, port } = await harness(1_000);
    const input = fromFileInput({ byteSize: 9 });
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));

    const entry = await cache.putFromFile(input);
    const row = await database.getFirst<{ byte_size: number }>(
      `SELECT byte_size FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    );

    expect(entry?.byteSize).toBe(9);
    expect(row?.byte_size).toBe(9);
    native.close();
  });

  it('drops an existing row and its running total when replacement transfer fails', async () => {
    const { native, database, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: 'old-generation',
      bytes: Uint8Array.from([9, 9, 9, 9]),
    });
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    port.failMoves = true;
    port.unreadableSources.add(input.sourceUri);

    await expect(cache.putFromFile(input)).resolves.toBeNull();

    expect(port.files.has(destination)).toBe(false);
    expect(await database.getFirst(
      `SELECT 1 AS present FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    )).toBeNull();
    expect(await cache.usageBytes(SCOPE)).toBe(0);
    native.close();
  });

  it('drops an existing row when replacement registration fails', async () => {
    const { native, database: raw, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: 'old-generation',
      bytes: Uint8Array.from([9, 9, 9, 9]),
    });
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    const failingCache = createLibraryCacheStore({
      database: {
        ...raw,
        async run(source, params) {
          if (/^\s*INSERT INTO library_cache_entries/u.test(source)) {
            throw new Error('database is busy');
          }
          return await raw.run(source, params);
        },
      },
      files: createLibraryFileStore({ port }),
      port,
    });

    await expect(failingCache.putFromFile(input)).rejects.toThrow('database is busy');

    expect(port.files.has(destination)).toBe(false);
    expect(await raw.getFirst(
      `SELECT 1 AS present FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    )).toBeNull();
    native.close();
  });

  it('serializes same-identity puts and leaves one consistent row and file', async () => {
    const { native, database, cache, port } = await harness(1_000);
    const firstInput = fromFileInput({
      sourceUri: 'file:///cache/library-stream/first.bin',
      generationId: 'first-generation',
    });
    const secondInput = fromFileInput({
      sourceUri: 'file:///cache/library-stream/second.bin',
      generationId: 'second-generation',
    });
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    port.files.set(firstInput.sourceUri, Uint8Array.from([1, 1, 1, 1]));
    port.files.set(secondInput.sourceUri, Uint8Array.from([2, 2, 2, 2]));
    let activeEnsures = 0;
    let maxActiveEnsures = 0;
    let releaseFirstEnsure!: () => void;
    const firstEnsureGate = new Promise<void>((resolve) => {
      releaseFirstEnsure = resolve;
    });
    let firstEnsureReached!: () => void;
    const firstEnsureReachedSignal = new Promise<void>((resolve) => {
      firstEnsureReached = resolve;
    });
    const realEnsure = port.ensureDirectories.bind(port);
    port.ensureDirectories = async () => {
      activeEnsures += 1;
      maxActiveEnsures = Math.max(maxActiveEnsures, activeEnsures);
      if (activeEnsures === 1) {
        firstEnsureReached();
        await firstEnsureGate;
      }
      await realEnsure();
      activeEnsures -= 1;
    };

    const first = cache.putFromFile(firstInput);
    await firstEnsureReachedSignal;
    const second = cache.putFromFile(secondInput);
    await Promise.resolve();
    expect(maxActiveEnsures).toBe(1);
    releaseFirstEnsure();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    const row = await database.getFirst<{ plaintext_sha256: string; uri: string }>(
      `SELECT plaintext_sha256, uri FROM library_cache_entries
        WHERE account_scope = ? AND role = ?`,
      [SCOPE, 'thumbnail'],
    );
    expect(row).toEqual({ plaintext_sha256: A, uri: destination });
    expect(port.files.get(destination)).toEqual(Uint8Array.from([2, 2, 2, 2]));
    native.close();
  });

  it('turns a refusal delete failure into a null result', async () => {
    const { native, cache, port } = await harness(1_000);
    const input = fromFileInput({ byteSize: 0 });
    port.files.set(input.sourceUri, Uint8Array.from([1]));
    port.delete = async (uri) => {
      if (uri === input.sourceUri) throw new Error('stream cleanup unavailable');
      port.files.delete(uri);
    };

    await expect(cache.putFromFile(input)).resolves.toBeNull();
    native.close();
  });

  it('rolls back the destination when usage estimation rejects', async () => {
    const { native, database: raw, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    const failingCache = createLibraryCacheStore({
      database: {
        ...raw,
        async getFirst(source, params) {
          if (/SUM\(byte_size\)/u.test(source)) throw new Error('database is busy');
          return await raw.getFirst(source, params);
        },
      },
      files: createLibraryFileStore({ port }),
      port,
    });

    await expect(failingCache.putFromFile(input)).rejects.toThrow('database is busy');

    expect(port.files.has(destination)).toBe(false);
    expect(await raw.getFirst(
      `SELECT 1 AS present FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    )).toBeNull();
    native.close();
  });

  it('keeps an existing entry intact when ensureDirectories rejects before replacement', async () => {
    const { native, database, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    const oldBytes = Uint8Array.from([9, 9, 9, 9]);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: 'old-generation',
      bytes: oldBytes,
    });
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    port.ensureDirectories = async () => {
      throw new Error('directories unavailable');
    };

    await expect(cache.putFromFile(input)).resolves.toBeNull();

    expect(port.files.get(destination)).toEqual(oldBytes);
    expect(port.files.has(input.sourceUri)).toBe(false);
    await expect(cache.find(SCOPE, A, 'thumbnail')).resolves.toMatchObject({
      generationId: 'old-generation',
    });
    expect(await database.getFirst(
      `SELECT 1 AS present FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    )).not.toBeNull();
    native.close();
  });

  it('keeps an existing entry intact when exists rejects before replacement', async () => {
    const { native, database, cache, port } = await harness(1_000);
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    const oldBytes = Uint8Array.from([9, 9, 9, 9]);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: 'old-generation',
      bytes: oldBytes,
    });
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    const realExists = port.exists.bind(port);
    port.exists = async (uri) => {
      if (uri === destination) throw new Error('exists unavailable');
      return await realExists(uri);
    };

    await expect(cache.putFromFile(input)).resolves.toBeNull();

    expect(port.files.get(destination)).toEqual(oldBytes);
    expect(port.files.has(input.sourceUri)).toBe(false);
    port.exists = realExists;
    await expect(cache.find(SCOPE, A, 'thumbnail')).resolves.toMatchObject({
      generationId: 'old-generation',
    });
    expect(await database.getFirst(
      `SELECT 1 AS present FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    )).not.toBeNull();
    native.close();
  });

  it('preserves the original INSERT error when rollback row cleanup rejects', async () => {
    const { native, database: raw, cache, port } = await harness(1_000);
    const input = fromFileInput();
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: 'old-generation',
      bytes: Uint8Array.from([9, 9, 9, 9]),
    });
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    let insertAttempted = false;
    const failingCache = createLibraryCacheStore({
      database: {
        ...raw,
        async run(source, params) {
          if (/^\s*INSERT INTO library_cache_entries/u.test(source)) {
            insertAttempted = true;
            throw new Error('original INSERT failure');
          }
          return await raw.run(source, params);
        },
        async getFirst(source, params) {
          if (insertAttempted && /library_cache_entries/u.test(source)) {
            throw new Error('rollback cleanup failure');
          }
          return await raw.getFirst(source, params);
        },
      },
      files: createLibraryFileStore({ port }),
      port,
      budgetBytes: 10,
    });

    await expect(failingCache.putFromFile(input)).rejects.toThrow('original INSERT failure');
    native.close();
  });

  it('rolls back a first-time entry when the over-budget eviction pass rejects', async () => {
    const { native, database: raw, cache, port } = await harness(10);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: null,
      bytes: Uint8Array.from([9, 9, 9, 9, 9, 9]),
    });
    const input = fromFileInput({
      plaintextSha256: B,
      sourceUri: 'file:///cache/library-stream/eviction-reject.bin',
      byteSize: 6,
      generationId: 'new-generation',
    });
    const destination = port.resolveCache(`${SCOPE}-${B}-thumbnail.bin`);
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4, 5, 6]));
    const failingCache = createLibraryCacheStore({
      database: {
        ...raw,
        async getAll(source, params) {
          if (/ORDER BY last_used_at ASC/u.test(source)) {
            throw new Error('eviction pass failed');
          }
          return await raw.getAll(source, params);
        },
      },
      files: createLibraryFileStore({ port }),
      port,
      budgetBytes: 10,
    });

    await expect(failingCache.putFromFile(input)).rejects.toThrow('eviction pass failed');

    expect(port.files.has(destination)).toBe(false);
    expect(await raw.getFirst(
      `SELECT 1 AS present FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, B, 'thumbnail'],
    )).toBeNull();
    native.close();
  });

  it('refuses an over-budget file before moving or leaving a destination', async () => {
    const { native, cache, port } = await harness(4);
    const input = fromFileInput({ byteSize: 5 });
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4, 5]));
    let moved = false;
    port.move = async () => {
      moved = true;
    };

    await expect(cache.putFromFile(input)).resolves.toBeNull();

    expect(moved).toBe(false);
    expect(port.files.has(input.sourceUri)).toBe(false);
    expect(port.files.has(destination)).toBe(false);
    native.close();
  });

  it('keeps a file started during an already-running sweep', async () => {
    const { native, database: raw, port } = await harness(1_000);
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let insertReached!: () => void;
    const insertReachedSignal = new Promise<void>((resolve) => {
      insertReached = resolve;
    });
    const database = {
      ...raw,
      async run(
        source: string,
        params?: Parameters<SqlDatabasePort['run']>[1],
      ) {
        if (/^\s*INSERT INTO library_cache_entries/u.test(source)) {
          insertReached();
          await insertGate;
        }
        return await raw.run(source, params);
      },
    };
    const cache = createLibraryCacheStore({
      database,
      files: createLibraryFileStore({ port }),
      port,
    });
    const input = fromFileInput();
    const destination = port.resolveCache(`${SCOPE}-${A}-thumbnail.bin`);
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    let releaseListing!: () => void;
    const listingGate = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    let listingReached!: () => void;
    const listingReachedSignal = new Promise<void>((resolve) => {
      listingReached = resolve;
    });
    const realListCache = port.listCache.bind(port);
    port.listCache = async () => {
      listingReached();
      await listingGate;
      return await realListCache();
    };
    const sweeping = cache.sweepOrphans();
    await listingReachedSignal;
    let moveReached!: () => void;
    const moveReachedSignal = new Promise<void>((resolve) => {
      moveReached = resolve;
    });
    const realMove = port.move.bind(port);
    port.move = async (sourceUri, destinationUri) => {
      await realMove(sourceUri, destinationUri);
      moveReached();
    };
    const putting = cache.putFromFile(input);
    await moveReachedSignal;
    await insertReachedSignal;
    releaseListing();
    await expect(sweeping).resolves.toBe(0);
    releaseInsert();
    await expect(putting).resolves.toMatchObject({ uri: destination });
    expect(port.files.has(destination)).toBe(true);
    native.close();
  });

  it('releases its writing shield after settling so a later sweep deletes an orphan', async () => {
    const { native, database, cache, port } = await harness(1_000);
    const input = fromFileInput();
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    const entry = await cache.putFromFile(input);
    expect(entry).not.toBeNull();
    await database.run(
      `DELETE FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'thumbnail'],
    );
    port.files.set(entry!.uri, Uint8Array.from([9]));

    await expect(cache.sweepOrphans()).resolves.toBe(1);
    expect(port.files.has(entry!.uri)).toBe(false);
    native.close();
  });

  it('ensures cache directories before moving the source', async () => {
    const { native, cache, port } = await harness(1_000);
    const input = fromFileInput();
    port.files.set(input.sourceUri, Uint8Array.from([1, 2, 3, 4]));
    const events: string[] = [];
    port.ensureDirectories = async () => {
      events.push('ensure');
    };
    const realMove = port.move.bind(port);
    port.move = async (sourceUri, destinationUri) => {
      events.push('move');
      await realMove(sourceUri, destinationUri);
    };

    await expect(cache.putFromFile(input)).resolves.not.toBeNull();
    expect(events).toEqual(['ensure', 'move']);
    native.close();
  });

  it('evicts the least recently used entry first when over budget', async () => {
    const { native, cache, now } = await harness(20);
    const write = async (digest: string) => {
      await cache.put({
        accountScope: SCOPE,
        plaintextSha256: digest,
        role: 'thumbnail',
        generationId: null,
        bytes: new Uint8Array(8),
      });
      now.value += 10;
    };
    await write(A);
    await write(B);
    // Touch A so B becomes the least recently used entry.
    await cache.find(SCOPE, A, 'thumbnail');
    now.value += 10;
    await write(C);

    expect(await cache.find(SCOPE, B, 'thumbnail')).toBeNull();
    expect(await cache.find(SCOPE, A, 'thumbnail')).not.toBeNull();
    expect(await cache.find(SCOPE, C, 'thumbnail')).not.toBeNull();
    expect(await cache.usageBytes(SCOPE)).toBeLessThanOrEqual(20);
    native.close();
  });

  it('promotes last_used_at when find hits a cached role', async () => {
    const { native, database, cache, now } = await harness(1_000);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'preview',
      generationId: null,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const before = await database.getFirst<{ last_used_at: number }>(
      `SELECT last_used_at FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'preview'],
    );
    expect(before?.last_used_at).toBe(1_000);

    now.value = 2_500;
    await cache.find(SCOPE, A, 'preview');

    const after = await database.getFirst<{ last_used_at: number }>(
      `SELECT last_used_at FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [SCOPE, A, 'preview'],
    );
    expect(after?.last_used_at).toBe(2_500);
    native.close();
  });

  it('reports a miss and drops the row when the OS reclaimed the file', async () => {
    const { native, cache, port } = await harness(1_000);
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'preview',
      generationId: null,
      bytes: new Uint8Array(4),
    });
    const entry = await cache.find(SCOPE, A, 'preview');
    await port.delete(entry!.uri);

    expect(await cache.find(SCOPE, A, 'preview')).toBeNull();
    expect(await cache.usageBytes(SCOPE)).toBe(0);
    native.close();
  });

  it('refuses to delete an entry whose uri escaped the cache root', async () => {
    const { native, database, cache, port } = await harness(1);
    const durable = port.resolveOriginal(`${A}.jpg`);
    await port.writeBytes(durable, new Uint8Array(64));
    await database.run(
      `INSERT INTO library_cache_entries (
         account_scope, plaintext_sha256, role, uri, byte_size,
         generation_id, created_at, last_used_at
       ) VALUES (?, ?, 'original', ?, 64, NULL, 1, 1)`,
      [SCOPE, A, durable],
    );

    const report = await cache.evictToBudget(SCOPE);

    expect(report.refused).toBe(1);
    expect(report.evicted).toBe(0);
    expect(await port.exists(durable)).toBe(true);
    native.close();
  });

  it('changes neither membership nor residency when the cache is cleared', async () => {
    const { native, database, cache } = await harness(1_000);
    await database.run(
      `INSERT INTO device_library_assets (
         plaintext_sha256, format, canonical_extension, byte_size, width, height,
         origin, source_image_id, local_original_uri, residency, protect_eligible,
         missing_original_since, created_at, updated_at
       ) VALUES (?, 'jpeg', 'jpg', 10, 4, 4, 'import', NULL,
         'file:///originals/a.jpg', 'local-original', 1, NULL, 5, 5)`,
      [A],
    );
    const before = await database.getAll('SELECT * FROM device_library_assets');
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: null,
      bytes: new Uint8Array(4),
    });

    await cache.clearScope(SCOPE);

    expect(await database.getAll('SELECT * FROM device_library_assets'))
      .toEqual(before);
    expect(await cache.usageBytes(SCOPE)).toBe(0);
    native.close();
  });

  it('eviction never mutates membership, protection, or account rows', async () => {
    const { native, database, cache, now } = await harness(8);
    const assetId = 'e'.repeat(64);
    await database.run(
      `INSERT INTO device_library_assets (
         plaintext_sha256, format, canonical_extension, byte_size, width, height,
         origin, source_image_id, local_original_uri, residency, protect_eligible,
         missing_original_since, created_at, updated_at
       ) VALUES (?, 'jpeg', 'jpg', 10, 4, 4, 'import', NULL,
         'file:///originals/a.jpg', 'local-original', 1, NULL, 5, 5)`,
      [A],
    );
    await database.run(
      `INSERT INTO library_asset_protection (
         account_scope, asset_id, plaintext_sha256, lifecycle, protection,
         generation, revision, original_generation_id, original_ciphertext_bytes,
         verified_at, failure_category, trashed_at, updated_at
       ) VALUES (?, ?, ?, 'active', 'unprotected', 0, NULL, NULL, NULL,
         NULL, NULL, NULL, 5)`,
      [SCOPE, assetId, A],
    );
    await database.run(
      `INSERT INTO library_account_assets (
         account_scope, asset_id, plaintext_sha256, device_id,
         enrolled_at, updated_at
       ) VALUES (?, ?, ?, 'device-1', 5, 5)`,
      [SCOPE, assetId, A],
    );
    const beforeDevice = await database.getAll(
      'SELECT * FROM device_library_assets',
    );
    const beforeProtection = await database.getAll(
      'SELECT * FROM library_asset_protection',
    );
    const beforeAccount = await database.getAll(
      'SELECT * FROM library_account_assets',
    );

    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: null,
      bytes: new Uint8Array(8),
    });
    now.value += 10;
    // Second put exceeds the 8-byte budget and forces LRU eviction of A.
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: B,
      role: 'thumbnail',
      generationId: null,
      bytes: new Uint8Array(8),
    });
    expect(await cache.find(SCOPE, A, 'thumbnail')).toBeNull();
    expect(await cache.find(SCOPE, B, 'thumbnail')).not.toBeNull();

    expect(await database.getAll('SELECT * FROM device_library_assets'))
      .toEqual(beforeDevice);
    expect(await database.getAll('SELECT * FROM library_asset_protection'))
      .toEqual(beforeProtection);
    expect(await database.getAll('SELECT * FROM library_account_assets'))
      .toEqual(beforeAccount);
    native.close();
  });

  it('never returns or evicts another account scope entry', async () => {
    const { native, cache } = await harness(8);
    await cache.put({
      accountScope: OTHER,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: null,
      bytes: new Uint8Array(8),
    });
    await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: null,
      bytes: new Uint8Array(8),
    });

    expect(await cache.find(SCOPE, A, 'thumbnail')).not.toBeNull();
    expect(await cache.find(OTHER, A, 'thumbnail')).not.toBeNull();
    await cache.clearScope(SCOPE);
    expect(await cache.find(OTHER, A, 'thumbnail')).not.toBeNull();
    native.close();
  });

  it('forgets every cached role for one digest', async () => {
    const { native, cache } = await harness(1_000);
    for (const role of ['thumbnail', 'preview', 'original'] as const) {
      await cache.put({
        accountScope: SCOPE,
        plaintextSha256: A,
        role,
        generationId: null,
        bytes: new Uint8Array(4),
      });
    }
    await cache.forget(SCOPE, A);
    expect(await cache.find(SCOPE, A, 'thumbnail')).toBeNull();
    expect(await cache.find(SCOPE, A, 'preview')).toBeNull();
    expect(await cache.find(SCOPE, A, 'original')).toBeNull();
    native.close();
  });

  it('forget with a role drops only that role', async () => {
    const { native, cache, port } = await harness(1_000);
    for (const role of ['thumbnail', 'original'] as const) {
      await cache.put({
        accountScope: SCOPE,
        plaintextSha256: A,
        role,
        generationId: null,
        bytes: new Uint8Array(4),
      });
    }
    const original = await cache.find(SCOPE, A, 'original');
    expect(port.files.has(original!.uri)).toBe(true);

    await cache.forget(SCOPE, A, 'original');

    expect(await cache.find(SCOPE, A, 'thumbnail')).not.toBeNull();
    expect(await cache.find(SCOPE, A, 'original')).toBeNull();
    expect(port.files.has(original!.uri)).toBe(false);
    native.close();
  });

  it('releases forgotten bytes so the next put is still one statement', async () => {
    const { native, cache, statements } = await harness(20);
    const put = (digest: string) => cache.put({
      accountScope: SCOPE,
      plaintextSha256: digest,
      role: 'thumbnail',
      generationId: null,
      bytes: new Uint8Array(8),
    });
    await put(A);
    await put(B);
    await cache.forget(SCOPE, A);

    statements.length = 0;
    await put(C);

    expect(statements).toHaveLength(1);
    expect(await cache.usageBytes(SCOPE)).toBe(16);
    native.close();
  });
});

// Board #27 S2 (R24): a decrypted file whose row is gone is swept, and never one
// a put is still registering.
describe('library cache store: orphan sweep', () => {
  const putInput = (digest: string) => ({
    accountScope: SCOPE,
    plaintextSha256: digest,
    role: 'thumbnail' as const,
    generationId: null,
    bytes: new Uint8Array([1, 2, 3]),
  });

  /**
   * An asset id unlike its digest in every place, as the account's derived ids
   * are: a sweep matching the wrong column must not pass by coincidence.
   */
  const assetIdOf = (digest: string) => digest.replace(
    /[0-9a-f]/gu,
    (c) => ((parseInt(c, 16) + 1) % 16).toString(16),
  );

  /** A protected, active projection for (scope, digest): the asset this phone knows. */
  async function seedProjection(database: SqlDatabasePort, scope: string, digest: string) {
    await createLibraryProtectionRepository({ database }).upsertProtection({
      accountScope: scope,
      assetId: assetIdOf(digest),
      plaintextSha256: digest,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 1,
      originalGenerationId: '11111111-1111-4111-8111-111111111111',
      originalCiphertextBytes: 10,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: 5,
      failureCategory: null,
      trashedAt: null,
    });
  }

  /** A cache over `native` whose cache-row INSERT and cache listing can be held. */
  async function gated() {
    const native = new DatabaseSync(':memory:');
    const raw = createNodeSqliteAdapter(native);
    await migrateDatabase(raw);
    const port = createFakeLibraryFilePort();
    await port.ensureDirectories();
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let insertReached!: () => void;
    const insertReachedSignal = new Promise<void>((resolve) => {
      insertReached = resolve;
    });
    const control = { holdInsert: false, failInsert: false, holdListing: null as Promise<void> | null };
    const database: SqlDatabasePort = {
      ...raw,
      async run(source, params) {
        if (/^\s*INSERT INTO library_cache_entries/u.test(source)) {
          if (control.failInsert) throw new Error('database is busy');
          if (control.holdInsert) {
            insertReached();
            await insertGate;
          }
        }
        return await raw.run(source, params);
      },
    };
    const listCache = port.listCache.bind(port);
    port.listCache = async () => {
      if (control.holdListing !== null) await control.holdListing;
      return await listCache();
    };
    const cache = createLibraryCacheStore({
      database,
      files: createLibraryFileStore({ port }),
      port,
    });
    return { native, raw, port, cache, control, releaseInsert, insertReachedSignal };
  }

  it('deletes cache files no row names, keeps named ones', async () => {
    const { native, database, cache, port } = await harness(1_000);
    await seedProjection(database, SCOPE, A);
    const named = await cache.put({
      accountScope: SCOPE,
      plaintextSha256: A,
      role: 'thumbnail',
      generationId: null,
      bytes: new Uint8Array([1, 2, 3]),
    });
    const orphan = port.resolveCache('scope-x-orphan.bin');
    port.files.set(orphan, new Uint8Array([9]));

    await expect(cache.sweepOrphans()).resolves.toBe(1);

    expect(port.files.has(orphan)).toBe(false);
    expect(port.files.has(named!.uri)).toBe(true);
    native.close();
  });

  it('a put whose file lands before the listing and whose row lands after the read is kept', async () => {
    const { native, cache, port, control, releaseInsert, insertReachedSignal } = await gated();
    control.holdInsert = true;

    const putting = cache.put(putInput(A));
    await insertReachedSignal;
    expect([...port.files.keys()]).toHaveLength(1);

    await expect(cache.sweepOrphans()).resolves.toBe(0);
    releaseInsert();
    const entry = await putting;

    expect(entry).not.toBeNull();
    expect(port.files.has(entry!.uri)).toBe(true);
    expect(await cache.find(SCOPE, A, 'thumbnail')).not.toBeNull();
    native.close();
  });

  it('a put that starts during the sweep is kept', async () => {
    const { native, cache, port, control, releaseInsert, insertReachedSignal } = await gated();
    let releaseListing!: () => void;
    control.holdListing = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    control.holdInsert = true;

    const sweeping = cache.sweepOrphans();
    const putting = cache.put(putInput(B));
    await insertReachedSignal;
    releaseListing();

    await expect(sweeping).resolves.toBe(0);
    expect([...port.files.keys()]).toHaveLength(1);
    releaseInsert();
    const entry = await putting;
    expect(port.files.has(entry!.uri)).toBe(true);
    native.close();
  });

  it('a second sweep while one runs stands aside: it lists nothing and deletes nothing', async () => {
    const { native, cache, port, control } = await gated();
    const orphan = port.resolveCache('scope-x-orphan.bin');
    port.files.set(orphan, new Uint8Array([1]));
    let releaseListing!: () => void;
    control.holdListing = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    let listings = 0;
    const heldList = port.listCache.bind(port);
    port.listCache = async () => {
      listings += 1;
      return await heldList();
    };

    const first = cache.sweepOrphans();
    const second = cache.sweepOrphans();
    releaseListing();

    await expect(second).resolves.toBe(0);
    await expect(first).resolves.toBe(1);
    expect(listings).toBe(1);
    expect(port.files.has(orphan)).toBe(false);
    native.close();
  });

  it('a file that cannot be deleted is skipped; the others still go', async () => {
    const { native, cache, port } = await harness(1_000);
    const stuck = port.resolveCache('scope-x-stuck.bin');
    const orphan = port.resolveCache('scope-x-orphan.bin');
    port.files.set(stuck, new Uint8Array([9]));
    port.files.set(orphan, new Uint8Array([8]));
    const realDelete = port.delete.bind(port);
    port.delete = async (uri: string) => {
      if (uri === stuck) throw new Error('busy');
      await realDelete(uri);
    };

    await expect(cache.sweepOrphans()).resolves.toBe(1);

    expect(port.files.has(stuck)).toBe(true);
    expect(port.files.has(orphan)).toBe(false);
    native.close();
  });

  it('every row names its file, whatever its scope', async () => {
    const { native, database, cache, port } = await harness(1_000);
    await seedProjection(database, SCOPE, A);
    await seedProjection(database, `${SCOPE}-other`, B);
    const first = await cache.put(putInput(A));
    const second = await cache.put({ ...putInput(B), accountScope: `${SCOPE}-other` });
    const orphan = port.resolveCache('scope-x-orphan.bin');
    port.files.set(orphan, new Uint8Array([9]));

    await expect(cache.sweepOrphans()).resolves.toBe(1);

    expect(port.files.has(first!.uri)).toBe(true);
    expect(port.files.has(second!.uri)).toBe(true);
    expect(port.files.has(orphan)).toBe(false);
    native.close();
  });

  it('a sweep whose row read fails deletes nothing, not every file', async () => {
    const { native, raw, port, cache } = await gated();
    await seedProjection(raw, SCOPE, A);
    const named = await cache.put(putInput(A));
    const orphan = port.resolveCache('scope-x-orphan.bin');
    port.files.set(orphan, new Uint8Array([9]));
    const failingRead = createLibraryCacheStore({
      database: {
        ...raw,
        getAll: (async (source: string, params?: never) => {
          if (/library_cache_entries/u.test(source)) throw new Error('database is busy');
          return await raw.getAll(source, params);
        }) as SqlDatabasePort['getAll'],
      },
      files: createLibraryFileStore({ port }),
      port,
    });

    await failingRead.sweepOrphans().catch(() => undefined);

    expect(port.files.has(named!.uri)).toBe(true);
    expect(port.files.has(orphan)).toBe(true);
    native.close();
  });

  it('a put registers before its write: a full sweep while its file is landing keeps it', async () => {
    const { native, cache, port } = await gated();
    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let landed!: () => void;
    const landedSignal = new Promise<void>((resolve) => {
      landed = resolve;
    });
    const realWrite = port.writeBytes.bind(port);
    port.writeBytes = async (uri: string, bytes: Uint8Array) => {
      await realWrite(uri, bytes);
      landed();
      await writeHeld;
    };

    const putting = cache.put(putInput(A));
    await landedSignal;
    await expect(cache.sweepOrphans()).resolves.toBe(0);
    releaseWrite();

    const entry = await putting;
    expect(port.files.has(entry!.uri)).toBe(true);
    native.close();
  });

  it('names are compared by file name', async () => {
    const { native, cache, port, raw } = await gated();
    await seedProjection(raw, SCOPE, C);
    const entry = await cache.put(putInput(C));
    const name = entry!.uri.slice(entry!.uri.lastIndexOf('/') + 1);
    await raw.run('UPDATE library_cache_entries SET uri = ?', [`file:/other/root/${name}`]);

    await expect(cache.sweepOrphans()).resolves.toBe(0);

    expect(port.files.has(entry!.uri)).toBe(true);
    native.close();
  });

  it('a put that throws releases its entry, so its file is an orphan afterwards', async () => {
    const { native, cache, port, control } = await gated();
    control.failInsert = true;

    await expect(cache.put(putInput(A))).rejects.toThrow('database is busy');
    expect([...port.files.keys()]).toHaveLength(1);

    await expect(cache.sweepOrphans()).resolves.toBe(1);
    expect([...port.files.keys()]).toHaveLength(0);
    native.close();
  });

  it('a failed listing deletes nothing, and a second sweep can still run', async () => {
    const { native, cache, port } = await gated();
    const orphan = port.resolveCache('scope-x-orphan.bin');
    port.files.set(orphan, new Uint8Array([9]));
    // A row with no projection: a listing that failed leaves its row alone too.
    const unknown = await cache.put(putInput(A));
    const listCache = port.listCache;
    port.listCache = async () => {
      throw new Error('cannot list');
    };

    await expect(cache.sweepOrphans()).resolves.toBe(0);
    expect(port.files.has(orphan)).toBe(true);
    expect(await cache.find(SCOPE, A, 'thumbnail')).not.toBeNull();
    expect(port.files.has(unknown!.uri)).toBe(true);

    port.listCache = listCache;
    await expect(cache.sweepOrphans()).resolves.toBe(2);
    native.close();
  });

  it('a row whose asset has no projection under its scope loses its row and its file', async () => {
    const { native, database, cache, port } = await harness(1_000);
    await seedProjection(database, SCOPE, A);
    const kept = await cache.put({ ...putInput(A), role: 'preview' });
    const dropped = await cache.put({ ...putInput(B), role: 'preview' });

    await expect(cache.sweepOrphans()).resolves.toBe(1);

    expect(await cache.find(SCOPE, B, 'preview')).toBeNull();
    expect(port.files.has(dropped!.uri)).toBe(false);
    expect(await cache.find(SCOPE, A, 'preview')).not.toBeNull();
    expect(port.files.has(kept!.uri)).toBe(true);
    native.close();
  });

  it.each([
    ['in the trash', "lifecycle = 'trash', trashed_at = 5"],
    ['not protected yet', "protection = 'pending'"],
  ])('a projection keeps its rows whatever its state: %s', async (_name, change) => {
    const { native, database, cache, port } = await harness(1_000);
    await seedProjection(database, SCOPE, A);
    await database.run(
      `UPDATE library_asset_protection SET ${change} WHERE plaintext_sha256 = ?`,
      [A],
    );
    const kept = await cache.put({ ...putInput(A), role: 'preview' });

    await expect(cache.sweepOrphans()).resolves.toBe(0);

    expect(await cache.find(SCOPE, A, 'preview')).not.toBeNull();
    expect(port.files.has(kept!.uri)).toBe(true);
    native.close();
  });

  it.each(['thumbnail', 'preview', 'original'] as const)(
    'a row with no projection goes whatever its role: %s',
    async (role) => {
      const { native, cache, port } = await harness(1_000);
      const dropped = await cache.put({ ...putInput(B), role });

      await expect(cache.sweepOrphans()).resolves.toBe(1);

      expect(await cache.find(SCOPE, B, role)).toBeNull();
      expect(port.files.has(dropped!.uri)).toBe(false);
      native.close();
    },
  );

  it('a projection under another scope does not keep it', async () => {
    const { native, database, cache, port } = await harness(1_000);
    await seedProjection(database, OTHER, B);
    const dropped = await cache.put({ ...putInput(B), role: 'preview' });

    await expect(cache.sweepOrphans()).resolves.toBe(1);

    expect(await cache.find(SCOPE, B, 'preview')).toBeNull();
    expect(port.files.has(dropped!.uri)).toBe(false);
    native.close();
  });

  it('a failed delete of rows deletes no file', async () => {
    const { native, raw, port, cache } = await gated();
    const unknown = await cache.put(putInput(A));
    const orphan = port.resolveCache('scope-x-orphan.bin');
    port.files.set(orphan, new Uint8Array([9]));
    const failingDelete = createLibraryCacheStore({
      database: {
        ...raw,
        run: (async (source: string, params?: never) => {
          if (/^\s*DELETE FROM library_cache_entries/u.test(source)) {
            throw new Error('database is busy');
          }
          return await raw.run(source, params);
        }) as SqlDatabasePort['run'],
      },
      files: createLibraryFileStore({ port }),
      port,
    });

    await expect(failingDelete.sweepOrphans()).rejects.toThrow('database is busy');

    expect(port.files.has(unknown!.uri)).toBe(true);
    expect(port.files.has(orphan)).toBe(true);
    native.close();
  });
});
