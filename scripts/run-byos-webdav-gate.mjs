#!/usr/bin/env node
/**
 * P12-B WebDAV gate (spec §8 (a)(b)(c)): runs the real-backend WebDAV suites
 * (`src/integration/webdav-*.integration.test.ts` — the reusable CloudObjectStore
 * contract, the append-only two-device convergence, and the 2 MiB speed line)
 * against ONE of three backends:
 *
 *   --backend docker   a throwaway hacdias/webdav:v5 container on a loopback port
 *                      (generated user/password, temp data dir; always stopped)
 *   --backend nas      a Synology NAS (Apache mod_dav) via cloudflared,
 *                      creds from secrets/nas-webdav.json
 *   --backend 123      123 云盘's official WebDAV, creds from secrets/123-webdav.json
 *
 * Credentials never reach stdout: every byte Jest emits is scrubbed of the
 * username and password before it is forwarded (same technique as the Wasabi
 * gate). For the two real backends a dated retention marker is PUT under the
 * root after the suites, and its URL printed, so the one-week "content still
 * there" check (spec §8) has something to read back.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const IMAGE = 'hacdias/webdav:v5';
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 250;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class GateError extends Error { constructor(m) { super(m); this.name = 'GateError'; } }

const args = process.argv.slice(2);
const bi = args.indexOf('--backend');
const backend = bi === -1 ? 'docker' : args[bi + 1];
const jestArgs = args.filter((_, i) => i !== bi && i !== bi + 1);
if (!['docker', 'nas', '123'].includes(backend)) {
  console.error('usage: node scripts/run-byos-webdav-gate.mjs [--backend docker|nas|123] [jest args]');
  process.exit(2);
}

const secrets = [];
const registerSecret = (v) => { if (typeof v === 'string' && v.length >= 4) secrets.push(v); };
const scrub = (t) => secrets.reduce((o, s) => o.split(s).join('<REDACTED>'), t);
const say = (l) => process.stdout.write(`${scrub(l)}\n`);

function docker(dockerArgs, { check = true } = {}) {
  const result = spawnSync('docker', dockerArgs, { encoding: 'utf8' });
  if (result.error) throw new GateError(`Could not run docker: ${result.error.message}. This gate needs a working Docker daemon (OrbStack or Docker Desktop).`);
  if (check && result.status !== 0) throw new GateError(`docker ${dockerArgs.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result;
}

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

async function waitForDav(baseUrl, username, password) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/`, { method: 'PROPFIND', headers: { authorization: basic(username, password), depth: '0' } });
      if (r.status === 207) return;
      last = `PROPFIND returned ${r.status}`;
    } catch (e) { last = e.message; }
    await delay(HEALTH_INTERVAL_MS);
  }
  throw new GateError(`WebDAV did not answer PROPFIND 207 within ${HEALTH_TIMEOUT_MS} ms (${last}).`);
}

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
    child.on('error', (error) => { console.error(`Failed to start ${label}: ${error.message}`); resolve(1); });
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

function runJest(env) {
  return runChild('npx', ['jest', '--config', 'jest.integration.config.js', 'src/integration/webdav-', ...jestArgs], env, 'Jest');
}

async function backendEnv() {
  if (backend === 'docker') {
    docker(['version', '--format', '{{.Server.Version}}']);
    const runId = randomBytes(4).toString('hex');
    const username = `wd${runId}`;
    const password = randomBytes(18).toString('base64url');
    registerSecret(password);
    const dir = mkdtempSync(path.join(tmpdir(), 'waifu-webdav-gate-'));
    writeFileSync(path.join(dir, 'config.yml'), `address: 0.0.0.0\nport: 6065\ndirectory: /data\npermissions: CRUD\ndebug: false\nusers:\n  - username: ${username}\n    password: ${password}\n`);
    const name = `waifu-webdav-gate-${runId}`;
    say(`Starting ${IMAGE} as ${name} …`);
    const started = docker(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::6065', '-v', `${path.join(dir, 'config.yml')}:/config.yml:ro`, '-v', `${path.join(dir, 'data')}:/data`, IMAGE, '-c', '/config.yml']);
    const containerId = started.stdout.trim();
    const mapping = docker(['port', containerId, '6065/tcp']).stdout.split('\n')[0].trim();
    const port = mapping.slice(mapping.lastIndexOf(':') + 1);
    if (!/^\d+$/.test(port)) { docker(['stop', '-t', '2', containerId], { check: false }); throw new GateError(`Could not read the published port from "${mapping}".`); }
    const baseUrl = `http://127.0.0.1:${port}`;
    try { await waitForDav(baseUrl, username, password); }
    catch (e) { docker(['stop', '-t', '2', containerId], { check: false }); throw e; }
    say(`WebDAV ready at ${baseUrl}.`);
    return {
      env: { BYOS_WEBDAV_BASE_URL: baseUrl, BYOS_WEBDAV_USERNAME: username, BYOS_WEBDAV_PASSWORD: password, BYOS_WEBDAV_ROOT: '/', BYOS_WEBDAV_LABEL: 'docker hacdias/webdav' },
      stop: () => docker(['stop', '-t', '2', containerId], { check: false }),
      logs: () => docker(['logs', '--tail', '40', containerId], { check: false }),
      marker: false,
    };
  }
  const file = backend === 'nas' ? 'secrets/nas-webdav.json' : 'secrets/123-webdav.json';
  let c;
  try { c = JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8')); }
  catch (e) { throw new GateError(`Could not read ${file}: ${e.message}`); }
  if (!c.baseUrl || !c.username || !c.password) throw new GateError(`${file} lacks baseUrl/username/password`);
  registerSecret(c.password); registerSecret(c.username);
  return {
    env: { BYOS_WEBDAV_BASE_URL: c.baseUrl, BYOS_WEBDAV_USERNAME: c.username, BYOS_WEBDAV_PASSWORD: c.password, BYOS_WEBDAV_ROOT: c.rootPath ?? '/', BYOS_WEBDAV_LABEL: backend === 'nas' ? 'owner NAS (Synology mod_dav via cloudflared)' : '123 云盘 official WebDAV' },
    stop: () => {},
    logs: () => null,
    marker: true,
  };
}

/** Spec §8: a dated file that the one-week retention check reads back. */
async function putRetentionMarker(env) {
  const root = (env.BYOS_WEBDAV_ROOT ?? '/').replace(/\/+$/, '');
  const base = `${env.BYOS_WEBDAV_BASE_URL.replace(/\/+$/, '')}${root}`;
  const auth = basic(env.BYOS_WEBDAV_USERNAME, env.BYOS_WEBDAV_PASSWORD);
  const date = new Date().toISOString().slice(0, 10);
  await fetch(`${base}/waifu-deck-retention/`, { method: 'MKCOL', headers: { authorization: auth } }).catch(() => null);
  const target = `${base}/waifu-deck-retention/${date}.txt`;
  const r = await fetch(target, { method: 'PUT', headers: { authorization: auth, 'content-type': 'text/plain' }, body: `P12-B WebDAV gate ${backend} ${new Date().toISOString()}\n` });
  say(`retention marker: PUT ${target} → ${r.status} (re-check on ${new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)})`);
}

async function main() {
  const b = await backendEnv();
  const onSignal = () => { b.stop(); process.exit(130); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let exitCode = 1;
  try {
    exitCode = await runJest({ ...process.env, ...b.env });
    if (b.marker) await putRetentionMarker(b.env);
    if (exitCode !== 0) {
      const logs = b.logs();
      if (logs) { console.error('--- WebDAV container logs (tail) ---'); console.error(scrub((logs.stdout || '') + (logs.stderr || ''))); }
    }
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    b.stop();
  }
  return exitCode;
}

main().then((code) => { process.exitCode = code; }, (error) => { console.error(error instanceof GateError ? error.message : error); process.exitCode = 1; });
