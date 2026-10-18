import { encodeBase64 } from './base64';
import type { ByosConnectFields } from './byos-connect-flow';
import { cloudFetch } from './cloud-fetch';
import { hashHex } from './s3-sigv4';
import type { S3FetchPort } from './s3-transport';

const encoder = new TextEncoder();

export const S3_API_KEY_PROVIDERS = ['bunny', 'b2', 'r2'] as const;
export type S3ApiKeyProvider = (typeof S3_API_KEY_PROVIDERS)[number];

export type S3ApiKeyErrorCode =
  | 'key_required'
  | 'unrecognized_key'
  | 'invalid_bunny_key'
  | 'invalid_b2_key'
  | 'invalid_cf_token'
  | 'r2_not_enabled'
  | 'b2_key_mint_failed'
  | 'create_bucket_failed'
  | 'network_error'
  | 'provider_error';

export type S3ApiKeyProvisionResult =
  | Readonly<{
      ok: true;
      provider: S3ApiKeyProvider;
      fields: ByosConnectFields;
      createdNewBucket: boolean;
    }>
  | Readonly<{
      ok: false;
      errorCode: S3ApiKeyErrorCode;
    }>;

export type S3ApiKeyProvisionOptions = Readonly<{
  fetchImpl?: S3FetchPort;
  defaultBunnyRegion?: string;
  preferredBucket?: string;
}>;

export const S3_PREFERRED_BUCKET = 'waifu-deck';

const BUNNY_STORAGE_ZONES_URL = 'https://api.bunny.net/storagezone';
const B2_AUTHORIZE_URL = 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account';
const B2_LIST_BUCKETS_PATH = '/b2api/v3/b2_list_buckets';
const B2_CREATE_BUCKET_PATH = '/b2api/v3/b2_create_bucket';
const B2_CREATE_KEY_PATH = '/b2api/v3/b2_create_key';
const B2_MINTED_KEY_NAME = 'waifu-deck-s3-key';
const CF_ACCOUNTS_URL = 'https://api.cloudflare.com/client/v4/accounts';
const CF_USER_TOKENS_VERIFY_URL = 'https://api.cloudflare.com/client/v4/user/tokens/verify';
const CF_R2_NOT_ENABLED_CODE = 10042;
const CF_R2_BUCKET_ALREADY_EXISTS_CODE = 10004;

