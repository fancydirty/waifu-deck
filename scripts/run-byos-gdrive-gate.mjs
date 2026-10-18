#!/usr/bin/env node
/**
 * P12-D Google Drive gate (spec §8, plan Task 12 Step 4): runs the real-backend
 * Drive suites (`src/integration/gdrive-*.integration.test.ts`) against the
 * owner's Google account, on the WEB gate client (T1 ledger row; 补裁 14(b)).
 *
 * Reads the refresh token `scripts/gdrive-device-login.mjs` stored in
 * `secrets/gdrive-gate-token.json` and the Web client's secret from
 * `secrets/google-oauth-web-client.json`, refreshes ONCE up front (a revoked
 * token fails fast with the next step instead of deep inside Jest), then runs
 * the suites in-band with that fresh access token. Google does not rotate
 * refresh tokens (补裁 3), so unlike the OneDrive gate there is NO write-back:
 * the token file is only ever read here. Credentials never reach stdout: every
 * byte Jest emits — and every line this script prints — is scrubbed of the
 * refresh token, the access token, the client secret and any
 * `error_description` (the WebDAV/OneDrive technique). Afterwards, ONLY when
 * Jest passed, a dated marker file is created in the Drive folder
 * `Waifu Deck/waifu-deck-retention/` and a local record naming that folder and
 * file is written to `~/waifu-acc/waifu-deck-retention/<date>.txt`, so the
 * +7 d "content still there" re-check (spec §8) has something to read back.
 *
 * Flags:
 *   --skip-large     omit the 61 MiB resumable line (BYOS_GDRIVE_LARGE)
 *   --preflight      do the token read/refresh only; print
 *                    `preflight ok: <accountEmail>` and exit 0 without
 *                    spawning Jest or writing any marker
 *   --dry-run        no token read, no network: print the exact Jest argv, the
 *                    child BYOS_GDRIVE_* env keys (never values) and the marker
 *                    paths a green run would write, then exit 0
 *   --proxy=<url>    for a machine that cannot reach Google directly (补裁 12):
 *                    sets HTTPS_PROXY/HTTP_PROXY + NODE_USE_ENV_PROXY=1 for
 *                    this process's fetch and for Jest (Node 26 honours both),
 *                    e.g. --proxy=http://127.0.0.1:7890
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setGlobalProxyFromEnv } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DRIVE_BASE, GATE_TOKEN_FILE, GOOGLE_GATE_CLIENT_ID, GOOGLE_TOKEN_URL, readGateClientSecret, writeFileAtomic0600 } from './gdrive-device-login.mjs';

export { GOOGLE_TOKEN_URL };
export const GATE_CLIENT_ID = GOOGLE_GATE_CLIENT_ID;
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const RETENTION_FOLDER = 'waifu-deck-retention';
export const LOCAL_MARKER_DIR = path.join(homedir(), 'waifu-acc', 'waifu-deck-retention');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class GateError extends Error { constructor(m) { super(m); this.name = 'GateError'; } }

/** Literal secrets are replaced wherever they appear; `error_description` values are replaced by shape, since their text is not known in advance. */
export function createScrubber() {
  const secrets = [];
  return {
    register(v) { if (typeof v === 'string' && v.length >= 4 && !secrets.includes(v)) secrets.push(v); },
    scrub(t) {
      return secrets.reduce((o, s) => o.split(s).join('<REDACTED>'), String(t))
        .replace(/("?error_description"?\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s,}&]+)/g, '$1<REDACTED>')
        // google-oauth.ts formats a token-endpoint failure as `Token endpoint <status>: <error> <error_description>`.
        .replace(/(Token endpoint \d{3}: \S+) [^\n]+/g, '$1 <error_description REDACTED>')
        // By shape too: an access token minted by a refresh INSIDE Jest was never registered here, and a refresh
        // token must never reach a log even if a code path forgets to register it.
        .replace(/ya29\.[\w.-]+/g, '<REDACTED>')
        .replace(/1\/\/0[\w-]+/g, '<REDACTED>');
    },
  };
}

