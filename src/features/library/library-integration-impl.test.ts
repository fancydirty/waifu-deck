// Board #24: imported ahead of the mock block below (none of these modules is
// mocked, and babel-jest hoists every `jest.mock` above the imports anyway).
import { DatabaseSync } from 'node:sqlite';
import { Directory, File, Paths } from 'expo-file-system';

import { migrateDatabase } from '@/db/schema';
import { createImageRepository } from '@/features/images/image-repository';
import { createLibraryCollectAdapter } from '@/features/library/library-collect-adapter';
import type { LibraryCollectAdapterDependencies } from '@/features/library/library-collect-adapter';
import type { LibraryCollectionFilesPort } from '@/features/library/library-collection-handover';
import { createExpoLibraryFilePort } from '@/features/library/library-expo-file-store';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import { createLibraryRepository } from '@/features/library/library-repository';
import {
  seedDeviceLibraryAsset,
  seedLibraryProtection,
  viewAssetId,
  viewDigest,
} from '@/features/library/library-view-test-support';
import type { WaifuImage } from '@/features/waifu/types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';
import { createLibraryEviction } from '@/features/library/library-eviction';
import {
  createLibraryLocalThumbnails,
  LIBRARY_THUMBNAIL_SOURCE_ORIGINAL_MAX_BYTES,
} from '@/features/library/library-local-thumbnails';
import { createLibraryStorageModeStore } from '@/features/library/library-storage-mode';
import { createLibrarySyncRound } from '@/features/library/library-sync-round';
import { createLibraryThumbnailPass } from '@/features/library/library-thumbnail-pass';

jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));
// The production S3 fetch port. Mocked to prove composition never calls it:
// building the integration is pure and synchronous (decision #23).
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
// Partial mocks over the two cipher factories: the real implementations still
// run, so the composition gets working ciphers, but the dispatch in
// `selectLibraryCipher` becomes directly observable at construction time.
jest.mock('@/features/library/library-object-crypto', () => {
  const actual = jest.requireActual('@/features/library/library-object-crypto');
  return {
    ...actual,
    createLibraryObjectCipher: jest.fn(actual.createLibraryObjectCipher),
  };
});
// Partial mock over the apply-writer factory: the real writer still runs, but
// C3b's `restoreImage` binding becomes observable at construction time without
// reaching SQLite.
jest.mock('@/features/library/library-sync-apply', () => {
  const actual = jest.requireActual('@/features/library/library-sync-apply');
  return {
    ...actual,
    createLibrarySyncApplyWriter: jest.fn(actual.createLibrarySyncApplyWriter),
  };
});
jest.mock('@/features/library/library-passthrough-cipher', () => {
  const actual = jest.requireActual(
    '@/features/library/library-passthrough-cipher',
  );
  return {
    ...actual,
    createPassthroughLibraryCipher: jest.fn(actual.createPassthroughLibraryCipher),
  };
});
// K6-1d: wraps the real factory so the `prewarm` closure handed to the trigger
// is reachable and callable directly, without starting a sync cycle.
jest.mock('@/features/library/library-sync-triggers', () => {
  const actual = jest.requireActual('@/features/library/library-sync-triggers');
  return {
    ...actual,
    createLibrarySyncTrigger: jest.fn(actual.createLibrarySyncTrigger),
  };
});
// K6-2b: partial mocks over the four action factories the composition
// decorates, so a test can inject the exact settled result an action reports
// and watch what the change feed says about it — without a bucket, a database,
// or a real upload.
jest.mock('@/features/library/library-protect-action', () => {
  const actual = jest.requireActual('@/features/library/library-protect-action');
  return {
    ...actual,
    createLibraryProtectAction: jest.fn(actual.createLibraryProtectAction),
  };
});
jest.mock('@/features/library/library-local-actions', () => {
  const actual = jest.requireActual('@/features/library/library-local-actions');
  return {
    ...actual,
    createLibraryLocalActions: jest.fn(actual.createLibraryLocalActions),
  };
});
jest.mock('@/features/library/library-account-actions', () => {
  const actual = jest.requireActual('@/features/library/library-account-actions');
  return {
    ...actual,
    createLibraryAccountActions: jest.fn(actual.createLibraryAccountActions),
  };
});
jest.mock('@/features/library/library-trash-actions', () => {
  const actual = jest.requireActual('@/features/library/library-trash-actions');
  return {
    ...actual,
    createLibraryTrashActions: jest.fn(actual.createLibraryTrashActions),
  };
});
// Board #12: partial mocks over the two protocol-v2 factories, so a test can
// prove which cloud stack the composition actually built (S3 vs append-only)
// without spying on I/O that neither stack performs at construction time
// (decision #23).
jest.mock('@/features/library/library-cloud-client-append', () => {
  const actual = jest.requireActual('@/features/library/library-cloud-client-append');
  return {
    ...actual,
    createAppendLibraryCloudClient: jest.fn(actual.createAppendLibraryCloudClient),
  };
});
jest.mock('@/features/library/library-reconciliation-append', () => {
  const actual = jest.requireActual('@/features/library/library-reconciliation-append');
  return {
    ...actual,
    createAppendLibraryReconciliationPort: jest.fn(actual.createAppendLibraryReconciliationPort),
  };
});
// Board #12 (T12 review pin): the same over the two protocol-v1 factories, so
// the store case can prove the S3 stack was NOT built. `fetchPort` alone
// cannot tell the branches apart: composing the S3 stack performs no fetch
// either (decision #23), so "no fetch" is true on both.
jest.mock('@/features/byos/s3-transport', () => {
  const actual = jest.requireActual('@/features/byos/s3-transport');
  return {
    ...actual,
    createS3Transport: jest.fn(actual.createS3Transport),
  };
});
jest.mock('@/features/library/library-cloud-client-s3', () => {
  const actual = jest.requireActual('@/features/library/library-cloud-client-s3');
  return {
    ...actual,
    createS3LibraryCloudClient: jest.fn(actual.createS3LibraryCloudClient),
  };
});
// K4 T4: wraps the real factory so the `onIngestOutcome` closure handed to
// the local core is reachable and callable directly with a synthetic
// outcome, the same "extract minimally" seam used for the wiring assertion.
jest.mock('@/features/library/library-integration-local-core', () => {
  const actual = jest.requireActual('@/features/library/library-integration-local-core');
  return {
    ...actual,
    createLocalLibraryIntegration: jest.fn(actual.createLocalLibraryIntegration),
  };
});

// Board #27 S1b T7: wraps the real factory so the dependencies handed to the
// collect adapter (its `onSuccess`) are reachable, as the local core's are.
jest.mock('@/features/library/library-collect-adapter', () => {
  const actual = jest.requireActual('@/features/library/library-collect-adapter');
  return {
    ...actual,
    createLibraryCollectAdapter: jest.fn(actual.createLibraryCollectAdapter),
  };
});

// Board #27 S3 Task 6: partial mocks over the four factories the 仅云端 wiring
// builds, so the arguments the composition hands them and the instance it
// shares between them are observable; the real implementations still run.
jest.mock('@/features/library/library-sync-round', () => {
  const actual = jest.requireActual('@/features/library/library-sync-round');
  return {
    ...actual,
    createLibrarySyncRound: jest.fn(actual.createLibrarySyncRound),
  };
});
jest.mock('@/features/library/library-eviction', () => {
  const actual = jest.requireActual('@/features/library/library-eviction');
  return {
    ...actual,
    createLibraryEviction: jest.fn(actual.createLibraryEviction),
  };
});
jest.mock('@/features/library/library-thumbnail-pass', () => {
  const actual = jest.requireActual('@/features/library/library-thumbnail-pass');
  return {
    ...actual,
    createLibraryThumbnailPass: jest.fn(actual.createLibraryThumbnailPass),
  };
});
jest.mock('@/features/library/library-local-thumbnails', () => {
  const actual = jest.requireActual('@/features/library/library-local-thumbnails');
  return {
    ...actual,
    createLibraryLocalThumbnails: jest.fn(actual.createLibraryLocalThumbnails),
  };
});

import { fetch as expoFetch } from 'expo/fetch';

import type { SqlDatabasePort, SqlBindValue, SqlRunResult } from '@/db/sql-port';
import type { ByosCredentials, WebdavBinding } from '@/features/byos/byos-credentials';
import {
  SUPPORTED_PROTOCOL_VERSION,
  type VaultEncryption,
  type VaultMeta,
} from '@/features/byos/byos-vault-meta';
import { createS3Transport } from '@/features/byos/s3-transport';
import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import type { LibraryActionResult } from '@/features/library/library-actions-types';
import { createLibraryAccountActions } from '@/features/library/library-account-actions';
import type { LibraryChange } from '@/features/library/library-change-feed';
import { createAppendLibraryCloudClient } from '@/features/library/library-cloud-client-append';
import { createS3LibraryCloudClient } from '@/features/library/library-cloud-client-s3';
import {
  acquireLibrarySyncLease,
  getLibraryBackgroundRound,
} from '@/features/library/library-background-sync-slot';
import { createLibraryIntegration } from '@/features/library/library-integration-impl';
import { createLocalLibraryIntegration } from '@/features/library/library-integration-local-core';
import type {
  ByosResolvedContext,
  LibraryIntegration,
  LibraryResetSession,
} from '@/features/library/library-integration-types';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import {
  createLibraryLocalActions,
  type LibraryLocalActions,
} from '@/features/library/library-local-actions';
import type {
  LibraryRoleFetch,
  LibraryTransferCoalescer,
} from '@/features/library/library-transfer-coalescer';
import { createLibraryObjectCipher } from '@/features/library/library-object-crypto';
import { createPassthroughLibraryCipher } from '@/features/library/library-passthrough-cipher';
import { createAppendLibraryReconciliationPort } from '@/features/library/library-reconciliation-append';
import {
  createLibraryProtectAction,
  type LibraryProtectAction,
} from '@/features/library/library-protect-action';
import { createLibrarySyncApplyWriter } from '@/features/library/library-sync-apply';
import type { RunToEmptyOutcome } from '@/features/library/library-sync-run-to-empty';
import {
  createLibrarySyncTrigger,
  type LibrarySyncTrigger,
} from '@/features/library/library-sync-triggers';
import { createLibraryTrashActions } from '@/features/library/library-trash-actions';
import type { DeviceLibraryAsset, LibraryIngestOutcome } from '@/features/library/library-types';