// Bunny Account API Key: 36-char UUID or 72/73-char double-UUID with hyphens
const BUNNY_UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(-?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$/u;

const CF_TOKEN_REGEX = /^(cfut_|cfat_)[A-Za-z0-9_-]{30,80}$|^[A-Za-z0-9_-]{40}$/u;

export function sha256HexString(input: string): string {
  return hashHex(encoder.encode(input));
}

export function parseBackblazePair(rawInput: string): readonly [string, string] | null {
  const trimmed = rawInput.trim();
  let parts: string[];
  if (trimmed.includes(':')) {
    const idx = trimmed.indexOf(':');
    parts = [trimmed.slice(0, idx), trimmed.slice(idx + 1)];
  } else if (trimmed.includes('\n')) {
    parts = trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } else if (/\s/u.test(trimmed)) {
    const match = /^(\S+)\s+(\S+)$/u.exec(trimmed);
    if (!match) return null;
    parts = [match[1]!, match[2]!];
  } else {
    return null;
  }

  if (parts.length !== 2) return null;
  const keyId = parts[0]!.trim();
  const appKey = parts[1]!.trim();
  const validKeyId = /^[0-9a-fA-F]{12,28}$/u.test(keyId);
  const validAppKey = appKey.length >= 28 && appKey.length <= 48 && !/\s/u.test(appKey);
  return validKeyId && validAppKey ? [keyId, appKey] : null;
}

/**
 * Backblaze Master Application Keys are 12 hex digits without the `00<region>`
 * prefix of S3-ready keys.
 */
export function isB2MasterKeyId(keyId: string): boolean {
  return (
    keyId.length === 12 &&
    !keyId.startsWith('000') &&
    !keyId.startsWith('001') &&
    !keyId.startsWith('002') &&
    !keyId.startsWith('003') &&
    !keyId.startsWith('004') &&
    !keyId.startsWith('005')
  );
}

export function extractB2Region(s3ApiUrl: string): string {
  let host = s3ApiUrl;
  try {
    const parsed = new URL(s3ApiUrl);
    if (parsed.hostname) host = parsed.hostname;
  } catch {
    // keep raw string
  }
  const match = /s3\.([a-z0-9-]+)\.backblazeb2\.com/iu.exec(host);
  return match?.[1]?.toLowerCase() ?? 'us-west-004';
}

export function detectS3ApiKeyProvider(rawInput: string): S3ApiKeyProvider | null {
  const trimmed = rawInput.trim();
  if (trimmed === '') return null;
  if (BUNNY_UUID_REGEX.test(trimmed)) {
    return 'bunny';
  }
  if (parseBackblazePair(trimmed) !== null) {
    return 'b2';
  }
  const tokenCandidate = trimmed.replace(/^Bearer\s+/iu, '').trim();
  if (CF_TOKEN_REGEX.test(tokenCandidate)) {
    return 'r2';
  }
  return null;
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readTextSafe(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function bunnyZoneToFields(
  obj: Record<string, unknown>,
  defaultRegion: string,
): ByosConnectFields | null {
  const name = typeof obj.Name === 'string' ? obj.Name.trim() : '';
  const password = typeof obj.Password === 'string' ? obj.Password.trim() : '';
  const regionRaw =
    typeof obj.Region === 'string' && obj.Region.trim() !== ''
      ? obj.Region.trim()
      : defaultRegion;
  if (name === '' || password === '') return null;
  const regionLower = regionRaw.toLowerCase();
  return {
    endpoint: `https://${regionLower}-s3.storage.bunnycdn.com`,
    region: regionLower,
    accessKey: name,
    secret: password,
    bucket: name,
  };
}

const BUNNY_STORAGE_ZONE_TYPE_S3 = 1;

function isBunnyZoneS3Enabled(obj: Record<string, unknown>): boolean {
  if (typeof obj.StorageZoneType === 'number') {
    return obj.StorageZoneType === BUNNY_STORAGE_ZONE_TYPE_S3;
  }
  return true;
}

function findPreferredBunnyZone(
  zones: readonly unknown[],
  preferredBucket: string,
  defaultRegion: string,
): ByosConnectFields | null {
  const preferredLower = preferredBucket.toLowerCase();
  let prefixMatch: ByosConnectFields | null = null;
  for (const item of zones) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj.Deleted === true || !isBunnyZoneS3Enabled(obj)) continue;
    const name = typeof obj.Name === 'string' ? obj.Name.trim() : '';
    const fields = bunnyZoneToFields(obj, defaultRegion);
    if (fields === null) continue;
    if (name.toLowerCase() === preferredLower) {
      return fields;
    }
    if (prefixMatch === null && name.toLowerCase().startsWith(`${preferredLower}-`)) {
      prefixMatch = fields;
    }
  }
  return prefixMatch;
}

async function provisionBunny(
  accountApiKey: string,
  fetchImpl: S3FetchPort,
  defaultRegion: string,
  preferredBucket: string,
): Promise<S3ApiKeyProvisionResult> {
  let listResp: Response;
  try {
    listResp = await fetchImpl(BUNNY_STORAGE_ZONES_URL, {
      method: 'GET',
      headers: {
        AccessKey: accountApiKey,
        Accept: 'application/json',
      },
    });
  } catch {
    return { ok: false, errorCode: 'network_error' };
  }

  if (listResp.status === 401 || listResp.status === 403) {
    return { ok: false, errorCode: 'invalid_bunny_key' };
  }
  if (listResp.status < 200 || listResp.status >= 300) {
    return { ok: false, errorCode: 'provider_error' };
  }

  const zones = await readJsonSafe(listResp);
  if (!Array.isArray(zones)) {
    return { ok: false, errorCode: 'provider_error' };
  }

  const existingZone = findPreferredBunnyZone(zones, preferredBucket, defaultRegion);
  if (existingZone !== null) {
    return {
      ok: true,
      provider: 'bunny',
      fields: existingZone,
      createdNewBucket: false,
    };
  }

  // Domain-separated digest so no raw prefix of a hash over the key alone is published
  const suffix = sha256HexString(`waifu-deck-bunny-zone:${accountApiKey}`).slice(0, 6);
  const candidates = [preferredBucket, `${preferredBucket}-${suffix}`];
  for (const candidateName of candidates) {
    let createResp: Response;
    try {
      createResp = await fetchImpl(BUNNY_STORAGE_ZONES_URL, {
        method: 'POST',
        headers: {
          AccessKey: accountApiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          Name: candidateName,
          Region: defaultRegion.toUpperCase(),
          StorageZoneType: BUNNY_STORAGE_ZONE_TYPE_S3,
          ZoneTier: 0,
        }),
      });
    } catch {
      continue;
    }

    if (createResp.status >= 200 && createResp.status < 300) {
      const createdObj = await readJsonSafe(createResp);
      if (createdObj !== null && typeof createdObj === 'object') {
        const fields = bunnyZoneToFields(createdObj as Record<string, unknown>, defaultRegion);
        if (fields !== null) {
          return {
            ok: true,
            provider: 'bunny',
            fields,
            createdNewBucket: true,
          };
        }
      }
    }
  }

  return { ok: false, errorCode: 'create_bucket_failed' };
}

