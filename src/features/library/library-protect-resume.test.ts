import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlBindValue, SqlDatabasePort } from '@/db/sql-port';
import type {
  LibrarySessionContext,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import {
  createLibraryProtectResume,
  LIBRARY_PROTECT_RESUME_BATCH,
} from '@/features/library/library-protect-resume';
import {
  seedDeviceAssetState,
  seedDeviceLibraryAsset,
  seedLibraryProtection,
  viewDigest,
} from '@/features/library/library-view-test-support';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

async function openDatabase(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

const MASTER_KEY = new Uint8Array(32).fill(7);
const SCOPE = 'scope-resume';
const CONTEXT: LibrarySessionContext = {
  deviceId: 'device-resume',
  masterKey: MASTER_KEY,
  accountScope: SCOPE,
};

function sessionWith(current: LibrarySessionContext | null): LibrarySessionPort {
  return { current: async () => current };
}

function recordingProtect() {
  const digests: string[] = [];
  return {
    digests,
    protect: async (digest: string): Promise<unknown> => {
      digests.push(digest);
      return { status: 'applied' };
    },
  };
}

/** A usable local original; answers its digest. */
async function localAsset(
  database: SqlDatabasePort,
  tag: string,
  createdAt = 1_000,
): Promise<string> {
  const digest = viewDigest(tag);
  await seedDeviceLibraryAsset(database, { plaintextSha256: digest, createdAt });
  return digest;
}

/** A durable `protect` intent the drain owns, keyed by the derived asset id. */
async function enqueueProtectOutbox(
  database: SqlDatabasePort,
  digest: string,
  state: 'pending' | 'sending',
): Promise<void> {
  await database.run(
    `INSERT INTO library_outbox (
       mutation_id, account_scope, device_id, asset_id, kind, base_revision,
       observed_generation, state, attempt_count, next_attempt_at,
       last_error_code, local_metadata_json, encrypted_payload,
       created_at, updated_at
     ) VALUES (?, ?, 'device-resume', ?, 'protect', NULL, NULL, ?, 0, NULL,
               NULL, '{}', NULL, 1, 1)`,
    [
      `11111111-2222-4333-8444-${digest.slice(0, 12)}`,
      SCOPE,
      deriveLibraryAssetId(MASTER_KEY, digest),
      state,
    ],
  );
}

/** A port that records every read, over the real adapter. */
function countingDatabase(database: SqlDatabasePort): {
  queries: string[];
  port: SqlDatabasePort;
} {
  const queries: string[] = [];
  return {
    queries,
    port: {
      exec: (source: string) => database.exec(source),
      run: (source: string, params?: readonly SqlBindValue[]) =>
        database.run(source, params),
      getFirst: <T>(source: string, params?: readonly SqlBindValue[]) =>
        database.getFirst<T>(source, params),
      getAll: <T>(source: string, params?: readonly SqlBindValue[]) => {
        queries.push(source);
        return database.getAll<T>(source, params);
      },
      transaction: <T>(
        task: (db: SqlDatabasePort) => Promise<T>,
      ): Promise<T> => database.transaction(task),
    },
  };
}

/**
 * N10 T2. The resume chain's re-protect pass: every candidate it dispatches is
 * an original whose bytes are here, whose protection nothing satisfies, and
 * whose protection no pending/sending outbox row explains — the ingest-time
 * protect that died before its first durable write. Skips keep the drain, the
 * trash sweeps, and protect's own short-circuit verdicts in charge.
 */
describe('library protect resume', () => {
  test('re-drives a local original whose protection row never landed', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      const digest = await localAsset(database, 'gap');
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(1);
      expect(sink.digests).toEqual([digest]);
    } finally {
      native.close();
    }
  });

  test('re-drives pending and retryable-failed protections with no outbox row', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      const pending = await localAsset(database, 'pending');
      await seedLibraryProtection(database, {
        plaintextSha256: pending,
        accountScope: SCOPE,
        protection: 'pending',
      });
      const failed = await localAsset(database, 'failed');
      await seedLibraryProtection(database, {
        plaintextSha256: failed,
        accountScope: SCOPE,
        protection: 'failed',
        failureCategory: 'retryable_transfer',
      });
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(2);
      expect(sink.digests.sort()).toEqual([failed, pending].sort());
    } finally {
      native.close();
    }
  });

  test('leaves a protected verified asset alone, but re-drives a protected one no run ever verified', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      const done = await localAsset(database, 'done');
      await seedLibraryProtection(database, {
        plaintextSha256: done,
        accountScope: SCOPE,
        protection: 'protected',
        originalGenerationId: 'gen-done',
        verifiedAt: 5,
      });
      const unverified = await localAsset(database, 'unverified');
      await seedLibraryProtection(database, {
        plaintextSha256: unverified,
        accountScope: SCOPE,
        protection: 'protected',
        originalGenerationId: 'gen-unverified',
      });
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(1);
      expect(sink.digests).toEqual([unverified]);
    } finally {
      native.close();
    }
  });

  test('skips an asset whose protect outbox row is pending or sending', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      for (const tag of ['held-pending', 'held-sending', 'free']) {
        const digest = await localAsset(database, tag);
        await seedLibraryProtection(database, {
          plaintextSha256: digest,
          accountScope: SCOPE,
          protection: 'failed',
          failureCategory: 'retryable_transfer',
        });
      }
      await enqueueProtectOutbox(database, viewDigest('held-pending'), 'pending');
      await enqueueProtectOutbox(database, viewDigest('held-sending'), 'sending');
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(1);
      expect(sink.digests).toEqual([viewDigest('free')]);
    } finally {
      native.close();
    }
  });

  test('skips assets whose bytes are flagged missing or are cloud-only', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('flagged'),
        missingOriginalSince: 7,
      });
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('cloud-only'),
        residency: 'cloud-only',
      });
      const here = await localAsset(database, 'here');
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(1);
      expect(sink.digests).toEqual([here]);
    } finally {
      native.close();
    }
  });

  test('skips account-trash and device-trash', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      const trashed = await localAsset(database, 'account-trash');
      await seedLibraryProtection(database, {
        plaintextSha256: trashed,
        accountScope: SCOPE,
        lifecycle: 'trash',
        protection: 'failed',
        failureCategory: 'retryable_transfer',
      });
      const deviceTrashed = await localAsset(database, 'device-trash');
      await seedDeviceAssetState(database, {
        plaintextSha256: deviceTrashed,
        deviceTrashedAt: 5,
      });
      const here = await localAsset(database, 'here');
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(1);
      expect(sink.digests).toEqual([here]);
    } finally {
      native.close();
    }
  });

  test('skips exactly the protect short-circuit verdicts', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      for (const tag of ['auth', 'quota']) {
        const digest = await localAsset(database, tag);
        await seedLibraryProtection(database, {
          plaintextSha256: digest,
          accountScope: SCOPE,
          protection: 'failed',
          failureCategory: tag === 'auth' ? 'auth_attention' : 'quota_full',
        });
      }
      const here = await localAsset(database, 'here');
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(1);
      expect(sink.digests).toEqual([here]);
    } finally {
      native.close();
    }
  });

  test('caps the pass and walks oldest first', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      const ordered: string[] = [];
      // Fixed-width tags: `viewDigest` zero-pads, so `cap-1` and `cap-10`
      // would hash to the same digest.
      for (let index = 0; index < LIBRARY_PROTECT_RESUME_BATCH + 2; index += 1) {
        ordered.push(await localAsset(database, `cap-${String(index).padStart(2, '0')}`, index + 1));
      }
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(LIBRARY_PROTECT_RESUME_BATCH);
      expect(sink.digests).toEqual(ordered.slice(0, LIBRARY_PROTECT_RESUME_BATCH));
    } finally {
      native.close();
    }
  });

  test('a protect that throws does not starve the rest of the pass', async () => {
    const { native, database } = await openDatabase();
    const digests: string[] = [];
    const attempted: string[] = [];
    try {
      const first = await localAsset(database, 'throws', 1);
      const second = await localAsset(database, 'survives', 2);
      const resume = createLibraryProtectResume({
        database,
        session: sessionWith(CONTEXT),
        protect: async (digest) => {
          attempted.push(digest);
          if (digest === first) throw new Error('upload exploded');
          digests.push(digest);
          return { status: 'applied' };
        },
      });

      await expect(resume()).resolves.toBe(2);
      expect(attempted).toEqual([first, second]);
      expect(digests).toEqual([second]);
    } finally {
      native.close();
    }
  });

  test('answers 0 without reading the library while no session is held', async () => {
    const { native, database } = await openDatabase();
    const sink = recordingProtect();
    try {
      await localAsset(database, 'waiting');
      const counted = countingDatabase(database);
      const resume = createLibraryProtectResume({
        database: counted.port,
        session: sessionWith(null),
        protect: sink.protect,
      });

      await expect(resume()).resolves.toBe(0);
      expect(counted.queries).toEqual([]);
      expect(sink.digests).toEqual([]);
    } finally {
      native.close();
    }
  });
});
