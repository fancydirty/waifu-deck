import { DatabaseSync } from 'node:sqlite';

import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

describe('Node SQLite adapter transactions', () => {
  test('queues root run, get, and exec behind an open transaction', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);
    await database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY NOT NULL)');
    let markReady!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const transaction = database.transaction(async (scoped) => {
        await scoped.run('INSERT INTO events (id) VALUES (?)', [1]);
        markReady();
        await gate;
      });
      await ready;

      const rootRun = database.run('INSERT INTO events (id) VALUES (?)', [2]);
      const rootGet = database.getFirst<{ count: number }>(
        'SELECT COUNT(*) AS count FROM events',
      );
      const rootExec = database.exec('INSERT INTO events (id) VALUES (3)');

      expect(
        nativeDatabase.prepare('SELECT COUNT(*) AS count FROM events').get(),
      ).toEqual({ count: 1 });

      release();
      await transaction;
      await rootRun;
      await expect(rootGet).resolves.toEqual({ count: 2 });
      await rootExec;
      await expect(
        database.getAll<{ id: number }>('SELECT id FROM events ORDER BY id'),
      ).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('serializes unrelated transactions while keeping nested work scoped', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);
    await database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY NOT NULL)');

    let releaseFirst!: () => void;
    let markFirstReady!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstReady = new Promise<void>((resolve) => {
      markFirstReady = resolve;
    });
    const order: string[] = [];

    try {
      const firstOutcome = database
        .transaction(async (transaction) => {
          order.push('first-start');
          await transaction.run('INSERT INTO events (id) VALUES (?)', [1]);
          await transaction.transaction(async (nested) => {
            order.push('nested');
            expect(nested).toBe(transaction);
            await nested.run('INSERT INTO events (id) VALUES (?)', [2]);
          });
          markFirstReady();
          await firstGate;
          throw new Error('rollback-first');
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      await firstReady;
      const second = database.transaction(async (transaction) => {
        order.push('second-start');
        await transaction.run('INSERT INTO events (id) VALUES (?)', [3]);
      });

      await Promise.resolve();
      expect(order).toEqual(['first-start', 'nested']);

      releaseFirst();
      await expect(firstOutcome).resolves.toMatchObject({ message: 'rollback-first' });
      await second;

      await expect(
        database.getAll<{ id: number }>('SELECT id FROM events ORDER BY id'),
      ).resolves.toEqual([{ id: 3 }]);
      expect(order).toEqual(['first-start', 'nested', 'second-start']);
    } finally {
      nativeDatabase.close();
    }
  });
});