async function mintB2S3Key(
  apiUrl: string,
  authToken: string,
  accountId: string,
  fetchImpl: S3FetchPort,
): Promise<readonly [string, string] | null> {
  const capabilities = [
    'listBuckets',
    'listAllBucketNames',
    'readBuckets',
    'writeBuckets',
    'listFiles',
    'readFiles',
    'writeFiles',
    'deleteFiles',
  ];
  let resp: Response;
  try {
    resp = await fetchImpl(`${apiUrl}${B2_CREATE_KEY_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId,
        keyName: B2_MINTED_KEY_NAME,
        capabilities,
      }),
    });
  } catch {
    return null;
  }
  if (resp.status < 200 || resp.status >= 300) return null;
  const json = await readJsonSafe(resp);
  if (json === null || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const newKeyId = typeof obj.applicationKeyId === 'string' ? obj.applicationKeyId.trim() : '';
  const newAppKey = typeof obj.applicationKey === 'string' ? obj.applicationKey.trim() : '';
  if (newKeyId === '' || newAppKey === '') return null;
  return [newKeyId, newAppKey];
}

function readB2RestrictedBucketName(storageApi: Record<string, unknown>): string | null {
  const allowed =
    storageApi.allowed !== null && typeof storageApi.allowed === 'object'
      ? (storageApi.allowed as Record<string, unknown>)
      : null;
  if (allowed === null) return null;
  if (typeof allowed.bucketName === 'string' && allowed.bucketName.trim() !== '') {
    return allowed.bucketName.trim();
  }
  if (Array.isArray(allowed.buckets)) {
    for (const item of allowed.buckets) {
      if (item !== null && typeof item === 'object') {
        const name = (item as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim() !== '') {
          return name.trim();
        }
      }
    }
  }
  return null;
}

async function provisionBackblaze(
  rawInput: string,
  fetchImpl: S3FetchPort,
  preferredBucket: string,
): Promise<S3ApiKeyProvisionResult> {
  const pair = parseBackblazePair(rawInput);
  if (pair === null) {
    return { ok: false, errorCode: 'invalid_b2_key' };
  }
  const [keyId, applicationKey] = pair;
  const basic = encodeBase64(encoder.encode(`${keyId}:${applicationKey}`));

  let authResp: Response;
  try {
    authResp = await fetchImpl(B2_AUTHORIZE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return { ok: false, errorCode: 'network_error' };
  }

  if (authResp.status === 401 || authResp.status === 403) {
    return { ok: false, errorCode: 'invalid_b2_key' };
  }
  if (authResp.status < 200 || authResp.status >= 300) {
    return { ok: false, errorCode: 'provider_error' };
  }

  const authJson = await readJsonSafe(authResp);
  if (authJson === null || typeof authJson !== 'object') {
    return { ok: false, errorCode: 'provider_error' };
  }
  const authObj = authJson as Record<string, unknown>;
  const accountId = typeof authObj.accountId === 'string' ? authObj.accountId.trim() : '';
  const authToken =
    typeof authObj.authorizationToken === 'string' ? authObj.authorizationToken.trim() : '';
  const apiInfo =
    authObj.apiInfo !== null && typeof authObj.apiInfo === 'object'
      ? (authObj.apiInfo as Record<string, unknown>)
      : null;
  const storageApi =
    apiInfo !== null && apiInfo.storageApi !== null && typeof apiInfo.storageApi === 'object'
      ? (apiInfo.storageApi as Record<string, unknown>)
      : authObj;
  const apiUrl =
    typeof storageApi.apiUrl === 'string' ? storageApi.apiUrl.trim().replace(/\/+$/u, '') : '';
  const s3ApiUrl =
    typeof storageApi.s3ApiUrl === 'string' ? storageApi.s3ApiUrl.trim().replace(/\/+$/u, '') : '';

  if (accountId === '' || authToken === '' || apiUrl === '' || s3ApiUrl === '') {
    return { ok: false, errorCode: 'provider_error' };
  }
  const region = extractB2Region(s3ApiUrl);

  // If the user supplied a bucket-restricted application key, B2 already scopes
  // it to that bucket and rejects unfiltered b2_list_buckets calls with 401.
  const restrictedBucketName = readB2RestrictedBucketName(storageApi);
  if (restrictedBucketName !== null && !isB2MasterKeyId(keyId)) {
    return {
      ok: true,
      provider: 'b2',
      fields: {
        endpoint: s3ApiUrl,
        region,
        accessKey: keyId,
        secret: applicationKey,
        bucket: restrictedBucketName,
      },
      createdNewBucket: false,
    };
  }

  // If the user supplied a Master Key, mint the S3-compatible Application Key
  // before creating any bucket so a mint failure never leaves an orphan bucket.
  let s3KeyId = keyId;
  let s3AppKey = applicationKey;
  if (isB2MasterKeyId(keyId)) {
    const minted = await mintB2S3Key(apiUrl, authToken, accountId, fetchImpl);
    if (minted === null) {
      return { ok: false, errorCode: 'b2_key_mint_failed' };
    }
    [s3KeyId, s3AppKey] = minted;
  }

  let listResp: Response;
  try {
    listResp = await fetchImpl(`${apiUrl}${B2_LIST_BUCKETS_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId }),
    });
  } catch {
    return { ok: false, errorCode: 'network_error' };
  }

  if (listResp.status < 200 || listResp.status >= 300) {
    return { ok: false, errorCode: 'provider_error' };
  }

  const listJson = await readJsonSafe(listResp);
  const buckets =
    listJson !== null &&
    typeof listJson === 'object' &&
    Array.isArray((listJson as Record<string, unknown>).buckets)
      ? ((listJson as Record<string, unknown>).buckets as unknown[])
      : [];

  let existingBucketName: string | null = null;
  let prefixBucketName: string | null = null;
  for (const item of buckets) {
    if (item === null || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    const name = typeof b.bucketName === 'string' ? b.bucketName.trim() : '';
    if (name === preferredBucket) {
      existingBucketName = name;
      break;
    }
    if (prefixBucketName === null && name.startsWith(`${preferredBucket}-`)) {
      prefixBucketName = name;
    }
  }

  let targetBucket = existingBucketName ?? prefixBucketName;
  let createdNew = false;

  if (targetBucket === null) {
    const suffix = accountId.slice(-6).toLowerCase();
    const candidates = [preferredBucket, `${preferredBucket}-${suffix}`];
    for (const candidate of candidates) {
      let createResp: Response;
      try {
        createResp = await fetchImpl(`${apiUrl}${B2_CREATE_BUCKET_PATH}`, {
          method: 'POST',
          headers: {
            Authorization: authToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            accountId,
            bucketName: candidate,
            bucketType: 'allPrivate',
          }),
        });
      } catch {
        continue;
      }

      if (createResp.status >= 200 && createResp.status < 300) {
        const createdJson = await readJsonSafe(createResp);
        const createdName =
          createdJson !== null &&
          typeof createdJson === 'object' &&
          typeof (createdJson as Record<string, unknown>).bucketName === 'string'
            ? ((createdJson as Record<string, unknown>).bucketName as string).trim()
            : '';
        targetBucket = createdName !== '' ? createdName : candidate;
        createdNew = true;
        break;
      }
    }
  }

  if (targetBucket === null) {
    return { ok: false, errorCode: 'create_bucket_failed' };
  }

  return {
    ok: true,
    provider: 'b2',
    fields: {
      endpoint: s3ApiUrl,
      region,
      accessKey: s3KeyId,
      secret: s3AppKey,
      bucket: targetBucket,
    },
    createdNewBucket: createdNew,
  };
}

