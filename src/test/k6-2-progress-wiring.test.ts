import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * K6-2 (spec §2 G3/G5). The percentage ring has exactly one production source
 * of truth: a blob PUT that goes through a staged file (the only SDK 56 channel
 * that reports `bytesSent`) and a blob GET that reports bytes as they arrive.
 * Both hooks are OPTIONAL on `S3LibraryTransportPort` /
 * `CreateS3LibraryCloudClientOptions` so the dozens of hand-written fakes in
 * the unit suites stay valid — which means a composition that forgets to wire
 * them still compiles, still uploads correctly, and silently never draws a
 * ring. That is precisely the K6-1e class of failure (green tests over a path
 * the device never takes), so pin the wiring here.
 */
function compositionSource(): string {
  return readFileSync(
    resolve(process.cwd(), 'src/features/library/library-integration-impl.ts'),
    'utf8',
  );
}

test('the BYOS cloud client is given a blob staging port and the progress store', () => {
  const source = compositionSource();
  const start = source.indexOf('const cloud = createS3LibraryCloudClient({');
  expect(start).toBeGreaterThan(-1);
  const call = source.slice(start, source.indexOf('});', start));
  // Staged file uploads: without this the client falls back to the in-memory
  // PUT and no upload ever reports a byte.
  expect(call).toMatch(/blobStaging:\s*port,/);
  // Download rings: without this a 下凡 never publishes.
  expect(call).toMatch(/transferProgress:\s*libraryTransferProgress,/);
});

test('the transport keeps its production upload port (no test double left behind)', () => {
  const source = compositionSource();
  const start = source.indexOf('const transport = createS3Transport(');
  expect(start).toBeGreaterThan(-1);
  const call = source.slice(start, source.indexOf('});', start));
  const override = /uploadFile:\s*(.+),/.exec(call);
  // K6-1g (K7 #36) made the upload port a real production choice: the native
  // module's port where it is linked in, `expo-file-system` where it is not.
  // The rule this test was written for is unchanged — the only value allowed
  // here is that production selector, never a fixture, fake, or double.
  expect(override?.[1]).toBe('selectUploadFilePort(WaifuSyncService)');
});
