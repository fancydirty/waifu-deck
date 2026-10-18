#!/usr/bin/env node
/**
 * Runs the BYOS integration gate against a throwaway bucket on real
 * Cloudflare R2 — the same suites `verify:byos-minio` runs, unmodified,
 * pointed at the backend a user would actually bring.
 *
 * Credentials come from a Cloudflare API token with R2 permissions: either
 * `CLOUDFLARE_API_TOKEN`, or the `<BYOS_R2_TOKEN_KEY>=` line of the file at
 * `BYOS_R2_TOKEN_FILE`, kept outside the repository. The token value is never written to
 * disk, committed, or printed: it lives in this process and in the child's
 * environment only, and every byte this script forwards from Jest is scrubbed.
 *
 * R2's S3 API does not take a Cloudflare API token as a bearer credential, and
 * it does not need a separately minted R2 access key either: an API token with
 * R2 permissions doubles as an S3 credential pair, where the Access Key ID is
 * the token's id (from the token-verify endpoint) and the Secret Access Key is
 * the SHA-256 hex digest of the token value. That derivation, with region
 * `auto`, is what this gate uses.
 *
 * The SigV4 signer below is harness code for bucket setup and teardown only —
 * the production signer is the subject of the suites, never their scaffolding.
 */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TOKEN_PATH = process.env.BYOS_R2_TOKEN_FILE ?? path.join(homedir(), 'projects', 'token.txt');
const TOKEN_KEY = process.env.BYOS_R2_TOKEN_KEY ?? 'cloudflare-api-token';
const CF_API = 'https://api.cloudflare.com/client/v4';
const REGION = 'auto';
/** Every bucket this gate is allowed to create *or* destroy starts with this. */
const BUCKET_PREFIX = 'waifu-deck-p5-';
const DELETE_CONCURRENCY = 16;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

/* ---------------------------------------------------------------- secrets -- */

/** Values scrubbed out of anything this process prints or forwards. */
const secrets = [];

function registerSecret(value) {
  if (value && value.length >= 8) secrets.push(value);
}

function scrub(text) {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('<REDACTED>');
  return out;
}

const say = (line) => process.stdout.write(`${scrub(line)}\n`);
const warn = (line) => process.stderr.write(`${scrub(line)}\n`);

function readToken() {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) {
    registerSecret(fromEnv);
    return fromEnv;
  }
  let contents;
  try {
    contents = readFileSync(TOKEN_PATH, 'utf8');
  } catch (error) {
    throw new GateError(
      `Could not read the Cloudflare token file at ${TOKEN_PATH}: ${error.message}`,
    );
  }
  const prefix = `${TOKEN_KEY}=`;
  const line = contents.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    throw new GateError(`${TOKEN_PATH} has no \`${TOKEN_KEY}=\` line.`);
  }
  const token = line.slice(prefix.length).trim();
  if (!token) {
    throw new GateError(`The \`${TOKEN_KEY}\` line in ${TOKEN_PATH} is empty.`);
  }
  registerSecret(token);
  return token;
}

/* ------------------------------------------------------- cloudflare rest -- */

async function cloudflare(token, method, endpoint, body) {
  const response = await fetch(`${CF_API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new GateError(
      `${method} ${endpoint} returned non-JSON (${response.status}): `
      + `${scrub(text).slice(0, 300)}`,
    );
  }
  if (!response.ok || payload.success === false) {
    const detail = (payload.errors ?? [])
      .map((error) => `${error.code}: ${error.message}`).join('; ');
    throw new GateError(
      `${method} ${endpoint} failed (${response.status}): ${detail || 'unknown error'}`,
    );
  }
  return payload.result;
}

/* -------------------------------------------------------------- s3 sigv4 -- */

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** RFC 3986 encoding; SigV4 canonical paths keep `/` unescaped. */
function uriEncode(value, keepSlashes) {
  let out = '';
  for (const char of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(char);
    if (/[A-Za-z0-9_.~-]/.test(c) || (keepSlashes && c === '/')) out += c;
    else out += `%${char.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Signs and sends an empty-payload S3 request. Teardown only ever needs GET
 * (list) and DELETE (object), both of which have no body.
 */
async function s3(args) {
  // Setup/teardown only: a connection the link closes without a response is
  // retried, not fatal (2026-09-16: one drop left a gate bucket behind).
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await s3Once(args); }
    catch (error) { last = error; await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); }
  }
  throw last;
}