function hasCfErrorCodeOrSubstring(rawText: string, code: number, substring: string): boolean {
  const lowerSub = substring.toLowerCase();
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    if (Array.isArray(parsed.errors)) {
      for (const err of parsed.errors) {
        if (err !== null && typeof err === 'object') {
          const obj = err as Record<string, unknown>;
          if (obj.code === code) return true;
          if (typeof obj.message === 'string' && obj.message.toLowerCase().includes(lowerSub)) {
            return true;
          }
        }
      }
    }
  } catch {
    // fallback to substring check
  }
  return rawText.toLowerCase().includes(lowerSub);
}

function isCfR2NotEnabled(rawText: string): boolean {
  return hasCfErrorCodeOrSubstring(rawText, CF_R2_NOT_ENABLED_CODE, 'r2 is not enabled');
}

function isCfBucketAlreadyExists(status: number, rawText: string): boolean {
  if (status === 409) return true;
  return hasCfErrorCodeOrSubstring(rawText, CF_R2_BUCKET_ALREADY_EXISTS_CODE, 'already exists');
}

function pickCfId(obj: Record<string, unknown>, idKey: 'id' | 'name'): string {
  const primary = obj[idKey];
  if (typeof primary === 'string' && primary.trim() !== '') {
    return primary.trim();
  }
  if (typeof obj.name === 'string' && obj.name.trim() !== '') {
    return obj.name.trim();
  }
  return '';
}