const applyWriterFactory = createLibrarySyncApplyWriter as jest.Mock;
const realCipherFactory = createLibraryObjectCipher as jest.Mock;
const passthroughCipherFactory = createPassthroughLibraryCipher as jest.Mock;
const fetchPort = expoFetch as unknown as jest.Mock;
const localCoreFactory = createLocalLibraryIntegration as jest.Mock;
const collectAdapterFactory = createLibraryCollectAdapter as jest.Mock;
const triggerFactory = createLibrarySyncTrigger as jest.Mock;
const protectActionFactory = createLibraryProtectAction as jest.Mock;
const localActionsFactory = createLibraryLocalActions as jest.Mock;
const accountActionsFactory = createLibraryAccountActions as jest.Mock;
const trashActionsFactory = createLibraryTrashActions as jest.Mock;
const appendCloudClientFactory = createAppendLibraryCloudClient as jest.Mock;
const appendReconciliationFactory = createAppendLibraryReconciliationPort as jest.Mock;
const s3TransportFactory = createS3Transport as jest.Mock;
const s3CloudClientFactory = createS3LibraryCloudClient as jest.Mock;
const syncRoundFactory = createLibrarySyncRound as jest.Mock;
const evictionFactory = createLibraryEviction as jest.Mock;
const thumbnailPassFactory = createLibraryThumbnailPass as jest.Mock;
const localThumbnailsFactory = createLibraryLocalThumbnails as jest.Mock;

/**
 * Composition never touches SQLite: every factory stores the port and queries
 * lazily. A port that throws on use would work equally well here; these
 * no-op answers just keep the failure mode obvious if that ever changes.
 */
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

const WEBDAV_BINDING: WebdavBinding = {
  kind: 'webdav',
  baseUrl: 'https://dav.example',
  username: 'u',
  password: 'p',
  rootPath: '/',
};

function vaultMeta(encryption: VaultEncryption): VaultMeta {
  return {
    format: 'waifu-deck-byos',
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    encryption,
    vaultId: '11111111-2222-4333-8444-555555555555',
    kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'c2FsdA' },
    keyCheckB64: 'a2V5Y2hlY2s',
    createdAt: '2026-08-29T00:00:00.000Z',
  };
}

function resolvedContext(encryption: VaultEncryption): ByosResolvedContext {
  return {
    kind: 's3',
    credentials,
    meta: vaultMeta(encryption),
    // Decision #14: an encryption:'none' vault has no key material at all and
    // is still a fully valid session.
    masterKey: encryption === 'none' ? null : new Uint8Array(32).fill(7),
    deviceId: 'device-1',
  };
}

/** The four Direct-only cloud surfaces, all null in the local-only core. */
function cloudSurfaces(integration: LibraryIntegration): readonly unknown[] {
  return [
    integration.libraryActions,
    integration.librarySync,
    integration.libraryCache,
    integration.librarySyncTrigger,
  ];
}

beforeEach(() => {
  applyWriterFactory.mockClear();
  realCipherFactory.mockClear();
  passthroughCipherFactory.mockClear();
  fetchPort.mockClear();
  localCoreFactory.mockClear();
  triggerFactory.mockClear();
  protectActionFactory.mockClear();
  localActionsFactory.mockClear();
  accountActionsFactory.mockClear();
  trashActionsFactory.mockClear();
  appendCloudClientFactory.mockClear();
  appendReconciliationFactory.mockClear();
  s3TransportFactory.mockClear();
  s3CloudClientFactory.mockClear();
  syncRoundFactory.mockClear();
  evictionFactory.mockClear();
  thumbnailPassFactory.mockClear();
  localThumbnailsFactory.mockClear();
});

