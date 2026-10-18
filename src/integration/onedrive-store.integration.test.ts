/**
 * P12-C (spec §8): the reusable `CloudObjectStore` contract and the 2 MiB
 * speed line against the REAL Microsoft Graph OneDrive backend — the owner's
 * personal account — selected by `npm run verify:byos-onedrive`, which
 * refreshes the stored token once up front and supplies the BYOS_ONEDRIVE_*
 * environment (and scrubs the secrets from output).
 *
 * Each run creates `it-<run>/{state,blobs}` under the app folder
 * (`onedrive-test-support`'s `createRunLayout`) and DELETEs that run folder
 * afterwards, so nothing accumulates on the real account between runs.
 */
import { describeCloudObjectStoreContract } from '@/features/cloud-store/cloud-object-store-contract-test-support';
import { createNodeBlobStaging } from '@/test/node-file-transfer';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { configured, factory, label, large } from './onedrive-test-support';

if (!configured) {
  console.warn(
    '[onedrive-integration] Skipping the OneDrive store suite: BYOS_ONEDRIVE_REFRESH_TOKEN/'
    + '_ACCESS_TOKEN are not all set. Run `npm run verify:byos-onedrive`.',
  );
}

if (configured) describeCloudObjectStoreContract(label, factory);

const describeBackend = configured ? describe : describe.skip;

describeBackend(`OneDrive speed line — ${label} (spec §8: 保存→上云秒数如实报告)`, () => {
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
      console.log(`[onedrive-speed] ${label}: put 2 MiB ${putMs} ms, get 2 MiB ${getMs} ms`);
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

(configured && large ? test : test.skip)('61 MiB putFromFile takes the fragment path on the real backend (3 × 20 MiB + 1 MiB, in order) and reads back byte-exact', async () => {
  const run = `l${Date.now().toString(36)}`;
  const { store, dispose } = await factory(run);
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
    console.log(`[onedrive-speed] ${label}: put 61 MiB in ${Date.now() - t0} ms, progress reports ${JSON.stringify(reports)}`);
    expect(reports).toEqual([20971520, 41943040, 62914560, size]);
    const back = await store.get('blobs/large');
    expect(back?.byteLength).toBe(size);
    expect(bytes.findIndex((b, i) => back![i] !== b)).toBe(-1);
  } finally { await dispose(); }
}, 900_000);
