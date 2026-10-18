import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { MICROSOFT_AUTHORIZE_URL, MICROSOFT_CLIENT_ID, MICROSOFT_SCOPE, MICROSOFT_TOKEN_URL } from './onedrive-device-login.mjs';
import { GRAPH_BASE } from './run-byos-onedrive-gate.mjs';

const pickFrom = (relUrl) => {
  const src = readFileSync(new URL(relUrl, import.meta.url), 'utf8');
  return (name) => new RegExp(`export const ${name} = '([^']+)'`).exec(src)?.[1];
};

test('the login helper carries the same identity constants as the app module', () => {
  const pick = pickFrom('../src/features/cloud-store/microsoft-oauth.ts');
  assert.equal(MICROSOFT_CLIENT_ID, pick('MICROSOFT_CLIENT_ID'));
  assert.equal(MICROSOFT_AUTHORIZE_URL, pick('MICROSOFT_AUTHORIZE_URL'));
  assert.equal(MICROSOFT_TOKEN_URL, pick('MICROSOFT_TOKEN_URL'));
  assert.equal(MICROSOFT_SCOPE, pick('MICROSOFT_SCOPE'));
});

test('the gate script carries the same Graph base as the adapter module', () => {
  const pick = pickFrom('../src/features/cloud-store/onedrive-cloud-object-store.ts');
  assert.equal(GRAPH_BASE, pick('GRAPH_BASE'));
});