function deviceLibraryAsset(): LibraryIngestOutcome['asset'] {
  return {
    plaintextSha256: 'digest-1',
    format: 'jpeg',
    canonicalExtension: 'jpg',
    byteSize: 1,
    width: 1,
    height: 1,
    origin: 'import',
    sourceImageId: null,
    localOriginalUri: 'file:///a.jpg',
    residency: 'local-original',
    protectEligible: true,
    missingOriginalSince: null,
    localThumbnailUri: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function expectViewSurfaceStagesShareCopies(
  integration: LibraryIntegration,
): Promise<void> {
  const shareFiles = integration.libraryView?.shareFiles;
  expect(shareFiles).toBeDefined();
  const digest = 'd'.repeat(64);
  const source = new File(Paths.cache, 'row45-share-source.bin');
  if (source.exists) source.delete();
  source.create({ intermediates: true, overwrite: true });
  source.write(new Uint8Array([7, 8, 9]));

  const staged = await shareFiles!.stage(source.uri, `${digest}.png`);

  const stagedFile = new File(staged);
  expect(staged).toBe(
    new File(new Directory(Paths.cache, 'library-share'), `${digest}.png`).uri,
  );
  expect(stagedFile.exists).toBe(true);
  await expect(stagedFile.bytes()).resolves.toEqual(new Uint8Array([7, 8, 9]));

  // One staged copy at a time; release removes only inside the area.
  const second = await shareFiles!.stage(source.uri, `${'e'.repeat(64)}.jpg`);
  expect(stagedFile.exists).toBe(false);
  await expect(shareFiles!.release(second)).resolves.toBeUndefined();
  expect(new File(second).exists).toBe(false);
  await expect(shareFiles!.release(source.uri)).resolves.toBeUndefined();
  expect(source.exists).toBe(true);
}

describe('Direct library composition', () => {
  it.each([
    ['omitted', {}],
    ['null (what the inert P4-pending resolver returns)', { byos: null }],
  ])('runs the local-only core when the BYOS context is %s', (_label, extra) => {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      ...extra,
    });

    expect(cloudSurfaces(integration)).toEqual([null, null, null, null]);
    expect(integration.libraryView).not.toBeNull();
    // The local product is untouched: import/collect/reconcile still work.
    expect(integration.libraryController).not.toBeNull();
    // Cloud-only controller methods stay absent rather than becoming no-ops.
    expect(integration.libraryController?.clearAccountProjection).toBeUndefined();
    expect(integration.libraryController?.assessRemoveDeviceData).toBeUndefined();
    expect(realCipherFactory).not.toHaveBeenCalled();
    expect(passthroughCipherFactory).not.toHaveBeenCalled();
  });

  it('composes the whole cloud stack from a resolved BYOS context', () => {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    for (const surface of cloudSurfaces(integration)) {
      expect(surface).not.toBeNull();
    }
    const controller = integration.libraryController;
    expect(controller).not.toBeNull();
    expect(typeof controller?.clearAccountProjection).toBe('function');
    expect(typeof controller?.assessRemoveDeviceData).toBe('function');
    expect(typeof controller?.removeAccountDataFromThisDevice).toBe('function');
    expect(typeof controller?.exportUnprotectedOriginals).toBe('function');
    expect(integration.libraryView?.model).toBeDefined();
    expect(integration.libraryView?.resolver).toBeDefined();
  });

  it('R31-D Task 3: the composition hands the local actions and the render readers one coalescer — a resolve joins a held download transfer', async () => {
    const { native, database } = await openDatabase();
    try {
      const digest = '3'.repeat(64);
      await cloudOnlyAsset(database, digest, 91);
      const integration = createLibraryIntegration({
        database,
        byos: resolvedContext('aes-gcm'),
      });
      const scope = await integration.libraryActions!.getAccountScope();
      if (scope === null) throw new Error('the composed session has no account scope');
      const masterKey = new Uint8Array(32).fill(7);
      const assetId = deriveLibraryAssetId(masterKey, digest);
      await seedLibraryProtection(database, {
        plaintextSha256: digest,
        accountScope: scope,
        assetId,
        protection: 'protected',
        originalGenerationId: 'gen-t3-share',
      });

      // The very instance the composition handed createLibraryLocalActions.
      const transferCoalescer = localActionsFactory.mock.calls.at(-1)?.[0]
        .transferCoalescer as LibraryTransferCoalescer<LibraryRoleFetch>;
      const promoted = 'file:///data/library/originals/shared.jpg';
      let release!: () => void;
      const heldTask = new Promise<LibraryRoleFetch>((resolve) => {
        release = () => resolve({ kind: 'promoted', uri: promoted });
      });
      transferCoalescer.runWithOwnership!(`${assetId}:original`, () => heldTask);

      const cloudClient = s3CloudClientFactory.mock.results.at(-1)!.value;
      const getObjectToFile = jest.spyOn(cloudClient, 'getObjectToFile');
      const join = jest.spyOn(transferCoalescer, 'runWithOwnership');

      const resolved = integration.libraryView!.resolver.resolve(digest, 'full');
      await waitUntil(() => join.mock.calls.length > 0, 'the view join');
      await macrotasks(2);
      expect(getObjectToFile).not.toHaveBeenCalled();

      release();
      await expect(resolved).resolves.toEqual({
        kind: 'file', uri: promoted, tier: 'local-original', role: 'original',
      });
      expect(getObjectToFile).not.toHaveBeenCalled();
    } finally {
      native.close();
    }
  });

  it('composes an encryption:none vault with no master key', () => {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('none'),
    });

    for (const surface of cloudSurfaces(integration)) {
      expect(surface).not.toBeNull();
    }
  });

  it('selects the cipher from the vault-meta encryption mode', () => {
    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    expect(realCipherFactory).toHaveBeenCalledTimes(1);
    expect(passthroughCipherFactory).not.toHaveBeenCalled();

    realCipherFactory.mockClear();

    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('none'),
    });

    // Decisions #14/#21: the 'none' pseudo masterKey never reaches a real
    // cipher, because 'none' is exactly the case that selects passthrough.
    expect(passthroughCipherFactory).toHaveBeenCalledTimes(1);
    expect(realCipherFactory).not.toHaveBeenCalled();
  });

  it('falls back to the local core when construction throws', () => {
    realCipherFactory.mockImplementationOnce(() => {
      throw new Error('native crypto unavailable');
    });

    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    expect(cloudSurfaces(integration)).toEqual([null, null, null, null]);
    expect(integration.libraryController).not.toBeNull();
  });

  it('board #27 S1b: the collection\'s files reach the local core on every path — local, BYOS, and the BYOS fallback', () => {
    const collectionFiles = { fileSize: jest.fn(), deleteUri: jest.fn() } as LibraryCollectionFilesPort;
    const handed = () => localCoreFactory.mock.calls.at(-1)?.[0].collectionFiles;

    createLibraryIntegration({ database: fakeDatabase(), collectionFiles });
    expect(handed()).toBe(collectionFiles);

    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
      collectionFiles,
    });
    expect(handed()).toBe(collectionFiles);

    realCipherFactory.mockImplementationOnce(() => {
      throw new Error('native crypto unavailable');
    });
    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
      collectionFiles,
    });
    expect(handed()).toBe(collectionFiles);
  });

  it('performs no network I/O while composing', () => {
    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    expect(fetchPort).not.toHaveBeenCalled();
  });

  it('board #12: a context that carries a CloudObjectStore composes the append-only client and reconciliation port, and performs no I/O while composing', () => {
    const store = createMemoryCloudObjectStore();
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: {
        kind: 'store',
        binding: WEBDAV_BINDING,
        store,
        meta: vaultMeta('aes-gcm'),
        masterKey: new Uint8Array(32).fill(7),
        deviceId: 'device-1',
      },
    });

    expect(integration.librarySync).not.toBeNull();
    expect(integration.libraryActions).not.toBeNull();
    expect(store.calls).toEqual([]);
    expect(fetchPort).not.toHaveBeenCalled();
    expect(appendCloudClientFactory).toHaveBeenCalledTimes(1);
    expect(appendReconciliationFactory).toHaveBeenCalledTimes(1);
    // The branch pin proper: no S3 transport and no CAS client were built.
    expect(s3TransportFactory).not.toHaveBeenCalled();
    expect(s3CloudClientFactory).not.toHaveBeenCalled();
  });

  it('board #12: on the append-only stack the session-ready prewarm is a no-op — no throw, no store call, no fetch', async () => {
    // The S3 branch warms a pooled connection with a GET on `<prefix>.warm`;
    // a CloudObjectStore has no long-lived connection to warm, so the guard
    // returns before touching anything. Reached the same way the K6-1d tests
    // reach `prewarm`: off the deps handed to the trigger factory.
    const store = createMemoryCloudObjectStore();
    createLibraryIntegration({
      database: fakeDatabase(),
      byos: {
        kind: 'store',
        binding: WEBDAV_BINDING,
        store,
        meta: vaultMeta('aes-gcm'),
        masterKey: new Uint8Array(32).fill(7),
        deviceId: 'device-1',
      },
    });
    const [deps] = triggerFactory.mock.calls.at(-1) as [{ prewarm?: () => void }];
    expect(typeof deps.prewarm).toBe('function');

    expect(() => deps.prewarm?.()).not.toThrow();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(store.calls).toEqual([]);
    expect(fetchPort).not.toHaveBeenCalled();
  });

  it('board #12 P12-B: a store context never reads S3 credentials (there are none) and composes the append stack', () => {
    const store = createMemoryCloudObjectStore();
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: {
        kind: 'store',
        binding: WEBDAV_BINDING,
        store,
        meta: vaultMeta('aes-gcm'),
        masterKey: new Uint8Array(32).fill(7),
        deviceId: 'device-1',
      },
    });
    expect(integration.librarySync).not.toBeNull();
    expect(s3TransportFactory).not.toHaveBeenCalled();
    expect(appendCloudClientFactory).toHaveBeenCalledTimes(1);
  });

  it('board #12: a kind:s3 context still composes the S3 stack (regression pin)', () => {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    expect(integration.librarySync).not.toBeNull();
    expect(appendCloudClientFactory).not.toHaveBeenCalled();
    expect(appendReconciliationFactory).not.toHaveBeenCalled();
    expect(s3TransportFactory).toHaveBeenCalledTimes(1);
    expect(s3CloudClientFactory).toHaveBeenCalledTimes(1);
  });
  /**
   * K6-1d / spec §4.5: the first upload after a session opens was paying a
   * cold DNS+TCP+TLS handshake (10–85 s measured). The composition hands the
   * trigger a warm-up that opens a real connection to the user's bucket on a
   * key that is not expected to exist — the 404 is the point, the connection
   * is the payload.
   */
  it('pre-warms the real S3 transport on session-ready, and not while composing (K6-1d)', async () => {
    fetchPort.mockResolvedValue({ status: 404, ok: false });

    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    const [deps] = triggerFactory.mock.calls.at(-1) as [{ prewarm?: () => void }];
    expect(typeof deps.prewarm).toBe('function');
    expect(fetchPort).not.toHaveBeenCalled();

    expect(() => deps.prewarm?.()).not.toThrow();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(fetchPort).toHaveBeenCalledTimes(1);
    const [url, init] = fetchPort.mock.calls[0] as [string, { method: string }];
    expect(init.method).toBe('GET');
    expect(String(url)).toContain(`${credentials.bucket}/${credentials.prefix}.warm`);
  });

  it('swallows a failed pre-warm instead of rejecting into the trigger (K6-1d)', async () => {
    fetchPort.mockRejectedValue(new Error('network down'));

    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });
    const [deps] = triggerFactory.mock.calls.at(-1) as [{ prewarm?: () => void }];

    expect(() => deps.prewarm?.()).not.toThrow();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(fetchPort).toHaveBeenCalledTimes(1);
  });

  it('binds the C3b rebuild port to saveMirroredCandidate so restored rows are library-owned (K2)', async () => {
    const saveCandidate = jest.fn(async () => ({ id: 1111 }));
    const saveMirroredCandidate = jest.fn(async () => ({ id: 4242 }));
    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
      images: { saveCandidate, saveMirroredCandidate } as never,
    });

    const [deps] = applyWriterFactory.mock.calls.at(-1) as [
      { restoreImage?: (candidate: unknown, savedAt: number) => Promise<number | null> },
    ];
    expect(deps.restoreImage).toBeDefined();
    const candidate = { providerKey: 'danbooru' } as never;
    await expect(deps.restoreImage!(candidate, 555)).resolves.toBe(4242);
    expect(saveMirroredCandidate).toHaveBeenCalledWith(candidate, 555);
    expect(saveCandidate).not.toHaveBeenCalled();
  });

  it('K6-5 C: the local core gets the image repository that records ingest failures', () => {
    // Without it the collect adapter has nowhere to write `library_error`, and
    // an ingest that throws is a save the user silently loses.
    const images = { saveCandidate: jest.fn() } as never;
    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
      images,
    });

    const [input] = localCoreFactory.mock.calls.at(-1) as [{ images?: unknown }];
    expect(input.images).toBe(images);
  });

  it('leaves the rebuild port unbound when no image repository is supplied', () => {
    createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    const [deps] = applyWriterFactory.mock.calls.at(-1) as [
      { restoreImage?: unknown },
    ];
    expect(deps.restoreImage).toBeUndefined();
  });

  it('K4 T4: notifies the sync trigger exactly once when ingest reports a new asset', () => {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    const onLibraryChanged = jest.spyOn(
      integration.librarySyncTrigger!,
      'onLibraryChanged',
    );
    const [{ onIngestOutcome }] = localCoreFactory.mock.calls.at(-1) as [
      { onIngestOutcome: (outcome: LibraryIngestOutcome) => void },
    ];

    onIngestOutcome({
      status: 'ingested',
      asset: deviceLibraryAsset(),
      enrollment: { status: 'skipped', reason: 'no_account' },
    });

    expect(onLibraryChanged).toHaveBeenCalledTimes(1);
  });

  it('K4 T4: does not notify the sync trigger for a duplicate ingest', () => {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    const onLibraryChanged = jest.spyOn(
      integration.librarySyncTrigger!,
      'onLibraryChanged',
    );
    const [{ onIngestOutcome }] = localCoreFactory.mock.calls.at(-1) as [
      { onIngestOutcome: (outcome: LibraryIngestOutcome) => void },
    ];

    onIngestOutcome({
      status: 'duplicate',
      asset: deviceLibraryAsset(),
      enrollment: { status: 'skipped', reason: 'no_account' },
    });

    expect(onLibraryChanged).not.toHaveBeenCalled();
  });

  /**
   * K6-2b (spec §2 G3, owner 2026-09-14: 「到底是上云了但 UI 过时还是确实还在
   * 上，这是个大事」). Proven on the emulator that day: the asset is `protected`
   * in SQLite 4.2 s after the save and the grid tile still reads "Available
   * offline" until the tab is left and re-entered. The composition is where the
   * completion of an action becomes an announcement a mounted screen can hear.
   */
  describe('K6-2b library change feed', () => {
    it('exposes a feed on the BYOS composition and on the local-only core', () => {
      const byosIntegration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const localIntegration = createLibraryIntegration({ database: fakeDatabase() });

      expect(byosIntegration.libraryChanges).not.toBeNull();
      // Board #27: the local core announces a vanished original on its own feed,
      // so a mounted grid re-reads without a cloud action in the process.
      expect(localIntegration.libraryChanges).not.toBeNull();
    });

    it('announces a committed upload as `protected` then `protect-settled`, once each', async () => {
      const protect = jest.fn(async (): Promise<LibraryActionResult> => ({ status: 'applied' }));
      protectActionFactory.mockReturnValueOnce(stubProtectAction({ protect }));
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await expect(integration.libraryActions!.protect(DIGEST)).resolves.toEqual({
        status: 'applied',
      });

      expect(seen).toEqual([
        { kind: 'protected', plaintextSha256: DIGEST },
        { kind: 'protect-settled', plaintextSha256: DIGEST },
      ]);
      expect(protect).toHaveBeenCalledTimes(1);
    });

    it('announces only `protect-settled` when the upload did not commit', async () => {
      protectActionFactory.mockReturnValueOnce(stubProtectAction({
        protect: async () => ({ status: 'blocked', category: 'offline' }),
      }));
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await integration.libraryActions!.protect(DIGEST);

      // The tile must still leave its in-flight rendering; it must not claim
      // the bucket has the bytes.
      expect(seen).toEqual([{ kind: 'protect-settled', plaintextSha256: DIGEST }]);
    });

    it('announces `protect-settled` when the upload throws, and still rejects', async () => {
      protectActionFactory.mockReturnValueOnce(stubProtectAction({
        protect: async () => { throw new Error('socket closed'); },
      }));
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await expect(integration.libraryActions!.protect(DIGEST)).rejects.toThrow('socket closed');

      expect(seen).toEqual([{ kind: 'protect-settled', plaintextSha256: DIGEST }]);
    });

    it('announces the ingest-time upload too — that is the one the owner watched go stale', async () => {
      const applySavePolicyAfterIngest = jest.fn(
        async (): Promise<LibraryActionResult> => ({ status: 'applied' }),
      );
      protectActionFactory.mockReturnValueOnce(
        stubProtectAction({ applySavePolicyAfterIngest }),
      );
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await integration.libraryActions!.applySavePolicyAfterIngest(DIGEST);

      expect(seen).toEqual([
        { kind: 'protected', plaintextSha256: DIGEST },
        { kind: 'protect-settled', plaintextSha256: DIGEST },
      ]);
      expect(applySavePolicyAfterIngest).toHaveBeenCalledTimes(1);
    });

    it('announces `ingested` the moment a new local asset lands', () => {
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);
      const [{ onIngestOutcome }] = localCoreFactory.mock.calls.at(-1) as [
        { onIngestOutcome: (outcome: LibraryIngestOutcome) => void },
      ];

      onIngestOutcome({
        status: 'ingested',
        asset: deviceLibraryAsset(),
        enrollment: { status: 'skipped', reason: 'no_account' },
      });

      expect(seen).toEqual([{ kind: 'ingested', plaintextSha256: 'digest-1' }]);
    });

    it('says nothing for a duplicate ingest', () => {
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);
      const [{ onIngestOutcome }] = localCoreFactory.mock.calls.at(-1) as [
        { onIngestOutcome: (outcome: LibraryIngestOutcome) => void },
      ];

      onIngestOutcome({
        status: 'duplicate',
        asset: deviceLibraryAsset(),
        enrollment: { status: 'skipped', reason: 'no_account' },
      });

      expect(seen).toEqual([]);
    });

    it('announces `round-complete` for each finished sync round', () => {
      let roundListener: ((outcome: RunToEmptyOutcome) => void) | null = null;
      triggerFactory.mockReturnValueOnce(stubSyncTrigger((cb) => {
        roundListener = cb;
      }));
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      expect(roundListener).not.toBeNull();
      roundListener!({
        rounds: 1,
        clean: true,
        capped: false,
        lastRound: {
          up: { total: 1, done: 1, failed: 0 },
          down: { total: 0, done: 0, failed: 0 },
        },
      });

      expect(seen).toEqual([{ kind: 'round-complete' }]);
    });

    it('K6-5 C: a finished round also re-ingests the saves the library lost', () => {
      // A round has just walked the library, so this is the cheapest moment to
      // notice a `ready` collection row that never became a library asset —
      // the blank-tile defect the owner hit after ~40 swipes.
      let roundListener: ((outcome: RunToEmptyOutcome) => void) | null = null;
      triggerFactory.mockReturnValueOnce(stubSyncTrigger((cb) => {
        roundListener = cb;
      }));
      const reingestMissingLibraryRows = jest.fn(async () => 0);
      localCoreFactory.mockImplementationOnce((input: unknown) => {
        const actual = jest.requireActual(
          '@/features/library/library-integration-local-core',
        ).createLocalLibraryIntegration(input) as LibraryIntegration;
        return {
          ...actual,
          libraryController: actual.libraryController === null ? null : {
            ...actual.libraryController,
            reingestMissingLibraryRows,
          },
        };
      });
      createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });

      expect(roundListener).not.toBeNull();
      roundListener!({
        rounds: 1,
        clean: true,
        capped: false,
        lastRound: {
          up: { total: 0, done: 0, failed: 0 },
          down: { total: 0, done: 0, failed: 0 },
        },
      });

      expect(reingestMissingLibraryRows).toHaveBeenCalledTimes(1);
    });

    it('announces `downloaded` when a cloud-only original reaches this device', async () => {
      localActionsFactory.mockReturnValueOnce(stubLocalActions({
        download: async () => ({ status: 'applied' }),
      }));
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await integration.libraryActions!.download(DIGEST);

      expect(seen).toEqual([{ kind: 'downloaded', plaintextSha256: DIGEST }]);
    });

    it('stays quiet when a download reports nothing to do', async () => {
      localActionsFactory.mockReturnValueOnce(stubLocalActions({
        download: async () => ({ status: 'noop', reason: 'already-satisfied' }),
      }));
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await integration.libraryActions!.download(DIGEST);

      expect(seen).toEqual([]);
    });

    it('announces `trashed` when an asset moves to the account trash', async () => {
      accountActionsFactory.mockReturnValueOnce({
        stopProtection: async () => ({ status: 'applied' }),
        removeFromLibrary: async () => ({ status: 'applied' }),
      });
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await integration.libraryActions!.removeFromLibrary(DIGEST);

      expect(seen).toEqual([{ kind: 'trashed', plaintextSha256: DIGEST }]);
    });

    it('announces `restored` when a restore intent is accepted', async () => {
      trashActionsFactory.mockReturnValueOnce({
        restore: async () => ({ status: 'queued', mutationId: 'm-1' }),
        permanentDelete: async () => ({ status: 'queued', mutationId: 'm-2' }),
        emptyTrash: async () => ({ status: 'not-applicable', reason: 'no_account' }),
      });
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await integration.libraryActions!.restoreFromTrash(DIGEST);

      expect(seen).toEqual([{ kind: 'restored', plaintextSha256: DIGEST }]);
    });

    it('stays quiet when a restore intent is not applicable', async () => {
      trashActionsFactory.mockReturnValueOnce({
        restore: async () => ({ status: 'not-applicable', reason: 'not_trash' }),
        permanentDelete: async () => ({ status: 'queued', mutationId: 'm-2' }),
        emptyTrash: async () => ({ status: 'not-applicable', reason: 'no_account' }),
      });
      const integration = createLibraryIntegration({
        database: fakeDatabase(),
        byos: resolvedContext('aes-gcm'),
      });
      const seen = recordChanges(integration);

      await integration.libraryActions!.restoreFromTrash(DIGEST);

      expect(seen).toEqual([]);
    });
  });
});

