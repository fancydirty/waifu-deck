import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type {
  SqlBindValue,
  SqlDatabasePort,
  SqlOperationScheduler,
  SqlRunResult,
} from '@/db/sql-port';
import { createFifoSqlScheduler } from '@/db/sql-port';

function nodeParams(params: readonly SqlBindValue[]): SQLInputValue[] {
  return params as SQLInputValue[];
}

export function createNodeSqliteAdapter(
  nativeDatabase: DatabaseSync,
): SqlDatabasePort {
  const schedule = createFifoSqlScheduler();
  const runDirectly: SqlOperationScheduler = (operation) => operation();

  function queryPort(
    transaction: SqlDatabasePort['transaction'],
    operationScheduler: SqlOperationScheduler,
  ): SqlDatabasePort {
    return {
      exec: (source: string) =>
        operationScheduler(async () => {
          nativeDatabase.exec(source);
        }),
      run: (
        source: string,
        params: readonly SqlBindValue[] = [],
      ): Promise<SqlRunResult> =>
        operationScheduler(async () => {
          const result = nativeDatabase.prepare(source).run(...nodeParams(params));
          return {
            changes: Number(result.changes),
            lastInsertRowId: Number(result.lastInsertRowid),
          };
        }),
      getFirst: <T>(
        source: string,
        params: readonly SqlBindValue[] = [],
      ): Promise<T | null> =>
        operationScheduler(async () => {
          const row = nativeDatabase.prepare(source).get(...nodeParams(params));
          return row ? ({ ...row } as T) : null;
        }),
      getAll: <T>(
        source: string,
        params: readonly SqlBindValue[] = [],
      ): Promise<T[]> =>
        operationScheduler(async () =>
          nativeDatabase
            .prepare(source)
            .all(...nodeParams(params))
            .map((row) => ({ ...row }) as T),
        ),
      transaction,
    };
  }

  function transaction<T>(
    task: (database: SqlDatabasePort) => Promise<T>,
  ): Promise<T> {
    return schedule(async () => {
      let transactionStarted = false;
      try {
        nativeDatabase.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        let transactionPort: SqlDatabasePort;
        transactionPort = queryPort(
          async (nestedTask) => nestedTask(transactionPort),
          runDirectly,
        );
        const result = await task(transactionPort);
        nativeDatabase.exec('COMMIT');
        transactionStarted = false;
        return result;
      } catch (error) {
        if (transactionStarted) nativeDatabase.exec('ROLLBACK');
        throw error;
      }
    });
  }

  return queryPort(transaction, schedule);
}