/** Line-buffered forwarding so a secret split across two chunks is still scrubbed whole. */
export function runChild(cmd, argv, env, label, scrub, sinks = { stdout: process.stdout, stderr: process.stderr }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: repoRoot, stdio: ['inherit', 'pipe', 'pipe'], env });
    const forward = (stream, sink) => {
      // Decode as UTF-8 so a multi-byte character split across two chunks is not turned into U+FFFD.
      stream.setEncoding('utf8');
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
    forward(child.stdout, sinks.stdout);
    forward(child.stderr, sinks.stderr);
    child.on('error', (error) => { sinks.stderr.write(scrub(`Failed to start ${label}: ${error.message}\n`)); resolve(1); });
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

export function parseArgs(args) {
  const proxyArg = args.find((a) => a.startsWith('--proxy='));
  return {
    skipLarge: args.includes('--skip-large'),
    preflight: args.includes('--preflight'),
    dryRun: args.includes('--dry-run'),
    proxy: proxyArg ? proxyArg.slice('--proxy='.length) : null,
    jestArgs: args.filter((a) => !['--skip-large', '--preflight', '--dry-run'].includes(a) && !a.startsWith('--proxy=')),
  };
}

export const jestArgvFor = (jestArgs) => ['jest', '--config', 'jest.integration.config.js', '--runInBand', 'src/integration/gdrive-', ...jestArgs];

/** BYOS_GDRIVE_LARGE is deleted from the inherited env first, then set only when the large line runs, so `--skip-large` always wins. */
export function buildChildEnv(opts, creds, base = process.env) {
  const env = { ...base };
  delete env.BYOS_GDRIVE_LARGE;
  env.BYOS_GDRIVE_REFRESH_TOKEN = creds.refreshToken;
  env.BYOS_GDRIVE_ACCESS_TOKEN = creds.accessToken;
  env.BYOS_GDRIVE_EXPIRES_AT = String(creds.expiresAt);
  env.BYOS_GDRIVE_CLIENT_ID = GATE_CLIENT_ID;
  env.BYOS_GDRIVE_CLIENT_SECRET = creds.clientSecret;
  env.BYOS_GDRIVE_LABEL = 'owner Google Drive (Web gate client)';
  if (!opts.skipLarge) env.BYOS_GDRIVE_LARGE = '1';
  if (opts.proxy) Object.assign(env, { HTTPS_PROXY: opts.proxy, HTTP_PROXY: opts.proxy, NODE_USE_ENV_PROXY: '1' });
  return env;
}

export function readTokenFile(file = GATE_TOKEN_FILE) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // Never e.message on a parse error: V8 quotes a fragment of the file (i.e. of the secret) in it.
    throw new GateError(`Could not read ${path.relative(repoRoot, GATE_TOKEN_FILE)}: ${e?.code ?? 'unreadable or not JSON'}. Run \`node scripts/gdrive-device-login.mjs\` once to sign in.`);
  }
  if (!saved.refreshToken) throw new GateError(`${path.relative(repoRoot, GATE_TOKEN_FILE)} has no refreshToken. Run \`node scripts/gdrive-device-login.mjs\` once to sign in.`);
  return saved;
}

/** One refresh up front, with the Web client's secret (Task 1: a secret-free refresh is `400 client_secret is missing`). */
export async function refreshGate({ refreshToken, clientSecret, fetchImpl = fetch, scrubber, now = Date.now }) {
  let r;
  try {
    r = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: GATE_CLIENT_ID, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new GateError(`Token refresh failed before a response: ${e?.name === 'TimeoutError' ? 'timed out after 30 s' : e?.message}. If this machine needs a proxy, pass --proxy=<url>.`);
  }
  const body = await r.json().catch(() => ({}));
  scrubber?.register(body.error_description);
  if (!r.ok) {
    if (body.error === 'invalid_grant') {
      throw new GateError('The stored refresh token was rejected (invalid_grant: revoked, six months unused, or retired by the 100-token cap). Run `node scripts/gdrive-device-login.mjs` again to sign in.');
    }
    // Never echo body.error_description (server-controlled free text): status + error code only.
    throw new GateError(`Token refresh failed: ${r.status} ${body.error || ''}`.trim());
  }
  if (typeof body.access_token !== 'string') throw new GateError('Token refresh succeeded but the response had no access_token.');
  // No rotation write-back (补裁 3): Google never returns a new refresh token here; if it ever did, the stored one stays valid.
  return { accessToken: body.access_token, expiresAt: now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000 };
}

const quote = (v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Spec §8: a dated file in `Waifu Deck/waifu-deck-retention/` on Drive, plus a local record naming it, for the +7 d read-back. */
export async function writeRetentionMarker({ accessToken, accountEmail, fetchImpl = fetch, localDir = LOCAL_MARKER_DIR, now = new Date() }) {
  const auth = { authorization: `Bearer ${accessToken}` };
  const drive = async (url, init = {}) => {
    const r = await fetchImpl(url, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${url.split('?')[0]} → ${r.status}`);
    return r.json();
  };
  const find = async (q) => (await drive(`${DRIVE_BASE}/files?${new URLSearchParams({ q, orderBy: 'createdTime', fields: 'files(id)', pageSize: '10' })}`)).files?.[0]?.id ?? null;
  const rootId = await find(`name = 'Waifu Deck' and mimeType = '${FOLDER_MIME}' and trashed = false and appProperties has { key = 'waifuDeck' and value = 'root' }`);
  if (rootId === null) throw new Error('no `Waifu Deck` folder is visible to the gate client');
  const folderQuery = `${quote(rootId)} in parents and name = ${quote(RETENTION_FOLDER)} and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const folderId = (await find(folderQuery))
    ?? (await drive(`${DRIVE_BASE}/files?fields=id`, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name: RETENTION_FOLDER, mimeType: FOLDER_MIME, parents: [rootId] }) })).id;
  const date = now.toISOString().slice(0, 10);
  const name = `${date}.txt`;
  const content = `P12-D Google Drive gate ${now.toISOString()}\n`;
  const sha256 = createHash('sha256').update(content).digest('hex');
  const boundary = `gate-${sha256.slice(0, 24)}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--`;
  const file = await drive(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,createdTime`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
  const recheckOn = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const localFile = path.join(localDir, `${date}.txt`);
  writeFileAtomic0600(localFile, [
    `P12-D Google Drive gate — green run ${now.toISOString()}`,
    `account: ${accountEmail ?? 'unknown'} (gate client ${GATE_CLIENT_ID})`,
    `drive folder: Waifu Deck/${RETENTION_FOLDER}/ (root folder id ${rootId}, retention folder id ${folderId})`,
    `drive file: ${name} (file id ${file.id}, created ${file.createdTime}, ${Buffer.byteLength(content)} bytes, sha256 ${sha256})`,
    `re-check on ${recheckOn}: GET ${DRIVE_BASE}/files/${file.id}?alt=media with the gate token; the body's sha256 must equal ${sha256}`,
    '',
  ].join('\n'));
  return { localFile, fileId: file.id, folderId, recheckOn };
}