const DIGEST = 'a'.repeat(64);

function recordChanges(integration: LibraryIntegration): LibraryChange[] {
  const seen: LibraryChange[] = [];
  integration.libraryChanges?.subscribe((change) => seen.push(change));
  return seen;
}

/**
 * A protect action whose settled results the test dictates. Only `protect` and
 * `applySavePolicyAfterIngest` are decorated by the composition; the other two
 * members exist so the object satisfies the port the rest of the stack takes.
 */
function stubProtectAction(
  overrides: Partial<LibraryProtectAction>,
): LibraryProtectAction {
  return {
    protect: async () => ({ status: 'noop', reason: 'not-applicable' }),
    applySavePolicyAfterIngest: async () => ({
      status: 'noop',
      reason: 'not-applicable',
    }),
    readRemoteState: async () => null,
    ensureCollected: async () => 'object_missing',
    isInFlight: () => false,
    settled: async () => undefined,
    settledAll: async () => undefined,
    fillDerived: async () => ({ status: 'complete' }),
    ...overrides,
  };
}

function stubLocalActions(
  overrides: Partial<LibraryLocalActions>,
): LibraryLocalActions {
  return {
    download: async () => ({ status: 'noop', reason: 'not-applicable' }),
    freeDeviceSpace: async () => ({ status: 'noop', reason: 'not-applicable' }),
    availableActions: async () => [],
    ...overrides,
  };
}

function stubSyncTrigger(
  captureRoundListener: (cb: (outcome: RunToEmptyOutcome) => void) => void,
): LibrarySyncTrigger {
  return {
    onAppStateChange: () => undefined,
    onLibraryChanged: () => undefined,
    onSessionReady: () => undefined,
    onNetworkReturn: () => undefined,
    onRoundComplete: (cb) => {
      captureRoundListener(cb);
      return () => undefined;
    },
    dispose: () => undefined,
  };
}

