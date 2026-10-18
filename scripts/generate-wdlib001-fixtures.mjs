#!/usr/bin/env node
import { createCipheriv, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(
  root,
  'modules', 'waifu-sync-service', 'android', 'src', 'test', 'resources', 'wdlib001',
);
const sizes = [1, 17, 65_537, 1_048_579];
const scopes = ['original', 'thumbnail', 'preview'];
const MAGIC = Buffer.from('WDLIB001', 'utf8');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest();
}

function deterministicBytes(length, label) {
  const output = Buffer.alloc(length);
  let offset = 0;
  let block = 0;
  while (offset < length) {
    const digest = sha256(Buffer.from(`wdlib001-fixture:${label}:${block}`, 'utf8'));
    const count = Math.min(digest.length, length - offset);
    digest.copy(output, offset, 0, count);
    offset += count;
    block += 1;
  }
  return output;
}

function seal(key, nonce, aad, plaintext) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

function makeFixture(scope, plaintextBytes) {
  const label = `${scope}:${plaintextBytes}`;
  const plaintext = deterministicBytes(plaintextBytes, `plaintext:${label}`);
  const masterKey = deterministicBytes(32, `master:${label}`);
  const dataKey = deterministicBytes(32, `data:${label}`);
  const keyNonce = deterministicBytes(12, `key-nonce:${label}`);
  const payloadNonce = deterministicBytes(12, `payload-nonce:${label}`);
  const assetId = sha256(plaintext).toString('hex');
  const keyAad = Buffer.from(`waifu-deck:library:v3:object-key:${assetId}:${scope}`, 'utf8');
  const payloadAad = Buffer.from(
    `waifu-deck:library:v3:object:${assetId}:${scope}:${plaintextBytes}`,
    'utf8',
  );
  const wrapped = seal(masterKey, keyNonce, keyAad, dataKey);
  const payload = seal(dataKey, payloadNonce, payloadAad, plaintext);
  const envelope = Buffer.concat([MAGIC, keyNonce, wrapped, payloadNonce, payload]);
  const file = `${scope}-${plaintextBytes}.wdlib`;
  return {
    file,
    scope,
    assetId,
    masterKey: masterKey.toString('hex'),
    plaintextBytes,
    plaintextSha256: assetId,
    envelope,
  };
}

const fixtures = scopes.flatMap((scope) => sizes.map((size) => makeFixture(scope, size)));
const manifest = JSON.stringify({
  format: 'wdlib001-fixtures-v1',
  seed: 'wdlib001-fixture',
  fixtures: fixtures.map(({ file, scope, assetId, masterKey, plaintextBytes, plaintextSha256 }) => ({
    file, scope, assetId, masterKey, plaintextBytes, plaintextSha256,
  })),
}, null, 2) + '\n';

if (process.argv.includes('--check')) {
  if (!existsSync(outputDir)) {
    throw new Error(`fixture directory missing: ${outputDir}`);
  }
  for (const fixture of fixtures) {
    const target = path.join(outputDir, fixture.file);
    if (!existsSync(target) || !readFileSync(target).equals(fixture.envelope)) {
      throw new Error(`fixture differs: ${target}`);
    }
  }
  const manifestPath = path.join(outputDir, 'fixtures.json');
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifest) {
    throw new Error(`fixture manifest differs: ${manifestPath}`);
  }
  console.log(`checked ${fixtures.length} WDLIB001 fixtures`);
} else {
  mkdirSync(outputDir, { recursive: true });
  for (const fixture of fixtures) {
    writeFileSync(path.join(outputDir, fixture.file), fixture.envelope);
  }
  writeFileSync(path.join(outputDir, 'fixtures.json'), manifest);
  console.log(`wrote ${fixtures.length} WDLIB001 fixtures to ${outputDir}`);
}
