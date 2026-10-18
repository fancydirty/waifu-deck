/**
 * C5 gate: the mirror transfer pool is a parallelism ceiling, not a rate limit.
 *
 * The owner's mirror ruling is that uploads and downloads run at the physical
 * limit: `runTransferPool`'s `concurrency` bounds how many requests are in
 * flight, and nothing inserts a delay between items. The unit suite proves the
 * no-delay property with fake timers, which cannot distinguish "no sleep" from
 * "a sleep the fake clock never advanced". This suite runs the production pool
 * over the production transport against a real S3-compatible backend and the
 * real clock, so a reintroduced throttle shows up as observed wall-clock
 * serialization rather than as a passing assertion.
 *
 * Parameterized by the same BYOS_IT_* environment as the other BYOS suites;
 * `npm run verify:byos-minio` supplies a throwaway container's values.
 */
import { createS3Transport } from '../features/byos/s3-transport';
import { runTransferPool } from '../features/library/library-transfer-pool';
import type { S3Credentials } from '../features/byos/s3-transport-types';

const endpoint = process.env.BYOS_IT_ENDPOINT ?? '';
const bucket = process.env.BYOS_IT_BUCKET ?? '';
const accessKeyId = process.env.BYOS_IT_ACCESS_KEY ?? '';
const secretAccessKey = process.env.BYOS_IT_SECRET ?? '';
const basePrefix = process.env.BYOS_IT_PREFIX ?? '';
const region = process.env.BYOS_IT_REGION ?? 'us-east-1';

const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

if (!configured) {
  console.warn(
    '[byos-integration] Skipping the transfer-pool concurrency suite: '
    + 'BYOS_IT_* are not all set. Run `npm run verify:byos-minio`.',
  );
}

const describeBackend = configured ? describe : describe.skip;

const credentials: S3Credentials = {
  endpoint, region, bucket, accessKeyId, secretAccessKey,
};

const bytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed * 37 + i * 11) % 256);

describeBackend('mirror transfer pool against a real S3-compatible backend', () => {
  const transport = createS3Transport(credentials);
  const runPrefix = `${basePrefix}pool-${Date.now().toString(36)}/`;
  const written = new Set<string>();

  afterAll(async () => {
    await Promise.all(
      [...written].map((key) => transport.deleteObject(key).catch(() => undefined)),
    );
  });

  it('uploads every item and keeps in-flight requests at the ceiling', async () => {
    const CONCURRENCY = 8;
    const ITEMS = 24;
    const keys = Array.from(
      { length: ITEMS },
      (_, i) => `${runPrefix}blob-${String(i).padStart(2, '0')}.bin`,
    );

    let inFlight = 0;
    let peakInFlight = 0;
    // Start times let us prove overlap without trusting a duration threshold:
    // a serialized pool never has two items open at the same instant.
    const spans: { start: number; end: number }[] = [];

    const started = Date.now();
    const result = await runTransferPool(
      keys,
      async (key) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        const start = Date.now();
        try {
          written.add(key);
          await transport.putObject(key, bytes(64 * 1024, key.length), {
            contentType: 'application/octet-stream',
          });
        } finally {
          spans.push({ start, end: Date.now() });
          inFlight -= 1;
        }
      },
      { concurrency: CONCURRENCY },
    );
    const elapsed = Date.now() - started;

    expect(result).toEqual({ total: ITEMS, done: ITEMS, failed: 0 });

    // The ceiling is respected: never more than `concurrency` open at once.
    expect(peakInFlight).toBeLessThanOrEqual(CONCURRENCY);

    // And it is actually used, not just respected. A pool that serialized —
    // or slept between items — could never open more than one at a time.
    expect(peakInFlight).toBeGreaterThan(1);

    // Independent of the counter: count real pairwise overlaps in the observed
    // spans. This survives a mutation that fakes the counter but serializes.
    const overlaps = spans.filter(
      (a, i) => spans.some((b, j) => j !== i && b.start < a.end && a.start < b.end),
    ).length;
    expect(overlaps).toBeGreaterThan(0);

    // Wall-clock sanity: the whole batch must beat the sum of its parts. With
    // real overlap the total is far below serial time; this is a loose bound
    // chosen so backend jitter cannot flake it.
    const serialFloor = spans.reduce((sum, s) => sum + (s.end - s.start), 0);
    expect(elapsed).toBeLessThan(serialFloor);

    // The no-throttle assertion, and the discriminating one. A `sleep(d)` before
    // each transfer keeps peak in-flight AND span overlap intact — both survive
    // it, because the lanes still run concurrently and the spans still nest. It
    // also survives gap-between-openings checks, since a uniform sleep makes the
    // lanes open in synchronized bursts whose consecutive gaps are still ~0.
    //
    // What a per-item delay cannot hide is dead time: with `n` items over `w`
    // lanes, the busy time is the summed span duration, so the wall clock can
    // exceed `serialFloor / lanes` only by real idleness. Requiring the observed
    // elapsed time to stay near that floor makes any inserted sleep fail, while
    // backend latency stays immune — it lands *inside* the spans, raising the
    // floor by exactly as much as it raises the elapsed time.
    const usedLanes = Math.min(CONCURRENCY, ITEMS);
    const idealElapsed = serialFloor / usedLanes;
    const deadTime = elapsed - idealElapsed;
    console.warn(
      `[pool] elapsed=${elapsed}ms serialFloor=${Math.round(serialFloor)}ms `
      + `ideal=${Math.round(idealElapsed)}ms dead=${Math.round(deadTime)}ms`,
    );
    expect(deadTime).toBeLessThan(500);

    // Every object is really on the backend, not merely counted as done.
    const listed = await transport.listObjects(runPrefix, undefined);
    expect(listed.objects.length).toBe(ITEMS);
  }, 120_000);

  it('downloads the same batch back through the pool without dropping bytes', async () => {
    const keys = [...written];
    expect(keys.length).toBeGreaterThan(0);

    let peakInFlight = 0;
    let inFlight = 0;
    const roundTripped: string[] = [];

    const result = await runTransferPool(
      keys,
      async (key) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          const got = await transport.getObject(key);
          if (got === null) throw new Error(`missing ${key}`);
          if (got.body.byteLength !== 64 * 1024) {
            throw new Error(`short read ${key}: ${got.body.byteLength}`);
          }
          roundTripped.push(key);
        } finally {
          inFlight -= 1;
        }
      },
      { concurrency: 8 },
    );

    expect(result.failed).toBe(0);
    expect(result.done).toBe(keys.length);
    expect(roundTripped.length).toBe(keys.length);
    expect(peakInFlight).toBeGreaterThan(1);
  }, 120_000);

  it('a failing item is counted and never cancels the other lanes', async () => {
    // The mirror must make progress on a partially broken batch: one absent
    // object (a real 404 from the backend, not a stubbed rejection) must not
    // stop the sibling downloads.
    const good = [...written].slice(0, 6);
    const missing = `${runPrefix}definitely-absent.bin`;
    const items = [...good, missing];

    const fetched: string[] = [];
    const result = await runTransferPool(
      items,
      async (key) => {
        const got = await transport.getObject(key);
        if (got === null) throw new Error(`absent ${key}`);
        fetched.push(key);
      },
      { concurrency: 4 },
    );

    expect(result.total).toBe(items.length);
    expect(result.failed).toBe(1);
    expect(result.done).toBe(good.length);
    expect(fetched.sort()).toEqual([...good].sort());
  }, 120_000);
});
