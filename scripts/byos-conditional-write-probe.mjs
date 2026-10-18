#!/usr/bin/env node
/**
 * Conditional-write atomicity probe for an S3-compatible store, parameterized
 * by the same BYOS_IT_* environment as the integration suites. It measures the
 * two guarantees the BYOS sync protocol relies on (2026-08-28 spec §1) under
 * TRUE concurrency, and prints an outcome histogram:
 *
 *   1. create race — two writers PUT the same fresh key with `If-None-Match: *`
 *      at the same instant. Atomic store: exactly one 200 and one 412.
 *   2. CAS race — two writers PUT the same key with `If-Match: <same ETag>`.
 *      Atomic store: one 200, one 412. (200,200) = a lost update.
 *
 * Plus the sequential sanity checks (duplicate create → 412, stale If-Match →
 * 412, read-after-write) so a store's failure mode can be classified. This is
 * harness code: it carries its own SigV4 signer so a signer bug in production
 * code cannot mask a store property. Output is informational; the caller gate
 * scrubs it. Probe keys are deleted at the end.
 *
 * Exit codes: 0 ATOMIC · 3 NON-ATOMIC · 4 INCONCLUSIVE (too few decided races)
 * · 1 crash · 2 missing env. The store gates print the result and do not fail
 * on it; the numbers belong in the ledger / docs/storage-backends.md table.
 */
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const endpoint = process.env.BYOS_IT_ENDPOINT ?? '';
const bucket = process.env.BYOS_IT_BUCKET ?? '';
const accessKeyId = process.env.BYOS_IT_ACCESS_KEY ?? '';
const secretAccessKey = process.env.BYOS_IT_SECRET ?? '';
const prefix = process.env.BYOS_IT_PREFIX ?? '';
const region = process.env.BYOS_IT_REGION ?? 'us-east-1';
const RACES = Number(process.env.PROBE_RACES ?? 30);
if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  process.stderr.write('BYOS_IT_ENDPOINT/BYOS_IT_BUCKET/BYOS_IT_ACCESS_KEY/BYOS_IT_SECRET are required.\n');
  process.exit(2);
}
// Scheme AND host come from the endpoint: MinIO is plain http on loopback.
// (2026-09-16 drift review: a hardcoded https:// made every MinIO request fail
// at the TLS layer and the old verdict rule certified "ATOMIC" from zero
// decided races. Neither may happen again — see MIN_DECIDED_RACES.)
const ORIGIN = new URL(endpoint).origin;
const HOST = new URL(endpoint).host;
/** A verdict needs at least this many races where BOTH writers got a real status. */
const MIN_DECIDED_RACES = Math.max(1, Math.ceil(RACES * 0.8));

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
/** One signed request. `extra` headers are signed too (If-Match / If-None-Match). */
async function s3(method, key, { body = '', extra = {} } = {}) {
  const canonicalUri = `/${uriEncode(`${bucket}/${key}`, true)}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = { host: HOST, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])) };
  const names = Object.keys(headers).sort();
  const canonicalRequest = [method, canonicalUri, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const res = await fetch(`${ORIGIN}${canonicalUri}`, { method, body: body || undefined, headers: { ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` } });
  const text = method === 'GET' ? await res.text() : (await res.arrayBuffer(), '');
  return { status: res.status, etag: res.headers.get('etag') ?? '', text };
}
/** A closed-without-response connection is a transport drop, recorded as status 0 rather than aborting the histogram. */
async function tryS3(...args) { try { return await s3(...args); } catch (e) { return { status: 0, etag: '', text: '', error: e.message }; } }

const pairKey = (a, b) => `(${[a, b].sort((x, y) => y - x).join(',')})`;
const bump = (h, k) => { h[k] = (h[k] ?? 0) + 1; };
const fmt = (h) => Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');

