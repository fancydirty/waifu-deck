import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readGateClientSecret } from './gdrive-device-login.mjs';
import { buildChildEnv, createScrubber, parseArgs, readTokenFile, refreshGate, runChild, runGate } from './run-byos-gdrive-gate.mjs';

// FAKE values only — never a real credential in a test.
const FAKE = { refresh: 'fake-refresh-1//0gFAKEFAKEFAKE', access: 'ya29.fake-access-FAKEFAKE', secret: 'GOCSPX-fake-secret-FAKE' };

const sink = () => { const chunks = []; return { chunks, write: (c) => { chunks.push(String(c)); return true; }, text: () => chunks.join('') }; };

function deps(overrides = {}) {
  const out = sink();
  const calls = { marker: 0, jestEnv: null };
  const scrubber = createScrubber();
  return {
    out, calls, scrubber,
    readTokenFile: () => ({ refreshToken: FAKE.refresh, accountEmail: 'gate@example.com', obtainedAt: '2026-09-25T00:00:00.000Z' }),
    readClientSecret: () => FAKE.secret,
    refresh: async () => ({ accessToken: FAKE.access, expiresAt: 1 }),
    spawnJest: async (env) => { calls.jestEnv = env; return 0; },
    writeMarker: async () => { calls.marker += 1; return { localFile: '/tmp/x.txt', fileId: 'f1', recheckOn: '2026-10-02' }; },
    ...overrides,
  };
}

test('the retention marker is written only after Jest exits 0', async () => {
  const red = deps({ spawnJest: async () => 1 });
  assert.equal(await runGate(parseArgs([]), red), 1);
  assert.equal(red.calls.marker, 0);
  assert.match(red.out.text(), /no retention marker written/);

  const green = deps();
  assert.equal(await runGate(parseArgs([]), green), 0);
  assert.equal(green.calls.marker, 1);
});

test('a marker failure is reported but never replaces a green exit code', async () => {
  const d = deps({ writeMarker: async () => { throw new Error(`boom ${FAKE.access}`); } });
  assert.equal(await runGate(parseArgs([]), d), 0);
  assert.match(d.out.text(), /retention marker failed: boom <REDACTED>/);
});

test('--preflight and --dry-run never spawn Jest nor write a marker; --dry-run reads no token', async () => {
  const pre = deps();
  assert.equal(await runGate(parseArgs(['--preflight']), pre), 0);
  assert.equal(pre.calls.jestEnv, null);
  assert.equal(pre.calls.marker, 0);
  assert.match(pre.out.text(), /preflight ok: gate@example.com/);

  const dry = deps({ readTokenFile: () => { throw new Error('read'); }, refresh: async () => { throw new Error('net'); } });
  assert.equal(await runGate(parseArgs(['--dry-run']), dry), 0);
  assert.equal(dry.calls.jestEnv, null);
  assert.match(dry.out.text(), /jest\.integration\.config\.js --runInBand src\/integration\/gdrive-/);
});

test('nothing the gate prints carries the refresh token, access token or client secret', async () => {
  // The fake Jest child prints every secret the gate itself knows, plus a refresh's error_description, through
  // the scrub function runGate hands it — so dropping ANY of runGate's scrubber.register calls leaks here.
  const d = deps({
    refresh: async ({ scrubber }) => { scrubber.register('description free text'); return { accessToken: FAKE.access, expiresAt: 1 }; },
    spawnJest: async (env, scrub) => {
      d.calls.jestEnv = env;
      d.out.write(scrub(`child saw ${FAKE.refresh} ${FAKE.access} ${FAKE.secret} and description free text\n`));
      return 0;
    },
  });
  await runGate(parseArgs([]), d);
  await runGate(parseArgs(['--preflight']), d);
  const printed = d.out.text();
  assert.match(printed, /child saw <REDACTED> <REDACTED> <REDACTED> and <REDACTED>/);
  for (const s of [...Object.values(FAKE), 'description free text']) assert.equal(printed.includes(s), false, `leaked: ${s}`);
  // The child still gets them — it needs them.
  assert.equal(d.calls.jestEnv.BYOS_GDRIVE_ACCESS_TOKEN, FAKE.access);
  assert.equal(d.calls.jestEnv.BYOS_GDRIVE_CLIENT_SECRET, FAKE.secret);
});

test('every byte a child prints is scrubbed, including a secret split across chunks and error_description text', async () => {
  const scrubber = createScrubber();
  for (const s of Object.values(FAKE)) scrubber.register(s);
  const out = sink();
  const err = sink();
  const script = [
    `process.stdout.write(${JSON.stringify(FAKE.refresh.slice(0, 9))});`,
    `setTimeout(() => { process.stdout.write(${JSON.stringify(`${FAKE.refresh.slice(9)} tail\n`)});`,
    `console.error(${JSON.stringify(`auth ${FAKE.access} ${FAKE.secret}`)});`,
    `console.log(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));`,
    `console.log(require('node:util').inspect({ error_description: 'Token has been expired or revoked.' }));`,
    `console.log('reauth_required: Token endpoint 400: invalid_grant Token has been expired or revoked.'); }, 20);`,
  ].join('\n');
  assert.equal(await runChild(process.execPath, ['-e', script], process.env, 'child', scrubber.scrub, { stdout: out, stderr: err }), 0);
  const all = out.text() + err.text();
  for (const s of Object.values(FAKE)) assert.equal(all.includes(s), false, 'a secret leaked');
  assert.equal(all.includes('expired or revoked'), false, 'an error_description leaked');
  assert.match(all, /<REDACTED> tail/);
  assert.match(all, /invalid_grant/);
});

