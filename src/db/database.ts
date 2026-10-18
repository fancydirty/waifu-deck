import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';

import type {
  SqlBindValue,
  SqlDatabasePort,
  SqlOperationScheduler,
  SqlRunResult,
} from '@/db/sql-port';
import { createFifoSqlScheduler } from '@/db/sql-port';
import { migrateDatabase } from '@/db/schema';

export const APP_DATABASE_NAME = 'waifu-deck.db';

export type AppDatabaseConnection = {
  database: SqlDatabasePort;
  close(): Promise<void>;
};

export type DatabaseResetApi = {
  openDatabaseAsync(
    databaseName: string,
    options?: SQLite.SQLiteOpenOptions,
  ): Promise<{ closeAsync(): Promise<void> }>;
  deleteDatabaseAsync(databaseName: string): Promise<void>;
};

export type AppDatabaseDependencies = {
  openDatabaseAsync(
    databaseName: string,
    options?: SQLite.SQLiteOpenOptions,
  ): Promise<SQLite.SQLiteDatabase>;
  migrate(database: SqlDatabasePort): Promise<void>;
};

export type ExpoSqliteAdapterOptions = {
  platform?: 'web' | 'native';
};

type ExpoQueryDatabase = Pick<
  SQLite.SQLiteDatabase,
  'execAsync' | 'runAsync' | 'getFirstAsync' | 'getAllAsync'
>;

function queryPort(
  nativeDatabase: ExpoQueryDatabase,
  transaction: SqlDatabasePort['transaction'],
  schedule: SqlOperationScheduler,
): SqlDatabasePort {
  return {
    exec: (source) => schedule(() => nativeDatabase.execAsync(source)),
    run: (source, params = []): Promise<SqlRunResult> =>
      schedule(async () => {
        const result = await nativeDatabase.runAsync(
          source,
          params as SqlBindValue[],
        );
        return {
          changes: result.changes,
          lastInsertRowId: result.lastInsertRowId,
        };
      }),
    getFirst: <T>(source: string, params: readonly SqlBindValue[] = []) =>
      schedule(() =>
        nativeDatabase.getFirstAsync<T>(source, params as SqlBindValue[]),
      ),
    getAll: <T>(source: string, params: readonly SqlBindValue[] = []) =>
      schedule(() =>
        nativeDatabase.getAllAsync<T>(source, params as SqlBindValue[]),
      ),
    transaction,
  };
}

export function createExpoSqliteAdapter(
  nativeDatabase: SQLite.SQLiteDatabase,
  options: ExpoSqliteAdapterOptions = {},
): SqlDatabasePort {
  const platform = options.platform ?? (Platform.OS === 'web' ? 'web' : 'native');
  const schedule = createFifoSqlScheduler();
  const runDirectly: SqlOperationScheduler = (operation) => operation();

  async function runScopedTask<T>(
    scopedDatabase: ExpoQueryDatabase,
    task: (database: SqlDatabasePort) => Promise<T>,
  ): Promise<T> {
    let transactionPort: SqlDatabasePort;
    transactionPort = queryPort(
      scopedDatabase,
      async (nestedTask) => nestedTask(transactionPort),
      runDirectly,
    );
    return task(transactionPort);
  }

  function transaction<T>(
    task: (database: SqlDatabasePort) => Promise<T>,
  ): Promise<T> {
    return schedule(async () => {
      let outcome: { value: T } | undefined;
      if (platform === 'web') {
        await nativeDatabase.withTransactionAsync(async () => {
          outcome = { value: await runScopedTask(nativeDatabase, task) };
        });
      } else {
        await nativeDatabase.withExclusiveTransactionAsync(
          async (nativeTransaction) => {
            outcome = { value: await runScopedTask(nativeTransaction, task) };
          },
        );
      }
      if (!outcome) throw new Error('SQLite transaction completed without a result');
      return outcome.value;
    });
  }

  return queryPort(nativeDatabase, transaction, schedule);
}

export async function openAppDatabaseConnection(
  databaseName = APP_DATABASE_NAME,
  {
    openDatabaseAsync = SQLite.openDatabaseAsync,
    migrate = migrateDatabase,
  }: Partial<AppDatabaseDependencies> = {},
): Promise<AppDatabaseConnection> {
  // expo-sqlite 56 returns the cached NativeDatabase for the same path and
  // options (SQLiteModule.kt:112-116) unless useNewConnection is set, so this
  // open cannot be matched later. closeAsync only drops a ref while the object
  // is shared. sharedObjectDidRelease() frees the native binding via ref.close()
  // (NativeDatabase.kt:28-30), not sqlite3_close; another JS handle then throws
  // NullPointerException. Board #27 S1a Task 5.
  const nativeDatabase = await openDatabaseAsync(databaseName, {
    useNewConnection: true,
  });
  const database = createExpoSqliteAdapter(nativeDatabase);
  try {
    // A second handle on the same file (an old bundle still closing during a
    // BYOS reload) briefly holds the WAL write lock. Wait for it to drain
    // instead of letting the migration's BEGIN EXCLUSIVE fail instantly with
    // SQLITE_BUSY. Issued on the connection before any WAL/journal work below.
    await database.exec('PRAGMA busy_timeout = 4000;');
    await migrate(database);
  } catch (error) {
    await nativeDatabase.closeAsync().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    database,
    async close() {
      if (closed) return;
      closed = true;
      await nativeDatabase.closeAsync();
    },
  };
}

export async function openAppDatabase(
  databaseName = APP_DATABASE_NAME,
): Promise<SqlDatabasePort> {
  return (await openAppDatabaseConnection(databaseName)).database;
}

export async function resetAppDatabase(
  api: DatabaseResetApi = SQLite,
  databaseName = APP_DATABASE_NAME,
): Promise<void> {
  try {
    const database = await api.openDatabaseAsync(databaseName, {
      useNewConnection: true,
    });
    await database.closeAsync();
  } catch {
    // A corrupt database may not open; deletion remains the recovery operation.
  }
  await api.deleteDatabaseAsync(databaseName);
}
