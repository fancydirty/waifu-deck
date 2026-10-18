import type { SQLiteDatabase } from 'expo-sqlite';

import type { SqlDatabasePort } from '@/db/sql-port';
import {
  APP_DATABASE_NAME,
  createExpoSqliteAdapter,
  openAppDatabaseConnection,
  resetAppDatabase,
} from '@/db/database';

type QueryDatabase = {
  execAsync: jest.Mock<Promise<void>, [string]>;
  runAsync: jest.Mock<
    Promise<{ changes: number; lastInsertRowId: number }>,
    [string, readonly unknown[]]
  >;
  getFirstAsync: jest.Mock<Promise<unknown>, [string, readonly unknown[]]>;
  getAllAsync: jest.Mock<Promise<unknown[]>, [string, readonly unknown[]]>;
};

type TransactionDatabase = QueryDatabase & {
  withTransactionAsync: jest.Mock<Promise<void>, [() => Promise<void>]>;
  withExclusiveTransactionAsync: jest.Mock<
    Promise<void>,
    [(database: QueryDatabase) => Promise<void>]
  >;
};

function createQueryDatabase(): QueryDatabase {
  return {
    execAsync: jest.fn(async (_source: string) => undefined),
    runAsync: jest.fn(
      async (_source: string, _params: readonly unknown[]) => ({
        changes: 1,
        lastInsertRowId: 1,
      }),
    ),
    getFirstAsync: jest.fn(
      async (_source: string, _params: readonly unknown[]) => null,
    ),
    getAllAsync: jest.fn(
      async (_source: string, _params: readonly unknown[]) => [],
    ),
  };
}

function createTransactionDatabase() {
  const root = createQueryDatabase();
  const exclusive = createQueryDatabase();
  const database: TransactionDatabase = {
    ...root,
    withTransactionAsync: jest.fn(async (task) => task()),
    withExclusiveTransactionAsync: jest.fn(async (task) => task(exclusive)),
  };
  return { database, exclusive };
}

const createAdapter = createExpoSqliteAdapter as unknown as (
  database: TransactionDatabase,
  options: { platform: 'web' | 'native' },
) => SqlDatabasePort;