async function main() {
  const keys = [];
  const mk = (tag) => { const k = `${prefix}probe/${tag}-${randomUUID()}`; keys.push(k); return k; };
  const summary = { store: HOST, races: RACES, drops: 0 };

  // Sequential sanity.
  const seq = mk('seq');
  const first = await tryS3('PUT', seq, { body: 'a', extra: { 'If-None-Match': '*' } });
  let dupe412 = 0; for (let i = 0; i < 10; i += 1) { const r = await tryS3('PUT', seq, { body: 'b', extra: { 'If-None-Match': '*' } }); if (r.status === 412) dupe412 += 1; }
  const stale = await tryS3('PUT', seq, { body: 'c', extra: { 'If-Match': '"0000deadbeef"' } });
  let staleReads = 0; for (let i = 0; i < 10; i += 1) { const w = await tryS3('PUT', seq, { body: `v${i}` }); const r = await tryS3('GET', seq); if (w.status === 200 && r.text !== `v${i}`) staleReads += 1; }
  summary.sequential = { firstCreate: first.status, duplicateCreate412: `${dupe412}/10`, staleIfMatch: stale.status, readAfterWriteStale: `${staleReads}/10` };

  // Create race.
  const createHist = {}; let createBothOk = 0; let createDecided = 0;
  for (let i = 0; i < RACES; i += 1) {
    const k = mk('create');
    const [a, b] = await Promise.all([
      tryS3('PUT', k, { body: 'writer-A', extra: { 'If-None-Match': '*' } }),
      tryS3('PUT', k, { body: 'writer-B', extra: { 'If-None-Match': '*' } }),
    ]);
    if (a.status === 0) summary.drops += 1; if (b.status === 0) summary.drops += 1;
    if (a.status !== 0 && b.status !== 0) createDecided += 1;
    bump(createHist, pairKey(a.status, b.status));
    if (a.status === 200 && b.status === 200) createBothOk += 1;
  }
  summary.createRace = { histogram: fmt(createHist), decided: `${createDecided}/${RACES}`, bothSucceeded: `${createBothOk}/${createDecided}` };

  // CAS race.
  const casHist = {}; let lost = 0; let casDecided = 0;
  for (let i = 0; i < RACES; i += 1) {
    const k = mk('cas');
    const base = await tryS3('PUT', k, { body: 'base' });
    if (base.status !== 200 || !base.etag) { bump(casHist, `setup-${base.status}`); if (base.status === 0) summary.drops += 1; continue; }
    const [a, b] = await Promise.all([
      tryS3('PUT', k, { body: 'writer-A', extra: { 'If-Match': base.etag } }),
      tryS3('PUT', k, { body: 'writer-B', extra: { 'If-Match': base.etag } }),
    ]);
    if (a.status === 0) summary.drops += 1; if (b.status === 0) summary.drops += 1;
    if (a.status !== 0 && b.status !== 0) casDecided += 1;
    bump(casHist, pairKey(a.status, b.status));
    if (a.status === 200 && b.status === 200) lost += 1;
  }
  summary.casRace = { histogram: fmt(casHist), decided: `${casDecided}/${RACES}`, lostUpdates: `${lost}/${casDecided}` };
  // A verdict is only ever drawn from races that actually completed on both
  // sides. Too few decided races (unreachable store, lossy link) → INCONCLUSIVE,
  // never ATOMIC by default.
  if (createDecided < MIN_DECIDED_RACES || casDecided < MIN_DECIDED_RACES) {
    summary.verdict = `INCONCLUSIVE: only ${createDecided}/${RACES} create and ${casDecided}/${RACES} CAS races were decided (need ${MIN_DECIDED_RACES}); no atomicity claim can be made from this run`;
  } else if (createBothOk === 0 && lost === 0) {
    summary.verdict = `ATOMIC: ${createDecided} create + ${casDecided} CAS races all produced exactly one winner (protocol assumption holds)`;
  } else {
    summary.verdict = 'NON-ATOMIC: concurrent conditional writes can both succeed (protocol assumption violated)';
  }

  // Cleanup.
  let cleaned = 0;
  for (let i = 0; i < keys.length; i += 8) { const rs = await Promise.all(keys.slice(i, i + 8).map((k) => tryS3('DELETE', k))); cleaned += rs.filter((r) => r.status === 204 || r.status === 200 || r.status === 404).length; }
  summary.cleanup = `${cleaned}/${keys.length} probe keys deleted`;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.verdict.startsWith('INCONCLUSIVE')) return 4;
  return summary.verdict.startsWith('ATOMIC') ? 0 : 3;
}
main().then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 1; });