/** A deck card: inserted by a refill, never saved (the state a rewind leaves). */
function deckCandidate(id: number): WaifuImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 1200,
    height: 1800,
    byteSize: 456_789,
    extension: '.jpg',
    dominantColor: '#aabbcc',
    isNsfw: false,
    isAnimated: false,
    tags: [],
  };
}

async function openDatabase(): Promise<Readonly<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}>> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

/**
 * A library row with no local file, so the composed Expo file store is never
 * asked to delete anything: these tests are about the wiring, and the purge's
 * file handling is proven on the fake port in `library-collected-purge.test.ts`.
 */
async function cloudOnlyAsset(
  database: SqlDatabasePort,
  digest: string,
  sourceImageId: number,
): Promise<void> {
  await database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width, height,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       missing_original_since, created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'provider', ?, NULL, 'cloud-only',
       1, NULL, 1, 1)`,
    [digest, sourceImageId],
  );
}

async function deviceRowCount(database: SqlDatabasePort, digest: string): Promise<number> {
  const row = await database.getFirst<{ n: number }>(
    'SELECT COUNT(*) AS n FROM device_library_assets WHERE plaintext_sha256 = ?',
    [digest],
  );
  return row?.n ?? 0;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function macrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/**
 * Board #24 stage 1 (spec §5.4.2): the library's local phase of a rewound save
 * lives in both cores — the local-only core passes an `after` hook that
 * announces `purged` (board #27 F1), and the BYOS composition wraps it in its
 * before/after hooks.
 */
describe('board #24: the purge of a rewound save, as each core composes it', () => {
  it('the local-only core exposes purgeCollectedImage and purgeUndoneLibraryRows over its own tables', async () => {
    const { native, database } = await openDatabase();
    try {
      const images = createImageRepository(database);
      await images.insertCandidates([deckCandidate(61), deckCandidate(62)]);
      const first = '6'.repeat(64);
      const second = '7'.repeat(64);
      await cloudOnlyAsset(database, first, 61);
      await cloudOnlyAsset(database, second, 62);
      const integration = createLibraryIntegration({ database, images });
      const controller = integration.libraryController!;

      await controller.purgeCollectedImage(61);

      await expect(deviceRowCount(database, first)).resolves.toBe(0);
      await expect(deviceRowCount(database, second)).resolves.toBe(1);
      await expect(controller.purgeUndoneLibraryRows()).resolves.toBe(1);
      await expect(deviceRowCount(database, second)).resolves.toBe(0);
    } finally {
      native.close();
    }
  });

  it('board #27 F1: the local-only core announces `purged`, so a no-cloud 收藏 delete reaches 收藏占用', async () => {
    const { native, database } = await openDatabase();
    try {
      const images = createImageRepository(database);
      await images.insertCandidates([deckCandidate(64)]);
      const digest = '9'.repeat(64);
      await cloudOnlyAsset(database, digest, 64);
      const integration = createLibraryIntegration({ database, images });
      const seen = recordChanges(integration);

      await integration.libraryController!.purgeCollectedImage(64);

      await expect(deviceRowCount(database, digest)).resolves.toBe(0);
      expect(seen).toEqual([{ kind: 'purged', plaintextSha256: digest }]);
    } finally {
      native.close();
    }
  });

  it('BYOS: waits for an upload of the same bytes, evicts the decrypted cache, then announces `purged`', async () => {
    let releaseUpload!: () => void;
    const upload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const settled = jest.fn((_digest: string) => upload);
    protectActionFactory.mockReturnValueOnce(stubProtectAction({ settled }));
    const { native, database } = await openDatabase();
    try {
      const images = createImageRepository(database);
      await images.insertCandidates([deckCandidate(63)]);
      const digest = '8'.repeat(64);
      await cloudOnlyAsset(database, digest, 63);
      const integration = createLibraryIntegration({
        database,
        byos: resolvedContext('aes-gcm'),
        images,
      });
      const scope = await integration.libraryActions!.getAccountScope();
      const forget = jest.spyOn(integration.libraryCache!, 'forget');
      const seen = recordChanges(integration);

      let finished = false;
      const purging = integration.libraryController!
        .purgeCollectedImage(63)
        .then(() => {
          finished = true;
        });
      await waitUntil(() => settled.mock.calls.length > 0, 'the upload join');
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Held on the upload: the transaction has not run and nothing is evicted.
      expect(settled).toHaveBeenCalledWith(digest);
      expect(finished).toBe(false);
      await expect(deviceRowCount(database, digest)).resolves.toBe(1);
      expect(forget).not.toHaveBeenCalled();
      expect(seen).toEqual([]);

      releaseUpload();
      await purging;

      expect(scope).not.toBeNull();
      expect(forget).toHaveBeenCalledWith(scope, digest);
      await expect(deviceRowCount(database, digest)).resolves.toBe(0);
      expect(seen).toEqual([{ kind: 'purged', plaintextSha256: digest }]);
    } finally {
      native.close();
    }
  });
});

describe('board #27: a session-free library view', () => {
  it('the local-only core composes a session-free view that answers with the category it was given', async () => {
    const { native, database } = await openDatabase();
    try {
      const images = createImageRepository(database);
      await images.insertCandidates([deckCandidate(71)]);
      const digest = viewDigest('deck-71');
      await cloudOnlyAsset(database, digest, 71);
      await seedLibraryProtection(database, {
        plaintextSha256: digest,
        protection: 'protected',
        originalGenerationId: 'gen-71',
      });
      const integration = createLibraryIntegration({
        database,
        images,
        localUnavailableCategory: 'offline',
      });

      expect(integration.libraryActions).toBeNull();
      await expect(
        integration.libraryView!.resolver.resolve(digest, 'grid'),
      ).resolves.toEqual({ kind: 'unavailable', category: 'offline' });
    } finally {
      native.close();
    }
  });

  it('the local-only core flags a vanished original and announces it on its own feed', async () => {
    const { native, database } = await openDatabase();
    try {
      const digest = '9'.repeat(64);
      await database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width, height,
           origin, source_image_id, local_original_uri, residency, protect_eligible,
           missing_original_since, created_at, updated_at
         ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, ?,
           'local-original', 1, NULL, 1, 1)`,
        [digest, `file:///data/library/originals/${digest}.jpg`],
      );
      const integration = createLibraryIntegration({ database });
      const seen = recordChanges(integration);

      await expect(integration.libraryController!.noteMissingOriginals()).resolves.toBe(1);

      expect(seen).toEqual([{ kind: 'original-missing', plaintextSha256: digest }]);
    } finally {
      native.close();
    }
  });

  it('the local-only core deviceLibraryBytes grows by exactly the bytes written under the library directory', async () => {
    const { native, database } = await openDatabase();
    try {
      const integration = createLibraryIntegration({ database });
      const file = new File(Paths.document, 'library', 'originals', 'x.jpg');
      if (file.exists) file.delete();
      const before = await integration.libraryController!.deviceLibraryBytes();

      file.create({ intermediates: true, overwrite: true });
      file.write(new Uint8Array(7));

      await expect(integration.libraryController!.deviceLibraryBytes()).resolves.toBe(before + 7);
    } finally {
      native.close();
    }
  });

  it('the BYOS composition hands the local core its own view, and that view is the one exposed', () => {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });
    const handed = localCoreFactory.mock.calls.at(-1)?.[0].libraryView;

    expect(handed).not.toBeNull();
    expect(handed).toBe(integration.libraryView);
  });

  // Board row 45: both compositions build `shareFiles` from their own file
  // store, so a cloud-only original can be staged as `<sha>.<ext>` for share
  // and export and released afterwards.
  it('row 45: the BYOS view surface stages and releases the typed share copy through its file store', async () => {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });

    await expectViewSurfaceStagesShareCopies(integration);
  });

  it('row 45: the local-only view surface stages and releases the typed share copy through its file store', async () => {
    const integration = createLibraryIntegration({ database: fakeDatabase() });

    await expectViewSurfaceStagesShareCopies(integration);
  });
});

describe('board #27: beginReset, the library half of 删除全部应用数据', () => {
  it('BYOS: beginReset waits for a running round, then holds every round off until end', async () => {
    const round = acquireLibrarySyncLease();
    expect(round).not.toBeNull();
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });
    let settled = false;
    let ended = false;
    let pending: Promise<{ end(options: Readonly<{ retire: boolean }>): void } | null> = (
      Promise.resolve(null)
    );
    try {
      pending = integration.libraryController!.beginReset().then(
        (session) => {
          settled = true;
          return session;
        },
        () => {
          settled = true;
          return null;
        },
      );
      await macrotasks(5);
      expect(settled).toBe(false);

      round!();
      const session = await pending;
      expect(session).not.toBeNull();
      expect(acquireLibrarySyncLease()).toBeNull();

      session!.end({ retire: false });
      ended = true;
      const freed = acquireLibrarySyncLease();
      expect(freed).not.toBeNull();
      freed!();
    } finally {
      if (!ended) {
        round?.();
        const session = await pending;
        session?.end({ retire: false });
      }
    }
  });

  it('BYOS: clearDevice waits for every running upload before it deletes a row', async () => {
    let releaseUpload!: () => void;
    const upload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    protectActionFactory.mockReturnValueOnce(stubProtectAction({
      settledAll: () => upload,
    }));
    const { native, database } = await openDatabase();
    const digest = 'e'.repeat(64);
    let session: LibraryResetSession | null = null;
    try {
      await cloudOnlyAsset(database, digest, 81);
      const integration = createLibraryIntegration({
        database,
        byos: resolvedContext('aes-gcm'),
      });
      session = await integration.libraryController!.beginReset();
      let settled = false;
      const clearing = session.clearDevice().then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await macrotasks(5);
      expect(settled).toBe(false);
      await expect(deviceRowCount(database, digest)).resolves.toBe(1);

      releaseUpload();
      await clearing;
      await expect(deviceRowCount(database, digest)).resolves.toBe(0);
    } finally {
      releaseUpload?.();
      session?.end({ retire: false });
      native.close();
    }
  });

  it('BYOS: end({ retire: true }) retires the composition while it still holds the lease', async () => {
    const disposed: boolean[] = [];
    triggerFactory.mockReturnValueOnce({
      ...stubSyncTrigger(() => undefined),
      dispose: () => {
        disposed.push(acquireLibrarySyncLease() === null);
      },
    });
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
    });
    const session = await integration.libraryController!.beginReset();
    let ended = false;
    try {
      session.end({ retire: true });
      ended = true;
      expect(disposed).toEqual([true]);
      expect(getLibraryBackgroundRound()).toBeNull();
      const freed = acquireLibrarySyncLease();
      expect(freed).not.toBeNull();
      freed!();
    } finally {
      if (!ended) session.end({ retire: false });
    }
  });
});

