// Upload an owner-signed release APK to Cloudflare R2 `waifudeck-releases` and
// update `latest.json` so `https://waifudeck.app/api/app/latest` and
// `https://waifudeck.app/api/app/download` serve it.
//
// Usage:
//   node scripts/release.mjs <path/to/app-release.apk> <MAJOR.MINOR.PATCH> "<notes>" [--allow-same-or-lower]
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const R2_BUCKET_NAME = 'waifudeck-releases';
export const SITE_URL = 'https://waifudeck.app';
export const EXPECTED_PACKAGE_NAME = 'app.waifudeck.mobile';
export const OWNER_SIGNING_CERT_SHA1 = '47767eb1893b02bac826197863bfe938d2abc606';

const VERSION_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const KNOWN_FLAGS = new Set(['--allow-same-or-lower']);

export function versionCodeOf(versionName) {
  const match = VERSION_PATTERN.exec(versionName);
  if (!match) {
    throw new Error(`version must be MAJOR.MINOR.PATCH (0..999 each), got: ${versionName}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (code <= 0) {
    throw new Error(`version must be MAJOR.MINOR.PATCH (> 0.0.0), got: ${versionName}`);
  }
  return code;
}

export function buildReleaseManifest({
  versionName,
  sizeBytes,
  sha256,
  notes = '',
  publishedAt = new Date().toISOString(),
  siteUrl = SITE_URL,
  currentCode = 0,
  allowSameOrLower = false,
}) {
  const versionCode = versionCodeOf(versionName);
  if (!allowSameOrLower && versionCode <= currentCode) {
    throw new Error(
      `version ${versionName} (${versionCode}) must be higher than current release (${currentCode})`,
    );
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`sizeBytes must be a positive integer, got: ${sizeBytes}`);
  }
  const normalizedSha = String(sha256).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedSha)) {
    throw new Error(`sha256 must be 64 lowercase hex chars, got: ${sha256}`);
  }
  const cleanSiteUrl = siteUrl.replace(/\/+$/, '');
  const shortSha = normalizedSha.slice(0, 12);
  return {
    versionCode,
    versionName,
    publishedAt,
    sizeBytes,
    sha256: normalizedSha,
    r2Key: `waifudeck-${versionName}-${shortSha}.apk`,
    notes: String(notes),
    downloadUrl: `${cleanSiteUrl}/api/app/download`,
  };
}

export function validateReleaseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      if (!KNOWN_FLAGS.has(arg)) {
        throw new Error(`unknown flag: ${arg}`);
      }
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 3) {
    throw new Error('too many positional arguments; wrap release notes in quotes');
  }
  const [apkPath, versionName, notes = ''] = positional;
  if (!apkPath || !versionName) {
    throw new Error(
      'usage: node scripts/release.mjs <apkPath> <MAJOR.MINOR.PATCH> "<notes>" [--allow-same-or-lower]',
    );
  }
  if (!existsSync(apkPath)) {
    throw new Error(`APK file not found: ${apkPath}`);
  }
  versionCodeOf(versionName);
  return {
    apkPath,
    versionName,
    notes,
    allowSameOrLower: flags.has('--allow-same-or-lower'),
  };
}

function findSdkBuildTool(toolName) {
  if (process.env.APKSIGNER && toolName === 'apksigner' && existsSync(process.env.APKSIGNER)) {
    return process.env.APKSIGNER;
  }
  const sdkHome =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(os.homedir(), 'Library/Android/sdk');
  const buildToolsRoot = path.join(sdkHome, 'build-tools');
  if (!existsSync(buildToolsRoot)) return null;
  const versions = readdirSync(buildToolsRoot).sort().reverse();
  for (const ver of versions) {
    const candidate = path.join(buildToolsRoot, ver, toolName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveJavaEnv() {
  const candidates = [
    process.env.JAVA_HOME,
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
  ].filter(Boolean);
  for (const home of candidates) {
    if (existsSync(home)) {
      return { ...process.env, JAVA_HOME: home, PATH: `${home}/bin:${process.env.PATH || ''}` };
    }
  }
  return process.env;
}

export function verifyApkOwnerSignatureAndMetadata(apkPath, expectedVersionName) {
  const apksigner = findSdkBuildTool('apksigner');
  if (!apksigner) {
    throw new Error('apksigner not found; set ANDROID_HOME or APKSIGNER to verify release signature');
  }
  const env = resolveJavaEnv();
  const out = execFileSync(apksigner, ['verify', '--print-certs', apkPath], {
    encoding: 'utf8',
    env,
  });
  const sha1Matches = [...out.matchAll(/certificate SHA-1 digest:\s*([0-9a-fA-F:]+)/g)].map((m) =>
    m[1].replace(/:/g, '').toLowerCase(),
  );
  if (sha1Matches.length === 0 || !sha1Matches.every((s) => s === OWNER_SIGNING_CERT_SHA1)) {
    throw new Error(
      `APK signing certificate SHA-1 mismatch: expected ${OWNER_SIGNING_CERT_SHA1}, got ${sha1Matches.join(',') || 'none'}`,
    );
  }

  const aapt2 = findSdkBuildTool('aapt2');
  if (!aapt2) {
    throw new Error('aapt2 not found; set ANDROID_HOME to verify APK package and versionCode');
  }
  const badging = execFileSync(aapt2, ['dump', 'badging', apkPath], {
    encoding: 'utf8',
    env,
  });
  const pkgMatch = badging.match(/package:\s+name='([^']+)'\s+versionCode='(\d+)'\s+versionName='([^']+)'/);
  if (!pkgMatch) {
    throw new Error('Could not parse package badging from APK via aapt2');
  }
  const [, actualPackage, actualCodeStr, actualVersionName] = pkgMatch;
  const expectedCode = versionCodeOf(expectedVersionName);
  if (actualPackage !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`APK package mismatch: expected ${EXPECTED_PACKAGE_NAME}, got ${actualPackage}`);
  }
  if (Number(actualCodeStr) !== expectedCode || actualVersionName !== expectedVersionName) {
    throw new Error(
      `APK version mismatch: expected ${expectedVersionName} (${expectedCode}), APK has ${actualVersionName} (${actualCodeStr})`,
    );
  }
}

export async function fetchCurrentRemoteVersionCode(fetchImpl = fetch) {
  const res = await fetchImpl(`${SITE_URL}/api/app/latest`);
  if (res.status === 404) return 0;
  if (!res.ok) {
    throw new Error(`failed to fetch current release from ${SITE_URL}/api/app/latest: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (typeof data?.versionCode !== 'number' || !Number.isInteger(data.versionCode)) {
    throw new Error('current release manifest on waifudeck.app is missing a valid versionCode');
  }
  return data.versionCode;
}

function r2PutObject(r2Key, filePath, contentType, repoRoot) {
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(
    npxBin,
    [
      'wrangler',
      'r2',
      'object',
      'put',
      `${R2_BUCKET_NAME}/${r2Key}`,
      '--file',
      filePath,
      '--content-type',
      contentType,
      '--remote',
    ],
    {
      stdio: 'inherit',
      cwd: path.join(repoRoot, 'site'),
      env: process.env,
    },
  );
}

async function main() {
  const { apkPath, versionName, notes, allowSameOrLower } = validateReleaseArgs(
    process.argv.slice(2),
  );
  verifyApkOwnerSignatureAndMetadata(apkPath, versionName);

  const apkBytes = readFileSync(apkPath);
  const sizeBytes = apkBytes.byteLength;
  const sha256 = createHash('sha256').update(apkBytes).digest('hex');
  const currentCode = await fetchCurrentRemoteVersionCode();

  const manifest = buildReleaseManifest({
    versionName,
    sizeBytes,
    sha256,
    notes,
    currentCode,
    allowSameOrLower,
  });

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wd-release-'));
  try {
    const manifestPath = path.join(tmpDir, 'latest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    r2PutObject(manifest.r2Key, apkPath, 'application/vnd.android.package-archive', repoRoot);
    r2PutObject('latest.json', manifestPath, 'application/json', repoRoot);

    console.log(
      `Released Waifu Deck ${manifest.versionName} (${manifest.versionCode}): ${manifest.r2Key}, ${manifest.sizeBytes} bytes, sha256=${manifest.sha256}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
