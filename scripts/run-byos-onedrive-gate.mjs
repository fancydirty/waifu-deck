#!/usr/bin/env node
/**
 * P12-C OneDrive gate (spec §4.2 补裁 8 and §8): runs the real-backend OneDrive
 * suites (`src/integration/onedrive-*.integration.test.ts`) against the
 * owner's personal Microsoft account.
 *
 * Reads the refresh token `scripts/onedrive-device-login.mjs` stored in
 * `secrets/onedrive-gate-token.json`, refreshes it ONCE up front (a stale or
 * revoked refresh token fails fast with a clear next step instead of failing
 * deep inside Jest), writes the rotated refresh token back to the file (only
 * when it actually rotated, and atomically via a same-dir temp + rename so an
 * interruption can never destroy the only copy) BEFORE Jest is spawned, then
 * runs the suites in-band with a fresh access token. Credentials never reach
 * stdout: every byte Jest emits — and every error this script prints — is
 * scrubbed of both tokens (same technique as the WebDAV gate). Afterwards,
 * only when Jest passed, a dated retention marker is PUT under the app folder
 * and its status printed, so the one-week "content still there" check
 * (spec §8) has something to read back.
 *
 * Flags:
 *   --skip-large   omit the 61 MiB fragment-path suite (BYOS_ONEDRIVE_LARGE)
 *   --preflight    do the token read/refresh/write-back only; print
 *                  `preflight ok: <accountEmail> (token rotated: yes|no)`
 *                  and exit 0 without spawning Jest or writing the marker
 *   --dry-run      skip the token read/refresh entirely; print the exact Jest
 *                  argv and the child BYOS_ONEDRIVE_* env keys (never values)
 *                  it would pass, then exit 0
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MICROSOFT_CLIENT_ID, MICROSOFT_SCOPE, MICROSOFT_TOKEN_URL } from './onedrive-device-login.mjs';

// Kept byte-identical to src/features/cloud-store/onedrive-cloud-object-store.ts (pinned by scripts/onedrive-constants.test.mjs).
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokenFile = path.join(repoRoot, 'secrets', 'onedrive-gate-token.json');

class GateError extends Error { constructor(m) { super(m); this.name = 'GateError'; } }

const args = process.argv.slice(2);
const skipLarge = args.includes('--skip-large');
const preflight = args.includes('--preflight');
const dryRun = args.includes('--dry-run');
const jestArgs = args.filter((a) => a !== '--skip-large' && a !== '--preflight' && a !== '--dry-run');

const secrets = [];
const registerSecret = (v) => { if (typeof v === 'string' && v.length >= 4) secrets.push(v); };
const scrub = (t) => secrets.reduce((o, s) => o.split(s).join('<REDACTED>'), t);
const say = (l) => process.stdout.write(`${scrub(l)}\n`);

function runChild(cmd, argv, env, label) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: repoRoot, stdio: ['inherit', 'pipe', 'pipe'], env });
    const forward = (stream, sink) => {
      let carry = '';
      stream.on('data', (chunk) => {
        const t = carry + chunk;
        const cut = t.lastIndexOf('\n');
        if (cut === -1) { carry = t; return; }
        carry = t.slice(cut + 1);
        sink.write(scrub(t.slice(0, cut + 1)));
      });
      stream.on('end', () => { if (carry) sink.write(scrub(carry)); });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('error', (error) => { console.error(scrub(`Failed to start ${label}: ${error.message}`)); resolve(1); });
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

const jestArgv = ['jest', '--config', 'jest.integration.config.js', '--runInBand', 'src/integration/onedrive-', ...jestArgs];

/** The child env: BYOS_ONEDRIVE_LARGE is deleted from the inherited env first, then set to '1' only when the large suite runs, so `--skip-large` always wins. */
function buildChildEnv(refreshToken, accessToken) {
  const env = { ...process.env };
  delete env.BYOS_ONEDRIVE_LARGE;
  env.BYOS_ONEDRIVE_REFRESH_TOKEN = refreshToken;
  env.BYOS_ONEDRIVE_ACCESS_TOKEN = accessToken;
  env.BYOS_ONEDRIVE_TOKEN_FILE = tokenFile;
  env.BYOS_ONEDRIVE_LABEL = 'owner OneDrive (personal)';
  if (!skipLarge) env.BYOS_ONEDRIVE_LARGE = '1';
  return env;
}