function parseCfIds(rawText: string, idKey: 'id' | 'name'): string[] {
  let parsed: Record<string, unknown>;
  try {
    const json = JSON.parse(rawText);
    if (json === null || typeof json !== 'object') return [];
    parsed = json as Record<string, unknown>;
  } catch {
    return [];
  }
  const result = parsed.result;
  if (result === null || result === undefined) return [];
  let items: unknown[] = [];
  if (Array.isArray(result)) {
    items = result;
  } else if (typeof result === 'object') {
    const resultObj = result as Record<string, unknown>;
    if (Array.isArray(resultObj.buckets)) {
      items = resultObj.buckets;
    } else {
      const single = pickCfId(resultObj, idKey);
      if (single !== '') return [single];
    }
  }
  const out: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const val = pickCfId(item as Record<string, unknown>, idKey);
    if (val !== '') out.push(val);
  }
  return out;
}

async function listCfBucketNames(
  token: string,
  accountId: string,
  fetchImpl: S3FetchPort,
): Promise<{ ok: true; names: string[] } | { ok: false; r2NotEnabled: boolean }> {
  const resp = await fetchImpl(`${CF_ACCOUNTS_URL}/${accountId}/r2/buckets`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  const text = await readTextSafe(resp);
  if (resp.status < 200 || resp.status >= 300) {
    return { ok: false, r2NotEnabled: isCfR2NotEnabled(text) };
  }
  return { ok: true, names: parseCfIds(text, 'name') };
}

async function verifyCloudflareTokenId(
  token: string,
  accountId: string,
  fetchImpl: S3FetchPort,
): Promise<string | null> {
  const urls = [
    `${CF_ACCOUNTS_URL}/${accountId}/tokens/verify`,
    CF_USER_TOKENS_VERIFY_URL,
  ];
  for (const url of urls) {
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
    } catch {
      continue;
    }
    if (resp.status >= 200 && resp.status < 300) {
      const json = await readJsonSafe(resp);
      if (json !== null && typeof json === 'object') {
        const resObj = (json as Record<string, unknown>).result;
        if (resObj !== null && typeof resObj === 'object') {
          const id = (resObj as Record<string, unknown>).id;
          if (typeof id === 'string' && id.trim() !== '') {
            return id.trim();
          }
        }
      }
    }
  }
  return null;
}