test('token shapes are scrubbed even when never registered (an access token minted inside Jest, a forgotten refresh token)', () => {
  const s = createScrubber();
  const out = s.scrub('Authorization: Bearer ya29.a0AfB_UNREGISTERED-fake and 1//0gUNREGISTERED-fake here');
  assert.equal(out.includes('UNREGISTERED'), false);
  assert.match(out, /Bearer <REDACTED> and <REDACTED> here/);
});

test('a refresh runs again right before the marker, and the marker uses that fresh token', async () => {
  let n = 0;
  let used = null;
  const d = deps({
    refresh: async () => { n += 1; return { accessToken: `${FAKE.access}-${n}`, expiresAt: 1 }; },
    writeMarker: async ({ accessToken }) => { used = accessToken; return { localFile: '/tmp/x.txt', fileId: 'f1', recheckOn: '2026-10-02' }; },
  });
  assert.equal(await runGate(parseArgs([]), d), 0);
  assert.equal(n, 2);
  assert.equal(used, `${FAKE.access}-2`);
  assert.equal(d.out.text().includes(FAKE.access), false);
});

test('refreshGate registers a failed refresh\'s error_description with the scrubber and never echoes it', async () => {
  const scrubber = createScrubber();
  const desc = 'Unauthorized client FREETEXT-FAKE';
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'unauthorized_client', error_description: desc }), { status: 401 });
  await assert.rejects(refreshGate({ refreshToken: FAKE.refresh, clientSecret: FAKE.secret, fetchImpl, scrubber }), (e) => !e.message.includes('FREETEXT'));
  // Later output that happens to carry the same text (a Jest line, a stack) is redacted because it was registered.
  assert.equal(scrubber.scrub(`jest: ${desc}`), 'jest: <REDACTED>');
});

test('a partial run (a Jest filter or --skip-large) exits green but writes no retention marker', async () => {
  for (const args of [['-t', '61 MiB'], ['--skip-large']]) {
    const d = deps();
    assert.equal(await runGate(parseArgs(args), d), 0);
    assert.equal(d.calls.marker, 0, args.join(' '));
    assert.match(d.out.text(), /Partial run/);
  }
});

test('the access tokens themselves are registered, not only caught by the ya29. shape rule', async () => {
  // An access token that does NOT look like ya29.* — only an explicit register() can hide it.
  const odd = 'opaque-access-token-FAKE-no-prefix';
  const odd2 = 'opaque-second-token-FAKE-no-prefix';
  let n = 0;
  const d = deps({
    // First refresh → `odd` (run-time token); second refresh (right before the marker) → `odd2`: each must be registered.
    refresh: async () => { n += 1; return { accessToken: n === 1 ? odd : odd2, expiresAt: 1 }; },
    spawnJest: async (env, scrub) => { d.calls.jestEnv = env; d.out.write(scrub(`child saw ${odd}\n`)); return 0; },
    writeMarker: async () => { throw new Error(`marker saw ${odd} and ${odd2}`); },
  });
  assert.equal(await runGate(parseArgs([]), d), 0);
  assert.match(d.out.text(), /marker saw <REDACTED> and <REDACTED>/);
  assert.equal(d.out.text().includes(odd), false);
  assert.equal(d.out.text().includes(odd2), false);
});

test('a malformed secret file never quotes a fragment of the secret in its error (V8 puts file text in JSON.parse messages)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gdrive-secret-'));
  const web = path.join(dir, 'web.json');
  writeFileSync(web, '{"web":{"client_id":"x","client_secret":GOCSPX-LEAKFAKE}}');
  assert.throws(() => readGateClientSecret(web), (e) => !/LEAKFAKE|GOCSPX/.test(e.message));
  const tok = path.join(dir, 'tok.json');
  writeFileSync(tok, '{"r":"a","refreshToken":X1//0gLEAKFAKE"}'); // an unexpected token → V8 quotes the text around it
  assert.throws(() => readTokenFile(tok), (e) => !/LEAKFAKE|1\/\/0/.test(e.message));
});

test('child output is decoded as UTF-8: a multi-byte character split across two writes arrives whole', async () => {
  const out = sink();
  const script = "const b = Buffer.from('界\\n'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 30);";
  assert.equal(await runChild(process.execPath, ['-e', script], process.env, 'child', (t) => t, { stdout: out, stderr: sink() }), 0);
  assert.equal(out.text(), '界\n');
});

test('--skip-large always wins over an inherited BYOS_GDRIVE_LARGE; --proxy reaches the child env', () => {
  const creds = { refreshToken: 'r', accessToken: 'a', expiresAt: 1, clientSecret: 's' };
  assert.equal(buildChildEnv(parseArgs(['--skip-large']), creds, { BYOS_GDRIVE_LARGE: '1' }).BYOS_GDRIVE_LARGE, undefined);
  assert.equal(buildChildEnv(parseArgs([]), creds, {}).BYOS_GDRIVE_LARGE, '1');
  const env = buildChildEnv(parseArgs(['--proxy=http://127.0.0.1:7890']), creds, {});
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.deepEqual(parseArgs(['--proxy=http://p:1', '-t', 'x']).jestArgs, ['-t', 'x']);
});
