/**
 * SigV4 wire compatibility against a real S3-compatible backend.
 *
 * This suite imports the production transport and lets it use the real global
 * `fetch` and the real clock: nothing here is faked, so a signature the unit
 * suite accepts but MinIO rejects fails this gate. It is parameterized by the
 * BYOS_IT_* environment so the same cases can be pointed at R2 later (P5);
 * `npm run verify:byos-minio` supplies a throwaway container's values.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createS3Transport } from '../features/byos/s3-transport';
import {
  S3TransportError,
  type S3Credentials,
} from '../features/byos/s3-transport-types';
import { createNodeDownloadFilePort } from '../test/node-file-transfer';

const endpoint = process.env.BYOS_IT_ENDPOINT ?? '';
const bucket = process.env.BYOS_IT_BUCKET ?? '';
const accessKeyId = process.env.BYOS_IT_ACCESS_KEY ?? '';
const secretAccessKey = process.env.BYOS_IT_SECRET ?? '';
const basePrefix = process.env.BYOS_IT_PREFIX ?? '';
const region = process.env.BYOS_IT_REGION ?? 'us-east-1';

const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

if (!configured) {
  console.warn(
    '[byos-integration] Skipping the S3 transport wire-compat suite: '
    + 'BYOS_IT_ENDPOINT/BYOS_IT_BUCKET/BYOS_IT_ACCESS_KEY/BYOS_IT_SECRET are '
    + 'not all set. Run `npm run verify:byos-minio` to start a throwaway MinIO '
    + 'container and run this gate against it.',
  );
}

const describeBackend = configured ? describe : describe.skip;

const credentials: S3Credentials = {
  endpoint, region, bucket, accessKeyId, secretAccessKey,
};

const runPrefix = `${basePrefix}wire-${Date.now().toString(36)}/`;
const seeded = new Set<string>();

const bytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed * 37 + i * 11) % 256);

describeBackend('S3 transport against a real S3-compatible backend', () => {
  const transport = createS3Transport(credentials, {
    downloadFile: createNodeDownloadFilePort(),
  });

  async function seed(
    key: string, body: Uint8Array,
  ): Promise<{ etag: string | null }> {
    seeded.add(key);
    return transport.putObject(key, body, {
      contentType: 'application/octet-stream',
    });
  }

  /** Returns the transport error an operation threw, failing if it resolved. */
  async function captureError(op: Promise<unknown>): Promise<S3TransportError> {
    try {
      await op;
    } catch (error) {
      return error as S3TransportError;
    }
    throw new Error('Expected the operation to be rejected by the backend.');
  }

  afterAll(async () => {
    await Promise.all(
      [...seeded].map((key) => transport.deleteObject(key).catch(() => undefined)),
    );
  });

  test('a signed PUT and GET round-trip the exact bytes and an ETag', async () => {
    const key = `${runPrefix}round-trip/state.json`;
    const body = bytes(1024, 3);

    const put = await seed(key, body);
    expect(put.etag).toMatch(/^"[0-9a-f]{32}"$/);

    const got = await transport.getObject(key);
    expect(got).not.toBeNull();
    expect(Array.from(got!.body)).toEqual(Array.from(body));
    expect(got!.etag).toBe(put.etag);
  });

  test('GET of an absent key is a null, not an error', async () => {
    await expect(transport.getObject(`${runPrefix}absent/state.json`))
      .resolves.toBeNull();
  });

  test('streams a present object to disk byte-for-byte, and a missing key is null', async () => {
    const key = `${runPrefix}streamed/blob.bin`;
    const body = bytes(256 * 1024 + 17, 23);
    await seed(key, body);
    const directory = mkdtempSync(join(tmpdir(), 'waifu-s3-download-'));
    const fileUri = pathToFileURL(join(directory, 'blob.bin')).href;
    try {
      await expect(transport.getObjectToFile(key, fileUri)).resolves.toMatchObject({
        etag: expect.stringMatching(/^"[0-9a-f]{32}"$/),
        bytesWritten: body.byteLength,
      });
      expect(new Uint8Array(readFileSync(new URL(fileUri)))).toEqual(body);
      await expect(transport.getObjectToFile(`${runPrefix}streamed/missing.bin`, fileUri + '-missing'))
        .resolves.toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('DELETE removes the object and is tolerated on a missing key', async () => {
    const key = `${runPrefix}delete/blob.bin`;
    await seed(key, bytes(64, 5));

    await expect(transport.deleteObject(key)).resolves.toBeUndefined();
    await expect(transport.getObject(key)).resolves.toBeNull();
    // The 404 tolerance the outbox depends on for replayed deletes.
    await expect(transport.deleteObject(key)).resolves.toBeUndefined();
  });

  test('If-None-Match:* creates once; the duplicate is a known precondition failure', async () => {
    const key = `${runPrefix}create-only/state.json`;
    const first = bytes(32, 7);
    seeded.add(key);

    const created = await transport.putObject(key, first, { ifNoneMatch: '*' });
    expect(created.etag).toBeTruthy();

    const error = await captureError(
      transport.putObject(key, bytes(32, 9), { ifNoneMatch: '*' }),
    );
    expect(error).toBeInstanceOf(S3TransportError);
    expect(error.status).toBe(412);
    expect(error.category).toBe('precondition');
    expect(error.outcomeKnown).toBe(true);

    // outcomeKnown=true is only honest if the refused write really did nothing.
    const got = await transport.getObject(key);
    expect(Array.from(got!.body)).toEqual(Array.from(first));
  });

  test('If-Match CAS accepts the current ETag and refuses a stale one', async () => {
    const key = `${runPrefix}cas/state.json`;
    const v2 = bytes(48, 13);

    const first = await seed(key, bytes(48, 11));
    const second = await transport.putObject(key, v2, {
      ifMatch: first.etag!,
    });
    expect(second.etag).toBeTruthy();
    expect(second.etag).not.toBe(first.etag);

    const error = await captureError(
      transport.putObject(key, bytes(48, 17), { ifMatch: first.etag! }),
    );
    expect(error).toBeInstanceOf(S3TransportError);
    expect(error.status).toBe(412);
    expect(error.category).toBe('precondition');
    expect(error.outcomeKnown).toBe(true);

    // A backend that ignored If-Match would have overwritten v2 here.
    const got = await transport.getObject(key);
    expect(Array.from(got!.body)).toEqual(Array.from(v2));
  });

  test('ListObjectsV2 returns the seeded keys with etag, lastModified and size', async () => {
    const prefix = `${runPrefix}listing/`;
    const sizes = [5, 17, 64];
    const putEtags: (string | null)[] = [];
    for (const [index, size] of sizes.entries()) {
      const put = await seed(`${prefix}asset-${index}/state.json`, bytes(size, index + 1));
      putEtags.push(put.etag);
    }

    // The transport exposes no max-keys knob, so the continuation-token path
    // stays covered by the parser unit tests; what only a real backend can
    // prove is that a signed ListObjectsV2 is accepted and that every field
    // comes back in the same shape the object-level calls return — a listing
    // ETag that does not equal the header ETag is useless for reconciliation.
    const page = await transport.listObjects(prefix, undefined);
    expect(page.nextToken).toBeUndefined();
    expect(page.objects.map((o) => o.key)).toEqual(
      sizes.map((_, index) => `${prefix}asset-${index}/state.json`),
    );
    for (const [index, object] of page.objects.entries()) {
      expect(object.size).toBe(sizes[index]);
      expect(object.etag).toBe(putEtags[index]);
      expect(Number.isNaN(Date.parse(object.lastModified))).toBe(false);
    }
  });

  test('a key and prefix of RFC 3986 sub-delimiters round-trip against the backend', async () => {
    // encodeURIComponent leaves (a*b)!' literal; SigV4 canonicalizes them, so a
    // raw signed path is a 403 from a real backend. The transport now encodes
    // each path segment identically for the signature and the wire, so a key
    // holding these characters must PUT, GET and list cleanly.
    const prefix = `${runPrefix}(a*b)!'/`;
    const key = `${prefix}state.json`;
    const body = bytes(24, 19);
    await seed(key, body);

    const got = await transport.getObject(key);
    expect(got).not.toBeNull();
    expect(Array.from(got!.body)).toEqual(Array.from(body));

    const page = await transport.listObjects(prefix, undefined);
    expect(page.objects.map((o) => o.key)).toEqual([key]);
  });
});
