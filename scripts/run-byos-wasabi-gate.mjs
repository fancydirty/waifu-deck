#!/usr/bin/env node
/**
 * BYOS integration gate against real Wasabi (S3-compatible) — the same suites
 * `verify:byos-minio` / `verify:byos-r2` run, unmodified, pointed at a
 * throwaway Wasabi bucket. Owner ask 2026-09-16: "咱们想支持的是完全 s3，而非只是
 * s3 中的 cf r2，所以要本着适配去" — a third-party S3 must pass the same gate.
 *
 * Credentials: $WASABI_CREDS_PATH (default ~/waifu-acc/wasabi.json) {accessKeyId, secretAccessKey} (0600,
 * owner-provided test keys). Never printed; every byte Jest emits is scrubbed.
 * Bucket lifecycle is plain S3 (PUT bucket → suites → list+delete → DELETE
 * bucket); the SigV4 below is harness code for setup/teardown only — the
 * production signer is the subject of the suites.
 */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 2026-09-16: /tmp is wiped on reboot (it took the first copy of these keys with it); keep them under $HOME.
const CREDS_PATH = process.env.WASABI_CREDS_PATH
  ?? `${process.env.HOME ?? ''}/waifu-acc/wasabi.json`;
const REGION = process.env.WASABI_REGION ?? 'us-east-1';
const HOST = `s3.${REGION}.wasabisys.com`;
const BUCKET_PREFIX = 'waifu-byos-it-';
const DELETE_CONCURRENCY = 8;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class GateError extends Error { constructor(m) { super(m); this.name = 'GateError'; } }
const secrets = [];
const registerSecret = (v) => { if (v && v.length >= 8) secrets.push(v); };
const scrub = (t) => secrets.reduce((o, s) => o.split(s).join('<REDACTED>'), t);
const say = (l) => process.stdout.write(`${scrub(l)}\n`);
const warn = (l) => process.stderr.write(`${scrub(l)}\n`);

function readCreds() {
  let parsed;
  try { parsed = JSON.parse(readFileSync(CREDS_PATH, 'utf8')); }
  catch (e) { throw new GateError(`Could not read ${CREDS_PATH}: ${e.message}`); }
  const { accessKeyId, secretAccessKey } = parsed;
  if (!accessKeyId || !secretAccessKey) throw new GateError(`${CREDS_PATH} lacks accessKeyId/secretAccessKey`);
  registerSecret(accessKeyId); registerSecret(secretAccessKey);
  return { accessKeyId, secretAccessKey };
}

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
/** Wasabi closes ~1 in 25 connections without a response; setup/teardown retries those. */
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
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), REGION), 's3'), 'aws4_request');
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
async function emptyBucket(creds, bucket) {
  let token; let deleted = 0; let zeroSize = 0;
  do {
    const r = await s3({ ...creds, method: 'GET', key: bucket, query: { 'list-type': 2, ...(token ? { 'continuation-token': token } : {}) } });
    const body = await r.text();
    if (!r.ok) throw new GateError(`ListObjectsV2 ${bucket} failed (${r.status}): ${scrub(body).slice(0, 300)}`);
    const listing = parseListing(body);
    zeroSize += listing.items.filter((i) => i.size === 0).length;
    for (let i = 0; i < listing.items.length; i += DELETE_CONCURRENCY) {
      const batch = listing.items.slice(i, i + DELETE_CONCURRENCY);
      const rs = await Promise.all(batch.map((it) => s3({ ...creds, method: 'DELETE', key: `${bucket}/${it.key}` })));
      rs.forEach((res, j) => { if (!res.ok && res.status !== 404 && res.status !== 204) throw new GateError(`DeleteObject ${batch[j].key} failed (${res.status})`); deleted += 1; });
    }
    token = listing.continuationToken;
  } while (token);
  return { deleted, zeroSize };
}
function runJest(env) { return runChild('npx', ['jest', '--config', 'jest.integration.config.js', ...process.argv.slice(2)], env, 'Jest'); }
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
  const creds = readCreds();
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const bucket = `${BUCKET_PREFIX}${runId}`;
  say(`Creating Wasabi bucket ${bucket} in ${REGION} …`);
  const created = await s3({ ...creds, method: 'PUT', key: bucket });
  if (!created.ok) throw new GateError(`CreateBucket ${bucket} failed (${created.status}): ${scrub(await created.text()).slice(0, 300)}`);
  let exitCode = 1; let removed = false;
  const teardown = async () => {
    if (removed) return;
    if (!bucket.startsWith(BUCKET_PREFIX)) throw new GateError(`Refusing to delete unexpected bucket ${bucket}`);
    const { deleted, zeroSize } = await emptyBucket(creds, bucket);
    const del = await s3({ ...creds, method: 'DELETE', key: bucket });
    if (!del.ok && del.status !== 404) throw new GateError(`DeleteBucket ${bucket} failed (${del.status}): ${scrub(await del.text()).slice(0, 200)}`);
    removed = true;
    say(`Deleted bucket ${bucket} (${deleted} objects removed; ${zeroSize} zero-size listing entries seen — a Bunny-class directory-marker signal if > 0).`);
  };
  const onSignal = () => { teardown().catch((e) => warn(`Teardown after signal failed: ${e.message}`)).finally(() => process.exit(130)); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    say(`Wasabi ready at https://${HOST}, bucket ${bucket}, region ${REGION}.`);
    const env = { ...process.env,
      BYOS_IT_ENDPOINT: `https://${HOST}`, BYOS_IT_BUCKET: bucket,
      BYOS_IT_ACCESS_KEY: creds.accessKeyId, BYOS_IT_SECRET: creds.secretAccessKey,
      BYOS_IT_PREFIX: `it/${runId}/`, BYOS_IT_REGION: REGION };
    exitCode = await runJest(env);
    if (process.env.BYOS_GATE_PROBE !== '0') {
      // Same instrument every store gate ends with (MinIO / R2 / Wasabi / Bunny).
      say('--- conditional-write atomicity probe (same bucket) ---');
      const probeCode = await runChild('node', ['scripts/byos-conditional-write-probe.mjs'], env, 'probe');
      if (probeCode !== 0) warn(`Probe exited ${probeCode} (informational; does not change the gate result).`);
    }
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    try { await teardown(); } catch (e) { warn(`Bucket teardown failed — ${bucket} may still exist: ${e.message}`); exitCode = exitCode === 0 ? 1 : exitCode; }
  }
  return exitCode;
}
main().then((code) => { process.exitCode = code; }, (e) => { warn(e instanceof GateError ? e.message : String(e?.stack ?? e)); process.exitCode = 1; });
