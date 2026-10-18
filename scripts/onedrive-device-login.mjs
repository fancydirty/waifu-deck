#!/usr/bin/env node
/**
 * P12-C gate login (spec §4.2 补裁 8): a one-time interactive PKCE sign-in on
 * the Mac that stores the owner's refresh token for the real-OneDrive gate.
 * Opens the consumers authorize URL in the default browser with the
 * loopback redirect registered in the Azure app, receives the code on
 * 127.0.0.1:53682, exchanges it, and writes secrets/onedrive-gate-token.json
 * (0600). Prints nothing secret. Re-run whenever the gate reports
 * `invalid_grant` (a personal-account refresh token dies after 90 idle days
 * or a password change).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Kept byte-identical to src/features/cloud-store/microsoft-oauth.ts (pinned by scripts/onedrive-constants.test.mjs).
export const MICROSOFT_CLIENT_ID = '40d6e21b-ea99-4417-af2c-65b1a290aa0d';
export const MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
export const MICROSOFT_SCOPE = 'Files.ReadWrite.AppFolder offline_access User.Read';
const REDIRECT = 'http://localhost:53682/callback';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repoRoot, 'secrets', 'onedrive-gate-token.json');
const b64url = (b) => Buffer.from(b).toString('base64url');

async function main() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const url = `${MICROSOFT_AUTHORIZE_URL}?${new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query', scope: MICROSOFT_SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })}`;
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const q = new URL(req.url, 'http://localhost').searchParams;
      if (!req.url.startsWith('/callback')) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }).end(q.get('error') ? `Sign-in failed: ${q.get('error')}` : 'Signed in. You can close this tab.');
      server.close();
      if (q.get('state') !== state) reject(new Error('state mismatch')); else if (q.get('error')) reject(new Error(q.get('error_description') || q.get('error'))); else resolve(q.get('code'));
    });
    server.listen(53682, '127.0.0.1', () => { console.log('Opening the Microsoft sign-in in your browser (personal account)…'); spawn('open', [url], { stdio: 'ignore' }).unref(); });
  });
  const r = await fetch(MICROSOFT_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, scope: MICROSOFT_SCOPE }) });
  const body = await r.json();
  if (!r.ok || !body.refresh_token) throw new Error(`token endpoint ${r.status}: ${body.error || 'no refresh_token'} ${body.error_description || ''}`);
  const me = await (await fetch('https://graph.microsoft.com/v1.0/me', { headers: { authorization: `Bearer ${body.access_token}` } })).json();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ refreshToken: body.refresh_token, accountEmail: me.mail || me.userPrincipalName || null, obtainedAt: new Date().toISOString() }, null, 2));
  chmodSync(out, 0o600);
  console.log(`Stored ${path.relative(repoRoot, out)} (0600) for ${me.mail || me.userPrincipalName || 'the signed-in account'}.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