describe('Expo SQLite adapter transactions', () => {
  test('uses the SDK 56 standard transaction API on web', async () => {
    const { database, exclusive } = createTransactionDatabase();
    const adapter = createAdapter(database, { platform: 'web' });

    await adapter.transaction(async (transaction) => {
      await transaction.run('INSERT INTO example (id) VALUES (?)', [1]);
    });

    expect(database.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(database.withExclusiveTransactionAsync).not.toHaveBeenCalled();
    expect(database.runAsync).toHaveBeenCalledWith(
      'INSERT INTO example (id) VALUES (?)',
      [1],
    );
    expect(exclusive.runAsync).not.toHaveBeenCalled();
  });

  test('uses an exclusive scoped transaction on native platforms', async () => {
    const { database, exclusive } = createTransactionDatabase();
    const adapter = createAdapter(database, { platform: 'native' });

    await adapter.transaction(async (transaction) => {
      await transaction.run('INSERT INTO example (id) VALUES (?)', [2]);
    });

    expect(database.withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
    expect(database.withTransactionAsync).not.toHaveBeenCalled();
    expect(exclusive.runAsync).toHaveBeenCalledWith(
      'INSERT INTO example (id) VALUES (?)',
      [2],
    );
    expect(database.runAsync).not.toHaveBeenCalled();
  });

  test.each(['web', 'native'] as const)(
    'queues root operations behind an open %s transaction in FIFO order',
    async (platform) => {
      const { database } = createTransactionDatabase();
      const adapter = createAdapter(database, { platform });
      let markReady!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const transaction = adapter.transaction(async (scoped) => {
        await scoped.run('scoped-run', []);
        await scoped.transaction(async (nested) => {
          expect(nested).toBe(scoped);
          await nested.getAll('scoped-nested-get', []);
        });
        markReady();
        await gate;
      });
      await ready;

      const rootCallsBefore = {
        exec: database.execAsync.mock.calls.length,
        run: database.runAsync.mock.calls.length,
        get: database.getFirstAsync.mock.calls.length,
      };
      const rootRun = adapter.run('root-run', []);
      const rootGet = adapter.getFirst('root-get', []);
      const rootExec = adapter.exec('root-exec');

      await Promise.resolve();
      expect(database.execAsync).toHaveBeenCalledTimes(rootCallsBefore.exec);
      expect(database.runAsync).toHaveBeenCalledTimes(rootCallsBefore.run);
      expect(database.getFirstAsync).toHaveBeenCalledTimes(rootCallsBefore.get);

      release();
      await transaction;
      await rootRun;
      await rootGet;
      await rootExec;

      const runOrder = database.runAsync.mock.invocationCallOrder.at(-1)!;
      const getOrder = database.getFirstAsync.mock.invocationCallOrder.at(-1)!;
      const execOrder = database.execAsync.mock.invocationCallOrder.at(-1)!;
      expect(runOrder).toBeLessThan(getOrder);
      expect(getOrder).toBeLessThan(execOrder);
    },
  );
});

describe('Expo SQLite recovery', () => {
  test('closes an opened native connection when migration fails', async () => {
    const failure = new Error('migration failed');
    const execAsync = jest.fn(async (_source: string) => undefined);
    const closeAsync = jest.fn(async () => undefined);
    const openDatabaseAsync = jest.fn(async () => (
      { execAsync, closeAsync } as unknown as SQLiteDatabase
    ));
    const migrate = jest.fn(async () => Promise.reject(failure));

    await expect(openAppDatabaseConnection('migration-test.db', {
      openDatabaseAsync,
      migrate,
    })).rejects.toBe(failure);

    expect(openDatabaseAsync).toHaveBeenCalledWith('migration-test.db', {
      useNewConnection: true,
    });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(closeAsync).toHaveBeenCalledTimes(1);
    expect(migrate.mock.invocationCallOrder[0]).toBeLessThan(
      closeAsync.mock.invocationCallOrder[0],
    );
  });

  test('sets a busy_timeout on the connection before running migrations', async () => {
    const execAsync = jest.fn(async (_source: string) => undefined);
    const closeAsync = jest.fn(async () => undefined);
    const openDatabaseAsync = jest.fn(async () => (
      { execAsync, closeAsync } as unknown as SQLiteDatabase
    ));
    const migrate = jest.fn(async () => undefined);

    const connection = await openAppDatabaseConnection('busy-timeout.db', {
      openDatabaseAsync,
      migrate,
    });

    const busyTimeoutCall = execAsync.mock.calls.find(([source]) =>
      /PRAGMA\s+busy_timeout/i.test(source),
    );
    expect(busyTimeoutCall?.[0]).toMatch(/busy_timeout\s*=\s*4000/i);
    // Issued before the migration's WAL journal switch and BEGIN EXCLUSIVE so a
    // residual writer (an old bundle still closing during a BYOS reload) is
    // waited out instead of failing the migration instantly with SQLITE_BUSY.
    expect(execAsync.mock.invocationCallOrder[0]).toBeLessThan(
      migrate.mock.invocationCallOrder[0],
    );

    await connection.close();
  });

  test('closes the SDK 56 database before deleting it', async () => {
    const calls: string[] = [];
    const closeAsync = jest.fn(async () => {
      calls.push('close');
    });
    const openDatabaseAsync = jest.fn(async () => {
      calls.push('open');
      return { closeAsync };
    });
    const deleteDatabaseAsync = jest.fn(async () => {
      calls.push('delete');
    });

    await resetAppDatabase({ openDatabaseAsync, deleteDatabaseAsync });

    expect(calls).toEqual(['open', 'close', 'delete']);
  });

  test('the app connection is its own native connection', async () => {
    const execAsync = jest.fn(async (_source: string) => undefined);
    const closeAsync = jest.fn(async () => undefined);
    const openDatabaseAsync = jest.fn(async () => (
      { execAsync, closeAsync } as unknown as SQLiteDatabase
    ));
    const migrate = jest.fn(async () => undefined);

    const connection = await openAppDatabaseConnection('migration-test.db', {
      openDatabaseAsync,
      migrate,
    });

    expect(openDatabaseAsync).toHaveBeenCalledWith('migration-test.db', {
      useNewConnection: true,
    });

    await connection.close();
  });

  test('the reset probe does not borrow the app connection', async () => {
    const closeAsync = jest.fn(async () => undefined);
    const openDatabaseAsync = jest.fn(async () => ({ closeAsync }));
    const deleteDatabaseAsync = jest.fn(async () => undefined);

    await resetAppDatabase({ openDatabaseAsync, deleteDatabaseAsync });

    expect(openDatabaseAsync).toHaveBeenCalledWith(APP_DATABASE_NAME, {
      useNewConnection: true,
    });
  });
});
