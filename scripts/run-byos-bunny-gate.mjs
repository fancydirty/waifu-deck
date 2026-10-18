#!/usr/bin/env node
/**
 * BYOS integration gate against real Bunny Edge Storage (S3-compatible API) —
 * the same suites `verify:byos-minio` / `verify:byos-r2` / `verify:byos-wasabi`
 * run, unmodified, pointed at a throwaway Bunny storage zone. Owner decision
 * 2026-09-16 (option A): third-party S3 stores are documented from measured
 * gate results, not assumed — Bunny gets the same full run Wasabi got.
 *
 * Bunny specifics (https://bunny.net/docs/storage/s3): a storage zone IS the
 * bucket; Access Key ID = zone name, Secret = zone password; endpoint
 * `https://<region>-s3.storage.bunnycdn.com`, SigV4 region = short code
 * (`de`, `ny`, `la`, `sg`, ...). S3 support can only be enabled at zone
 * creation (`StorageZoneType: 1`), so the zone is created/deleted through the
 * account API (`api.bunny.net`, header `AccessKey`).
 *
 * Credentials: the account API key is read from ~/projects/token.txt
 * (`bunny-api-key=…`) or `BUNNY_API_KEY`. The zone password comes back from
 * the create call. None of them is ever printed; every byte Jest emits is
 * scrubbed. After Jest, `scripts/byos-conditional-write-probe.mjs` runs
 * against the same zone so the conditional-write atomicity numbers are
 * directly comparable with the Wasabi ledger entry.
 */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TOKEN_FILE = path.join(homedir(), 'projects', 'token.txt');
const API_BASE = 'https://api.bunny.net';
const ZONE_REGION = (process.env.BUNNY_ZONE_REGION ?? 'DE').toUpperCase(); // DE | NY | LA | SG
const SIGV4_REGION = ZONE_REGION.toLowerCase();
const HOST = `${SIGV4_REGION}-s3.storage.bunnycdn.com`;
const ZONE_PREFIX = 'waifu-byos-it-';
const DELETE_CONCURRENCY = 8;
const READY_TIMEOUT_MS = 120_000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class GateError extends Error { constructor(m) { super(m); this.name = 'GateError'; } }
const secrets = [];
const registerSecret = (v) => { if (v && v.length >= 8) secrets.push(v); };
const scrub = (t) => secrets.reduce((o, s) => o.split(s).join('<REDACTED>'), t);
const say = (l) => process.stdout.write(`${scrub(l)}\n`);
const warn = (l) => process.stderr.write(`${scrub(l)}\n`);

function readApiKey() {
  if (process.env.BUNNY_API_KEY) { registerSecret(process.env.BUNNY_API_KEY); return process.env.BUNNY_API_KEY; }
  let text;
  try { text = readFileSync(TOKEN_FILE, 'utf8'); }
  catch (e) { throw new GateError(`Could not read ${TOKEN_FILE}: ${e.message}`); }
  const line = text.split('\n').find((l) => l.startsWith('bunny-api-key='));
  const key = line?.slice('bunny-api-key='.length).trim();
  if (!key) throw new GateError(`${TOKEN_FILE} has no bunny-api-key= line`);
  registerSecret(key);
  return key;
}

