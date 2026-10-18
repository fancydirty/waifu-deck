jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import type {
  LibraryLocalThumbnails,
  LocalThumbnailResult,
} from '@/features/library/library-local-thumbnails';
import { createLibraryThumbnailPass } from '@/features/library/library-thumbnail-pass';

const sha = (tag: string) => tag.padEnd(64, '0');
const C1 = sha('c1');
const C2 = sha('c2');
const F = sha('f0');
const N = sha('a1');
const L = sha('a2');
const T = sha('a3');
const P = sha('a4');
const D = sha('a5');
const X = sha('a6');
const G = sha('a7');

const ENSURED: LocalThumbnailResult = { status: 'ensured', uri: 'file:///t.webp', source: 'cloud-thumbnail' };
const UNSUPPORTED: LocalThumbnailResult = { status: 'failed', reason: 'cloud', category: 'unsupported_image' };

type SeedOptions = Readonly<{
  createdAt: number;
  residency?: 'cloud-only' | 'local-original';
  flagged?: boolean;
  thumbnailUri?: string | null;
  lifecycle?: 'active' | 'trash';
  protection?: 'protected' | 'pending';
  deviceTrashed?: boolean;
  otherScope?: boolean;
  noOriginalGeneration?: boolean;
}>;

function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('createLibraryThumbnailPass', () => {
  let h: ActionsHarness;

  beforeEach(async () => {
    h = await createActionsHarness();
  });

  afterEach(() => {
    h.close();
  });

  async function seed(digest: string, o: SeedOptions): Promise<void> {
    await h.seedProjectedAsset({
      plaintextSha256: digest,
      protection: 'protected',
      originalGenerationId: `orig-${digest.slice(0, 4)}`,
    });
    const residency = o.residency ?? 'cloud-only';
    await h.database.run(
      `UPDATE device_library_assets
          SET created_at = ?, residency = ?, local_original_uri = ?,
              missing_original_since = ?, local_thumbnail_uri = ?
        WHERE plaintext_sha256 = ?`,
      [
        o.createdAt,
        residency,
        residency === 'local-original' ? `file:///data/library/originals/${digest}.jpg` : null,
        o.flagged === true ? 1 : null,
        o.thumbnailUri ?? null,
        digest,
      ],
    );
    await h.database.run(
      `UPDATE library_asset_protection
          SET lifecycle = ?, protection = ?, account_scope = ?
        WHERE plaintext_sha256 = ?`,
      [
        o.lifecycle ?? 'active',
        o.protection ?? 'protected',
        o.otherScope === true ? 'scope-other' : TEST_ACCOUNT_SCOPE,
        digest,
      ],
    );
    if (o.noOriginalGeneration === true) {
      await h.database.run(
        'UPDATE library_asset_protection SET original_generation_id = NULL WHERE plaintext_sha256 = ?',
        [digest],
      );
    }
    if (o.deviceTrashed === true) {
      await h.database.run(
        `INSERT INTO library_device_asset_state (plaintext_sha256, device_trashed_at, updated_at)
         VALUES (?, 5, 5)`,
        [digest],
      );
    }
  }

  function passWith(
    ensure: (digest: string) => Promise<LocalThumbnailResult>,
    concurrency?: number,
  ) {
    const ensureLocalThumbnail = jest.fn(ensure);
    const thumbnails: Pick<LibraryLocalThumbnails, 'ensureLocalThumbnail'> = { ensureLocalThumbnail };
    return {
      ensureLocalThumbnail,
      pass: createLibraryThumbnailPass({
        database: h.database,
        thumbnails,
        ...(concurrency === undefined ? {} : { concurrency }),
      }),
    };
  }

  it('lists what has no original here and no thumbnail, newest first', async () => {
    await seed(C1, { createdAt: 1 });
    await seed(F, { createdAt: 2, residency: 'local-original', flagged: true });
    await seed(C2, { createdAt: 3 });
    await seed(N, { createdAt: 4, thumbnailUri: 'file:///data/library/thumbnails/n.webp' });
    await seed(L, { createdAt: 5, residency: 'local-original' });
    await seed(T, { createdAt: 6, lifecycle: 'trash' });
    await seed(P, { createdAt: 7, protection: 'pending' });
    await seed(D, { createdAt: 8, deviceTrashed: true });
    await seed(X, { createdAt: 9, otherScope: true });
    await seed(G, { createdAt: 10, noOriginalGeneration: true });
    const { pass, ensureLocalThumbnail } = passWith(async () => ENSURED, 1);

    const result = await pass.run(TEST_ACCOUNT_SCOPE);

    expect(ensureLocalThumbnail.mock.calls.map(([digest]) => digest)).toEqual([C2, F, C1]);
    expect(result).toEqual({ total: 3, done: 3, failed: 0 });
  });

  it('runs 8 lanes', async () => {
    for (let i = 0; i < 10; i += 1) await seed(sha(`b${i}`), { createdAt: i + 1 });
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const { pass } = passWith(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return ENSURED;
    });

    const run = pass.run(TEST_ACCOUNT_SCOPE);
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(peak).toBe(8);
    gate.release();

    await expect(run).resolves.toEqual({ total: 10, done: 10, failed: 0 });
  });

  it.each(['object_missing', 'integrity', 'unsupported_image'] as const)(
    'does not retry a permanent %s next round, until a generation changes',
    async (category) => {
      await seed(C1, { createdAt: 1 });
      const { pass, ensureLocalThumbnail } = passWith(
        async () => ({ status: 'failed', reason: 'cloud', category }),
      );

      expect(await pass.run(TEST_ACCOUNT_SCOPE)).toEqual({ total: 1, done: 0, failed: 1 });
      expect(await pass.run(TEST_ACCOUNT_SCOPE)).toEqual({ total: 0, done: 0, failed: 0 });
      expect(ensureLocalThumbnail).toHaveBeenCalledTimes(1);

      await h.database.run("UPDATE library_asset_protection SET thumbnail_generation_id = 'new'");
      await pass.run(TEST_ACCOUNT_SCOPE);

      expect(ensureLocalThumbnail).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['thumbnail_generation_id', 'preview_generation_id', 'original_generation_id'])(
    'retries a permanent failure once %s changes',
    async (column) => {
      await seed(C1, { createdAt: 1 });
      const { pass, ensureLocalThumbnail } = passWith(async () => UNSUPPORTED);
      await pass.run(TEST_ACCOUNT_SCOPE);
      await pass.run(TEST_ACCOUNT_SCOPE);
      expect(ensureLocalThumbnail).toHaveBeenCalledTimes(1);

      await h.database.run(`UPDATE library_asset_protection SET ${column} = 'changed'`);
      await pass.run(TEST_ACCOUNT_SCOPE);

      expect(ensureLocalThumbnail).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['too-large', 'no-source', 'no-asset'] as const)('treats %s as permanent too', async (reason) => {
    await seed(C1, { createdAt: 1 });
    const { pass, ensureLocalThumbnail } = passWith(async () => ({ status: 'failed', reason }));

    await pass.run(TEST_ACCOUNT_SCOPE);
    await pass.run(TEST_ACCOUNT_SCOPE);

    expect(ensureLocalThumbnail).toHaveBeenCalledTimes(1);
  });

  it.each<[string, LocalThumbnailResult]>([
    ['offline', { status: 'failed', reason: 'cloud', category: 'offline' }],
    ['error', { status: 'failed', reason: 'error' }],
    ['unchecked', { status: 'failed', reason: 'unchecked' }],
    ['write-failed', { status: 'failed', reason: 'write-failed' }],
  ])('retries a transient failure: %s', async (_name, answer) => {
    await seed(C1, { createdAt: 1 });
    const { pass, ensureLocalThumbnail } = passWith(async () => answer);

    expect(await pass.run(TEST_ACCOUNT_SCOPE)).toEqual({ total: 1, done: 0, failed: 1 });
    await pass.run(TEST_ACCOUNT_SCOPE);

    expect(ensureLocalThumbnail).toHaveBeenCalledTimes(2);
  });

  it('lets an ensured digest leave the skip map', async () => {
    await seed(C1, { createdAt: 1 });
    const answers: LocalThumbnailResult[] = [UNSUPPORTED, ENSURED, UNSUPPORTED];
    const { pass, ensureLocalThumbnail } = passWith(async () => answers.shift()!);
    const setGeneration = (value: string) => h.database.run(
      'UPDATE library_asset_protection SET thumbnail_generation_id = ?',
      [value],
    );
    await setGeneration('first');

    await pass.run(TEST_ACCOUNT_SCOPE);
    await setGeneration('second');
    await pass.run(TEST_ACCOUNT_SCOPE);
    await setGeneration('first');
    await pass.run(TEST_ACCOUNT_SCOPE);

    expect(ensureLocalThumbnail).toHaveBeenCalledTimes(3);
  });
});