/**
 * Board #27 S1b Task 8 (spec R26): a restore's hold around the replacement.
 * The next collect adapter the composition builds is the real one, over an
 * ingest that records each `sourceImageId` and fails, with `drain` optionally
 * held by the test.
 */
function recordingCollectAdapter(
  heldDrain?: Promise<void>,
): Readonly<{ recorded: number[] }> {
  const recorded: number[] = [];
  collectAdapterFactory.mockImplementationOnce(
    (dependencies: LibraryCollectAdapterDependencies) => {
      const real = jest.requireActual(
        '@/features/library/library-collect-adapter',
      ).createLibraryCollectAdapter({
        ...dependencies,
        ingest: {
          ingestUri: async (input: { sourceImageId?: number | null }) => {
            recorded.push(input.sourceImageId ?? -1);
            throw new Error('recorded, not ingested');
          },
        },
      });
      return heldDrain === undefined ? real : { ...real, drain: () => heldDrain };
    },
  );
  return { recorded };
}

describe('board #27 S1b T8: beginReset stops new ingests and purges, settle waits', () => {
  it('beginReset refuses before its hold resolves, and a rejecting hold leaves nothing refused', async () => {
    let rejectHold!: (error: Error) => void;
    const hold = new Promise<never>((_resolve, reject) => {
      rejectHold = reject;
    });
    const { recorded } = recordingCollectAdapter();
    const { native, database } = await openDatabase();
    try {
      const digest = 'd'.repeat(64);
      await cloudOnlyAsset(database, digest, 81);
      const controller = createLocalLibraryIntegration({
        database,
        images: createImageRepository(database),
        resetHooks: { hold: () => hold },
      }).libraryController!;

      const beginning = controller.beginReset();
      const rejection = expect(beginning).rejects.toThrow('the hold failed');
      controller.onCollectedOriginalReady({
        imageId: 84,
        localUri: 'file:///documents/collection/84.jpg',
      });
      await macrotasks(2);
      expect(recorded).toEqual([]);
      await expect(controller.purgeUndoneLibraryRows()).resolves.toBe(0);
      await expect(deviceRowCount(database, digest)).resolves.toBe(1);

      rejectHold(new Error('the hold failed'));
      await rejection;

      controller.onCollectedOriginalReady({
        imageId: 84,
        localUri: 'file:///documents/collection/84.jpg',
      });
      expect(recorded).toEqual([84]);
      await expect(controller.purgeUndoneLibraryRows()).resolves.toBe(1);
      await expect(deviceRowCount(database, digest)).resolves.toBe(0);
    } finally {
      native.close();
    }
  });

  it('an end whose hold throws still stops refusing', async () => {
    const { recorded } = recordingCollectAdapter();
    const { native, database } = await openDatabase();
    try {
      const digest = 'd'.repeat(64);
      await cloudOnlyAsset(database, digest, 81);
      const controller = createLocalLibraryIntegration({
        database,
        images: createImageRepository(database),
        resetHooks: {
          hold: async () => ({
            settleUploads: async () => undefined,
            end: () => {
              throw new Error('the hold end failed');
            },
          }),
        },
      }).libraryController!;
      const session = await controller.beginReset();

      expect(() => session.end({ retire: true })).toThrow('the hold end failed');

      controller.onCollectedOriginalReady({
        imageId: 84,
        localUri: 'file:///documents/collection/84.jpg',
      });
      expect(recorded).toEqual([84]);
      await expect(controller.purgeUndoneLibraryRows()).resolves.toBe(1);
      await expect(deviceRowCount(database, digest)).resolves.toBe(0);
    } finally {
      native.close();
    }
  });

  it('settle waits for the pool, the uploads and the purges, refuses new ingests and purges meanwhile, and deletes nothing', async () => {
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let releaseAll!: () => void;
    const settledAllHeld = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    let releaseUpload!: () => void;
    const uploadHeld = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const digest = 'd'.repeat(64);
    const e = '9'.repeat(64);
    const f = '7'.repeat(64);
    const settledAll = jest.fn(() => settledAllHeld);
    const settled = jest.fn((asset: string) => (
      asset === e ? uploadHeld : Promise.resolve()
    ));
    protectActionFactory.mockReturnValueOnce(stubProtectAction({ settledAll, settled }));
    const { recorded } = recordingCollectAdapter(drain);
    const { native, database } = await openDatabase();
    let session: LibraryResetSession | null = null;
    try {
      const images = createImageRepository(database);
      await images.insertCandidates([deckCandidate(83), deckCandidate(85)]);
      await cloudOnlyAsset(database, digest, 81);
      await cloudOnlyAsset(database, e, 83);
      await cloudOnlyAsset(database, f, 85);
      const integration = createLibraryIntegration({
        database,
        byos: resolvedContext('aes-gcm'),
        images,
      });
      const controller = integration.libraryController!;

      const purging = controller.purgeCollectedImage(83);
      await waitUntil(() => settled.mock.calls.length > 0, 'the upload join');
      session = await controller.beginReset();
      let settledDone = false;
      const settling = session.settle().then(() => {
        settledDone = true;
      });
      await macrotasks(5);
      expect(settledDone).toBe(false);
      expect(settledAll).not.toHaveBeenCalled();

      releaseDrain();
      await waitUntil(() => settledAll.mock.calls.length > 0, 'the uploads wait');
      expect(settledAll).toHaveBeenCalledTimes(1);
      await macrotasks(2);
      expect(settledDone).toBe(false);

      controller.onCollectedOriginalReady({
        imageId: 84,
        localUri: 'file:///documents/collection/84.jpg',
      });
      expect(recorded).toEqual([]);
      await expect(controller.purgeCollectedImage(85)).resolves.toBeUndefined();
      await expect(controller.purgeUndoneLibraryRows()).resolves.toBe(0);
      await expect(deviceRowCount(database, f)).resolves.toBe(1);
      await expect(deviceRowCount(database, digest)).resolves.toBe(1);

      releaseAll();
      await macrotasks(5);
      expect(settledDone).toBe(false);
      releaseUpload();
      await purging;
      await settling;
      expect(settledDone).toBe(true);
      await expect(deviceRowCount(database, e)).resolves.toBe(0);
      await expect(deviceRowCount(database, digest)).resolves.toBe(1);

      session.end({ retire: false });
      controller.onCollectedOriginalReady({
        imageId: 84,
        localUri: 'file:///documents/collection/84.jpg',
      });
      expect(recorded).toEqual([84]);
      await controller.purgeCollectedImage(85);
      await expect(deviceRowCount(database, f)).resolves.toBe(0);
    } finally {
      releaseDrain?.();
      releaseAll?.();
      releaseUpload?.();
      session?.end({ retire: false });
      native.close();
    }
  });
});

