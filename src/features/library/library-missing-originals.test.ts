import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryChange } from '@/features/library/library-change-feed';
import { createLibraryMissingOriginals } from '@/features/library/library-missing-originals';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import { createLibraryTestHarness } from '@/features/library/library-test-support';

/** `plaintext_sha256 → missing_original_since` for every device row. */
async function flags(
  database: SqlDatabasePort,
): Promise<Record<string, number | null>> {
  const rows = await database.getAll<{
    plaintext_sha256: string;
    missing_original_since: number | null;
  }>(
    `SELECT plaintext_sha256, missing_original_since
       FROM device_library_assets`,
  );
  return Object.fromEntries(
    rows.map((row) => [row.plaintext_sha256, row.missing_original_since]),
  );
}

async function insertDeviceRow(
  database: SqlDatabasePort,
  digest: string,
  input: Readonly<{
    residency: 'local-original' | 'cloud-only';
    uri: string | null;
    missingOriginalSince: number | null;
    updatedAt: number;
  }>,
): Promise<void> {
  await database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width, height,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       missing_original_since, created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, ?, ?, 1, ?, 1, ?)`,
    [
      digest,
      input.uri,
      input.residency,
      input.missingOriginalSince,
      input.updatedAt,
    ],
  );
}

describe('noteMissingOriginals', () => {
  it('flags only a local-original row whose file is gone, once, and announces it', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const present = 'a'.repeat(64);
      const gone = 'b'.repeat(64);
      const flagged = 'c'.repeat(64);
      const cloudOnly = 'd'.repeat(64);
      const presentUri = `file:///data/library/originals/${present}.jpg`;
      const goneUri = `file:///data/library/originals/${gone}.jpg`;
      const flaggedUri = `file:///data/library/originals/${flagged}.jpg`;
      harness.port.files.set(presentUri, Uint8Array.from([1, 2, 3]));
      await insertDeviceRow(harness.database, present, {
        residency: 'local-original',
        uri: presentUri,
        missingOriginalSince: null,
        updatedAt: 1,
      });
      await insertDeviceRow(harness.database, gone, {
        residency: 'local-original',
        uri: goneUri,
        missingOriginalSince: null,
        updatedAt: 1,
      });
      await insertDeviceRow(harness.database, flagged, {
        residency: 'local-original',
        uri: flaggedUri,
        missingOriginalSince: 3,
        updatedAt: 1,
      });
      await insertDeviceRow(harness.database, cloudOnly, {
        residency: 'cloud-only',
        uri: null,
        missingOriginalSince: null,
        updatedAt: 1,
      });
      const heard: LibraryChange[] = [];
      const missing = createLibraryMissingOriginals({
        database: harness.database,
        files: harness.port,
        changes: { emit: (change) => { heard.push(change); } },
        clock: () => 50,
      });

      await expect(missing.noteMissingOriginals()).resolves.toBe(1);
      await expect(missing.noteMissingOriginals()).resolves.toBe(0);
      await expect(flags(harness.database)).resolves.toEqual({
        [present]: null,
        [gone]: 50,
        [cloudOnly]: null,
        [flagged]: 3,
      });
      expect(heard).toEqual([{ kind: 'original-missing', plaintextSha256: gone }]);
    } finally {
      harness.close();
    }
  });

  it('the pass reads the originals by name and never lists entries', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const present1 = 'f'.repeat(64);
      const present2 = '1'.repeat(64);
      const missing = '2'.repeat(64);
      const presentUri1 = `file:///data/library/originals/${present1}.jpg`;
      const presentUri2 = `file:///data/library/originals/${present2}.jpg`;
      const missingUri = `file:///data/library/originals/${missing}.jpg`;
      for (const [digest, uri] of [
        [present1, presentUri1],
        [present2, presentUri2],
        [missing, missingUri],
      ]) {
        await insertDeviceRow(harness.database, digest, {
          residency: 'local-original',
          uri,
          missingOriginalSince: null,
          updatedAt: 1,
        });
      }

      let listCalls = 0;
      const probed: string[] = [];
      const missingOriginals = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          ...harness.port,
          originalsRootUri: harness.port.originalsRootUri,
          ...{
            async listOriginals() {
              throw new Error('the pass must not list entries');
            },
            async listOriginalNames() {
              listCalls += 1;
              return [`${present1}.jpg`, `${present2}.jpg`];
            },
            async probe(uri: string) {
              probed.push(uri);
              return 'absent' as const;
            },
          },
        },
        changes: { emit() {} },
        clock: () => 50,
      });

      await expect(missingOriginals.noteMissingOriginals()).resolves.toBe(1);
      expect(listCalls).toBe(1);
      // A per-row check of every candidate is the cost the listing replaced.
      expect(probed).toEqual([missingUri]);
      await expect(flags(harness.database)).resolves.toEqual({
        [present1]: null,
        [present2]: null,
        [missing]: 50,
      });
    } finally {
      harness.close();
    }
  });

  it('a row inside the directory whose name is missing is kept when probe says present', async () => {
    // A listing that comes back short — a uri-form mismatch, or a directory
    // read that failed while single paths still resolve — costs a probe per
    // row the listing misses, never a flag on a file that is still there.
    const harness = await createLibraryTestHarness();
    try {
      const first = '4'.repeat(64);
      const second = '5'.repeat(64);
      for (const digest of [first, second]) {
        const uri = `file:///data/library/originals/${digest}.jpg`;
        harness.port.files.set(uri, Uint8Array.from([1]));
        await insertDeviceRow(harness.database, digest, {
          residency: 'local-original',
          uri,
          missingOriginalSince: null,
          updatedAt: 1,
        });
      }
      const missingOriginals = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          originalsRootUri: harness.port.originalsRootUri,
          async listOriginalNames(): Promise<string[]> {
            return [];
          },
          probe: (uri: string) => harness.port.probe(uri),
        },
        changes: {
          emit() {
            throw new Error('a file that is still there must not be announced');
          },
        },
        clock: () => 50,
      });

      await expect(missingOriginals.noteMissingOriginals()).resolves.toBe(0);
      await expect(flags(harness.database)).resolves.toEqual({
        [first]: null,
        [second]: null,
      });
    } finally {
      harness.close();
    }
  });

  it('a row inside the directory whose name is missing is flagged when probe says absent', async () => {
    // A restore brings back device rows whose originals the delete removed:
    // the directory lists as empty and every row is flagged, once, with its
    // own announcement (S1a leg 4, check 4.9).
    const harness = await createLibraryTestHarness();
    try {
      const digests = ['9'.repeat(64), 'a1'.repeat(32), 'b2'.repeat(32)];
      for (const digest of digests) {
        await insertDeviceRow(harness.database, digest, {
          residency: 'local-original',
          uri: `file:///data/library/originals/${digest}.jpg`,
          missingOriginalSince: null,
          updatedAt: 1,
        });
      }
      const heard: LibraryChange[] = [];
      const missingOriginals = createLibraryMissingOriginals({
        database: harness.database,
        files: harness.port,
        changes: { emit: (change) => { heard.push(change); } },
        clock: () => 50,
      });

      await expect(missingOriginals.noteMissingOriginals()).resolves.toBe(3);
      await expect(flags(harness.database)).resolves.toEqual(
        Object.fromEntries(digests.map((digest) => [digest, 50])),
      );
      expect(heard).toEqual(
        [...digests].sort().map((digest) => ({
          kind: 'original-missing',
          plaintextSha256: digest,
        })),
      );
    } finally {
      harness.close();
    }
  });

  it('a row inside the directory whose name is missing is kept when probe throws', async () => {
    // Out of file descriptors, expo's `exists` answers "absent" rather than
    // failing (it resolves the path with canonicalPath, which opens it, and
    // reads the failure as "no permission"); the probe throws instead. A
    // window that closes mid-pass must not flag the rows probed inside it.
    const harness = await createLibraryTestHarness();
    try {
      const inWindow1 = '6'.repeat(64);
      const inWindow2 = '7'.repeat(64);
      const gone = '8'.repeat(64);
      for (const digest of [inWindow1, inWindow2, gone]) {
        const uri = `file:///data/library/originals/${digest}.jpg`;
        if (digest !== gone) harness.port.files.set(uri, Uint8Array.from([1]));
        await insertDeviceRow(harness.database, digest, {
          residency: 'local-original',
          uri,
          missingOriginalSince: null,
          updatedAt: 1,
        });
      }
      const heard: LibraryChange[] = [];
      let failuresLeft = 2;
      const missingOriginals = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          originalsRootUri: harness.port.originalsRootUri,
          // The directory read failed too, so every row is probed.
          async listOriginalNames(): Promise<string[]> {
            return [];
          },
          async probe(uri: string) {
            // Rows are probed in digest order: the window covers the first two.
            if (failuresLeft > 0) {
              failuresLeft -= 1;
              throw new Error('Missing READ permission');
            }
            return harness.port.probe(uri);
          },
        },
        changes: { emit: (change) => { heard.push(change); } },
        clock: () => 50,
      });

      await expect(missingOriginals.noteMissingOriginals()).resolves.toBe(1);
      await expect(flags(harness.database)).resolves.toEqual({
        [inWindow1]: null,
        [inWindow2]: null,
        [gone]: 50,
      });
      expect(heard).toEqual([{ kind: 'original-missing', plaintextSha256: gone }]);
    } finally {
      harness.close();
    }
  });

  it('a listing that rejects flags nothing', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const digest = '3'.repeat(64);
      const uri = `file:///data/library/originals/${digest}.jpg`;
      await insertDeviceRow(harness.database, digest, {
        residency: 'local-original',
        uri,
        missingOriginalSince: null,
        updatedAt: 1,
      });

      let probeCalls = 0;
      const missingOriginals = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          originalsRootUri: harness.port.originalsRootUri,
          async listOriginalNames(): Promise<string[]> {
            throw new Error('storage unavailable');
          },
          // The file really is gone: only the listing error keeps the flag
          // off, so treating that error as an empty listing flags the row.
          async probe() {
            probeCalls += 1;
            return 'absent' as const;
          },
        },
        changes: { emit() {} },
        clock: () => 50,
      });

      await expect(missingOriginals.noteMissingOriginals()).resolves.toBe(0);
      expect(probeCalls).toBe(0);
      await expect(flags(harness.database)).resolves.toEqual({ [digest]: null });
    } finally {
      harness.close();
    }
  });

  it('a download that lands at the same uri mid-pass keeps its row', async () => {
    // Originals are content-addressed (`<sha>.<ext>`), so a download or a heal
    // rewrites the row at the SAME uri; only `updated_at` tells the pass the
    // row moved on after the SELECT.
    const harness = await createLibraryTestHarness();
    try {
      const digest = 'd'.repeat(64);
      const uri = `file:///data/library/originals/${digest}.jpg`;
      await insertDeviceRow(harness.database, digest, {
        residency: 'local-original',
        uri,
        missingOriginalSince: null,
        updatedAt: 1_000,
      });
      const missing = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          originalsRootUri: harness.port.originalsRootUri,
          async listOriginalNames() {
            return [];
          },
          // The probe misses the file, then the download lands before the
          // UPDATE: only the row's new `updated_at` can stop the flag.
          async probe() {
            await createLibraryProtectionRepository({
              database: harness.database,
              clock: () => 2_000,
            }).setResidency(digest, 'local-original', uri);
            return 'absent' as const;
          },
        },
        changes: {
          emit() {
            throw new Error('a row rewritten since the SELECT must not announce');
          },
        },
        clock: () => 50,
      });

      await expect(missing.noteMissingOriginals()).resolves.toBe(0);
      await expect(flags(harness.database)).resolves.toEqual({ [digest]: null });
    } finally {
      harness.close();
    }
  });

  it('no candidate rows, no listing', async () => {
    const harness = await createLibraryTestHarness();
    try {
      let listCalls = 0;
      const missing = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          originalsRootUri: harness.port.originalsRootUri,
          async listOriginalNames() {
            listCalls += 1;
            return [];
          },
          async probe(): Promise<'present' | 'absent'> {
            throw new Error('no candidate row, nothing to probe');
          },
        },
        changes: { emit() {} },
        clock: () => 50,
      });

      await expect(missing.noteMissingOriginals()).resolves.toBe(0);
      expect(listCalls).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('a row rewritten after the SELECT keeps its state', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const digest = 'e'.repeat(64);
      const uri = `file:///data/library/originals/${digest}.jpg`;
      const landedUri = `file:///data/library/originals/${digest}-landed.jpg`;
      await insertDeviceRow(harness.database, digest, {
        residency: 'local-original',
        uri,
        missingOriginalSince: null,
        updatedAt: 1_000,
      });
      const missing = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          originalsRootUri: harness.port.originalsRootUri,
          // A download lands between the SELECT and the listing: the row's
          // uri and updated_at move on before the loop reaches it, so the
          // listing's stale view of the row must not win the race.
          async listOriginalNames() {
            await createLibraryProtectionRepository({
              database: harness.database,
              clock: () => 2_000,
            }).setResidency(digest, 'local-original', landedUri);
            return [];
          },
          async probe() {
            return 'absent' as const;
          },
        },
        changes: {
          emit() {
            throw new Error('a row that moved since the SELECT must not announce');
          },
        },
        clock: () => 50,
      });

      await expect(missing.noteMissingOriginals()).resolves.toBe(0);
      await expect(flags(harness.database)).resolves.toEqual({ [digest]: null });
    } finally {
      harness.close();
    }
  });

  it('a row outside the originals directory is absent without a probe', async () => {
    // Board #27 S1b Task 2 (spec R25): a restore brings the rows back
    // verbatim, so a backup exported under Android user 10 names user 10's
    // path. On the device `File.info()` throws on that path every time (the
    // permission check never passes), so a pass that probed it would never
    // flag it and mirror-down would never re-fetch it.
    const harness = await createLibraryTestHarness();
    try {
      const own = '0a'.repeat(32);
      const foreign = '0b'.repeat(32);
      const ownUri = `file:///data/library/originals/${own}.jpg`;
      const foreignUri =
        'file:///data/user/10/app.waifudeck.mobile/files/library/originals/'
        + foreign + '.jpg';
      harness.port.files.set(ownUri, Uint8Array.from([1]));
      for (const [digest, uri] of [
        [own, ownUri],
        [foreign, foreignUri],
      ]) {
        await insertDeviceRow(harness.database, digest, {
          residency: 'local-original',
          uri,
          missingOriginalSince: null,
          updatedAt: 1,
        });
      }
      const probed: string[] = [];
      const probe = async (uri: string): Promise<'present' | 'absent'> => {
        probed.push(uri);
        if (uri === foreignUri) throw new Error('Missing READ permission');
        return harness.port.probe(uri);
      };
      const heard: LibraryChange[] = [];
      const missing = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          ...harness.port,
          async listOriginalNames() {
            return [`${own}.jpg`, `${foreign}.jpg`];
          },
          probe,
        },
        changes: { emit: (change) => { heard.push(change); } },
        clock: () => 50,
      });

      await expect(missing.noteMissingOriginals()).resolves.toBe(1);
      await expect(flags(harness.database)).resolves.toEqual({
        [own]: null,
        [foreign]: 50,
      });
      expect(heard).toEqual([
        { kind: 'original-missing', plaintextSha256: foreign },
      ]);
      expect(probed).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it('an equivalent-form path is probed, never flagged by the directory rule', async () => {
    // On Android `/data/data/<pkg>/` is user 0's `/data/user/0/<pkg>/`: a row
    // stored in the other form still names this device's directory, so only
    // a checked "absent" may flag it.
    const harness = await createLibraryTestHarness();
    try {
      const R = 'file:///data/user/0/app.waifudeck.mobile/files/library/originals';
      const d = '0c'.repeat(32);
      const uri =
        'file:///data/data/app.waifudeck.mobile/files/library/originals/'
        + d + '.jpg';
      await insertDeviceRow(harness.database, d, {
        residency: 'local-original',
        uri,
        missingOriginalSince: null,
        updatedAt: 1,
      });
      const probed: string[] = [];
      const probe = async (probedUri: string): Promise<'present' | 'absent'> => {
        probed.push(probedUri);
        return 'present';
      };
      const missing = createLibraryMissingOriginals({
        database: harness.database,
        files: { originalsRootUri: R, listOriginalNames: async () => [], probe },
        changes: { emit() {} },
        clock: () => 50,
      });

      await expect(missing.noteMissingOriginals()).resolves.toBe(0);
      await expect(flags(harness.database)).resolves.toEqual({ [d]: null });
      expect(probed).toEqual([uri]);
    } finally {
      harness.close();
    }
  });

  it('a listed original inside the directory is never probed', async () => {
    // A listed name is present only for a row whose uri is inside this
    // device's originals directory.
    const harness = await createLibraryTestHarness();
    try {
      const d = '0d'.repeat(32);
      const uri = `file:///data/library/originals/${d}.jpg`;
      await insertDeviceRow(harness.database, d, {
        residency: 'local-original',
        uri,
        missingOriginalSince: null,
        updatedAt: 1,
      });
      const probed: string[] = [];
      const probe = async (probedUri: string): Promise<'present' | 'absent'> => {
        probed.push(probedUri);
        return 'present';
      };
      const missing = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          originalsRootUri: 'file:///data/library/originals/',
          listOriginalNames: async () => [`${d}.jpg`],
          probe,
        },
        changes: { emit() {} },
        clock: () => 50,
      });

      await expect(missing.noteMissingOriginals()).resolves.toBe(0);
      await expect(flags(harness.database)).resolves.toEqual({ [d]: null });
      expect(probed).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("a foreign row re-pointed to this device's path mid-pass keeps its state", async () => {
    // Board #27 S1b Task 3: the heal (or mirror-down) re-points a foreign
    // row at this device's path. The foreign branch flags through the same
    // guarded UPDATE as a probed row, so the re-pointed row keeps its state.
    const harness = await createLibraryTestHarness();
    try {
      const d = '0e'.repeat(32);
      const foreignUri =
        'file:///data/user/10/app.waifudeck.mobile/files/library/originals/'
        + d + '.jpg';
      const ownUri = `${harness.port.originalsRootUri}/${d}.jpg`;
      await insertDeviceRow(harness.database, d, {
        residency: 'local-original',
        uri: foreignUri,
        missingOriginalSince: null,
        updatedAt: 1_000,
      });
      const missing = createLibraryMissingOriginals({
        database: harness.database,
        files: {
          originalsRootUri: harness.port.originalsRootUri,
          async listOriginalNames() {
            await createLibraryProtectionRepository({
              database: harness.database,
              clock: () => 2_000,
            }).setResidency(d, 'local-original', ownUri);
            return [];
          },
          async probe() {
            return 'absent' as const;
          },
        },
        changes: {
          emit() {
            throw new Error('a row re-pointed since the SELECT must not announce');
          },
        },
        clock: () => 50,
      });

      await expect(missing.noteMissingOriginals()).resolves.toBe(0);
      await expect(flags(harness.database)).resolves.toEqual({ [d]: null });
    } finally {
      harness.close();
    }
  });
});
