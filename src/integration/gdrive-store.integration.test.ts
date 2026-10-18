/**
 * P12-D (spec §8; plan Task 12 Step 3): the reusable `CloudObjectStore`
 * contract (samePathBehavior 'append' — Drive addresses files by id, so a
 * second same-name put adds a row and reads return the earliest), a 2 MiB
 * timing line and a 61 MiB resumable line against the REAL Google Drive
 * backend — the owner's account — selected by `npm run verify:byos-gdrive`,
 * which refreshes once up front, supplies the BYOS_GDRIVE_* environment and
 * scrubs the secrets from output.
 *
 * Each run creates `Waifu Deck/it-<run>/{state,blobs}` and deletes the run
 * folder afterwards (one `files.delete` removes the descendants, 补裁 5).
 */
import type { S3UploadFileRequest } from '@/features/byos/s3-transport';
import { describeCloudObjectStoreContract } from '@/features/cloud-store/cloud-object-store-contract-test-support';
import { createNodeBlobStaging, createNodeUploadFilePort } from '@/test/node-file-transfer';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { configured, createRunLayout, deleteRunFolder, factory, label, large, logObservations, storeFor } from './gdrive-test-support';

if (!configured) {
  console.warn(
    '[gdrive-integration] Skipping the Google Drive store suite: BYOS_GDRIVE_REFRESH_TOKEN/'
    + '_ACCESS_TOKEN/_CLIENT_ID/_CLIENT_SECRET are not all set. Run `npm run verify:byos-gdrive`.',
  );
}

if (configured) describeCloudObjectStoreContract(label, factory, { samePathBehavior: 'append' });

const describeBackend = configured ? describe : describe.skip;

describeBackend(`Google Drive speed line — ${label} (spec §8: 保存→上云秒数如实报告)`, () => {
  test('2 MiB putFromFile + get round-trip, timed, byte-exact', async () => {
    const run = `s${Date.now().toString(36)}`;
    const { store, dispose } = await factory(run);
    try {
      await store.ensureLayout();
      const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 31 + 7) % 256);
      const staging = createNodeBlobStaging();
      const uri = staging.resolveTemp('speed-2mib');
      await staging.writeBytes(uri, bytes);
      const t0 = Date.now();
      await store.putFromFile('blobs/speed-2mib', uri, 'application/octet-stream');
      const putMs = Date.now() - t0;
      const t1 = Date.now();
      const back = await store.get('blobs/speed-2mib');
      const getMs = Date.now() - t1;
      console.log(`[gdrive-speed] ${label}: put 2 MiB ${putMs} ms, get 2 MiB ${getMs} ms`);
      expect(back?.byteLength).toBe(bytes.byteLength);
      expect(bytes.findIndex((b, i) => back![i] !== b)).toBe(-1);
    } finally {
      await dispose();
    }
  }, 300_000);

  test('1 MiB getToFile round-trip is byte-exact and missing blobs leave no file', async () => {
    const run = `f${Date.now().toString(36)}`;
    const { store, dispose } = await factory(run);
    const staging = createNodeBlobStaging();
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 17 + 3) % 256);
    const source = staging.resolveTemp('file-get-source');
    const destination = staging.resolveTemp('file-get-destination');
    const missing = staging.resolveTemp('file-get-missing');
    try {
      await store.ensureLayout();
      await staging.writeBytes(source, bytes);
      await store.putFromFile('blobs/file-get', source, 'application/octet-stream');
      expect(store.getToFile).toBeDefined();
      const result = await store.getToFile!('blobs/file-get', destination);
      expect(result?.bytesWritten).toBe(bytes.byteLength);
      expect(new Uint8Array(await fs.readFile(fileURLToPath(destination)))).toEqual(bytes);
      await expect(store.getToFile!('blobs/file-missing', missing)).resolves.toBeNull();
      await expect(fs.stat(fileURLToPath(missing))).rejects.toThrow();
    } finally {
      await staging.delete(source);
      await staging.delete(destination);
      await staging.delete(missing);
      await dispose();
    }
  }, 300_000);
});

// 61 MiB: comfortably over Drive's 5 MB resumable threshold and over the 60 MiB
// figure the OneDrive gate used, so the two gates' numbers are comparable. No
// Drive fragments this round (补裁 5): this proves ONE whole-file PUT commits.
(configured && large ? test : test.skip)('61 MiB putFromFile commits through one resumable session with ONE whole-file PUT (no Content-Range) and reads back byte-exact', async () => {
  const run = `l${Date.now().toString(36)}`;
  const ids = await createRunLayout(run);
  const puts: Omit<S3UploadFileRequest, 'onProgress' | 'signal'>[] = [];
  const node = createNodeUploadFilePort();
  // The Node upload port reports progress only at 0 and at the end (see
  // node-file-transfer.ts: Node's fetch has no upload progress), so the
  // production 20 s stall watchdog — which the native uploader keeps fed with
  // real byte counts on the device — would fire on any whole-file PUT that
  // takes longer than 20 s here (measured 21–28 s for 61 MiB on the office
  // link, 2026-09-25). OneDrive's gate never met this because its 61 MiB goes up
  // as 20 MiB fragments. Widen the window for THIS test only; the watchdog
  // itself is pinned by the unit suites.
  const store = storeFor(ids, async (request) => {
    puts.push({ url: new URL(request.url).host, fileUri: request.fileUri, headers: request.headers });
    return node(request);
  }, 300_000);
  try {
    const size = 61 * 1024 * 1024;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096) % 256;
    const staging = createNodeBlobStaging();
    const uri = staging.resolveTemp('large');
    await staging.writeBytes(uri, bytes);
    const reports: number[] = [];
    const t0 = Date.now();
    await store.putFromFile('blobs/large', uri, 'application/octet-stream', (sent) => reports.push(sent));
    const putMs = Date.now() - t0;
    const t1 = Date.now();
    const back = await store.get('blobs/large');
    const getMs = Date.now() - t1;
    console.log(`[gdrive-speed] ${label}: put 61 MiB ${putMs} ms (one session PUT to ${puts[0]?.url ?? '?'}), get 61 MiB ${getMs} ms, progress reports ${JSON.stringify(reports)}`);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.headers).toEqual({ 'content-length': String(size) });
    expect(reports[reports.length - 1]).toBe(size);
    expect(back?.byteLength).toBe(size);
    expect(bytes.findIndex((b, i) => back![i] !== b)).toBe(-1);
  } finally {
    await deleteRunFolder(ids.runFolderId);
  }
}, 900_000);

afterAll(() => { if (configured) logObservations('gdrive-store'); });
