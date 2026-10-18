jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import type { SqlBindValue, SqlDatabasePort, SqlRunResult } from '@/db/sql-port';
import {
  TEST_ACCOUNT_SCOPE,
  TEST_GENERATION_ID,
  TEST_PREVIEW_GENERATION_ID,
  TEST_THUMBNAIL_GENERATION_ID,
} from '@/features/library/library-actions-test-support';
import type { LibraryChange } from '@/features/library/library-change-feed';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import {
  createLibraryEviction,
  type LibraryEvictionDependencies,
} from '@/features/library/library-eviction';
import {
  createLibraryLocalThumbnails,
  type LibraryLocalThumbnails,
} from '@/features/library/library-local-thumbnails';
import type { LibraryFillDerivedResult } from '@/features/library/library-protect-action';
import {
  createRenderHarness,
  DIGEST,
  ORIGINAL,
  THUMB_BYTES,
  WRONG_ORIGINAL,
  type RenderHarness,
} from '@/features/library/library-render-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

beforeEach(() => {
  resetExpoCryptoDouble();
});

const identity = jest.requireActual('@/features/library/library-identity') as
  typeof import('@/features/library/library-identity');
const { createLibrarySyncRound } = jest.requireActual('@/features/library/library-sync-round') as
  typeof import('@/features/library/library-sync-round');
const { runToEmpty } = jest.requireActual('@/features/library/library-sync-run-to-empty') as
  typeof import('@/features/library/library-sync-run-to-empty');
const { createLibraryMirrorUp } = jest.requireActual('@/features/library/library-mirror-up') as
  typeof import('@/features/library/library-mirror-up');
const { createLibraryProtectAction } = jest.requireActual('@/features/library/library-protect-action') as
  typeof import('@/features/library/library-protect-action');
const D = DIGEST;
const O: string = identity.sha256PlaintextHex(WRONG_ORIGINAL);
const SCOPE = TEST_ACCOUNT_SCOPE;
const GENERATION = TEST_GENERATION_ID;
const OTHER_GENERATION = 'other-original-gen';
const NOW = 777;

let outboxSequence = 0;

/** One evictable asset: a committed, verified, handed-over local original. */
async function seedCandidate(
  h: RenderHarness,
  sha: string,
  bytes: Uint8Array,
  generationId: string,
  ordinal: number,
): Promise<void> {
  await h.actions.seedLocalAsset({ plaintextSha256: sha, bytes });
  await h.actions.seedSourceImage({
    plaintextSha256: sha,
    overrides: {
      download_state: 'mirrored',
      local_uri: null,
      queue_ordinal: ordinal,
      decision_ordinal: ordinal,
    },
  });
  await h.actions.protection.upsertProtection({
    accountScope: SCOPE,
    assetId: h.actions.assetIdFor(sha),
    plaintextSha256: sha,
    lifecycle: 'active',
    protection: 'protected',
    generation: 1,
    revision: 1,
    originalGenerationId: generationId,
    originalCiphertextBytes: 128,
    thumbnailGenerationId: TEST_THUMBNAIL_GENERATION_ID,
    previewGenerationId: TEST_PREVIEW_GENERATION_ID,
    verifiedAt: 1,
    failureCategory: null,
    trashedAt: null,
  });
}

const seedD = (h: RenderHarness) => seedCandidate(h, D, ORIGINAL, GENERATION, 1);
const seedO = (h: RenderHarness) => seedCandidate(h, O, WRONG_ORIGINAL, OTHER_GENERATION, 2);
const EMPTY_TRANSFER = { total: 0, done: 0, failed: 0 } as const;

const sql = (h: RenderHarness, source: string, params: readonly SqlBindValue[] = []) =>
  h.actions.database.run(source, params);

async function insertOutbox(h: RenderHarness, sha: string, kind: string, state: string): Promise<void> {
  outboxSequence += 1;
  await sql(
    h,
    `INSERT INTO library_outbox (
       mutation_id, account_scope, device_id, asset_id, kind, base_revision,
       observed_generation, state, attempt_count, next_attempt_at,
       last_error_code, local_metadata_json, encrypted_payload, created_at, updated_at
     ) VALUES (?, ?, 'device-x', ?, ?, NULL, NULL, ?, 0, NULL, NULL, '{}', NULL, 1, 1)`,
    [
      `eeeeeeee-0000-4000-8000-${String(outboxSequence).padStart(12, '0')}`,
      SCOPE,
      h.actions.assetIdFor(sha),
      kind,
      state,
    ],
  );
}

