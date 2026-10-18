export type SqlBindValue = string | number | null | Uint8Array;

export type SqlRunResult = {
  changes: number;
  lastInsertRowId: number;
};

export interface SqlDatabasePort {
  exec(source: string): Promise<void>;
  run(source: string, params?: readonly SqlBindValue[]): Promise<SqlRunResult>;
  getFirst<T>(source: string, params?: readonly SqlBindValue[]): Promise<T | null>;
  getAll<T>(source: string, params?: readonly SqlBindValue[]): Promise<T[]>;
  transaction<T>(task: (database: SqlDatabasePort) => Promise<T>): Promise<T>;
}

export type SqlOperationScheduler = <T>(operation: () => Promise<T>) => Promise<T>;

export function createFifoSqlScheduler(): SqlOperationScheduler {
  let tail: Promise<void> = Promise.resolve();

  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
