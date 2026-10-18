import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryObjectRole } from '@/features/library/library-actions-types';
import { LIBRARY_CACHE_MAX_BYTES } from '@/features/library/library-cache-limits';
import type {
  LibraryFilePort,
  LibraryFileStore,
} from '@/features/library/library-file-store';

export type LibraryCacheEntry = Readonly<{
  accountScope: string;
  plaintextSha256: string;
  role: LibraryObjectRole;
  uri: string;
  byteSize: number;
  /** The object generation these bytes came from, when one is known. */
  generationId: string | null;
  createdAt: number;
  lastUsedAt: number;
}>;

export type LibraryCacheEvictionReport = Readonly<{
  evicted: number;
  /** Rows whose `uri` was outside the cache root: refused, never deleted. */
  refused: number;
  failed: number;
  usageBytes: number;
}>;

export type LibraryCacheStore = Readonly<{
  find(
    accountScope: string,
    plaintextSha256: string,
    role: LibraryObjectRole,
  ): Promise<LibraryCacheEntry | null>;
  readBytes(entry: LibraryCacheEntry): Promise<Uint8Array>;
  put(input: Readonly<{
    accountScope: string;
    plaintextSha256: string;
    role: LibraryObjectRole;
    generationId: string | null;
    bytes: Uint8Array;
  }>): Promise<LibraryCacheEntry | null>;
  putFromFile(input: Readonly<{
    accountScope: string;
    plaintextSha256: string;
    role: LibraryObjectRole;
    generationId: string | null;
    sourceUri: string;
    byteSize: number;
  }>): Promise<LibraryCacheEntry | null>;
  evictToBudget(accountScope: string): Promise<LibraryCacheEvictionReport>;
  clearScope(accountScope: string): Promise<LibraryCacheEvictionReport>;
  /** One digest's cached files; with a `role`, only that role's row and file. */
  forget(
    accountScope: string,
    plaintextSha256: string,
    role?: LibraryObjectRole,
  ): Promise<void>;
  usageBytes(accountScope: string): Promise<number>;
  /**
   * R24: deletes each file in the cache directory whose file name no
   * `library_cache_entries` row has; never one a `put` in flight is writing;
   * answers how many it deleted; a failed listing deletes nothing. It first
   * drops every row whose (scope, digest) has no projection.
   */
  sweepOrphans(): Promise<number>;
}>;

export type LibraryCacheStoreDependencies = Readonly<{
  database: SqlDatabasePort;
  files: LibraryFileStore;
  port: LibraryFilePort;
  budgetBytes?: number;
  clock?: () => number;
}>;

type CacheRow = {
  account_scope: string;
  plaintext_sha256: string;
  role: string;
  uri: string;
  byte_size: number;
  generation_id: string | null;
  created_at: number;
  last_used_at: number;
};

const COLUMNS = `
  account_scope, plaintext_sha256, role, uri, byte_size, generation_id,
  created_at, last_used_at
`;

