#!/usr/bin/env node
/**
 * P12-D gate login (spec §4.3 补裁 11 → 14(b); plan Task 12 Step 1): a
 * one-time interactive PKCE sign-in on the Mac that stores the owner's refresh
 * token for the real-Google-Drive gate. It uses the WEB gate client, not the
 * app's iOS client: Google blocks loopback for Android/iOS clients (补裁 1),
 * and the Web client needs `access_type=offline&prompt=consent` to be issued a
 * refresh token plus `client_secret` on the exchange and on every refresh
 * (Task 1, measured). The secret is read from secrets/google-oauth-web-client.json,
 * sent only as a form field, and never printed.
 *
 * Writes the authorize URL to secrets/gdrive-login-url.txt (0600; override with
 * GDRIVE_LOGIN_URL_FILE) and, unless
 * `--no-browser` (or GDRIVE_LOGIN_NO_BROWSER=1), opens it in the default
 * browser; receives the code on 127.0.0.1:53682, checks `state`, exchanges the
 * code ONCE (a timed-out exchange can still consume the single-use code — Task 1
 * evidence c7 — so a timeout means "sign in again", never a re-post), reads the
 * account e-mail from Drive's `about`, and writes
 * secrets/gdrive-gate-token.json (0600, same-dir temp + rename). Prints nothing
 * secret.
 *
 * Re-run whenever the gate reports `invalid_grant`. With the consent screen in
 * Production (since 2026-09-22), the reasons that still apply are: the grant
 * was revoked; the token went unused for six months; or more than 100 refresh
 * tokens were issued for this account and client, which silently retires the
 * oldest (补裁 3). Only a return to Testing would add the 7-day expiry.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Kept byte-identical to src/features/cloud-store/google-oauth.ts (pinned by scripts/gdrive-constants.test.mjs).
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** The app's iOS-type client (google-oauth.ts GOOGLE_CLIENT_ID) — named here only so the constants test can prove the gate client differs on purpose. */
export const GOOGLE_APP_CLIENT_ID = '550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec.apps.googleusercontent.com';
/** The Web-type gate client (T1 ledger row; 补裁 14(b)) — deliberately NOT the app client. */
export const GOOGLE_GATE_CLIENT_ID = '550668815694-po1qgtra8ssijqme37640553b40lnqbp.apps.googleusercontent.com';
export const GOOGLE_GATE_REDIRECT_URI = 'http://localhost:53682/callback';
// Kept byte-identical to src/features/cloud-store/gdrive-cloud-object-store.ts (pinned by scripts/gdrive-constants.test.mjs).
export const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
export const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GATE_TOKEN_FILE = path.join(repoRoot, 'secrets', 'gdrive-gate-token.json');
export const WEB_CLIENT_FILE = path.join(repoRoot, 'secrets', 'google-oauth-web-client.json');
const urlFile = process.env.GDRIVE_LOGIN_URL_FILE ?? path.join(repoRoot, 'secrets', 'gdrive-login-url.txt');
const b64url = (b) => Buffer.from(b).toString('base64url');

/** The Web gate client's secret; refuses a file that belongs to another client. Never prints the value. */
export function readGateClientSecret(file = WEB_CLIENT_FILE) {
  let web;
  try {
    web = JSON.parse(readFileSync(file, 'utf8')).web;
  } catch (e) {
    // Never e.message on a parse error: V8 quotes a fragment of the file (i.e. of the client secret) in it.
    throw new Error(`Could not read ${path.relative(repoRoot, file)}: ${e?.code ?? 'unreadable or not JSON'}`);
  }
  if (web?.client_id !== GOOGLE_GATE_CLIENT_ID) throw new Error(`${path.relative(repoRoot, file)} is not the Web gate client ${GOOGLE_GATE_CLIENT_ID}.`);
  if (typeof web.client_secret !== 'string' || web.client_secret === '') throw new Error(`${path.relative(repoRoot, file)} has no client_secret.`);
  return web.client_secret;
}

/** Same-dir temp created 0600 with `wx`, then renamed over the target (d93b0f0), so an interruption never leaves a truncated token file. */
export function writeFileAtomic0600(target, text) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

async function main() {
  const clientSecret = readGateClientSecret();
  const noBrowser = process.argv.includes('--no-browser') || process.env.GDRIVE_LOGIN_NO_BROWSER === '1';
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const url = `${GOOGLE_AUTHORIZE_URL}?${new URLSearchParams({ client_id: GOOGLE_GATE_CLIENT_ID, response_type: 'code', redirect_uri: GOOGLE_GATE_REDIRECT_URI, scope: GOOGLE_SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' })}`;
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url.startsWith('/callback')) { res.writeHead(404).end(); return; }
      const q = new URL(req.url, 'http://localhost').searchParams;
      const stateOk = q.get('state') === state;
      res.writeHead(200, { 'content-type': 'text/plain' }).end(!stateOk ? 'Sign-in refused: state mismatch.' : q.get('error') ? `Sign-in failed: ${q.get('error')}` : 'Signed in. You can close this tab.');
      server.close();
      if (!stateOk) reject(new Error('state mismatch — sign in again.'));
      else if (q.get('error')) reject(new Error(`Google refused the sign-in: ${q.get('error')}`));
      else if (!q.get('code')) reject(new Error('The callback carried no code — sign in again.'));
      else resolve(q.get('code'));
    });
    server.on('error', reject);
    server.listen(53682, '127.0.0.1', () => {
      writeFileAtomic0600(urlFile, `${url}\n`);
      console.log(`Authorize URL written to ${urlFile} (0600). Waiting for ${GOOGLE_GATE_REDIRECT_URI} …`);
      if (!noBrowser) { console.log('Opening the Google sign-in in your browser…'); spawn('open', [url], { stdio: 'ignore' }).unref(); }
    });
  });
  // Exactly one exchange: on a timeout the code may already be consumed (Task 1, c7), so never re-post it.
  let r;
  try {
    r = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: GOOGLE_GATE_CLIENT_ID, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: GOOGLE_GATE_REDIRECT_URI, code_verifier: verifier }), signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError';
    throw new Error(`${timedOut ? `Token exchange timed out after ${TOKEN_REQUEST_TIMEOUT_MS / 1000} s` : 'Token exchange failed before a response'}; the code is never re-posted — sign in again.`);
  }
  const body = await r.json().catch(() => ({}));
  // Status + error code only: error_description is server-controlled free text.
  if (!r.ok || typeof body.refresh_token !== 'string') throw new Error(`Token endpoint ${r.status}: ${body.error || 'no refresh_token'} — sign in again.`);
  const about = await fetch(`${DRIVE_BASE}/about?fields=user(emailAddress)`, { headers: { authorization: `Bearer ${body.access_token}` } });
  const accountEmail = about.ok ? ((await about.json()).user?.emailAddress ?? null) : null;
  writeFileAtomic0600(GATE_TOKEN_FILE, JSON.stringify({ refreshToken: body.refresh_token, accountEmail, obtainedAt: new Date().toISOString() }, null, 2));
  console.log(`Stored ${path.relative(repoRoot, GATE_TOKEN_FILE)} (0600) for ${accountEmail ?? `the signed-in account (about → ${about.status})`}.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
