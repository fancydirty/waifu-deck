#!/usr/bin/env node
/**
 * Runs the BYOS integration gate against a throwaway MinIO container.
 *
 * Starts `minio/minio` on a Docker-assigned loopback port with generated root
 * credentials, waits for its health endpoint, creates a run-scoped bucket with
 * a signed CreateBucket request, then runs the Jest integration project with
 * the BYOS_IT_* environment pointed at it. The container is always stopped,
 * and Jest's exit code is passed through.
 *
 * The SigV4 signer below is harness code for bucket setup only — the
 * production signer is the subject of the suite, never its scaffolding.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IMAGE = 'minio/minio';
const REGION = 'us-east-1';
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 250;
const BUCKET_TIMEOUT_MS = 60_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

function docker(args, { check = true } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) {
    throw new GateError(
      `Could not run docker: ${result.error.message}. `
      + 'This gate needs a working Docker daemon (OrbStack or Docker Desktop).',
    );
  }
  if (check && result.status !== 0) {
    throw new GateError(
      `docker ${args.join(' ')} failed (${result.status}): `
      + `${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** Minimal SigV4 header set for an empty-payload request. */
function signEmptyPayload({ method, host, canonicalUri, accessKeyId, secretAccessKey }) {
  const amzDate = `${new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
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
    '',
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
  return {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
      + `SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastReason = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/minio/health/live`);
      if (response.ok) return;
      lastReason = `health returned ${response.status}`;
    } catch (error) {
      lastReason = error.message;
    }
    await delay(HEALTH_INTERVAL_MS);
  }
  throw new GateError(
    `MinIO did not become healthy within ${HEALTH_TIMEOUT_MS}ms (${lastReason}).`,
  );
}

async function createBucket(baseUrl, bucket, accessKeyId, secretAccessKey) {
  const url = new URL(`${baseUrl}/${bucket}`);
  // `/minio/health/live` goes green before the object layer can serve writes:
  // recent releases answer CreateBucket with 503 XMinioServerNotInitialized for
  // a short window after that. Treating it as fatal made the whole gate fail on
  // a startup race, so retry until the object layer is genuinely up. Any other
  // status still fails immediately — this must not paper over a real rejection.
  const deadline = Date.now() + BUCKET_TIMEOUT_MS;
  let lastDetail = 'no attempt made';
  for (;;) {
    const response = await fetch(url, {
      method: 'PUT',
      headers: signEmptyPayload({
        method: 'PUT',
        host: url.host,
        canonicalUri: `/${bucket}`,
        accessKeyId,
        secretAccessKey,
      }),
    });
    // 409 BucketAlreadyOwnedByYou is a benign re-run of the same setup.
    if (response.ok || response.status === 409) return;

    const body = (await response.text()).slice(0, 512);
    lastDetail = `${response.status}: ${body}`;
    const initializing = response.status === 503
      && body.includes('XMinioServerNotInitialized');
    if (!initializing || Date.now() >= deadline) {
      throw new GateError(`CreateBucket ${bucket} failed (${lastDetail})`);
    }
    await delay(HEALTH_INTERVAL_MS);
  }
}

function runChild(command, argv, env) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd: repoRoot, stdio: 'inherit', env });
    child.on('error', (error) => {
      console.error(`Failed to start ${command}: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

function runJest(env) {
  return runChild(
    'npx',
    ['jest', '--config', 'jest.integration.config.js', ...process.argv.slice(2)],
    env,
  );
}

async function main() {
  docker(['version', '--format', '{{.Server.Version}}']);

  const runId = randomBytes(4).toString('hex');
  const accessKeyId = `byosit${randomBytes(7).toString('hex')}`;
  const secretAccessKey = randomBytes(24).toString('base64url');
  const bucket = `byos-it-${runId}`;
  const name = `waifu-byos-minio-${runId}`;

  console.log(`Starting ${IMAGE} as ${name} …`);
  const started = docker([
    'run', '-d', '--rm', '--name', name,
    '-e', `MINIO_ROOT_USER=${accessKeyId}`,
    '-e', `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
    '-p', '127.0.0.1::9000',
    IMAGE, 'server', '/data', '--address', ':9000',
  ]);
  const containerId = started.stdout.trim();

  const stopContainer = () => {
    // --rm removes the container once it stops.
    docker(['stop', '-t', '2', containerId], { check: false });
  };
  const onSignal = () => {
    stopContainer();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let exitCode = 1;
  try {
    const mapping = docker(['port', containerId, '9000/tcp']).stdout
      .split('\n')[0].trim();
    const port = mapping.slice(mapping.lastIndexOf(':') + 1);
    if (!/^\d+$/.test(port)) {
      throw new GateError(`Could not read the published port from "${mapping}".`);
    }
    const baseUrl = `http://127.0.0.1:${port}`;

    await waitForHealth(baseUrl);
    await createBucket(baseUrl, bucket, accessKeyId, secretAccessKey);
    console.log(`MinIO ready at ${baseUrl}, bucket ${bucket}.`);

    const env = {
      ...process.env,
      BYOS_IT_ENDPOINT: baseUrl,
      BYOS_IT_BUCKET: bucket,
      BYOS_IT_ACCESS_KEY: accessKeyId,
      BYOS_IT_SECRET: secretAccessKey,
      BYOS_IT_PREFIX: `it/${runId}/`,
      BYOS_IT_REGION: REGION,
    };
    exitCode = await runJest(env);
    if (process.env.BYOS_GATE_PROBE !== '0') {
      // Same instrument every store gate ends with, so the atomicity numbers
      // in the ledger are comparable across MinIO / R2 / Wasabi / Bunny.
      console.log('--- conditional-write atomicity probe (same bucket) ---');
      const probeCode = await runChild('node', ['scripts/byos-conditional-write-probe.mjs'], env);
      if (probeCode !== 0) console.error(`Probe exited ${probeCode} (informational; does not change the gate result).`);
    }

    if (exitCode !== 0) {
      const logs = docker(['logs', '--tail', '40', containerId], { check: false });
      console.error('--- MinIO container logs (tail) ---');
      console.error((logs.stdout || '') + (logs.stderr || ''));
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    stopContainer();
  }
  return exitCode;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error instanceof GateError ? error.message : error);
    process.exitCode = 1;
  },
);