/**
 * The whole run with its side effects injected, so the two reviewer rules are
 * testable without a token or a network: nothing secret reaches `out`, and the
 * marker is written only after Jest exits 0.
 */
export async function runGate(opts, deps) {
  const { scrubber, out } = deps;
  const say = (l) => out.write(`${scrubber.scrub(l)}\n`);
  if (opts.dryRun) {
    const env = buildChildEnv(opts, { refreshToken: 'placeholder', accessToken: 'placeholder', expiresAt: 0, clientSecret: 'placeholder' }, {});
    say(`dry-run: would read ${path.relative(repoRoot, GATE_TOKEN_FILE)} and secrets/google-oauth-web-client.json, refresh once at ${GOOGLE_TOKEN_URL} (client ${GATE_CLIENT_ID}, no write-back)`);
    say(`dry-run: would spawn: npx ${jestArgvFor(opts.jestArgs).join(' ')}`);
    say(`dry-run: child env keys: ${Object.keys(env).sort().join(', ')}`);
    say(`dry-run: on a green run only, would create Drive file Waifu Deck/${RETENTION_FOLDER}/<date>.txt and write ${path.join(LOCAL_MARKER_DIR, '<date>.txt')}`);
    return 0;
  }
  const saved = deps.readTokenFile();
  scrubber.register(saved.refreshToken);
  const clientSecret = deps.readClientSecret();
  scrubber.register(clientSecret);
  const { accessToken, expiresAt } = await deps.refresh({ refreshToken: saved.refreshToken, clientSecret, scrubber });
  scrubber.register(accessToken);
  if (opts.preflight) {
    say(`preflight ok: ${saved.accountEmail ?? 'unknown account'} (gate client ${GATE_CLIENT_ID}; no rotation write-back)`);
    return 0;
  }
  say(`gate client ${GATE_CLIENT_ID}; account ${saved.accountEmail ?? 'unknown'}; token obtained ${saved.obtainedAt ?? 'unknown'}`);
  const env = buildChildEnv(opts, { refreshToken: saved.refreshToken, accessToken, expiresAt, clientSecret });
  const exitCode = await deps.spawnJest(env, scrubber.scrub);
  if (exitCode !== 0) {
    say(`Jest exited ${exitCode}: no retention marker written.`);
    return exitCode;
  }
  // A marker certifies a FULL green run: a filtered (`-t …`) or `--skip-large` run proves less, so it writes none.
  if (opts.jestArgs.length > 0 || opts.skipLarge) {
    say('Partial run (Jest filters or --skip-large): no retention marker written.');
    return exitCode;
  }
  // The marker is best-effort: a failure is reported (scrubbed) but never replaces Jest's exit code.
  try {
    // A long run can outlive the first access token (~1 h): refresh again for the marker write.
    const fresh = await deps.refresh({ refreshToken: saved.refreshToken, clientSecret, scrubber });
    scrubber.register(fresh.accessToken);
    const m = await deps.writeMarker({ accessToken: fresh.accessToken, accountEmail: saved.accountEmail ?? null });
    say(`retention marker: Drive Waifu Deck/${RETENTION_FOLDER}/ file ${m.fileId}; local record ${m.localFile}; re-check on ${m.recheckOn}`);
  } catch (e) {
    say(`retention marker failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return exitCode;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scrubber = createScrubber();
  if (opts.proxy && !opts.dryRun) setGlobalProxyFromEnv({ HTTPS_PROXY: opts.proxy, HTTP_PROXY: opts.proxy });
  const onSignal = () => process.exit(130);
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    return await runGate(opts, {
      scrubber,
      out: process.stdout,
      readTokenFile,
      readClientSecret: () => readGateClientSecret(),
      refresh: (input) => refreshGate(input),
      spawnJest: (env, scrub) => runChild('npx', jestArgvFor(opts.jestArgs), env, 'Jest', scrub),
      writeMarker: (input) => writeRetentionMarker(input),
    });
  } catch (error) {
    console.error(scrubber.scrub(error instanceof GateError ? error.message : String(error)));
    return 1;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; });
}