describe('board #27 S1b: the hand-over, as the local core composes it', () => {
  const D = viewDigest('h');
  const COLLECTION_URI = 'file:///collection/71.jpg';

  /** Image 71 saved and ready at `L` with a recorded ingest verdict (the migration only takes rows without one), its original on disk, its device row. */
  async function fixture(libraryError: string | null = 'storage_failed') {
    const { native, database } = await openDatabase();
    const original = new File(Paths.document, 'library', 'originals', `${D}.jpg`);
    original.create({ intermediates: true, overwrite: true });
    original.write(new Uint8Array(5));
    await database.run(
      `INSERT INTO images (
         id, provider_key, provider_item_id, remote_url, width, height, byte_size,
         extension, dominant_color, content_rating, is_nsfw, is_animated,
         tags_json, decision, presented_at, decided_at, queue_ordinal,
         decision_ordinal, local_uri, download_state, library_error
       ) VALUES (71, 'waifu_im', '71', 'https://cdn.example.com/71.jpg', 10, 10, 100,
                 '.jpg', '#aabbcc', 'safe', 0, 0, '[]', 'saved', 1, 2, 71, 71, ?,
                 'ready', ?)`,
      [COLLECTION_URI, libraryError],
    );
    await seedDeviceLibraryAsset(database, {
      plaintextSha256: D,
      sourceImageId: 71,
      localOriginalUri: original.uri,
      byteSize: 5,
    });
    const sizes = new Map<string, number>([[COLLECTION_URI, 5]]);
    const collectionFiles: LibraryCollectionFilesPort = {
      fileSize: async (uri) => sizes.get(uri) ?? 0,
      deleteUri: async (uri) => {
        sizes.delete(uri);
      },
    };
    const images = createImageRepository(database);
    const row = await database.getFirst<{ plaintext_sha256: string }>(
      'SELECT plaintext_sha256 FROM device_library_assets WHERE plaintext_sha256 = ?',
      [D],
    );
    expect(row).not.toBeNull();
    return { native, database, original, sizes, collectionFiles, images };
  }

  async function state(images: ReturnType<typeof createImageRepository>) {
    const row = await images.getById(71);
    return {
      downloadState: row?.downloadState,
      localUri: row?.localUri,
      libraryError: row?.libraryError,
    };
  }

  it('a successful collect ingest hands the row over', async () => {
    const { native, database, original, sizes, collectionFiles, images } = await fixture();
    try {
      const integration = createLibraryIntegration({ database, images, collectionFiles });
      const seen = recordChanges(integration);
      const adapterInput = collectAdapterFactory.mock.calls.at(-1)?.[0] as LibraryCollectAdapterDependencies;
      const asset = await createLibraryRepositoryAsset(database, D);

      adapterInput.onSuccess!(
        { imageId: 71, localUri: COLLECTION_URI },
        {
          status: 'ingested',
          asset,
          enrollment: { status: 'skipped', reason: 'no_account' },
        },
      );

      await waitUntil(() => seen.some((change) => change.kind === 'handed-over'), 'the hand-over');
      // The recorder's clear of the verdict is its own async write.
      let cleared = false;
      for (let tick = 0; tick < 200 && !cleared; tick += 1) {
        cleared = (await state(images)).libraryError === null;
        if (!cleared) await macrotasks(1);
      }
      await expect(state(images)).resolves.toEqual({
        downloadState: 'mirrored',
        localUri: null,
        libraryError: null,
      });
      expect(sizes.has(COLLECTION_URI)).toBe(false);
      expect(seen).toContainEqual({ kind: 'handed-over', imageId: 71, plaintextSha256: D });
      original.delete();
    } finally {
      native.close();
    }
  });

  it('a healing ingest (a duplicate outcome) hands the row over too', async () => {
    const { native, database, original, sizes, collectionFiles, images } = await fixture();
    try {
      const integration = createLibraryIntegration({ database, images, collectionFiles });
      const seen = recordChanges(integration);
      const adapterInput = collectAdapterFactory.mock.calls.at(-1)?.[0] as LibraryCollectAdapterDependencies;
      const asset = await createLibraryRepositoryAsset(database, D);

      // A heal: the asset already existed, so the ingest answers `duplicate`.
      adapterInput.onSuccess!(
        { imageId: 71, localUri: COLLECTION_URI },
        {
          status: 'duplicate',
          asset,
          enrollment: { status: 'skipped', reason: 'no_account' },
        },
      );

      await waitUntil(() => seen.some((change) => change.kind === 'handed-over'), 'the hand-over');
      await expect(state(images)).resolves.toMatchObject({
        downloadState: 'mirrored',
        localUri: null,
      });
      expect(sizes.has(COLLECTION_URI)).toBe(false);
      expect(seen.filter((change) => change.kind === 'handed-over')).toEqual([
        { kind: 'handed-over', imageId: 71, plaintextSha256: D },
      ]);
      original.delete();
    } finally {
      native.close();
    }
  });

  it('the controller runs the migration', async () => {
    const { native, database, original, sizes, collectionFiles, images } = await fixture(null);
    try {
      const integration = createLibraryIntegration({ database, images, collectionFiles });
      const seen = recordChanges(integration);

      await expect(integration.libraryController!.handOverExisting()).resolves.toBe(1);

      await expect(state(images)).resolves.toEqual({
        downloadState: 'mirrored',
        localUri: null,
        libraryError: null,
      });
      expect(sizes.has(COLLECTION_URI)).toBe(false);
      expect(seen).toContainEqual({ kind: 'handed-over', imageId: 71, plaintextSha256: D });
      original.delete();
    } finally {
      native.close();
    }
  });

  it('without the collection\'s files nothing is handed over', async () => {
    // No recorded verdict, so row 71 is a real candidate for the migration.
    const { native, database, original, images } = await fixture(null);
    try {
      const integration = createLibraryIntegration({ database, images });
      const seen = recordChanges(integration);

      await expect(integration.libraryController!.handOverExisting()).resolves.toBe(0);

      await expect(state(images)).resolves.toEqual({
        downloadState: 'ready',
        localUri: COLLECTION_URI,
        libraryError: null,
      });
      expect(seen).toEqual([]);
      original.delete();
    } finally {
      native.close();
    }
  });
});

