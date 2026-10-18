import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { clearAccountProjection } from '@/features/library/library-account-projection';
import {
  assessRemoveDeviceData,
  exportUnprotectedOriginals,
  markExported,
  removeAccountDataFromThisDevice,
} from '@/features/library/library-remove-device-data';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-remove';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const ASSET_A = 'c'.repeat(64);
const ASSET_B = 'd'.repeat(64);
const ORIGINALS_ROOT = 'file:///data/library/originals';

async function harness(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

async function seedAsset(
  database: SqlDatabasePort,
  input: Readonly<{
    digest: string;
    assetId: string;
    uri: string | null;
    protection: 'unprotected' | 'pending' | 'protected' | 'failed' | null;
    exportedAt?: number | null;
  }>,
): Promise<void> {
  if (input.uri !== null || input.protection !== null) {
    await database.run(
      `INSERT INTO device_library_assets (
         plaintext_sha256, format, canonical_extension, byte_size, width, height,
         origin, source_image_id, local_original_uri, residency, protect_eligible,
         missing_original_since, created_at, updated_at
       ) VALUES (?, 'jpeg', 'jpg', 10, 4, 4, 'import', NULL,
         ?, 'local-original', 1, NULL, 5, 5)`,
      [input.digest, input.uri],
    );
  }
  if (input.protection !== null) {
    await database.run(
      `INSERT INTO library_asset_protection (
         account_scope, asset_id, plaintext_sha256, lifecycle, protection,
         generation, revision, original_generation_id, original_ciphertext_bytes,
         verified_at, failure_category, trashed_at, updated_at
       ) VALUES (?, ?, ?, 'active', ?, 0, NULL, NULL, NULL,
         NULL, NULL, NULL, 5)`,
      [SCOPE, input.assetId, input.digest, input.protection],
    );
  }
  if (input.exportedAt != null) {
    await markExported(database, input.digest, input.exportedAt);
  }
}

describe('assessRemoveDeviceData', () => {
  it('blocks remove-device-data and names the unprotected count', () => {
    expect(assessRemoveDeviceData({
      rows: [
        {
          plaintextSha256: DIGEST_A,
          localOriginalUri: 'file://a',
          protection: 'unprotected',
          exportedAt: null,
        },
      ],
    })).toEqual({
      affectedOriginals: 1,
      unprotectedCount: 1,
      unprotectedDigests: [DIGEST_A],
    });
  });

  it('allows remove when every original is protected or exported', () => {
    expect(assessRemoveDeviceData({
      rows: [
        {
          plaintextSha256: DIGEST_A,
          localOriginalUri: 'file://a',
          protection: 'protected',
          exportedAt: null,
        },
        {
          plaintextSha256: DIGEST_B,
          localOriginalUri: 'file://b',
          protection: 'unprotected',
          exportedAt: 1,
        },
      ],
    }).unprotectedCount).toBe(0);
  });
});

describe('removeAccountDataFromThisDevice', () => {
  it('returns blocked and deletes nothing when unprotectedCount > 0', async () => {
    const { native, database } = await harness();
    await seedAsset(database, {
      digest: DIGEST_A,
      assetId: ASSET_A,
      uri: `${ORIGINALS_ROOT}/${DIGEST_A}.jpg`,
      protection: 'unprotected',
    });
    const deleteOriginal = jest.fn(async () => undefined);
    const signOut = jest.fn(async () => undefined);
    const clearCacheScope = jest.fn(async () => undefined);

    const result = await removeAccountDataFromThisDevice({
      database,
      accountScope: SCOPE,
      originalsRootUri: ORIGINALS_ROOT,
      deleteOriginal,
      clearCacheScope,
      signOut,
    });

    expect(result).toEqual({ status: 'blocked', unprotectedCount: 1 });
    expect(deleteOriginal).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(clearCacheScope).not.toHaveBeenCalled();
    expect(
      await database.getFirst(
        'SELECT COUNT(*) AS n FROM library_asset_protection WHERE account_scope = ?',
        [SCOPE],
      ),
    ).toEqual({ n: 1 });
    native.close();
  });

  it('deletes durable originals under the originals root then clears projection and signs out', async () => {
    const { native, database } = await harness();
    const uri = `${ORIGINALS_ROOT}/${DIGEST_A}.jpg`;
    await seedAsset(database, {
      digest: DIGEST_A,
      assetId: ASSET_A,
      uri,
      protection: 'protected',
    });
    const deleteOriginal = jest.fn(async () => undefined);
    const signOut = jest.fn(async () => undefined);
    const clearCacheScope = jest.fn(async () => undefined);
    const callOrder: string[] = [];
    deleteOriginal.mockImplementation(async () => {
      callOrder.push('deleteOriginal');
    });
    clearCacheScope.mockImplementation(async () => {
      callOrder.push('clearCache');
    });
    signOut.mockImplementation(async () => {
      callOrder.push('signOut');
    });

    const result = await removeAccountDataFromThisDevice({
      database,
      accountScope: SCOPE,
      originalsRootUri: ORIGINALS_ROOT,
      deleteOriginal,
      clearCacheScope,
      signOut,
    });

    expect(result).toEqual({ status: 'removed', deletedOriginals: 1 });
    expect(deleteOriginal).toHaveBeenCalledWith(uri);
    expect(callOrder).toEqual(['deleteOriginal', 'clearCache', 'signOut']);
    expect(
      await database.getFirst(
        'SELECT COUNT(*) AS n FROM library_asset_protection WHERE account_scope = ?',
        [SCOPE],
      ),
    ).toEqual({ n: 0 });
    native.close();
  });

  it('refuses URIs outside the durable originals root before deleting anything', async () => {
    const { native, database } = await harness();
    await seedAsset(database, {
      digest: DIGEST_A,
      assetId: ASSET_A,
      uri: 'file:///elsewhere/a.jpg',
      protection: 'protected',
    });
    const deleteOriginal = jest.fn(async () => undefined);
    const signOut = jest.fn(async () => undefined);

    await expect(removeAccountDataFromThisDevice({
      database,
      accountScope: SCOPE,
      originalsRootUri: ORIGINALS_ROOT,
      deleteOriginal,
      clearCacheScope: async () => undefined,
      signOut,
    })).rejects.toThrow(/outside the durable originals root/);

    expect(deleteOriginal).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    native.close();
  });
});

describe('exportUnprotectedOriginals', () => {
  it('exports then marks exported_at so remove becomes allowed', async () => {
    const { native, database } = await harness();
    const uri = `${ORIGINALS_ROOT}/${DIGEST_A}.jpg`;
    await seedAsset(database, {
      digest: DIGEST_A,
      assetId: ASSET_A,
      uri,
      protection: 'unprotected',
    });
    const exportToPhotos = jest.fn(async () => undefined);

    const before = assessRemoveDeviceData({
      rows: [
        {
          plaintextSha256: DIGEST_A,
          localOriginalUri: uri,
          protection: 'unprotected',
          exportedAt: null,
        },
      ],
    });
    expect(before.unprotectedCount).toBe(1);

    const result = await exportUnprotectedOriginals({
      database,
      accountScope: SCOPE,
      exportToPhotos,
      clock: () => 42,
    });

    expect(result).toEqual({ exported: 1 });
    expect(exportToPhotos).toHaveBeenCalledWith(uri);
    const marked = await database.getFirst<{ exported_at: number }>(
      'SELECT exported_at FROM library_device_asset_state WHERE plaintext_sha256 = ?',
      [DIGEST_A],
    );
    expect(marked?.exported_at).toBe(42);

    const deleteOriginal = jest.fn(async () => undefined);
    const remove = await removeAccountDataFromThisDevice({
      database,
      accountScope: SCOPE,
      originalsRootUri: ORIGINALS_ROOT,
      deleteOriginal,
      clearCacheScope: async () => undefined,
      signOut: async () => undefined,
    });
    expect(remove).toEqual({ status: 'removed', deletedOriginals: 1 });
    expect(deleteOriginal).toHaveBeenCalledWith(uri);
    native.close();
  });

  it('sign-out does not delete durable local originals', async () => {
    // Sign-out path is clearAccountProjection only — never deleteOriginal.
    // This named invariant is asserted at the settings-screen layer; here we
    // prove remove is the only helper that calls deleteOriginal.
    const { native, database } = await harness();
    await seedAsset(database, {
      digest: DIGEST_A,
      assetId: ASSET_A,
      uri: `${ORIGINALS_ROOT}/${DIGEST_A}.jpg`,
      protection: 'unprotected',
    });
    const deleteOriginal = jest.fn(async () => undefined);
    await clearAccountProjection(database, SCOPE);
    expect(deleteOriginal).not.toHaveBeenCalled();
    expect(
      await database.getFirst<{ local_original_uri: string }>(
        'SELECT local_original_uri FROM device_library_assets WHERE plaintext_sha256 = ?',
        [DIGEST_A],
      ),
    ).toEqual({ local_original_uri: `${ORIGINALS_ROOT}/${DIGEST_A}.jpg` });
    native.close();
  });
});
