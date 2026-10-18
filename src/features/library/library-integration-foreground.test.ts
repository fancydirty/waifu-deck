// Board #28: every compose test that needs the sync-service native module
// mocked non-null lives here. `jest.mock` is file-wide, and
// `library-integration-impl.test.ts` composes ~50 integrations that are never
// disposed: with the module non-null each would add a real guard to the shared
// `libraryTransferProgress`, and no start/stop count could be exact.
import type { SqlBindValue, SqlDatabasePort, SqlRunResult } from '@/db/sql-port';
import type { ByosCredentials } from '@/features/byos/byos-credentials';
import type { VaultMeta } from '@/features/byos/byos-vault-meta';
import { SUPPORTED_PROTOCOL_VERSION } from '@/features/byos/byos-vault-meta';
import { createLibraryIntegration } from '@/features/library/library-integration-impl';
import type {
  ByosResolvedContext,
  LibraryIntegration,
} from '@/features/library/library-integration-types';
import { createSyncForegroundGuard } from '@/features/library/library-sync-foreground';
import { libraryTransferProgress } from '@/features/library/library-transfer-progress';

const mockCalls: string[] = [];

jest.mock('expo-crypto', () => jest.requireActual('../../test/expo-crypto-double'));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../../../modules/waifu-sync-service', () => ({
  WaifuSyncService: {
    start: async () => {
      mockCalls.push('start');
    },
    update: async () => {
      mockCalls.push('update');
    },
    stop: async () => {
      mockCalls.push('stop');
    },
    addListener: () => ({ remove: () => undefined }),
    isBatteryOptimizationIgnored: () => true,
    requestIgnoreBatteryOptimizations: async () => undefined,
    uploadFile: async () => ({ status: 200, headers: {}, body: '' }),
    cancelUpload: async () => undefined,
    downloadRanges: async () => ({ status: 206 }),
    cancelDownload: async () => undefined,
  },
}));
jest.mock('@/features/library/library-sync-notifications', () => ({
  requestPostNotificationsPermission: async () => true,
}));
jest.mock('@/features/library/library-sync-foreground', () => {
  const actual = jest.requireActual('@/features/library/library-sync-foreground');
  return {
    ...actual,
    createSyncForegroundGuard: jest.fn((...args: unknown[]) => {
      const guard = actual.createSyncForegroundGuard(...args);
      jest.spyOn(guard, 'dispose');
      return guard;
    }),
  };
});

const guardFactory = createSyncForegroundGuard as jest.Mock;

function fakeDatabase(): SqlDatabasePort {
  const database: SqlDatabasePort = {
    async exec(): Promise<void> {},
    async run(
      _source: string,
      _params?: readonly SqlBindValue[],
    ): Promise<SqlRunResult> {
      return { changes: 0, lastInsertRowId: 0 };
    },
    async getFirst<T>(): Promise<T | null> {
      return null;
    },
    async getAll<T>(): Promise<T[]> {
      return [];
    },
    async transaction<T>(
      task: (db: SqlDatabasePort) => Promise<T>,
    ): Promise<T> {
      return task(database);
    },
  };
  return database;
}

const credentials: ByosCredentials = {
  kind: 's3',
  endpoint: 'https://example.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'waifu-deck-test',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'shhh',
  prefix: 'waifu-deck/',
};

function boundContext(): ByosResolvedContext {
  const meta: VaultMeta = {
    format: 'waifu-deck-byos',
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    encryption: 'aes-gcm',
    vaultId: '11111111-2222-4333-8444-555555555555',
    kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'c2FsdA' },
    keyCheckB64: 'a2V5Y2hlY2s',
    createdAt: '2026-08-29T00:00:00.000Z',
  };
  return {
    kind: 's3',
    credentials,
    meta,
    masterKey: new Uint8Array(32).fill(7),
    deviceId: 'device-1',
  };
}

const composed: LibraryIntegration[] = [];

function composeBound(): LibraryIntegration {
  const integration = createLibraryIntegration({
    database: fakeDatabase(),
    byos: boundContext(),
  });
  composed.push(integration);
  return integration;
}

function composeLocal(): LibraryIntegration {
  const integration = createLibraryIntegration({ database: fakeDatabase() });
  composed.push(integration);
  return integration;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function guardDisposeCounts(): number[] {
  return guardFactory.mock.results.map(
    (result) => (result.value.dispose as jest.Mock).mock.calls.length,
  );
}

beforeEach(() => {
  guardFactory.mockClear();
  mockCalls.length = 0;
});

afterEach(async () => {
  for (const integration of composed.splice(0)) integration.libraryDispose?.();
  libraryTransferProgress.clear('digest-a');
  await flush();
});

describe('the sync foreground guard lives exactly as long as its composition', () => {
  it('a post-guard construction failure releases the guard before falling back', () => {
    const backgrounds = jest.requireActual<typeof import('@/features/library/library-background-sync')>(
      '@/features/library/library-background-sync',
    );
    const slots = jest.requireActual<typeof import('@/features/library/library-background-sync-slot')>(
      '@/features/library/library-background-sync-slot',
    );
    slots.setLibraryBackgroundRound(null);
    const spy = jest.spyOn(backgrounds, 'createExpoBackgroundTaskApi').mockImplementation(() => {
      throw new Error('background module constructor refused');
    });
    try {
      const integration = composeBound();
      expect(integration.libraryActions).toBeNull();
      expect(guardFactory).toHaveBeenCalledTimes(1);
      expect(guardDisposeCounts()).toEqual([1]);
      expect(slots.getLibraryBackgroundRound()).toBeNull();
    } finally {
      spy.mockRestore();
      for (const result of guardFactory.mock.results) result.value.dispose();
      slots.setLibraryBackgroundRound(null);
    }
  });

  it("a bound composition's libraryDispose disposes the one sync-service guard it created", () => {
    const integration = composeBound();
    expect(guardFactory).toHaveBeenCalledTimes(1);
    expect(guardDisposeCounts()).toEqual([0]);

    integration.libraryDispose?.();
    expect(guardDisposeCounts()).toEqual([1]);

    integration.libraryDispose?.();
    expect(guardDisposeCounts()).toEqual([1]);
  });

  it('the local-only core has nothing to release', () => {
    const integration = composeLocal();
    expect(guardFactory).not.toHaveBeenCalled();
    expect(integration.libraryDispose).toBeUndefined();
  });

  it('compose, close, compose: one batch drains to exactly one stop', async () => {
    const first = composeBound();
    first.libraryDispose?.();
    composeBound();
    expect(guardFactory).toHaveBeenCalledTimes(2);

    libraryTransferProgress.set('digest-a', { sent: 0, total: 1 });
    await flush();
    libraryTransferProgress.clear('digest-a');
    await flush();

    expect(mockCalls.filter((call) => call === 'start')).toHaveLength(1);
    expect(mockCalls.filter((call) => call === 'stop')).toHaveLength(1);
  });
});