describe('board #27 S2: R24', () => {
  it('the local-only core sweeps library-cache orphans', async () => {
    const { native, database } = await openDatabase();
    try {
      const integration = createLibraryIntegration({ database });
      const port = createExpoLibraryFilePort();
      await port.ensureDirectories();
      const named = port.resolveCache('scope-n.bin');
      const orphan = port.resolveCache('scope-o.bin');
      await port.writeBytes(named, new Uint8Array([1, 2, 3]));
      await port.writeBytes(orphan, new Uint8Array([4, 5, 6]));
      await createLibraryProtectionRepository({ database }).upsertProtection({
        accountScope: 'scope',
        assetId: viewAssetId('n'),
        plaintextSha256: viewDigest('n'),
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
      await database.run(
        `INSERT INTO library_cache_entries (
           account_scope, plaintext_sha256, role, uri, byte_size, generation_id,
           created_at, last_used_at
         ) VALUES ('scope', ?, 'preview', ?, 3, NULL, 1, 1)`,
        [viewDigest('n'), named],
      );

      await expect(integration.libraryController!.sweepCacheOrphans()).resolves.toBe(1);

      expect(new File(Paths.cache, 'library-cache', 'scope-o.bin').exists).toBe(false);
      expect(new File(Paths.cache, 'library-cache', 'scope-n.bin').exists).toBe(true);
    } finally {
      native.close();
    }
  });

  it('a composition that has a cache store sweeps that store, whose in-flight puts it can see', async () => {
    const { native, database } = await openDatabase();
    try {
      const sweepOrphans = jest.fn(async () => 7);
      const libraryCache = { sweepOrphans } as unknown as NonNullable<
        Parameters<typeof createLocalLibraryIntegration>[0]['libraryCache']
      >;
      const controller = createLocalLibraryIntegration({
        database,
        images: createImageRepository(database),
        libraryCache,
      }).libraryController!;

      await expect(controller.sweepCacheOrphans()).resolves.toBe(7);
      expect(sweepOrphans).toHaveBeenCalledTimes(1);
    } finally {
      native.close();
    }
  });
});

async function createLibraryRepositoryAsset(
  database: SqlDatabasePort,
  digest: string,
): Promise<DeviceLibraryAsset> {
  const asset = await createLibraryRepository(database).findLocalAsset(digest);
  if (asset === null) throw new Error('fixture asset missing');
  return asset;
}

describe('board #27 S3: 仅云端 wiring', () => {
  const VAULT_ID = vaultMeta('aes-gcm').vaultId;

  function mapStore(seed?: Readonly<Record<string, string>>) {
    const map = new Map<string, string>(Object.entries(seed ?? {}));
    const store = createLibraryStorageModeStore({
      getItem: async (key) => map.get(key) ?? null,
      setItem: async (key, value) => { map.set(key, value); },
      removeItem: async (key) => { map.delete(key); },
    });
    return store;
  }

  function compose(store = mapStore()) {
    const integration = createLibraryIntegration({
      database: fakeDatabase(),
      byos: resolvedContext('aes-gcm'),
      storageModeStore: store,
    });
    return { integration, store };
  }

  const roundDeps = () => syncRoundFactory.mock.calls.at(-1)![0] as {
    isCloudOnly: () => Promise<boolean>;
  };

  async function macrotasks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }

  it('the trigger drives the mode-aware round', () => {
    compose();

    const [deps] = triggerFactory.mock.calls.at(-1) as [{ round: unknown }];
    expect(syncRoundFactory).toHaveBeenCalledTimes(1);
    expect(deps.round).toBe(syncRoundFactory.mock.results[0].value);
  });

  it('one ensure serves the pass and the eviction, with the cloud and board #31\'s cap', () => {
    compose();

    expect(localThumbnailsFactory).toHaveBeenCalledTimes(1);
    expect(thumbnailPassFactory).toHaveBeenCalledTimes(1);
    expect(evictionFactory).toHaveBeenCalledTimes(1);
    expect(localThumbnailsFactory.mock.calls[0][0]).toMatchObject({
      originalByteLimit: LIBRARY_THUMBNAIL_SOURCE_ORIGINAL_MAX_BYTES,
      cloud: expect.objectContaining({ roles: expect.anything() }),
    });
    const ensure = localThumbnailsFactory.mock.results[0].value;
    expect(thumbnailPassFactory.mock.calls[0][0].thumbnails).toBe(ensure);
    expect(evictionFactory.mock.calls[0][0].thumbnails).toBe(ensure);
    // Their 8-lane defaults are pinned in their own modules.
    expect(thumbnailPassFactory.mock.calls[0][0]).not.toHaveProperty('concurrency');
    expect(evictionFactory.mock.calls[0][0]).not.toHaveProperty('concurrency');
  });

  it('the round shares the pass and the eviction it was built from', () => {
    compose();

    const roundInput = syncRoundFactory.mock.calls[0][0];
    expect(roundInput.thumbnailPass).toBe(thumbnailPassFactory.mock.results[0].value);
    expect(roundInput.eviction).toBe(evictionFactory.mock.results[0].value);
    expect(evictionFactory.mock.calls[0][0].isCloudOnly).toBe(roundInput.isCloudOnly);
  });

  it('the round asks the library for its account scope', async () => {
    const { integration } = compose();
    const roundInput = syncRoundFactory.mock.calls[0][0] as {
      getAccountScope: () => Promise<string | null>;
    };
    const scope = await integration.libraryActions!.getAccountScope();

    expect(scope).toEqual(expect.any(String));
    await expect(roundInput.getAccountScope()).resolves.toBe(scope);
  });

  it("the eviction fills derived roles through the composition's protect action", async () => {
    compose();
    const action = protectActionFactory.mock.results.at(-1)!.value as {
      fillDerived: (sha: string) => Promise<unknown>;
    };
    const fill = jest.spyOn(action, 'fillDerived').mockResolvedValue({ status: 'unfillable' });
    const deps = evictionFactory.mock.calls[0][0] as {
      fillDerived: (sha: string) => Promise<unknown>;
    };

    await expect(deps.fillDerived('d')).resolves.toEqual({ status: 'unfillable' });
    expect(fill).toHaveBeenCalledWith('d');
  });

  it('isCloudOnly reads this vault\'s choice', async () => {
    const { store } = compose();
    const { isCloudOnly } = roundDeps();

    await expect(isCloudOnly()).resolves.toBe(false);
    await store.write(VAULT_ID, 'cloud-only');
    await expect(isCloudOnly()).resolves.toBe(true);
    await store.write('other', 'cloud-only');
    await expect(isCloudOnly()).resolves.toBe(false);
  });

  it('set writes the mode, then starts a round', async () => {
    const order: string[] = [];
    const inner = mapStore();
    const store = {
      ...inner,
      write: async (vaultId: string, mode: 'both' | 'cloud-only') => {
        await inner.write(vaultId, mode);
        order.push('write');
      },
    };
    const { integration } = compose(store);
    const trigger = integration.librarySyncTrigger!;
    const spy = jest.spyOn(trigger, 'onLibraryChanged').mockImplementation(() => {
      order.push('round');
    });

    await integration.libraryStorageMode!.set('cloud-only');

    await expect(inner.read(VAULT_ID)).resolves.toBe('cloud-only');
    await expect(integration.libraryStorageMode!.read()).resolves.toBe('cloud-only');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['write', 'round']);
  });

  it('a hand-over starts a round only in 仅云端', async () => {
    const { integration, store } = compose();
    const spy = jest.spyOn(integration.librarySyncTrigger!, 'onLibraryChanged')
      .mockImplementation(() => undefined);
    const handedOver = { kind: 'handed-over', imageId: 7, plaintextSha256: 'd' } as const;

    integration.libraryChanges!.emit(handedOver);
    await macrotasks(5);
    expect(spy).not.toHaveBeenCalled();

    await store.write(VAULT_ID, 'cloud-only');
    integration.libraryChanges!.emit(handedOver);
    await macrotasks(5);
    expect(spy).toHaveBeenCalledTimes(1);

    integration.libraryChanges!.emit({ kind: 'freed', plaintextSha256: 'd' });
    await macrotasks(5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a hand-over whose mode cannot be read starts nothing and throws nothing', async () => {
    const inner = mapStore();
    const { integration } = compose({
      ...inner,
      read: async () => { throw new Error('kv'); },
    });
    const spy = jest.spyOn(integration.librarySyncTrigger!, 'onLibraryChanged')
      .mockImplementation(() => undefined);

    integration.libraryChanges!.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: 'd' });
    await macrotasks(5);

    expect(spy).not.toHaveBeenCalled();
  });

  it('a background wakeup runs the mode-aware round', async () => {
    const none = { total: 0, done: 0, failed: 0 };
    const roundSpy = jest.fn(async () => ({ up: none, down: none }));
    syncRoundFactory.mockImplementationOnce(() => roundSpy);
    compose();

    await getLibraryBackgroundRound()!();

    expect(roundSpy).toHaveBeenCalledTimes(1);
  });

  it('set switches back to 本地+云端 too', async () => {
    const { integration } = compose();
    const spy = jest.spyOn(integration.librarySyncTrigger!, 'onLibraryChanged')
      .mockImplementation(() => undefined);

    await integration.libraryStorageMode!.set('cloud-only');
    await integration.libraryStorageMode!.set('both');

    await expect(integration.libraryStorageMode!.read()).resolves.toBe('both');
    await expect(roundDeps().isCloudOnly()).resolves.toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('set reports a write that failed and starts no round', async () => {
    const inner = mapStore();
    const { integration } = compose({
      ...inner,
      write: async () => { throw new Error('kv'); },
    });
    const spy = jest.spyOn(integration.librarySyncTrigger!, 'onLibraryChanged')
      .mockImplementation(() => undefined);

    await expect(integration.libraryStorageMode!.set('cloud-only')).rejects.toThrow('kv');
    expect(spy).not.toHaveBeenCalled();
  });

  it('the local core has no storage mode', () => {
    expect(createLibraryIntegration({ database: fakeDatabase() }).libraryStorageMode)
      .toBeUndefined();
  });
});

/**
 * N10 T1: the controller member the collection's resume sweep calls. The
 * vault composition overrides the local core's answer with the session-gated
 * one, so a committed cloud original generation counts as bytes existing;
 * the local-only core answers from its own tables alone.
 */
describe('N10 T1: the dead-mirrored-row selector, as each core exposes it', () => {
  it('BYOS: the controller counts a committed cloud original, the local answer cannot', async () => {
    const { native, database } = await openDatabase();
    try {
      const images = createImageRepository(database);
      const dead = await images.saveMirroredCandidate(
        { ...deckCandidate(91), id: undefined } as never,
        100,
      );
      const healed = await images.saveMirroredCandidate(
        { ...deckCandidate(92), id: undefined } as never,
        100,
      );
      await cloudOnlyAsset(database, viewDigest('n10-byos-dead'), dead.id);
      await cloudOnlyAsset(database, viewDigest('n10-byos-healed'), healed.id);
      const integration = createLibraryIntegration({
        database,
        byos: resolvedContext('aes-gcm'),
        images,
      });
      const scope = await integration.libraryActions!.getAccountScope();
      if (scope === null) throw new Error('the composed session has no account scope');
      await seedLibraryProtection(database, {
        plaintextSha256: viewDigest('n10-byos-healed'),
        accountScope: scope,
        protection: 'protected',
        originalGenerationId: 'gen-n10-byos',
      });

      await expect(
        integration.libraryController!.listMirrorDeadSavedImageIds(),
      ).resolves.toEqual([dead.id]);
    } finally {
      native.close();
    }
  });

  it('the local-only core answers with no protection table involvement', async () => {
    const { native, database } = await openDatabase();
    try {
      const images = createImageRepository(database);
      const dead = await images.saveMirroredCandidate(
        { ...deckCandidate(93), id: undefined } as never,
        100,
      );
      await cloudOnlyAsset(database, viewDigest('n10-local-dead'), dead.id);
      // A vault-era projection row says nothing without a cloud: the row is
      // still byte-dead here and still repairable by re-download.
      await seedLibraryProtection(database, {
        plaintextSha256: viewDigest('n10-local-dead'),
        protection: 'protected',
        originalGenerationId: 'gen-n10-local-leftover',
      });
      const integration = createLibraryIntegration({ database, images });

      await expect(
        integration.libraryController!.listMirrorDeadSavedImageIds(),
      ).resolves.toEqual([dead.id]);
    } finally {
      native.close();
    }
  });
});

describe('N10 T2: the re-protect pass, as each core exposes it', () => {
  it('BYOS: the controller hands an uncommitted original to the protect action', async () => {
    const { native, database } = await openDatabase();
    try {
      const digest = viewDigest('n10-reprotect');
      await seedDeviceLibraryAsset(database, { plaintextSha256: digest });
      const integration = createLibraryIntegration({
        database,
        byos: resolvedContext('aes-gcm'),
      });
      // The exact action instance the composition wired the pass to.
      const uploads = protectActionFactory.mock.results.at(-1)!
        .value as LibraryProtectAction;
      const protect = jest.spyOn(uploads, 'protect');

      await expect(
        integration.libraryController!.reprotectUncommittedOriginals(),
      ).resolves.toBe(1);
      expect(protect).toHaveBeenCalledWith(digest);
      // The pass performs no network I/O of its own: the protect above ran
      // into its blocked verdict (the seeded uri does not exist) and returned.
      expect(fetchPort).not.toHaveBeenCalled();
    } finally {
      native.close();
    }
  });

  it('the local-only core answers 0 — no account, nothing to commit an original to', async () => {
    const { native, database } = await openDatabase();
    try {
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-local-reprotect'),
      });
      const integration = createLibraryIntegration({ database });

      await expect(
        integration.libraryController!.reprotectUncommittedOriginals(),
      ).resolves.toBe(0);
    } finally {
      native.close();
    }
  });
});

describe('N6-A2: local-core live change publication, purgeImportedAsset, and reset coordination', () => {
  it('exposes purgeImportedAsset and importConfirmedFiles on the controller, and purgeImportedAsset emits a purged event in the local-only core', async () => {
    const { native, database } = await openDatabase();
    try {
      const digest = viewDigest('n6-a2-local-import');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        origin: 'import',
        importClassification: 'safe',
      });
      const integration = createLibraryIntegration({ database });
      const seen = recordChanges(integration);

      expect(typeof integration.libraryController?.importConfirmedFiles).toBe(
        'function',
      );
      await expect(
        integration.libraryController!.purgeImportedAsset!(digest),
      ).resolves.toBe(true);
      expect(seen).toContainEqual({
        kind: 'purged',
        plaintextSha256: digest,
      });
    } finally {
      native.close();
    }
  });

  it('beginReset refuses new confirmed imports until end() is called', async () => {
    const { native, database } = await openDatabase();
    try {
      const integration = createLibraryIntegration({ database });
      const reset = await integration.libraryController!.beginReset();

      const refused =
        await integration.libraryController!.importConfirmedFiles!({
          uris: ['file:///nonexistent/pick.jpg'],
          classification: 'safe',
        });
      expect(refused).toEqual({
        selected: 1,
        ingested: 0,
        duplicates: 0,
        notEnrolled: 0,
        retainedClassificationCount: 0,
        rejected: [{ code: 'storage_failed' }],
      });
      await reset.settle();
      reset.end({ retire: false });
    } finally {
      native.close();
    }
  });
});