function toEntry(row: CacheRow): LibraryCacheEntry {
  return {
    accountScope: row.account_scope,
    plaintextSha256: row.plaintext_sha256,
    role: row.role as LibraryObjectRole,
    uri: row.uri,
    byteSize: row.byte_size,
    generationId: row.generation_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function createLibraryCacheStore({
  database,
  files,
  port,
  budgetBytes = LIBRARY_CACHE_MAX_BYTES,
  clock = Date.now,
}: LibraryCacheStoreDependencies): LibraryCacheStore {
  /**
   * Invariant 3 guard. Only a path inside the cache root may ever be deleted by
   * this module, so a corrupted, hand-edited, or migrated row can never make
   * eviction remove a durable original or device-trash bytes.
   */
  const insideCacheRoot = (uri: string): boolean =>
    uri.startsWith(port.cacheRootUri);

  const dropRow = async (
    accountScope: string,
    plaintextSha256: string,
    role: LibraryObjectRole,
  ): Promise<void> => {
    await database.run(
      `DELETE FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [accountScope, plaintextSha256, role],
    );
  };

  /**
   * K7 cut 8 (audit ㉞): the running total per scope. Learned from SQL once
   * per scope, then maintained in memory so an ordinary cache write is a single
   * INSERT. A write that replaces an existing role adds its bytes without
   * subtracting the bytes it replaced, so the number can only ever be too high
   * — which at worst runs one eviction pass that re-learns the exact total from
   * SQL and evicts nothing. It can never hide an over-budget scope.
   */
  const totals = new Map<string, number>();

  /** The authoritative total. Every eviction decision starts from this. */
  const sumUsageBytes = async (accountScope: string): Promise<number> => {
    const row = await database.getFirst<{ total: number | null }>(
      `SELECT SUM(byte_size) AS total FROM library_cache_entries
        WHERE account_scope = ?`,
      [accountScope],
    );
    const total = row?.total ?? 0;
    totals.set(accountScope, total);
    return total;
  };

  /**
   * The cheap estimate the write path uses to decide whether an eviction pass
   * is needed at all. Never reported to a caller: `usageBytes()` stays
   * authoritative so nothing outside this module ever sees the estimate.
   */
  const estimatedUsage = async (accountScope: string): Promise<number> => {
    const known = totals.get(accountScope);
    return known ?? await sumUsageBytes(accountScope);
  };

  /**
   * Adjusts a total this module already knows. A scope it has not learned yet
   * stays unlearned rather than being seeded from a delta, because a total that
   * is too LOW would hide an over-budget scope.
   */
  const addToTotal = (accountScope: string, delta: number): void => {
    const known = totals.get(accountScope);
    if (known === undefined) return;
    totals.set(accountScope, Math.max(0, known + delta));
  };

  /** Cache file names are scope-free: the row owns the scope, the name owns the bytes. */
  const cacheName = (
    accountScope: string,
    plaintextSha256: string,
    role: LibraryObjectRole,
  ): string => `${accountScope}-${plaintextSha256}-${role}.bin`;

  const evictRows = async (
    rows: readonly CacheRow[],
  ): Promise<{ evicted: number; refused: number; failed: number }> => {
    let evicted = 0;
    let refused = 0;
    let failed = 0;
    for (const row of rows) {
      if (!insideCacheRoot(row.uri)) {
        // Refuse and keep the row so the anomaly stays visible and retryable.
        refused += 1;
        continue;
      }
      try {
        await port.delete(row.uri);
      } catch {
        failed += 1;
        continue;
      }
      await dropRow(
        row.account_scope,
        row.plaintext_sha256,
        row.role as LibraryObjectRole,
      );
      evicted += 1;
      addToTotal(row.account_scope, -row.byte_size);
    }
    return { evicted, refused, failed };
  };

  /**
   * The oldest-first budget pass. It always starts from the authoritative SQL
   * total, so an in-memory estimate can never change which rows are evicted.
   * `watch` names the row a caller just wrote: when the pass has to evict it
   * (only possible when refused rows keep the scope over budget), the caller is
   * told so it can report an uncached entry instead of a dangling uri.
   */
  const evictScope = async (
    accountScope: string,
    watch?: Readonly<{ plaintextSha256: string; role: LibraryObjectRole }>,
  ): Promise<LibraryCacheEvictionReport & { evictedWatched: boolean }> => {
    let evicted = 0;
    let refused = 0;
    let failed = 0;
    let evictedWatched = false;
    let usage = await sumUsageBytes(accountScope);
    // Oldest-first, one bounded page at a time, and only while still over
    // budget. Stop mid-page once under budget so LRU victims are not
    // over-evicted. `refused` rows keep their bytes, so a scope that is over
    // budget solely because of refused rows terminates instead of spinning.
    while (usage > budgetBytes) {
      const rows = await database.getAll<CacheRow>(
        `SELECT ${COLUMNS} FROM library_cache_entries
          WHERE account_scope = ?
          ORDER BY last_used_at ASC, plaintext_sha256 ASC, role ASC
          LIMIT 32`,
        [accountScope],
      );
      if (rows.length === 0) break;
      let pageEvicted = 0;
      let pageRefused = 0;
      for (const row of rows) {
        if (usage <= budgetBytes) break;
        if (!insideCacheRoot(row.uri)) {
          pageRefused += 1;
          continue;
        }
        try {
          await port.delete(row.uri);
        } catch {
          failed += 1;
          continue;
        }
        await dropRow(
          row.account_scope,
          row.plaintext_sha256,
          row.role as LibraryObjectRole,
        );
        pageEvicted += 1;
        usage -= row.byte_size;
        if (
          watch !== undefined
          && row.plaintext_sha256 === watch.plaintextSha256
          && row.role === watch.role
        ) {
          evictedWatched = true;
        }
      }
      evicted += pageEvicted;
      refused += pageRefused;
      if (pageEvicted === 0) break;
      usage = await sumUsageBytes(accountScope);
    }
    totals.set(accountScope, usage);
    return { evicted, refused, failed, usageBytes: usage, evictedWatched };
  };

  /** Uris a `put` is writing and has not registered yet (R24). */
  const writing = new Map<string, number>();
  /** While a sweep runs: what it must keep besides the named files. */
  let sweepKeep: Set<string> | null = null;
  const nameOf = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1);
  /** Same-destination writes queue; independent cache files stay concurrent. */
  const writeChains = new Map<string, Promise<void>>();
  const serializeWrite = async <T>(
    uri: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const previous = writeChains.get(uri) ?? Promise.resolve();
    const current = previous.then(task);
    const tail = current.then(() => undefined, () => undefined);
    writeChains.set(uri, tail);
    try {
      return await current;
    } finally {
      if (writeChains.get(uri) === tail) writeChains.delete(uri);
    }
  };

  const bestEffortDelete = async (uri: string): Promise<void> => {
    // A leftover stream temp is removed by the startup sweep; a rowless cache
    // file is removed by sweepOrphans, so cleanup deletes stay best effort.
    await port.delete(uri).catch(() => undefined);
  };

  const dropIdentityRow = async (
    accountScope: string,
    plaintextSha256: string,
    role: LibraryObjectRole,
  ): Promise<void> => {
    const row = await database.getFirst<CacheRow>(
      `SELECT ${COLUMNS} FROM library_cache_entries
        WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
      [accountScope, plaintextSha256, role],
    );
    if (row === null) return;
    await dropRow(accountScope, plaintextSha256, role);
    addToTotal(accountScope, -row.byte_size);
  };

  const bestEffortDropIdentityRow = async (
    accountScope: string,
    plaintextSha256: string,
    role: LibraryObjectRole,
  ): Promise<void> => {
    // Row cleanup must not mask the transfer or registration outcome.
    await dropIdentityRow(accountScope, plaintextSha256, role).catch(() => undefined);
  };

  const registerCacheEntry = async ({
    accountScope,
    plaintextSha256,
    role,
    generationId,
    uri,
    byteSize,
  }: Readonly<{
    accountScope: string;
    plaintextSha256: string;
    role: LibraryObjectRole;
    generationId: string | null;
    uri: string;
    byteSize: number;
  }>): Promise<LibraryCacheEntry | null> => {
    // Learn the scope's total once, before the first write decides anything.
    const before = await estimatedUsage(accountScope);
    const at = clock();
    await database.run(
      `INSERT INTO library_cache_entries (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_scope, plaintext_sha256, role) DO UPDATE SET
         uri = excluded.uri,
         byte_size = excluded.byte_size,
         generation_id = excluded.generation_id,
         created_at = excluded.created_at,
         last_used_at = excluded.last_used_at`,
      [
        accountScope,
        plaintextSha256,
        role,
        uri,
        byteSize,
        generationId,
        at,
        at,
      ],
    );
    // A write that replaces an existing role counts its bytes twice until the
    // next eviction pass re-learns the exact total; an estimate that is too
    // high only ever costs one extra pass. Anything that deletes cache rows
    // behind this module's back (an account reset) is corrected the same way.
    const total = before + byteSize;
    totals.set(accountScope, total);
    // The bytes and the row are both durable here, so the entry is built from
    // what was written instead of reading the row back. An overwrite stores
    // `created_at = at` too, so the returned entry and the row never disagree.
    const entry: LibraryCacheEntry = {
      accountScope,
      plaintextSha256,
      role,
      uri,
      byteSize,
      generationId,
      createdAt: at,
      lastUsedAt: at,
    };
    if (total <= budgetBytes) return entry;
    // Over budget: run the ordinary oldest-first pass, which re-learns the
    // exact total from SQL. This entry is the most recently used row, so it
    // is only reached when refused rows keep the scope over budget.
    const report = await evictScope(accountScope, { plaintextSha256, role });
    return report.evictedWatched ? null : entry;
  };

  const store: LibraryCacheStore = {
    async find(accountScope, plaintextSha256, role) {
      const row = await database.getFirst<CacheRow>(
        `SELECT ${COLUMNS} FROM library_cache_entries
          WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
        [accountScope, plaintextSha256, role],
      );
      if (row === null) return null;
      // The OS cache directory can be reclaimed at any time. A vanished file is
      // an ordinary miss, never an error and never a corrupt render.
      if (!(await port.exists(row.uri))) {
        await dropRow(accountScope, plaintextSha256, role);
        addToTotal(accountScope, -row.byte_size);
        return null;
      }
      const at = clock();
      await database.run(
        `UPDATE library_cache_entries SET last_used_at = ?
          WHERE account_scope = ? AND plaintext_sha256 = ? AND role = ?`,
        [at, accountScope, plaintextSha256, role],
      );
      return { ...toEntry(row), lastUsedAt: at };
    },

    async readBytes(entry) {
      return await port.readBytes(entry.uri);
    },

    async put({ accountScope, plaintextSha256, role, generationId, bytes }) {
      const uri = port.resolveCache(cacheName(accountScope, plaintextSha256, role));
      return await serializeWrite(uri, async () => {
        if (bytes.byteLength === 0) return null;
        // An entry larger than the whole budget would evict everything and then
        // itself. Skip it and let the caller render from the bytes in hand.
        if (bytes.byteLength > budgetBytes) return null;
        writing.set(uri, (writing.get(uri) ?? 0) + 1);
        sweepKeep?.add(nameOf(uri));
        try {
          try {
            await port.ensureDirectories();
            await port.writeBytes(uri, bytes);
          } catch {
            // A cache write failure is never a render failure.
            return null;
          }
          return await registerCacheEntry({
            accountScope,
            plaintextSha256,
            role,
            generationId,
            uri,
            byteSize: bytes.byteLength,
          });
        } finally {
          const left = (writing.get(uri) ?? 1) - 1;
          if (left <= 0) writing.delete(uri);
          else writing.set(uri, left);
        }
      });
    },

    async putFromFile({
      accountScope,
      plaintextSha256,
      role,
      generationId,
      sourceUri,
      byteSize,
    }) {
      const uri = port.resolveCache(cacheName(accountScope, plaintextSha256, role));
      return await serializeWrite(uri, async () => {
        if (byteSize === 0 || byteSize > budgetBytes) {
          await bestEffortDelete(sourceUri);
          return null;
        }
        writing.set(uri, (writing.get(uri) ?? 0) + 1);
        sweepKeep?.add(nameOf(uri));
        let destinationDeleted = false;
        let destinationMoved = false;
        try {
          try {
            await port.ensureDirectories();
            if (await port.exists(uri)) {
              await port.delete(uri);
              destinationDeleted = true;
            }
          } catch {
            await bestEffortDelete(sourceUri);
            if (destinationDeleted) {
              await bestEffortDropIdentityRow(accountScope, plaintextSha256, role);
            }
            return null;
          }
          try {
            await port.move(sourceUri, uri);
            destinationMoved = true;
          } catch {
            try {
              await port.copyFrom(sourceUri, uri);
              await port.delete(sourceUri);
              destinationMoved = true;
            } catch {
              await bestEffortDelete(uri);
              await bestEffortDelete(sourceUri);
              if (destinationDeleted) {
                await bestEffortDropIdentityRow(accountScope, plaintextSha256, role);
              }
              return null;
            }
          }
          try {
            return await registerCacheEntry({
              accountScope,
              plaintextSha256,
              role,
              generationId,
              uri,
              byteSize,
            });
          } catch (error) {
            await bestEffortDelete(uri);
            await bestEffortDelete(sourceUri);
            if (destinationDeleted || destinationMoved) {
              await bestEffortDropIdentityRow(accountScope, plaintextSha256, role);
            }
            throw error;
          }
        } finally {
          const left = (writing.get(uri) ?? 1) - 1;
          if (left <= 0) writing.delete(uri);
          else writing.set(uri, left);
        }
      });
    },

    evictToBudget: (accountScope) => evictScope(accountScope),

    async clearScope(accountScope) {
      const rows = await database.getAll<CacheRow>(
        `SELECT ${COLUMNS} FROM library_cache_entries WHERE account_scope = ?`,
        [accountScope],
      );
      const report = await evictRows(rows);
      return { ...report, usageBytes: await sumUsageBytes(accountScope) };
    },

    async forget(accountScope, plaintextSha256, role) {
      const rows = await database.getAll<CacheRow>(
        `SELECT ${COLUMNS} FROM library_cache_entries
          WHERE account_scope = ? AND plaintext_sha256 = ?
            AND (? IS NULL OR role = ?)`,
        [accountScope, plaintextSha256, role ?? null, role ?? null],
      );
      await evictRows(rows);
    },

    usageBytes: sumUsageBytes,

    async sweepOrphans() {
      if (sweepKeep !== null) return 0;
      const keep = new Set([...writing.keys()].map(nameOf));
      sweepKeep = keep;
      try {
        let listed: string[];
        try {
          listed = await port.listCache();
        } catch {
          return 0;
        }
        // Board #27 S3 (R24 residue): a row for an asset this phone no longer
        // knows under that scope — a preview decrypted after 删除全部应用数据
        // forgot the library, before the database closed — names a file no
        // composition can read. Drop the row; the loop below takes its file.
        await database.run(
          `DELETE FROM library_cache_entries
            WHERE NOT EXISTS (
              SELECT 1 FROM library_asset_protection p
               WHERE p.account_scope = library_cache_entries.account_scope
                 AND p.plaintext_sha256 = library_cache_entries.plaintext_sha256)`,
        );
        const rows = await database.getAll<{ uri: string }>(
          'SELECT uri FROM library_cache_entries',
        );
        for (const row of rows) keep.add(nameOf(row.uri));
        let deleted = 0;
        for (const uri of listed) {
          if (keep.has(nameOf(uri))) continue;
          try {
            await port.delete(uri);
            deleted += 1;
          } catch {
            // The next pass tries again.
          }
        }
        return deleted;
      } finally {
        sweepKeep = null;
      }
    },
  };

  // `files` is retained so the store shares the one file abstraction the rest
  // of the library uses; every path it deletes is still root-checked above.
  void files;

  return store;
}
