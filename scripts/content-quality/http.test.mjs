import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuditRequestError,
  fetchJsonWithRetry,
  parseRetryAfter,
  redactText,
  toSafeError,
} from './http.mjs';

test('redacts URL queries, credentials, bearer tokens, and home paths', () => {
  const redacted = redactText(
    'GET https://api.example.test/items?api_key=abc#frag Authorization: secret Bearer xyz /Users/alice/private.txt',
  );
  assert.equal(redacted.includes('abc'), false);
  assert.equal(redacted.includes('secret'), false);
  assert.equal(redacted.includes('xyz'), false);
  assert.equal(redacted.includes('/Users/alice'), false);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /\[HOME\]/);
});

test('safe request errors expose only bounded diagnostic fields', () => {
  const safe = toSafeError(new AuditRequestError(
    'rate_limited',
    'HTTP 429 from api.example.test',
    { status: 429, retryAfterMs: 2_000 },
  ));
  assert.deepEqual(safe, {
    reason: 'rate_limited',
    message: 'HTTP 429 from api.example.test',
    status: 429,
    retryAfterMs: 2_000,
  });
});

test('parses both Retry-After forms deterministically', () => {
  assert.equal(parseRetryAfter('2', 0), 2_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1_000), 2_000);
  assert.equal(parseRetryAfter('not-a-date', 0), null);
});

test('honors a bounded Retry-After before one retry', async () => {
  const sleeps = [];
  const attempts = [];
  let request = 0;
  let clock = 0;
  const body = await fetchJsonWithRetry({
    url: 'https://api.example.test/items?token=secret',
    headers: { 'User-Agent': 'test' },
    fetchImpl: async () => {
      request += 1;
      clock += 10;
      if (request === 1) {
        return new Response('{}', {
          status: 429,
          headers: { 'retry-after': '2', 'content-type': 'application/json' },
        });
      }
      return Response.json({ ok: true });
    },
    sleep: async (ms) => sleeps.push(ms),
    now: () => clock,
    onAttempt: (attempt) => attempts.push(attempt),
  });
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(sleeps, [2_000]);
  assert.deepEqual(attempts.map((attempt) => attempt.ok), [false, true]);
});