async function s3Once(
  { method, host, key = '', query = {}, accessKeyId, secretAccessKey },
) {
  const canonicalUri = key === '' ? '/' : `/${uriEncode(key, true)}`;
  const canonicalQuery = Object.keys(query).sort()
    .map((name) => `${uriEncode(name, false)}=${uriEncode(String(query[name]), false)}`)
    .join('&');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex('');
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    names.map((name) => `${name}:${headers[name]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), REGION), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8').digest('hex');
  const url = `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  return fetch(url, {
    method,
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
        + `SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
  });
}

/** Pulls `<Key>` values and the truncation cursor out of a ListObjectsV2 body. */
function parseListing(xml) {
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map(([, key]) => key
    .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'"));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const cursor = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  return { keys, continuationToken: truncated ? cursor?.[1] : undefined };
}

/**
 * Empties the bucket. R2 refuses to delete a bucket that still holds objects,
 * so teardown cannot be a single call.
 */
async function emptyBucket(credentials, bucket) {
  const host = `${credentials.accountHost}`;
  let continuationToken;
  let deleted = 0;
  do {
    const response = await s3({
      ...credentials,
      method: 'GET',
      host,
      key: bucket,
      query: {
        'list-type': 2,
        ...(continuationToken ? { 'continuation-token': continuationToken } : {}),
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new GateError(
        `ListObjectsV2 on ${bucket} failed (${response.status}): `
        + `${scrub(body).slice(0, 300)}`,
      );
    }
    const listing = parseListing(body);
    for (let index = 0; index < listing.keys.length; index += DELETE_CONCURRENCY) {
      const batch = listing.keys.slice(index, index + DELETE_CONCURRENCY);
      const results = await Promise.all(batch.map((key) => s3({
        ...credentials, method: 'DELETE', host, key: `${bucket}/${key}`,
      })));
      for (const [offset, result] of results.entries()) {
        // 404 means a concurrent delete already won; the object is gone either way.
        if (!result.ok && result.status !== 404) {
          throw new GateError(
            `DeleteObject ${batch[offset]} failed (${result.status}).`,
          );
        }
        deleted += 1;
      }
    }
    continuationToken = listing.continuationToken;
  } while (continuationToken);
  return deleted;
}

/* ----------------------------------------------------------------- jest --- */

/**
 * Runs Jest with the child's output piped through the scrubber rather than
 * inherited, so a failing assertion that happens to render the transport
 * config cannot leak the derived secret into a terminal or CI log.
 */
function runChild(command, argv, env, label) {
  return new Promise((resolve) => {
    const child = spawn(
      command,
      argv,
      { cwd: repoRoot, stdio: ['inherit', 'pipe', 'pipe'], env },
    );
    const forward = (stream, sink) => {
      let carry = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const text = carry + chunk;
        const cut = text.lastIndexOf('\n');
        if (cut === -1) {
          carry = text;
          return;
        }
        carry = text.slice(cut + 1);
        sink.write(scrub(text.slice(0, cut + 1)));
      });
      stream.on('end', () => {
        if (carry) sink.write(scrub(carry));
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('error', (error) => {
      warn(`Failed to start ${label}: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

function runJest(env) {
  return runChild('npx', ['jest', '--config', 'jest.integration.config.js', ...process.argv.slice(2)], env, 'Jest');
}

/* ----------------------------------------------------------------- main --- */

async function main() {
  const token = readToken();

  const verified = await cloudflare(token, 'GET', '/user/tokens/verify');
  if (verified.status !== 'active') {
    throw new GateError(`The Cloudflare token is ${verified.status}, not active.`);
  }
  // The token id doubles as the S3 Access Key ID; the secret is its digest.
  const accessKeyId = verified.id;
  const secretAccessKey = sha256Hex(token);
  registerSecret(secretAccessKey);

  const accounts = await cloudflare(token, 'GET', '/accounts');
  if (accounts.length !== 1) {
    throw new GateError(
      `Expected exactly one Cloudflare account for this token, found ${accounts.length}. `
      + 'Set the account explicitly before running this gate.',
    );
  }
  const accountId = accounts[0].id;
  const accountHost = `${accountId}.r2.cloudflarestorage.com`;
  const credentials = { accessKeyId, secretAccessKey, accountHost };

  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const bucket = `${BUCKET_PREFIX}${runId}`;
  say(`Creating R2 bucket ${bucket} …`);
  await cloudflare(token, 'POST', `/accounts/${accountId}/r2/buckets`, { name: bucket });

  let exitCode = 1;
  let removed = false;
  const teardown = async () => {
    if (removed) return;
    // Never let a bug here reach a bucket this gate did not create.
    if (!bucket.startsWith(BUCKET_PREFIX)) {
      throw new GateError(`Refusing to delete unexpected bucket ${bucket}.`);
    }
    const deleted = await emptyBucket(credentials, bucket);
    await cloudflare(token, 'DELETE', `/accounts/${accountId}/r2/buckets/${bucket}`);
    removed = true;
    say(`Deleted bucket ${bucket} (${deleted} objects removed).`);
  };
  const onSignal = () => {
    teardown().catch((error) => warn(`Teardown after signal failed: ${error.message}`))
      .finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    say(`R2 ready at https://${accountHost}, bucket ${bucket}, region ${REGION}.`);
    const env = {
      ...process.env,
      BYOS_IT_ENDPOINT: `https://${accountHost}`,
      BYOS_IT_BUCKET: bucket,
      BYOS_IT_ACCESS_KEY: accessKeyId,
      BYOS_IT_SECRET: secretAccessKey,
      BYOS_IT_PREFIX: `it/${runId}/`,
      BYOS_IT_REGION: REGION,
    };
    exitCode = await runJest(env);
    if (process.env.BYOS_GATE_PROBE !== '0') {
      // Same instrument every store gate ends with (MinIO / R2 / Wasabi / Bunny).
      say('--- conditional-write atomicity probe (same bucket) ---');
      const probeCode = await runChild('node', ['scripts/byos-conditional-write-probe.mjs'], env, 'probe');
      if (probeCode !== 0) warn(`Probe exited ${probeCode} (informational; does not change the gate result).`);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    try {
      await teardown();
    } catch (error) {
      warn(`Bucket teardown failed — ${bucket} may still exist: ${error.message}`);
      exitCode = exitCode === 0 ? 1 : exitCode;
    }
  }
  return exitCode;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    warn(error instanceof GateError ? error.message : String(error?.stack ?? error));
    process.exitCode = 1;
  },
);