async function assetOf(h: RenderHarness, sha: string) {
  return h.actions.repository.findLocalAsset(sha);
}

function wrapDatabase(
  database: SqlDatabasePort,
  around: (
    source: string,
    params: readonly SqlBindValue[] | undefined,
    run: () => Promise<SqlRunResult>,
  ) => Promise<SqlRunResult>,
): SqlDatabasePort {
  return {
    exec: (source) => database.exec(source),
    run: (source, params) => around(source, params, () => database.run(source, params)),
    getFirst: (source, params) => database.getFirst(source, params),
    getAll: (source, params) => database.getAll(source, params),
    transaction: (task) => database.transaction(task),
  };
}

type Built = {
  eviction: ReturnType<typeof createLibraryEviction>;
  thumbnails: LibraryLocalThumbnails;
  fillDerived: jest.Mock<Promise<LibraryFillDerivedResult>, [string]>;
  isCloudOnly: jest.Mock<Promise<boolean>, []>;
  heard: LibraryChange[];
};

function build(
  h: RenderHarness,
  over: Partial<LibraryEvictionDependencies> & Readonly<{ derived?: LibraryDerivedImages }> = {},
): Built {
  const heard: LibraryChange[] = [];
  const thumbnails = over.thumbnails as LibraryLocalThumbnails | undefined
    ?? createLibraryLocalThumbnails({
      repository: h.actions.repository,
      files: h.actions.files,
      port: h.actions.port,
      derived: over.derived ?? h.derived,
    });
  const fillDerived = jest.fn(
    async (_sha: string): Promise<LibraryFillDerivedResult> => ({ status: 'complete' }),
  );
  const isCloudOnly = jest.fn(async () => true);
  const { derived: _derived, ...rest } = over;
  const eviction = createLibraryEviction({
    database: h.actions.database,
    files: h.actions.files,
    port: h.actions.port,
    repository: h.actions.repository,
    thumbnails,
    fillDerived,
    isCloudOnly,
    changes: { emit: (change) => { heard.push(change); } },
    clock: () => NOW,
    concurrency: 1,
    ...rest,
  });
  return { eviction, thumbnails, fillDerived, isCloudOnly, heard };
}

