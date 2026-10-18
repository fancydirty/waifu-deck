import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DRIVE_BASE, GOOGLE_APP_CLIENT_ID, GOOGLE_AUTHORIZE_URL, GOOGLE_GATE_CLIENT_ID, GOOGLE_GATE_REDIRECT_URI, GOOGLE_SCOPE, GOOGLE_TOKEN_URL } from './gdrive-device-login.mjs';
import { GOOGLE_TOKEN_URL as GATE_TOKEN_URL, GATE_CLIENT_ID } from './run-byos-gdrive-gate.mjs';

const pickFrom = (relUrl) => {
  const src = readFileSync(new URL(relUrl, import.meta.url), 'utf8');
  return (name) => new RegExp(`export const ${name} = '([^']+)'`).exec(src)?.[1];
};

test('the login helper carries the same endpoints and scope as the app module', () => {
  const pick = pickFrom('../src/features/cloud-store/google-oauth.ts');
  assert.equal(GOOGLE_AUTHORIZE_URL, pick('GOOGLE_AUTHORIZE_URL'));
  assert.equal(GOOGLE_TOKEN_URL, pick('GOOGLE_TOKEN_URL'));
  assert.equal(GOOGLE_SCOPE, pick('GOOGLE_SCOPE'));
});

test('the gate client differs from the app client explicitly: two named constants, both present (补裁 11/14)', () => {
  const pick = pickFrom('../src/features/cloud-store/google-oauth.ts');
  assert.equal(GOOGLE_APP_CLIENT_ID, pick('GOOGLE_CLIENT_ID'));
  assert.match(GOOGLE_GATE_CLIENT_ID, /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
  assert.notEqual(GOOGLE_GATE_CLIENT_ID, GOOGLE_APP_CLIENT_ID);
  assert.equal(GOOGLE_GATE_REDIRECT_URI, 'http://localhost:53682/callback');
  assert.notEqual(GOOGLE_GATE_REDIRECT_URI, pick('GOOGLE_REDIRECT_URI'));
});

test('the gate script refreshes against the same token endpoint with the gate client', () => {
  assert.equal(GATE_TOKEN_URL, GOOGLE_TOKEN_URL);
  assert.equal(GATE_CLIENT_ID, GOOGLE_GATE_CLIENT_ID);
});

test('the helper carries the same Drive base as the adapter module', () => {
  const pick = pickFrom('../src/features/cloud-store/gdrive-cloud-object-store.ts');
  assert.equal(DRIVE_BASE, pick('DRIVE_BASE'));
});