async function provisionCloudflareR2(
  rawToken: string,
  fetchImpl: S3FetchPort,
  preferredBucket: string,
): Promise<S3ApiKeyProvisionResult> {
  const token = rawToken.replace(/^Bearer\s+/iu, '').trim();

  let accountsResp: Response;
  try {
    accountsResp = await fetchImpl(CF_ACCOUNTS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return { ok: false, errorCode: 'network_error' };
  }

  const accountsText = await readTextSafe(accountsResp);
  if (accountsResp.status < 200 || accountsResp.status >= 300) {
    return {
      ok: false,
      errorCode: isCfR2NotEnabled(accountsText) ? 'r2_not_enabled' : 'invalid_cf_token',
    };
  }

  const accountIds = parseCfIds(accountsText, 'id');
  if (accountIds.length === 0) {
    return { ok: false, errorCode: 'invalid_cf_token' };
  }

  let selectedAccountId = accountIds[0]!;
  let selectedBuckets: string[] | null = null;
  let sawR2NotEnabled = false;

  for (const id of accountIds) {
    try {
      const listed = await listCfBucketNames(token, id, fetchImpl);
      if (listed.ok) {
        if (selectedBuckets === null) {
          selectedAccountId = id;
          selectedBuckets = listed.names;
        }
        if (listed.names.includes(preferredBucket)) {
          selectedAccountId = id;
          selectedBuckets = listed.names;
          break;
        }
      } else if (listed.r2NotEnabled) {
        sawR2NotEnabled = true;
      }
    } catch {
      // continue checking other accounts
    }
  }

  if (selectedBuckets === null) {
    return {
      ok: false,
      errorCode: sawR2NotEnabled ? 'r2_not_enabled' : 'invalid_cf_token',
    };
  }

  const alreadyExists = selectedBuckets.includes(preferredBucket);
  let bucketName = preferredBucket;
  let createdNew = false;

  if (!alreadyExists) {
    let createResp: Response;
    try {
      createResp = await fetchImpl(`${CF_ACCOUNTS_URL}/${selectedAccountId}/r2/buckets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: preferredBucket }),
      });
    } catch {
      return { ok: false, errorCode: 'network_error' };
    }
    const createText = await readTextSafe(createResp);
    if (createResp.status >= 200 && createResp.status < 300) {
      bucketName = parseCfIds(createText, 'name')[0] ?? preferredBucket;
      createdNew = true;
    } else if (!isCfBucketAlreadyExists(createResp.status, createText)) {
      return {
        ok: false,
        errorCode: isCfR2NotEnabled(createText) ? 'r2_not_enabled' : 'create_bucket_failed',
      };
    }
  }

  const tokenId = await verifyCloudflareTokenId(token, selectedAccountId, fetchImpl);
  if (tokenId === null) {
    return { ok: false, errorCode: 'invalid_cf_token' };
  }
  const secretKey = sha256HexString(token);

  return {
    ok: true,
    provider: 'r2',
    fields: {
      endpoint: `https://${selectedAccountId}.r2.cloudflarestorage.com`,
      region: 'auto',
      accessKey: tokenId,
      secret: secretKey,
      bucket: bucketName,
    },
    createdNewBucket: createdNew,
  };
}

export async function provisionS3FromApiKey(
  rawInput: string,
  selectedProviderOverride?: S3ApiKeyProvider | null,
  options: S3ApiKeyProvisionOptions = {},
): Promise<S3ApiKeyProvisionResult> {
  const cleaned = rawInput.trim();
  if (cleaned === '') {
    return { ok: false, errorCode: 'key_required' };
  }
  const provider = selectedProviderOverride ?? detectS3ApiKeyProvider(cleaned) ?? null;
  if (provider === null) {
    return { ok: false, errorCode: 'unrecognized_key' };
  }
  const fetchImpl = options.fetchImpl ?? cloudFetch;
  const defaultBunnyRegion = options.defaultBunnyRegion ?? 'SG';
  const preferredBucket = options.preferredBucket ?? S3_PREFERRED_BUCKET;

  switch (provider) {
    case 'bunny':
      return provisionBunny(cleaned, fetchImpl, defaultBunnyRegion, preferredBucket);
    case 'b2':
      return provisionBackblaze(cleaned, fetchImpl, preferredBucket);
    case 'r2':
      return provisionCloudflareR2(cleaned, fetchImpl, preferredBucket);
  }
}