function readTokenFile() {
  let saved;
  try {
    saved = JSON.parse(readFileSync(tokenFile, 'utf8'));
  } catch (e) {
    throw new GateError(`Could not read ${path.relative(repoRoot, tokenFile)}: ${e.message}. Run \`node scripts/onedrive-device-login.mjs\` once to sign in.`);
  }
  if (!saved.refreshToken) throw new GateError(`${path.relative(repoRoot, tokenFile)} has no refreshToken. Run \`node scripts/onedrive-device-login.mjs\` once to sign in.`);
  return saved;
}

/** Refreshes once up front so a dead/revoked token fails fast with a clear next step. */
async function refresh(refreshToken) {
  const r = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: MICROSOFT_SCOPE }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 400 && body.error === 'invalid_grant') {
      throw new GateError('The stored refresh token was rejected (invalid_grant). Run `node scripts/onedrive-device-login.mjs` again to sign in.');
    }
    // Never echo body.error_description (server-controlled free text): status + error code only.
    throw new GateError(`Token refresh failed: ${r.status} ${body.error || ''}`.trim());
  }
  if (!body.access_token) throw new GateError('Token refresh succeeded but the response had no access_token.');
  const newRefreshToken = body.refresh_token || refreshToken;
  return { accessToken: body.access_token, refreshToken: newRefreshToken, rotated: newRefreshToken !== refreshToken };
}

/** Atomic, owner-only rewrite: a same-dir temp created 0o600 then renamed over the original, so an interruption never leaves the only copy of a rotated token truncated. */
function writeTokenFileAtomic(saved, refreshToken) {
  const tmp = path.join(path.dirname(tokenFile), `.${path.basename(tokenFile)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ ...saved, refreshToken, rotatedAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, tokenFile);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** Spec §8: a dated file under the app folder that the one-week retention check reads back. */
async function putRetentionMarker(accessToken) {
  const date = new Date().toISOString().slice(0, 10);
  const target = `${GRAPH_BASE}/me/drive/special/approot:/waifu-deck-retention/${date}.txt:/content`;
  const r = await fetch(target, { method: 'PUT', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'text/plain' }, body: `P12-C OneDrive gate ${new Date().toISOString()}` });
  say(`retention marker: PUT ${target} → ${r.status} (re-check on ${new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)})`);
}

async function main() {
  if (dryRun) {
    const env = buildChildEnv('placeholder-refresh-token', 'placeholder-access-token');
    say(`dry-run: would spawn: npx ${jestArgv.join(' ')}`);
    say(`dry-run: child BYOS_ONEDRIVE_* env keys: ${Object.keys(env).filter((k) => k.startsWith('BYOS_ONEDRIVE_')).sort().join(', ')}`);
    return 0;
  }

  const saved = readTokenFile();
  registerSecret(saved.refreshToken);

  const { accessToken, refreshToken, rotated } = await refresh(saved.refreshToken);
  registerSecret(refreshToken);
  registerSecret(accessToken);

  // Write-back only when the token actually rotated, and BEFORE Jest is spawned.
  if (rotated) writeTokenFileAtomic(saved, refreshToken);

  if (preflight) {
    say(`preflight ok: ${saved.accountEmail ?? 'unknown account'} (token rotated: ${rotated ? 'yes' : 'no'})`);
    return 0;
  }

  const env = buildChildEnv(refreshToken, accessToken);
  const onSignal = () => process.exit(130);
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let exitCode = 1;
  try {
    exitCode = await runChild('npx', jestArgv, env, 'Jest');
    if (exitCode === 0) {
      // The marker is best-effort: a PUT failure is reported (scrubbed) but never replaces Jest's exit code.
      try { await putRetentionMarker(accessToken); }
      catch (e) { console.error(scrub(`retention marker failed: ${e instanceof Error ? e.message : String(e)}`)); }
    }
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(scrub(error instanceof GateError ? error.message : String(error))); process.exitCode = 1; });
}