async function bunnyApi(apiKey, method, route, body) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}${route}`, {
        method,
        headers: { AccessKey: apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.status >= 500) throw new GateError(`${method} ${route} → ${res.status}: ${scrub(text).slice(0, 200)}`);
      return { status: res.status, text, json: text ? safeJson(text) : null };
    } catch (error) { last = error; await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); }
  }
  throw last;
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

const hmac = (k, d) => createHmac('sha256', k).update(d, 'utf8').digest();
const sha256Hex = (d) => createHash('sha256').update(d).digest('hex');
function uriEncode(value, keepSlashes) {
  let out = '';
  for (const ch of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9_.~-]/.test(c) || (keepSlashes && c === '/')) out += c;
    else out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}
/** Setup/teardown S3 calls retry transport-level drops; the production signer is the subject of the suites. */
async function s3(args) {
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await s3Once(args); }
    catch (error) { last = error; await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); }
  }
  throw last;
}
async function s3Once({ method, key = '', query = {}, body = '', accessKeyId, secretAccessKey }) {
  const canonicalUri = key === '' ? '/' : `/${uriEncode(key, true)}`;
  const canonicalQuery = Object.keys(query).sort()
    .map((n) => `${uriEncode(n, false)}=${uriEncode(String(query[n]), false)}`).join('&');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = { host: HOST, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonicalRequest = [method, canonicalUri, canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${SIGV4_REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), SIGV4_REGION), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const url = `https://${HOST}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  return fetch(url, { method, body: body || undefined, headers: { ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` } });
}
function parseListing(xml) {
  const items = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, b]) => ({
    key: (/<Key>([\s\S]*?)<\/Key>/.exec(b)?.[1] ?? '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'"),
    size: Number.parseInt(/<Size>([\s\S]*?)<\/Size>/.exec(b)?.[1] ?? '0', 10),
  }));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const cursor = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  return { items, continuationToken: truncated ? cursor?.[1] : undefined };
}
async function emptyZone(creds, bucket) {
  let token; let deleted = 0; let zeroSize = 0; let listed = 0; const zeroKeys = [];
  do {
    const r = await s3({ ...creds, method: 'GET', key: bucket, query: { 'list-type': 2, ...(token ? { 'continuation-token': token } : {}) } });
    const body = await r.text();
    if (!r.ok) throw new GateError(`ListObjectsV2 ${bucket} failed (${r.status}): ${scrub(body).slice(0, 300)}`);
    const listing = parseListing(body);
    listed += listing.items.length;
    for (const i of listing.items) if (i.size === 0) { zeroSize += 1; if (zeroKeys.length < 5) zeroKeys.push(i.key); }
    for (let i = 0; i < listing.items.length; i += DELETE_CONCURRENCY) {
      const batch = listing.items.slice(i, i + DELETE_CONCURRENCY);
      const rs = await Promise.all(batch.map((it) => s3({ ...creds, method: 'DELETE', key: `${bucket}/${it.key}` })));
      rs.forEach((res, j) => { if (!res.ok && res.status !== 404 && res.status !== 204) throw new GateError(`DeleteObject ${batch[j].key} failed (${res.status})`); deleted += 1; });
    }
    token = listing.continuationToken;
  } while (token);
  return { listed, deleted, zeroSize, zeroKeys };
}
async function waitUntilReady(creds, bucket) {
  const started = Date.now();
  let lastStatus = 'n/a';
  while (Date.now() - started < READY_TIMEOUT_MS) {
    try {
      const r = await s3Once({ ...creds, method: 'GET', key: bucket, query: { 'list-type': 2, 'max-keys': 1 } });
      lastStatus = String(r.status);
      if (r.ok) return Date.now() - started;
      await r.text();
    } catch (e) { lastStatus = `transport: ${e.message}`; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new GateError(`Zone ${bucket} never became reachable over S3 within ${READY_TIMEOUT_MS} ms (last: ${lastStatus})`);
}
function runChild(cmd, argv, env, label) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: repoRoot, stdio: ['inherit', 'pipe', 'pipe'], env });
    const forward = (stream, sink) => { let carry = ''; stream.setEncoding('utf8');
      stream.on('data', (chunk) => { const t = carry + chunk; const cut = t.lastIndexOf('\n'); if (cut === -1) { carry = t; return; } carry = t.slice(cut + 1); sink.write(scrub(t.slice(0, cut + 1))); });
      stream.on('end', () => { if (carry) sink.write(scrub(carry)); }); };
    forward(child.stdout, process.stdout); forward(child.stderr, process.stderr);
    child.on('error', (e) => { warn(`Failed to start ${label}: ${e.message}`); resolve(1); });
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}
async function main() {
  const apiKey = readApiKey();
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const zoneName = `${ZONE_PREFIX}${runId}`;
  say(`Creating Bunny storage zone ${zoneName} (region ${ZONE_REGION}, S3 enabled) …`);
  const created = await bunnyApi(apiKey, 'POST', '/storagezone', {
    Name: zoneName, Region: ZONE_REGION, StorageZoneType: 1,
    ...(process.env.BUNNY_ZONE_TIER ? { ZoneTier: Number(process.env.BUNNY_ZONE_TIER) } : {}),
  });
  if (created.status !== 201 || !created.json?.Id || !created.json?.Password) {
    throw new GateError(`Create zone failed (${created.status}): ${scrub(created.text).slice(0, 300)}`);
  }
  const zone = created.json;
  registerSecret(zone.Password); registerSecret(zone.ReadOnlyPassword);
  const creds = { accessKeyId: zone.Name, secretAccessKey: zone.Password };
  const bucket = zone.Name;
  say(`Zone id ${zone.Id} created; S3Hostname=${zone.S3Hostname ?? '(unset)'}; StorageZoneType=${zone.StorageZoneType}.`);
  let exitCode = 1; let removed = false;
  const teardown = async () => {
    if (removed) return;
    if (!bucket.startsWith(ZONE_PREFIX)) throw new GateError(`Refusing to delete unexpected zone ${bucket}`);
    let stats = { listed: 0, deleted: 0, zeroSize: 0, zeroKeys: [] };
    try { stats = await emptyZone(creds, bucket); }
    catch (e) { warn(`Emptying zone over S3 failed (${e.message}); deleting the zone anyway.`); }
    const del = await bunnyApi(apiKey, 'DELETE', `/storagezone/${zone.Id}`);
    if (del.status !== 204 && del.status !== 404) throw new GateError(`DeleteStorageZone ${zone.Id} failed (${del.status}): ${scrub(del.text).slice(0, 200)}`);
    removed = true;
    say(`Deleted zone ${bucket} (id ${zone.Id}): ${stats.listed} keys listed, ${stats.deleted} removed; ${stats.zeroSize} zero-size listing entries` +
      (stats.zeroSize ? ` — directory-marker signal, e.g. ${stats.zeroKeys.map((k) => JSON.stringify(k)).join(', ')}` : '') + '.');
  };
  const onSignal = () => { teardown().catch((e) => warn(`Teardown after signal failed: ${e.message}`)).finally(() => process.exit(130)); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    const readyMs = await waitUntilReady(creds, bucket);
    say(`Bunny ready at https://${HOST}, zone/bucket ${bucket}, SigV4 region ${SIGV4_REGION} (reachable after ${readyMs} ms).`);
    const env = { ...process.env,
      BYOS_IT_ENDPOINT: `https://${HOST}`, BYOS_IT_BUCKET: bucket,
      BYOS_IT_ACCESS_KEY: creds.accessKeyId, BYOS_IT_SECRET: creds.secretAccessKey,
      BYOS_IT_PREFIX: `it/${runId}/`, BYOS_IT_REGION: SIGV4_REGION };
    exitCode = await runChild('npx', ['jest', '--config', 'jest.integration.config.js', ...process.argv.slice(2)], env, 'Jest');
    if (process.env.BYOS_GATE_PROBE !== '0') {
      say('--- conditional-write atomicity probe (same zone) ---');
      const probeCode = await runChild('node', ['scripts/byos-conditional-write-probe.mjs'], env, 'probe');
      if (probeCode !== 0) warn(`Probe exited ${probeCode} (informational; does not change the gate result).`);
    }
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    try { await teardown(); } catch (e) { warn(`Zone teardown failed — zone ${bucket} (id ${zone.Id}) may still exist: ${e.message}`); exitCode = exitCode === 0 ? 1 : exitCode; }
  }
  return exitCode;
}
main().then((code) => { process.exitCode = code; }, (e) => { warn(e instanceof GateError ? e.message : String(e?.stack ?? e)); process.exitCode = 1; });
