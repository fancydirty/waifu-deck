import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildReleaseManifest,
  fetchCurrentRemoteVersionCode,
  OWNER_SIGNING_CERT_SHA1,
  validateReleaseArgs,
  versionCodeOf,
} from './release.mjs';

test('release.mjs derives versionCode and rejects malformed or zero versions', () => {
  assert.equal(versionCodeOf('1.2.0'), 1_002_000);
  assert.equal(versionCodeOf('1.2.1'), 1_002_001);
  assert.throws(() => versionCodeOf('0.0.0'), /MAJOR\.MINOR\.PATCH/);
  assert.throws(() => versionCodeOf('01.2.0'), /MAJOR\.MINOR\.PATCH/);
});

test('release.mjs enforces versionCode progression, content-hashed r2Key, and owner signing certificate constant', () => {
  assert.equal(OWNER_SIGNING_CERT_SHA1, '47767eb1893b02bac826197863bfe938d2abc606');
  const sha256 = 'a'.repeat(64);
  assert.throws(
    () =>
      buildReleaseManifest({
        versionName: '1.2.0',
        sizeBytes: 1024,
        sha256,
        notes: 'downgrade attempt',
        publishedAt: '2026-10-16T08:00:00.000Z',
        siteUrl: 'https://waifudeck.app',
        currentCode: 1_002_000,
      }),
    /must be higher than current release/,
  );

  const allowedReset = buildReleaseManifest({
    versionName: '1.2.0',
    sizeBytes: 1024,
    sha256,
    notes: 'allowed reset',
    publishedAt: '2026-10-16T08:00:00.000Z',
    siteUrl: 'https://waifudeck.app',
    currentCode: 1_002_001,
    allowSameOrLower: true,
  });
  assert.equal(allowedReset.versionCode, 1_002_000);
  assert.equal(allowedReset.r2Key, 'waifudeck-1.2.0-aaaaaaaaaaaa.apk');
  assert.equal(allowedReset.downloadUrl, 'https://waifudeck.app/api/app/download');
});

test('release.mjs parses CLI arguments and rejects unknown flags or extra positional args', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wd-rel-test-'));
  try {
    const dummyApk = path.join(tmpDir, 'dummy.apk');
    writeFileSync(dummyApk, 'dummy-apk');
    const parsed = validateReleaseArgs([
      dummyApk,
      '1.2.1',
      'Release notes',
      '--allow-same-or-lower',
    ]);
    assert.deepEqual(parsed, {
      apkPath: dummyApk,
      versionName: '1.2.1',
      notes: 'Release notes',
      allowSameOrLower: true,
    });

    assert.throws(
      () => validateReleaseArgs([dummyApk, '1.2.1', '--unknown-flag']),
      /unknown flag/,
    );
    assert.throws(
      () => validateReleaseArgs([dummyApk, '1.2.1', 'unquoted', 'notes']),
      /too many positional arguments/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fetchCurrentRemoteVersionCode fails closed on non-404 HTTP errors or invalid JSON', async () => {
  const code404 = await fetchCurrentRemoteVersionCode(async () => new Response('', { status: 404 }));
  assert.equal(code404, 0);

  await assert.rejects(
    () => fetchCurrentRemoteVersionCode(async () => new Response('err', { status: 503 })),
    /HTTP 503/,
  );

  await assert.rejects(
    () =>
      fetchCurrentRemoteVersionCode(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    /missing a valid versionCode/,
  );
});
