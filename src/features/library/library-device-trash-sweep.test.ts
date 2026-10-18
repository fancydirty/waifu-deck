jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import {
  createLibraryDeviceTrashSweep,
  type LibraryDeviceTrashSweep,
} from '@/features/library/library-device-trash-sweep';
import { LIBRARY_TRASH_RETENTION_MS } from '@/features/library/library-trash-deadline';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const DIGEST = 'e'.repeat(64);
const BYTES = Uint8Array.from([7, 7, 7, 7]);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('createLibraryDeviceTrashSweep', () => {
  let harness: ActionsHarness;
  let sweep: LibraryDeviceTrashSweep;
  let now: number;
  let trashUri: string;
  let originalUri: string;

  beforeEach(async () => {
    resetExpoCryptoDouble();
    harness = await createActionsHarness();
    now = 1_700_000_000_000;
    trashUri = `${harness.port.trashRootUri}/${DIGEST}.jpg`;
    originalUri = harness.originalUriFor(DIGEST);
    sweep = createLibraryDeviceTrashSweep({
      database: harness.database,
      protection: harness.protection,
      files: harness.port,
      clock: () => now,
    });
  });

  afterEach(() => {
    harness.close();
  });

  async function seedExpiredTrash(trashedAt: number): Promise<void> {
    await harness.port.writeBytes(trashUri, BYTES);
    await harness.protection.setDeviceTrash(DIGEST, trashUri, trashedAt);
  }

  it('deletes only trash-root bytes after device_trashed_at + 30 days', async () => {
    await seedExpiredTrash(now - LIBRARY_TRASH_RETENTION_MS - DAY_MS);

    const report = await sweep.run(TEST_ACCOUNT_SCOPE);

    expect(report).toEqual({ deleted: 1, refused: 0, failed: 0 });
    expect(await harness.port.exists(trashUri)).toBe(false);
    await expect(
      harness.protection.readDeviceState(DIGEST),
    ).resolves.toMatchObject({
      deviceTrashUri: null,
      deviceTrashedAt: null,
    });
  });

  it('does nothing before the deadline', async () => {
    await seedExpiredTrash(now - LIBRARY_TRASH_RETENTION_MS + DAY_MS);

    const report = await sweep.run(TEST_ACCOUNT_SCOPE);

    expect(report.deleted).toBe(0);
    expect(await harness.port.exists(trashUri)).toBe(true);
    await expect(
      harness.protection.readDeviceState(DIGEST),
    ).resolves.toMatchObject({
      deviceTrashUri: trashUri,
      deviceTrashedAt: now - LIBRARY_TRASH_RETENTION_MS + DAY_MS,
    });
  });

  it('refuses a candidate whose uri is outside trashRootUri', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await harness.protection.setDeviceTrash(
      DIGEST,
      originalUri,
      now - LIBRARY_TRASH_RETENTION_MS - DAY_MS,
    );
    harness.port.deletedFiles.length = 0;

    const report = await sweep.run(TEST_ACCOUNT_SCOPE);

    expect(report).toMatchObject({ deleted: 0, refused: 1 });
    expect(await harness.port.exists(originalUri)).toBe(true);
    expect(
      harness.port.deletedFiles.some((uri) =>
        uri.startsWith(harness.port.originalsRootUri),
      ),
    ).toBe(false);
  });

  it('never deletes durable local originals even when expired', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes: BYTES });
    await harness.port.writeBytes(trashUri, BYTES);
    await harness.protection.setDeviceTrash(
      DIGEST,
      trashUri,
      now - LIBRARY_TRASH_RETENTION_MS - DAY_MS,
    );
    harness.port.deletedFiles.length = 0;

    const report = await sweep.run(TEST_ACCOUNT_SCOPE);

    expect(await harness.port.exists(originalUri)).toBe(true);
    expect(report.deleted).toBe(1);
    expect(await harness.port.exists(trashUri)).toBe(false);
    expect(
      harness.port.deletedFiles.some((uri) =>
        uri.startsWith(harness.port.originalsRootUri),
      ),
    ).toBe(false);
    await expect(harness.database.getFirst(
      `SELECT local_original_uri FROM device_library_assets
        WHERE plaintext_sha256 = ?`,
      [DIGEST],
    )).resolves.toEqual({ local_original_uri: originalUri });
  });
});