describe('library eviction (board #27 S3, spec §5.10, finding 6)', () => {
  let h: RenderHarness;
  let U: string;

  beforeEach(async () => {
    h = await createRenderHarness();
    U = h.actions.originalUriFor(D);
  });

  afterEach(() => {
    h.close();
  });

  it('a row the pass keeps once is evicted by the next round of the same run', async () => {
    await seedD(h);
    await seedO(h);
    const b = build(h);
    b.fillDerived.mockImplementation(async (sha) => (
      sha === D && b.fillDerived.mock.calls.length === 1
        ? { status: 'retry' }
        : { status: 'complete' }
    ));
    const round = createLibrarySyncRound({
      mirrorUp: { mirrorUp: async () => EMPTY_TRANSFER },
      mirrorDown: { mirrorDown: async () => EMPTY_TRANSFER },
      thumbnailPass: { run: async () => EMPTY_TRANSFER },
      eviction: b.eviction,
      isCloudOnly: async () => true,
      getAccountScope: async () => SCOPE,
    });

    const result = await runToEmpty(round, { maxRounds: 20 });
    expect(result).toMatchObject({ rounds: 3, clean: true });
    expect((await assetOf(h, D))?.residency).toBe('cloud-only');
    expect((await assetOf(h, O))?.residency).toBe('cloud-only');
  });

  it('a row adopted at join is verified by mirror-up and then evicted in 仅云端', async () => {
    await seedCandidate(h, D, ORIGINAL, GENERATION, 1);
    await h.actions.protection.upsertProtection({
      accountScope: SCOPE,
      assetId: h.actions.assetIdFor(D),
      plaintextSha256: D,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 1,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: null,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    const action = createLibraryProtectAction(h.actions.protectDependencies);
    const mirrorUp = createLibraryMirrorUp({
      enrollMissing: async () => undefined,
      getAccountScope: async () => SCOPE,
      listProtectCandidates: (scope) => h.actions.protection.listProtectCandidates(scope),
      protect: action.protect,
    });
    const b = build(h);
    const round = createLibrarySyncRound({
      mirrorUp,
      mirrorDown: { mirrorDown: async () => EMPTY_TRANSFER },
      thumbnailPass: { run: async () => EMPTY_TRANSFER },
      eviction: b.eviction,
      isCloudOnly: async () => true,
      getAccountScope: async () => SCOPE,
    });

    await expect(round()).resolves.toEqual({
      up: { total: 1, done: 1, failed: 0 },
      down: { total: 1, done: 1, failed: 0 },
    });
    expect(h.actions.cloud.blobPuts).toEqual([]);
    expect(h.actions.cloud.submitted).toEqual([]);
    expect((await h.actions.protection.findByDigest(SCOPE, D))?.verifiedAt)
      .not.toBeNull();
    const asset = await assetOf(h, D);
    expect(asset?.residency).toBe('cloud-only');
    expect(asset?.localOriginalUri).toBeNull();
    expect(asset?.localThumbnailUri).toBe(h.actions.files.thumbnailUriFor(D, 'webp'));
    expect(h.actions.port.deletedFiles).toContain(U);
  });

  it('a row kept every time does not spin', async () => {
    await seedD(h);
    await seedO(h);
    const b = build(h);
    b.fillDerived.mockImplementation(async (sha) => (
      sha === D ? { status: 'retry' } : { status: 'complete' }
    ));
    const round = createLibrarySyncRound({
      mirrorUp: { mirrorUp: async () => EMPTY_TRANSFER },
      mirrorDown: { mirrorDown: async () => EMPTY_TRANSFER },
      thumbnailPass: { run: async () => EMPTY_TRANSFER },
      eviction: b.eviction,
      isCloudOnly: async () => true,
      getAccountScope: async () => SCOPE,
    });

    const result = await runToEmpty(round, { maxRounds: 20 });

    expect(result).toMatchObject({ rounds: 2, clean: false });
    expect((await assetOf(h, D))?.residency).toBe('local-original');
    expect((await assetOf(h, O))?.residency).toBe('cloud-only');
  });

  it('a row kept alone stops after one round', async () => {
    await seedD(h);
    const b = build(h);
    b.fillDerived.mockResolvedValue({ status: 'retry' });
    const round = createLibrarySyncRound({
      mirrorUp: { mirrorUp: async () => EMPTY_TRANSFER },
      mirrorDown: { mirrorDown: async () => EMPTY_TRANSFER },
      thumbnailPass: { run: async () => EMPTY_TRANSFER },
      eviction: b.eviction,
      isCloudOnly: async () => true,
      getAccountScope: async () => SCOPE,
    });

    const result = await runToEmpty(round, { maxRounds: 20 });

    expect(result).toMatchObject({ rounds: 1, clean: false });
    expect((await assetOf(h, D))?.residency).toBe('local-original');
  });

  it('flips, then deletes, then announces', async () => {
    await seedD(h);
    const deletes: [string, string | undefined][] = [];
    const order: string[] = [];
    const files = {
      originalUriFor: h.actions.files.originalUriFor,
      deleteOriginal: async (uri: string) => {
        deletes.push([uri, (await assetOf(h, D))?.residency]);
        order.push('delete');
        await h.actions.files.deleteOriginal(uri);
      },
    };
    const b = build(h, {
      files,
      changes: { emit: (change) => { order.push(change.kind); } },
    });

    const result = await b.eviction.evict(SCOPE);

    expect(result).toEqual({ reclaimed: 0, evicted: 1, kept: 0 });
    expect(deletes).toEqual([[U, 'cloud-only']]);
    expect(order).toEqual(['delete', 'freed']);
    expect(await assetOf(h, D)).toMatchObject({
      residency: 'cloud-only',
      localOriginalUri: null,
      missingOriginalSince: null,
      localThumbnailUri: h.actions.files.thumbnailUriFor(D, 'webp'),
      updatedAt: NOW,
    });
    expect(h.actions.port.files.has(U)).toBe(false);
  });

  it('announces one freed change naming the digest', async () => {
    await seedD(h);
    const b = build(h);

    await b.eviction.evict(SCOPE);

    expect(b.heard).toEqual([{ kind: 'freed', plaintextSha256: D }]);
  });

  it('a crash between the flip and the delete leaves an orphan the next pass deletes', async () => {
    await seedD(h);
    let failures = 1;
    const files = {
      originalUriFor: h.actions.files.originalUriFor,
      deleteOriginal: async (uri: string) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('disk error');
        }
        await h.actions.files.deleteOriginal(uri);
      },
    };
    const b = build(h, { files });

    expect(await b.eviction.evict(SCOPE)).toEqual({ reclaimed: 0, evicted: 1, kept: 0 });
    expect(h.actions.port.files.has(U)).toBe(true);
    // The row changed when the flip committed: announced even though the
    // delete failed, so no screen keeps the uri the reclaim is about to take.
    expect(b.heard).toEqual([{ kind: 'freed', plaintextSha256: D }]);

    expect(await b.eviction.evict(SCOPE)).toEqual({ reclaimed: 1, evicted: 0, kept: 0 });
    expect(h.actions.port.files.has(U)).toBe(false);
    expect(b.heard).toHaveLength(1);
  });

  it('a reclaim that cannot tell whether a row names the file deletes nothing', async () => {
    await h.actions.seedProjectedAsset({
      plaintextSha256: O,
      protection: 'protected',
      originalGenerationId: OTHER_GENERATION,
    });
    const orphan = h.actions.originalUriFor(O);
    h.actions.port.files.set(orphan, Uint8Array.from([1, 2, 3]));
    const repository = {
      isOriginalNamed: async (): Promise<boolean> => {
        throw new Error('database locked');
      },
    };
    const b = build(h, { repository });

    expect(await b.eviction.evict(SCOPE)).toEqual({ reclaimed: 0, evicted: 0, kept: 0 });
    expect(h.actions.port.files.has(orphan)).toBe(true);
  });

  it('a flip whose file check cannot be answered keeps the file for the next reclaim', async () => {
    await seedD(h);
    const repository = {
      isOriginalNamed: async (): Promise<boolean> => {
        throw new Error('database locked');
      },
    };
    const b = build(h, { repository });

    expect(await b.eviction.evict(SCOPE)).toEqual({ reclaimed: 0, evicted: 1, kept: 0 });
    expect((await assetOf(h, D))?.residency).toBe('cloud-only');
    expect(h.actions.port.files.has(U)).toBe(true);

    expect(await build(h).eviction.evict(SCOPE)).toEqual({ reclaimed: 1, evicted: 0, kept: 0 });
    expect(h.actions.port.files.has(U)).toBe(false);
  });

  it('the orphan goes before anything is evicted', async () => {
    await seedD(h);
    await h.actions.seedProjectedAsset({
      plaintextSha256: O,
      protection: 'protected',
      originalGenerationId: OTHER_GENERATION,
    });
    const orphan = h.actions.originalUriFor(O);
    h.actions.port.files.set(orphan, Uint8Array.from([1, 2, 3]));
    const log: string[] = [];
    const files = {
      originalUriFor: h.actions.files.originalUriFor,
      deleteOriginal: async (uri: string) => {
        log.push(`delete:${uri}`);
        await h.actions.files.deleteOriginal(uri);
      },
    };
    const database = wrapDatabase(h.actions.database, async (source, params, run) => {
      const result = await run();
      if (source.trimStart().startsWith('UPDATE device_library_assets')) {
        log.push(`flip:${String(params?.[1])}`);
      }
      return result;
    });
    const b = build(h, { files, database });

    const result = await b.eviction.evict(SCOPE);

    expect(result).toEqual({ reclaimed: 1, evicted: 1, kept: 0 });
    expect(log).toEqual([`delete:${orphan}`, `flip:${D}`, `delete:${U}`]);
  });

  it('the reclaim only touches a file the listing found', async () => {
    await h.actions.seedProjectedAsset({
      plaintextSha256: O,
      protection: 'protected',
      originalGenerationId: OTHER_GENERATION,
    });
    const stray = `${h.actions.port.originalsRootUri}/stray.jpg`;
    h.actions.port.files.set(stray, Uint8Array.from([5, 5, 5]));
    const deleted: string[] = [];
    const files = {
      originalUriFor: h.actions.files.originalUriFor,
      deleteOriginal: async (uri: string) => {
        deleted.push(uri);
        await h.actions.files.deleteOriginal(uri);
      },
    };
    const b = build(h, { files });

    expect(await b.eviction.evict(SCOPE)).toEqual({ reclaimed: 0, evicted: 0, kept: 0 });
    expect(deleted).toEqual([]);
    expect(h.actions.port.files.has(stray)).toBe(true);
  });

  it('a reclaim goes on past a file it cannot delete', async () => {
    const second = identity.sha256PlaintextHex(Uint8Array.from([8, 8, 8, 8]));
    for (const [sha, generation] of [[O, OTHER_GENERATION], [second, 'second-orphan-gen']] as const) {
      await h.actions.seedProjectedAsset({
        plaintextSha256: sha,
        protection: 'protected',
        originalGenerationId: generation,
      });
      h.actions.port.files.set(h.actions.originalUriFor(sha), Uint8Array.from([1, 2, 3]));
    }
    let failures = 1;
    const files = {
      originalUriFor: h.actions.files.originalUriFor,
      deleteOriginal: async (uri: string) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('disk error');
        }
        await h.actions.files.deleteOriginal(uri);
      },
    };
    const b = build(h, { files });

    expect(await b.eviction.evict(SCOPE)).toEqual({ reclaimed: 1, evicted: 0, kept: 0 });
    const left = [O, second].filter((sha) => h.actions.port.files.has(h.actions.originalUriFor(sha)));
    expect(left).toHaveLength(1);
  });

  it('runs 8 lanes by default', async () => {
    for (let i = 0; i < 10; i += 1) {
      const bytes = Uint8Array.from([100 + i, 1, 2, 3, 4, 5, 6, 7]);
      await seedCandidate(h, identity.sha256PlaintextHex(bytes), bytes, `lane-gen-${i}`, i + 1);
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let running = 0;
    let peak = 0;
    const eviction = createLibraryEviction({
      database: h.actions.database,
      files: h.actions.files,
      port: h.actions.port,
      repository: h.actions.repository,
      thumbnails: { ensureLocalThumbnail: async () => ({ status: 'failed', reason: 'no-source' }) },
      fillDerived: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
        return { status: 'retry' };
      },
      isCloudOnly: async () => true,
      changes: { emit: () => undefined },
    });

    const pass = eviction.evict(SCOPE);
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(peak).toBe(8);
    release();

    expect(await pass).toEqual({ reclaimed: 0, evicted: 0, kept: 10 });
  });

  it('a heal during the reclaim keeps its file', async () => {
    await h.actions.seedProjectedAsset({
      plaintextSha256: O,
      protection: 'protected',
      originalGenerationId: OTHER_GENERATION,
    });
    const orphan = h.actions.originalUriFor(O);
    h.actions.port.files.set(orphan, Uint8Array.from([1, 2, 3]));
    let healed = false;
    // A heal adopts the file after the rows were read and before the check.
    const named = h.actions.repository.isOriginalNamed;
    const repository = {
      isOriginalNamed: async (uri: string) => {
        if (!healed) {
          healed = true;
          await sql(
            h,
            `UPDATE device_library_assets
                SET residency = 'local-original', local_original_uri = ?
              WHERE plaintext_sha256 = ?`,
            [orphan, O],
          );
        }
        return named(uri);
      },
    };
    const b = build(h, { repository });

    const result = await b.eviction.evict(SCOPE);

    expect(result).toEqual({ reclaimed: 0, evicted: 0, kept: 0 });
    expect(h.actions.port.files.has(orphan)).toBe(true);
  });

  // Each variant differs from the evictable baseline by exactly one change.
  // The SELECT excludes the row (`kept: 0`); a candidate condition dropped
  // there leaves the flip to refuse, which answers `kept: 1` instead.
  const excluded: readonly (readonly [string, (x: RenderHarness) => Promise<void>])[] = [
    ['(a) the image is still ready', (x) => sql(x, "UPDATE images SET download_state = 'ready'").then(() => undefined)],
    ['(b) not verified', (x) => sql(x, 'UPDATE library_asset_protection SET verified_at = NULL').then(() => undefined)],
    ['(c) protection pending', (x) => sql(x, "UPDATE library_asset_protection SET protection = 'pending'").then(() => undefined)],
    ['(d) lifecycle trash', (x) => sql(x, "UPDATE library_asset_protection SET lifecycle = 'trash'").then(() => undefined)],
    ['(e) flagged missing', (x) => sql(x, 'UPDATE device_library_assets SET missing_original_since = 5').then(() => undefined)],
    ['(f) device-trashed', (x) => sql(
      x,
      `INSERT INTO library_device_asset_state (plaintext_sha256, device_trashed_at, updated_at)
       VALUES (?, 5, 5)`,
      [D],
    ).then(() => undefined)],
    ['(g) a trash intent sending', (x) => insertOutbox(x, D, 'trash', 'sending')],
    ['(l) a stop-protection intent pending', (x) => insertOutbox(x, D, 'stop-protection', 'pending')],
    ['(m) no original generation', (x) => sql(x, 'UPDATE library_asset_protection SET original_generation_id = NULL').then(() => undefined)],
    ['(n) residency cached', (x) => sql(x, "UPDATE device_library_assets SET residency = 'cached'").then(() => undefined)],
    ['(o) no local original uri', (x) => sql(x, 'UPDATE device_library_assets SET local_original_uri = NULL').then(() => undefined)],
    ['(q) the projection is under another account', (x) => sql(x, "UPDATE library_asset_protection SET account_scope = 'scope-B'").then(() => undefined)],
  ];
  it.each(excluded)('is not listed, untouched: %s', async (_name, change) => {
    await seedD(h);
    await change(h);
    const before = await assetOf(h, D);
    const b = build(h);

    const result = await b.eviction.evict(SCOPE);

    expect(result).toEqual({ reclaimed: 0, evicted: 0, kept: 0 });
    expect(await assetOf(h, D)).toEqual(before);
    expect(h.actions.port.files.has(U)).toBe(true);
    expect(b.heard).toEqual([]);
  });

  const keptCases: readonly (readonly [
    string,
    (b: Built, x: RenderHarness) => void,
    Partial<LibraryEvictionDependencies> & Readonly<{ derived?: LibraryDerivedImages }>,
  ])[] = [
    ['(h) fillDerived answers retry', (b) => b.fillDerived.mockResolvedValue({ status: 'retry' }), {}],
    ['(i) the local thumbnail cannot be made', () => undefined, {
      derived: {
        derive: async () => ({ thumbnail: null, preview: null, animated: false, failed: true }),
      },
    }],
    ['(p) a named thumbnail whose check cannot be answered', () => undefined, {
      thumbnails: { ensureLocalThumbnail: async () => ({ status: 'failed', reason: 'unchecked' }) },
    }],
    ['(j) the mode is back to both', (b) => b.isCloudOnly.mockResolvedValue(false), {}],
    ['(k) the mode read rejects', (b) => b.isCloudOnly.mockRejectedValue(new Error('kv')), {}],
  ];
  it.each(keptCases)('is kept, untouched: %s', async (_name, arrange, over) => {
    await seedD(h);
    if (_name.startsWith('(p)')) {
      // The row already names a thumbnail: only the ensure answer can keep it.
      await sql(h, 'UPDATE device_library_assets SET local_thumbnail_uri = ?', [
        h.actions.files.thumbnailUriFor(D, 'webp'),
      ]);
    }
    const before = await assetOf(h, D);
    const b = build(h, over);
    arrange(b, h);

    const result = await b.eviction.evict(SCOPE);

    expect(result).toEqual({ reclaimed: 0, evicted: 0, kept: 1 });
    expect(await assetOf(h, D)).toEqual(before);
    expect(h.actions.port.files.has(U)).toBe(true);
    expect(b.heard).toEqual([]);
    if (_name.startsWith('(j)')) expect(b.fillDerived).not.toHaveBeenCalled();
  });

  // The change lands after the listing, while the row is being prepared; the
  // flip's own conditions are the last word.
  type Change = Readonly<{
    name: string;
    /** Set up before the pass, so the thumbnail already exists. */
    preEnsure?: boolean;
    /** Run after `ensureLocalThumbnail` answers instead of inside `fillDerived`. */
    afterEnsure?: boolean;
    change: (x: RenderHarness) => Promise<void>;
  }>;
  const flipChanges: readonly Change[] = [
    { name: '(a) the image becomes ready', change: (x) => sql(x, "UPDATE images SET download_state = 'ready'").then(() => undefined) },
    { name: '(b) lifecycle becomes trash', change: (x) => sql(x, "UPDATE library_asset_protection SET lifecycle = 'trash'").then(() => undefined) },
    {
      name: '(c) the original is re-pointed',
      change: async (x) => {
        const other = `${x.actions.port.originalsRootUri}/re-pointed.jpg`;
        x.actions.port.files.set(other, Uint8Array.from([4, 4, 4]));
        await sql(x, 'UPDATE device_library_assets SET local_original_uri = ?', [other]);
      },
    },
    {
      name: '(d) the row is flagged missing',
      preEnsure: true,
      change: (x) => sql(x, 'UPDATE device_library_assets SET missing_original_since = 5').then(() => undefined),
    },
    {
      name: '(e) the thumbnail name is cleared',
      afterEnsure: true,
      change: (x) => sql(x, 'UPDATE device_library_assets SET local_thumbnail_uri = NULL').then(() => undefined),
    },
    { name: '(f) a stop-protection intent is sending', change: (x) => insertOutbox(x, D, 'stop-protection', 'sending') },
    {
      name: '(g) the asset is device-trashed',
      change: (x) => sql(
        x,
        `INSERT INTO library_device_asset_state (plaintext_sha256, device_trashed_at, updated_at)
         VALUES (?, 5, 5)`,
        [D],
      ).then(() => undefined),
    },
    { name: '(h) protection becomes unprotected', change: (x) => sql(x, "UPDATE library_asset_protection SET protection = 'unprotected'").then(() => undefined) },
    { name: '(i) verification is cleared', change: (x) => sql(x, 'UPDATE library_asset_protection SET verified_at = NULL').then(() => undefined) },
    { name: '(j) the original generation is cleared', change: (x) => sql(x, 'UPDATE library_asset_protection SET original_generation_id = NULL').then(() => undefined) },
    { name: '(k) the projection moves to another account', change: (x) => sql(x, "UPDATE library_asset_protection SET account_scope = 'scope-B'").then(() => undefined) },
    { name: '(l) a stop-protection intent is pending', change: (x) => insertOutbox(x, D, 'stop-protection', 'pending') },
    { name: '(o) residency becomes cached, the uri kept', preEnsure: true, change: (x) => sql(x, "UPDATE device_library_assets SET residency = 'cached'").then(() => undefined) },
    { name: '(n) a trash intent is sending', change: (x) => insertOutbox(x, D, 'trash', 'sending') },
    {
      name: '(m) the projection is adopted as stopped',
      change: (x) => x.actions.protection.upsertProtection({
        accountScope: SCOPE,
        assetId: x.actions.assetIdFor(D),
        plaintextSha256: D,
        lifecycle: 'active',
        protection: 'unprotected',
        generation: 1,
        revision: 1,
        originalGenerationId: null,
        originalCiphertextBytes: null,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        failureCategory: null,
        trashedAt: null,
      }),
    },
  ];
  it.each(flipChanges.map((c) => [c.name, c] as const))(
    'a row that changes before the flip is kept: %s',
    async (_name, variant) => {
      await seedD(h);
      const plain = build(h);
      if (variant.preEnsure === true) {
        expect((await plain.thumbnails.ensureLocalThumbnail(D)).status).toBe('ensured');
      }
      const thumbnails: LibraryLocalThumbnails = {
        ensureLocalThumbnail: async (sha) => {
          const result = await plain.thumbnails.ensureLocalThumbnail(sha);
          if (variant.afterEnsure === true) await variant.change(h);
          return result;
        },
      };
      const b = build(h, { thumbnails });
      if (variant.afterEnsure !== true) {
        b.fillDerived.mockImplementation(async () => {
          await variant.change(h);
          return { status: 'complete' };
        });
      }

      const result = await b.eviction.evict(SCOPE);

      expect(result).toEqual({ reclaimed: 0, evicted: 0, kept: 1 });
      expect(b.heard).toEqual([]);
      expect(h.actions.port.files.has(U)).toBe(true);
      expect((await assetOf(h, D))?.residency).toBe(
        variant.name.startsWith('(o)') ? 'cached' : 'local-original',
      );
    },
  );

  it('unfillable still evicts', async () => {
    await seedD(h);
    const b = build(h);
    b.fillDerived.mockResolvedValue({ status: 'unfillable' });

    expect(await b.eviction.evict(SCOPE)).toEqual({ reclaimed: 0, evicted: 1, kept: 0 });
  });

  it('a switch back mid-pass stops it', async () => {
    await seedD(h);
    await seedO(h);
    await sql(h, 'UPDATE device_library_assets SET created_at = 2 WHERE plaintext_sha256 = ?', [O]);
    await sql(h, 'UPDATE device_library_assets SET created_at = 1 WHERE plaintext_sha256 = ?', [D]);
    const b = build(h);
    const answers = [true, true, false];
    b.isCloudOnly.mockImplementation(async () => answers.shift() ?? false);

    const result = await b.eviction.evict(SCOPE);

    expect(result).toEqual({ reclaimed: 0, evicted: 1, kept: 1 });
    expect(b.fillDerived).toHaveBeenCalledTimes(1);
    expect(b.fillDerived).toHaveBeenCalledWith(D);
    expect((await assetOf(h, D))?.residency).toBe('cloud-only');
    expect((await assetOf(h, O))?.residency).toBe('local-original');
  });

  it('a switch back during the work keeps the original', async () => {
    await seedD(h);
    const b = build(h);
    const answers = [true, false];
    b.isCloudOnly.mockImplementation(async () => answers.shift() ?? false);

    const result = await b.eviction.evict(SCOPE);

    expect(result).toEqual({ reclaimed: 0, evicted: 0, kept: 1 });
    expect((await assetOf(h, D))?.residency).toBe('local-original');
    expect(h.actions.port.files.has(U)).toBe(true);
    expect(b.heard).toEqual([]);
  });

  it('a heal between the flip and the delete keeps the file', async () => {
    await seedD(h);
    const database = wrapDatabase(h.actions.database, async (source, _params, run) => {
      const result = await run();
      if (source.trimStart().startsWith('UPDATE device_library_assets')) {
        await sql(
          h,
          `UPDATE device_library_assets
              SET residency = 'local-original', local_original_uri = ?
            WHERE plaintext_sha256 = ?`,
          [U, D],
        );
      }
      return result;
    });
    const b = build(h, { database });

    const result = await b.eviction.evict(SCOPE);

    expect(result).toEqual({ reclaimed: 0, evicted: 1, kept: 0 });
    expect(h.actions.port.files.has(U)).toBe(true);
  });

  it('a failed originals listing still evicts', async () => {
    await seedD(h);
    const port = {
      listOriginals: async (): Promise<string[]> => {
        throw new Error('listing failed');
      },
    };
    const b = build(h, { port });

    expect(await b.eviction.evict(SCOPE)).toEqual({ reclaimed: 0, evicted: 1, kept: 0 });
  });

  it("the thumbnail is the local original's", async () => {
    await seedD(h);
    const b = build(h);

    await b.eviction.evict(SCOPE);

    expect(h.deriveCalls[0]).toMatchObject({ sourceUri: U, roles: ['thumbnail'] });
    const named = (await assetOf(h, D))?.localThumbnailUri;
    expect(named).toBe(h.actions.files.thumbnailUriFor(D, 'webp'));
    expect([...h.actions.port.files.get(named!)!]).toEqual([...THUMB_BYTES]);
  });

  it('N6-A2 (spec §4.9): refuses to evict legacy/provider over-cap rows (protect_eligible=0 or byte_size > 67,108,768) and rows with stale authority', async () => {
    await seedD(h);
    // 1. protect_eligible = 0 is excluded at candidate selection
    await sql(
      h,
      'UPDATE device_library_assets SET protect_eligible = 0 WHERE plaintext_sha256 = ?',
      [D],
    );
    expect(await build(h).eviction.evict(SCOPE)).toEqual({
      reclaimed: 0,
      evicted: 0,
      kept: 0,
    });
    expect(h.actions.port.files.has(U)).toBe(true);

    // 2. Abnormal row with protect_eligible = 1 but byte_size = 67,108,769 is
    // also excluded at candidate selection and flip
    await sql(
      h,
      'UPDATE device_library_assets SET protect_eligible = 1, byte_size = 67108769 WHERE plaintext_sha256 = ?',
      [D],
    );
    expect(await build(h).eviction.evict(SCOPE)).toEqual({
      reclaimed: 0,
      evicted: 0,
      kept: 0,
    });
    expect(h.actions.port.files.has(U)).toBe(true);

    // 3. Stale authority (`isAuthorityCurrent` returning false) keeps the
    // eligible row without evicting
    await sql(
      h,
      'UPDATE device_library_assets SET byte_size = 1024 WHERE plaintext_sha256 = ?',
      [D],
    );
    const staleEviction = build(h, {
      isAuthorityCurrent: async () => false,
    });
    expect(await staleEviction.eviction.evict(SCOPE)).toEqual({
      reclaimed: 0,
      evicted: 0,
      kept: 1,
    });
    expect((await assetOf(h, D))?.residency).toBe('local-original');
    expect(h.actions.port.files.has(U)).toBe(true);
  });
});
