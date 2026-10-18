import { CloudStoreError, type CloudObjectStore } from '@/features/cloud-store/cloud-object-store';
import { bootstrapGoogleDriveLayout } from '@/features/cloud-store/gdrive-layout';
import { createProductionGoogleDriveStore } from '@/features/cloud-store/gdrive-store-production';
import { bootstrapOneDriveLayout } from '@/features/cloud-store/onedrive-layout';
import { createProductionOneDriveStore } from '@/features/cloud-store/onedrive-store-production';
import { createProductionWebdavStore } from '@/features/cloud-store/webdav-store-production';
import {
  createLibraryStorageModeStore, type LibraryStorageModeStore,
} from '@/features/library/library-storage-mode';

import { encodeBase64 } from './base64';
import {
  createByosCredentialStore,
  type ByosCredentials, type ByosCredentialStore, type GoogleDriveBinding, type OneDriveBinding, type WebdavBinding,
} from './byos-credentials';
import {
  createByosSessionCache, type ByosSessionCache,
} from './byos-session-cache';
import { createStoreVaultOrAdopt, createVaultOrAdopt } from './byos-vault-init';
import {
  APPEND_PROTOCOL_VERSION, openVaultWithPassword, parseVaultMeta, VaultMetaError,
  type VaultEncryption, type VaultMeta,
} from './byos-vault-meta';
import { cloudFetch } from './cloud-fetch';
import { createGoogleSignIn, type GoogleSignInPort } from './google-sign-in';
import { createMicrosoftSignIn, type MicrosoftSignInPort } from './microsoft-sign-in';
import { createS3Transport } from './s3-transport';
import { S3TransportError } from './s3-transport-types';

export {
  detectS3ApiKeyProvider,
  provisionS3FromApiKey,
  S3_API_KEY_PROVIDERS,
  S3_PREFERRED_BUCKET,
  type S3ApiKeyErrorCode,
  type S3ApiKeyProvisionOptions,
  type S3ApiKeyProvisionResult,
  type S3ApiKeyProvider,
} from './s3-api-key-provisioner';

/**
 * The UI-independent BYOS connect flow (design D1/D2/D7).
 *
 * The settings section (Task 5) is a thin shell over the three entry points
 * here: `probeBucket` (step one of the two-step disclosure), then
 * `connectToBucket` (step two: create, join-encrypted, or join-plain), and
 * `disconnectDevice`. Everything I/O-shaped is injectable so the flow can be
 * proved without a bucket, a device, or a screen.
 *
 * Failure contract: every *remote* failure — unreachable endpoint, rejected
 * keys, non-S3 endpoint, corrupt vault-meta, wrong password — is returned as
 * data (`{kind:'error'}` / `{ok:false}`), never thrown. The only rejections
 * that escape are local secure-storage failures on the persistence step,
 * which are device faults rather than connect outcomes and have no honest
 * `ByosConnectError` member.
 */

const META_KEY = 'vault-meta.json';

/** D1: the form collects no prefix (U4-design ruling 2026-10-12); an empty or absent prefix defaults to this. */
export const BYOS_DEFAULT_PREFIX = 'waifu-deck/';

/**
 * D1 collects four fields (endpoint, bucket, access key, secret) but SigV4
 * needs a fifth, so `region` is defaulted rather than asked for. 'auto' is
 * the value Cloudflare R2 requires, and R2 is the store the release gates
 * verify against. A store that validates the signed region instead (AWS S3,
 * or MinIO with a configured region — the local gate signs 'us-east-1') will
 * reject this default with a `credential` 403, so `region` stays overridable
 * on the fields. Surfacing it in the form is a Task 5 / owner decision, not
 * something this engine can decide.
 */
export const BYOS_DEFAULT_REGION = 'auto';

export type ByosConnectFields = Readonly<{
  endpoint: string;
  bucket: string;
  accessKey: string;
  secret: string;
  /** Absent on the form since the 2026-10-12 ruling; `''` and absent mean the default. */
  prefix?: string;
  region?: string;
}>;

/**
 * The slice of the S3 transport this flow needs: exactly what
 * `createVaultOrAdopt` consumes, so the same port serves probe and connect.
 */
export type ByosTransportPort = {
  getObject(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  putObject(
    key: string,
    body: Uint8Array,
    options: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<{ etag: string | null }>;
};

/**
 * Product-facing connect failures (D7 maps each to its own copy).
 *
 * Full mapping table — the only place a raw transport/vault error becomes a
 * user-visible category:
 *
 * | source                                  | category            | why |
 * |-----------------------------------------|---------------------|-----|
 * | S3TransportError 'network'              | network             | no response at all: offline, DNS, TLS |
 * | S3TransportError 'rate_limited'         | network             | 429/503: the endpoint is reachable but not answering usefully; "try again / check the endpoint" is the same advice |
 * | S3TransportError 'credential'           | credential_rejected | 401/403: key, secret, permission — or a region the store refuses to accept |
 * | S3TransportError 'not_found' on the     | (not an error)      | 404 on the meta GET is how an empty bucket looks; `getObject` already returns null for it, so it becomes `{kind:'empty'}` |
 * |   vault-meta GET                        |                     | |
 * | S3TransportError 'client' (other 4xx)   | not_s3              | the host answered, but not like a usable S3 bucket |
 * | S3TransportError 'server' (5xx)         | not_s3              | same: answered, unusable. A genuine S3 store having a bad day lands here too, so the D7 copy for not_s3 must read as "this address did not answer like a usable bucket", not "you typed a non-S3 URL" |
 * | S3TransportError 'precondition'         | not_s3              | 409/412 cannot reach the caller from a GET, and `createVaultOrAdopt` already absorbs the create race; one escaping means the store contradicted itself |
 * | CloudStoreError 'server'/'client'/      | not_webdav          | the address answered, but not like a usable WebDAV folder |
 * |   'not_found'/'quota_full' on a WebDAV  |                     | |
 * |   probe                                 |                     | |
 * | Graph 4xx/5xx other than auth/network,  | not_onedrive        | Graph answered, but not like a usable app folder (4xx/5xx other than auth/network; also a deleted app folder) |
 * |   or a deleted app folder (Tasks 9–10)  |                     | |
 * | Drive 4xx/5xx other than auth/network,  | not_gdrive          | Drive answered, but not like a usable `Waifu Deck` folder (P12-D) |
 * |   or a deleted Waifu Deck folder        |                     | |
 * |   (start-up resolver, and sign-in/      |                     | |
 * |   probe/connect/reauth here)            |                     | |
 * | CloudStoreError 'auth' whose message    | reauth_required     | the saved Microsoft or Google sign-in was revoked or expired (`invalid_grant`); re-sign-in keeps the library |
 * |   names `reauth_required` (the identity |                     | |
 * |   token endpoint answered               |                     | |
 * |   `invalid_grant` on the saved refresh  |                     | |
 * |   token)                                |                     | |
 * | CloudStoreError 'auth', other messages, | network (WebDAV) /  | N9: a WebDAV 401/403 may be the store's own transient misbehavior (123 云盘 answered 401 for two minutes and healed), so it reads as 暂时连不上, never as rejected credentials; a drive provider's other auth failure is its saved sign-in being refused |
 * |   on a WebDAV vs a drive store          | credential_rejected | |
 * | browser sign-in closed, dismissed, or   | sign_in_cancelled   | the user closed the browser sign-in or denied consent |
 * |   consent denied                        |                     | |
 * |   (`createMicrosoftSignIn`,             |                     | |
 * |   `createGoogleSignIn`)                 |                     | |
 * | non-https or unparsable baseUrl         | insecure_url        | local validation, never reaches the network: the release manifest ships no usesCleartextTraffic, so http:// could never work on device (spec §4.1 补裁); refused by toWebdavBinding before probeWebdav/connectWebdav construct a store |
 * | VaultMetaError 'malformed'              | meta_corrupt        | unparseable or invalid vault-meta.json |
 * | VaultMetaError 'unsupported-version'    | meta_corrupt        | strictly "this app is too old", but the pinned union has no member for it; `detail` carries the real message |
 * | VaultMetaError 'wrong-password'         | wrong_password      | keyCheck mismatch, or no password for an encrypted vault — kept strictly distinct from corruption |
 * | anything else (e.g. `new URL` throwing  | not_s3              | a malformed endpoint is the dominant case; `detail` preserves the original message so nothing is silently swallowed |
 * |   on an endpoint with no scheme)        |                     | |
 * | password empty / confirmation mismatch  | password_mismatch   | local validation, never reaches the bucket (see `validateNewPassword`) |
 */
export type ByosConnectError =
  | 'network'
  | 'credential_rejected'
  | 'not_s3'
  | 'not_webdav'
  | 'not_onedrive'
  | 'not_gdrive'
  | 'reauth_required'
  | 'sign_in_cancelled'
  | 'insecure_url'
  | 'meta_corrupt'
  | 'wrong_password'
  | 'password_mismatch';

/**
 * `detail` is a diagnostic tag or the underlying error message. It is never
 * user-facing copy on its own; the UI renders `category` (D7) and may branch
 * on a known tag (currently only 'password_required') to refine it.
 */
export type ByosConnectFailure = {
  readonly category: ByosConnectError;
  readonly detail?: string;
};

export type ConnectableProbe =
  | { kind: 'empty' }
  | { kind: 'existing-encrypted'; meta: VaultMeta }
  | { kind: 'existing-plain'; meta: VaultMeta };

export type ProbeResult =
  | ConnectableProbe
  | ({ kind: 'error' } & ByosConnectFailure);

export type ConnectInput = Readonly<{
  fields: ByosConnectFields;
  probe: ConnectableProbe;
  /** Create only; defaults to 'aes-gcm' (D1: encryption switch defaults on). */
  encryption?: VaultEncryption;
  password?: string;
  /** Create only; D9 requires a second matching entry. */
  passwordConfirm?: string;
}>;

export type ConnectResult =
  | { ok: true; vaultId: string; encryption: VaultEncryption }
  | ({ ok: false } & ByosConnectFailure);

export type ByosConnectDeps = Readonly<{
  createTransport?: (credentials: ByosCredentials) => ByosTransportPort;
  credentialStore?: ByosCredentialStore;
  sessionCache?: ByosSessionCache;
  storageMode?: Pick<LibraryStorageModeStore, 'clear'>;
}>;

// React Native's global fetch mangles binary bodies; `expo/fetch` is the
// supported native client. Same injection the Direct composition uses (see
// `library-integration-impl.ts`).
function defaultCreateTransport(credentials: ByosCredentials): ByosTransportPort {
  return createS3Transport(credentials, {
    fetchImpl: cloudFetch,
  });
}

const decoder = new TextDecoder();

/**
 * Empty and absent resolve identically — both mean "no prefix chosen", which is
 * all the removed field ever produced when left blank (U4-design 2026-10-12).
 */
function normalizePrefix(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+/, '');
  if (trimmed === '') return BYOS_DEFAULT_PREFIX;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * Whitespace is trimmed from every field a user pastes on a phone *except*
 * the secret, where a leading or trailing space could be part of the actual
 * key and silently dropping it would produce an unexplainable 403.
 */
function toCredentials(fields: ByosConnectFields): ByosCredentials {
  return {
    kind: 's3',
    endpoint: fields.endpoint.trim().replace(/\/+$/, ''),
    region: (fields.region ?? BYOS_DEFAULT_REGION).trim(),
    bucket: fields.bucket.trim(),
    accessKeyId: fields.accessKey.trim(),
    secretAccessKey: fields.secret,
    prefix: normalizePrefix(fields.prefix),
  };
}

/** The single error→category funnel documented on `ByosConnectError`. */
function classify(error: unknown): ByosConnectFailure {
  if (error instanceof S3TransportError) {
    switch (error.category) {
      case 'network':
      case 'rate_limited':
        return { category: 'network', detail: error.message };
      case 'credential':
        return { category: 'credential_rejected', detail: error.message };
      default:
        return { category: 'not_s3', detail: error.message };
    }
  }
  if (error instanceof VaultMetaError) {
    return {
      category: error.code === 'wrong-password' ? 'wrong_password' : 'meta_corrupt',
      detail: error.message,
    };
  }
  return {
    category: 'not_s3',
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * D9: no strength gate, only the two rules the product actually enforces —
 * non-empty, and typed the same way twice. The pinned P4 category union has
 * no dedicated "password required" member, so an empty password reuses
 * `password_mismatch` and is distinguished by `detail: 'password_required'`.
 * D1 makes the field required in the form, so this is a backstop rather than
 * a routine path.
 */
function validateNewPassword(
  password: string | undefined,
  passwordConfirm: string | undefined,
): ByosConnectFailure | null {
  if (!password) {
    return { category: 'password_mismatch', detail: 'password_required' };
  }
  if (password !== passwordConfirm) {
    return { category: 'password_mismatch', detail: 'confirmation_mismatch' };
  }
  return null;
}

/**
 * Step one of D1: read `<prefix>vault-meta.json` with the entered fields.
 * Absent meta means an empty bucket to create in; present meta branches on
 * its encryption mode; everything else is a categorized error.
 */
export async function probeBucket(
  fields: ByosConnectFields,
  deps: ByosConnectDeps = {},
): Promise<ProbeResult> {
  const credentials = toCredentials(fields);
  const createTransport = deps.createTransport ?? defaultCreateTransport;
  let stored: { body: Uint8Array } | null;
  try {
    const transport = createTransport(credentials);
    stored = await transport.getObject(`${credentials.prefix}${META_KEY}`);
  } catch (error) {
    return { kind: 'error', ...classify(error) };
  }
  // A 404 is not a failure here: `getObject` resolves null for it, and an
  // absent vault-meta.json is exactly what a fresh bucket looks like.
  if (stored === null) return { kind: 'empty' };

  let meta: VaultMeta;
  try {
    meta = parseVaultMeta(decoder.decode(stored.body));
  } catch (error) {
    return { kind: 'error', ...classify(error) };
  }
  return meta.encryption === 'aes-gcm'
    ? { kind: 'existing-encrypted', meta }
    : { kind: 'existing-plain', meta };
}

/**
 * Step two of D1. On success the device is connected: credentials and the
 * derived session (D2) are persisted, and the caller reloads app services
 * (D4) so the resolver picks the vault up.
 *
 * Persistence order is credentials first, then session. If the second write
 * fails, the device is left "configured but locked" — a state the resolver
 * already models and the user can recover from by re-entering the password —
 * rather than holding key material for a vault it has no credentials for.
 */
export async function connectToBucket(
  input: ConnectInput,
  deps: ByosConnectDeps = {},
): Promise<ConnectResult> {
  const { fields, probe } = input;
  const credentials = toCredentials(fields);
  const createTransport = deps.createTransport ?? defaultCreateTransport;

  let meta: VaultMeta;
  let masterKey: Uint8Array | null;
  try {
    if (probe.kind === 'empty') {
      const encryption = input.encryption ?? 'aes-gcm';
      if (encryption === 'aes-gcm') {
        const invalid = validateNewPassword(input.password, input.passwordConfirm);
        if (invalid) return { ok: false, ...invalid };
      }
      const transport = createTransport(credentials);
      // One create-only PUT; a vault created by another device between probe
      // and create is adopted off the 412 rather than clobbered (K7 ㉟).
      const opened = await createVaultOrAdopt(
        transport,
        credentials.prefix,
        encryption === 'aes-gcm' ? input.password ?? null : null,
        encryption,
      );
      meta = opened.meta;
      masterKey = opened.masterKey;
    } else {
      // Join: the probed meta is authoritative for this attempt. Only the
      // password has to be checked, and keyCheck does that offline.
      meta = probe.meta;
      masterKey = await openVaultWithPassword(meta, input.password ?? null);
    }
  } catch (error) {
    return { ok: false, ...classify(error) };
  }

  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const sessionCache = deps.sessionCache ?? createByosSessionCache();
  await credentialStore.save(credentials);
  await sessionCache.save({
    // D2 caches the derived key so start-up skips scrypt. Decision #21's
    // pseudo key for 'none' vaults is derivable from vaultId alone and is
    // deliberately not stored — the resolver re-derives it.
    masterKeyB64: meta.encryption === 'aes-gcm' && masterKey !== null
      ? encodeBase64(masterKey)
      : null,
    vaultId: meta.vaultId,
    encryption: meta.encryption,
  });

  return { ok: true, vaultId: meta.vaultId, encryption: meta.encryption };
}

export type WebdavConnectFields = Readonly<{
  baseUrl: string;
  username: string;
  password: string;
  /** Absent on the form since the 2026-10-12 ruling; `''` and absent mean the default `/`. */
  rootPath?: string;
}>;

export type WebdavConnectDeps = Readonly<{
  createStore?: (binding: WebdavBinding) => CloudObjectStore;
  credentialStore?: ByosCredentialStore;
  sessionCache?: ByosSessionCache;
}>;

/** Empty and absent resolve identically — both mean the default `/` (U4-design 2026-10-12). */
function normalizeRootPath(raw: string | undefined): string {
  // Repeated slashes are collapsed too: the adapter joins `rootPath` into
  // every object URL, so a doubled slash typed once would be doubled forever.
  const trimmed = (raw ?? '').trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : `/${trimmed}/`;
}

/**
 * https only (spec §4.1 补裁: the release manifest forbids cleartext, so
 * http:// could never work on device). Unlike the S3 flow's `secret`, the
 * WebDAV login password is never trimmed — a leading or trailing space could
 * be part of the actual credential.
 */
function toWebdavBinding(fields: WebdavConnectFields): WebdavBinding | null {
  const baseUrl = fields.baseUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return {
    kind: 'webdav',
    baseUrl,
    username: fields.username.trim(),
    password: fields.password,
    rootPath: normalizeRootPath(fields.rootPath),
  };
}

/** The `CloudObjectStore`/vault-meta counterpart of `classify`, for the WebDAV, OneDrive and Google Drive ports. */
function classifyStore(error: unknown, fallback: 'not_webdav' | 'not_onedrive' | 'not_gdrive'): ByosConnectFailure {
  if (error instanceof CloudStoreError) {
    if (error.category === 'network' || error.category === 'rate_limited') {
      return { category: 'network', detail: error.message };
    }
    if (error.category === 'auth') {
      return error.message.includes('reauth_required')
        ? { category: 'reauth_required', detail: error.message }
        // N9 (owner 2026-10-12): a WebDAV 401/403 is indistinguishable from the
        // store's transient misbehavior — 123 云盘 answered 401 for two minutes
        // and healed itself — so it reads as 暂时连不上, never as rejected
        // credentials. Only the drive providers have a sign-in to redo.
        : fallback === 'not_webdav'
          ? { category: 'network', detail: error.message }
          : { category: 'credential_rejected', detail: error.message };
    }
    return { category: fallback, detail: error.message };
  }
  if (error instanceof VaultMetaError) {
    return {
      category: error.code === 'wrong-password' ? 'wrong_password' : 'meta_corrupt',
      detail: error.message,
    };
  }
  return {
    category: fallback,
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * `probeBucket`'s WebDAV counterpart: `ensureLayout` then a meta GET. A
 * plaintext vault on a store-backed binding is `meta_corrupt`, never
 * `existing-plain` — spec §6 forces `aes-gcm` for every cloud-drive backend,
 * so an unencrypted meta here is corruption, not a legitimate join target.
 */
export async function probeWebdav(
  fields: WebdavConnectFields,
  deps: WebdavConnectDeps = {},
): Promise<ProbeResult> {
  const binding = toWebdavBinding(fields);
  if (binding === null) return { kind: 'error', category: 'insecure_url' };
  const store = (deps.createStore ?? createProductionWebdavStore)(binding);

  let stored: Uint8Array | null;
  try {
    await store.ensureLayout();
    stored = await store.get(META_KEY);
  } catch (error) {
    return { kind: 'error', ...classifyStore(error, 'not_webdav') };
  }
  if (stored === null) return { kind: 'empty' };

  try {
    const meta = parseVaultMeta(decoder.decode(stored), APPEND_PROTOCOL_VERSION);
    if (meta.encryption !== 'aes-gcm') {
      return { kind: 'error', category: 'meta_corrupt', detail: 'unencrypted_store_vault' };
    }
    return { kind: 'existing-encrypted', meta };
  } catch (error) {
    return { kind: 'error', ...classifyStore(error, 'not_webdav') };
  }
}

/** `connectToBucket`'s WebDAV counterpart: create/adopt a v2 vault, or join one by password. */
export async function connectWebdav(
  input: Readonly<{
    fields: WebdavConnectFields;
    probe: ConnectableProbe;
    password?: string;
    passwordConfirm?: string;
  }>,
  deps: WebdavConnectDeps = {},
): Promise<ConnectResult> {
  const binding = toWebdavBinding(input.fields);
  if (binding === null) return { ok: false, category: 'insecure_url' };
  const store = (deps.createStore ?? createProductionWebdavStore)(binding);

  let meta: VaultMeta;
  let masterKey: Uint8Array;
  try {
    if (input.probe.kind === 'empty') {
      const invalid = validateNewPassword(input.password, input.passwordConfirm);
      if (invalid) return { ok: false, ...invalid };
      ({ meta, masterKey } = await createStoreVaultOrAdopt(store, input.password!));
    } else {
      // `existing-plain` cannot arrive from `probeWebdav` (spec §6 forces
      // aes-gcm on every store-backed vault), but a directly-constructed
      // probe could still carry one; treat it as corruption rather than
      // calling `openVaultWithPassword` with a meta it never expects — that
      // path can return null, which would leave `masterKey` unsound here.
      if (input.probe.meta.encryption !== 'aes-gcm') {
        return { ok: false, category: 'meta_corrupt', detail: 'unencrypted_store_vault' };
      }
      meta = input.probe.meta;
      const opened = await openVaultWithPassword(meta, input.password ?? null);
      if (opened === null) {
        return { ok: false, category: 'wrong_password' };
      }
      masterKey = opened;
    }
  } catch (error) {
    return { ok: false, ...classifyStore(error, 'not_webdav') };
  }

  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const sessionCache = deps.sessionCache ?? createByosSessionCache();
  await credentialStore.saveBinding(binding);
  await sessionCache.save({
    masterKeyB64: encodeBase64(masterKey),
    vaultId: meta.vaultId,
    encryption: 'aes-gcm',
  });

  return { ok: true, vaultId: meta.vaultId, encryption: 'aes-gcm' };
}

/** A signed-in OneDrive account + app folder, before or after it is persisted. `accessToken` is seeded from the sign-in so connect never refreshes (never rotates) before the binding is saved. */
export type OneDriveSource = Readonly<{ binding: OneDriveBinding; accessToken: string | null; expiresAt: number }>;

export type SignInResult = { ok: true; source: OneDriveSource } | ({ ok: false } & ByosConnectFailure);
export type ReauthResult = { ok: true } | ({ ok: false } & ByosConnectFailure);

/** `bootstrapOneDriveLayout`'s resolved shape. `onedrive-layout` exports the function, not a named result type; captured structurally here instead of editing that shared file. */
type OneDriveBootstrap = Awaited<ReturnType<typeof bootstrapOneDriveLayout>>;

export type OneDriveConnectDeps = Readonly<{
  createStore?: (source: OneDriveSource) => CloudObjectStore;
  signIn?: MicrosoftSignInPort;
  bootstrap?: (accessToken: string) => Promise<OneDriveBootstrap>;
  credentialStore?: ByosCredentialStore;
  sessionCache?: ByosSessionCache;
}>;

const defaultBootstrap = (accessToken: string): Promise<OneDriveBootstrap> =>
  bootstrapOneDriveLayout(cloudFetch, accessToken);

function oneDriveStore(source: OneDriveSource, deps: OneDriveConnectDeps, credentialStore: ByosCredentialStore): CloudObjectStore {
  return deps.createStore
    ? deps.createStore(source)
    : createProductionOneDriveStore(source.binding, { accessToken: source.accessToken ?? undefined, expiresAt: source.expiresAt, credentialStore });
}

/** Browser sign-in, then the app-folder bootstrap: yields the binding-to-be. Persists nothing. */
export async function signInWithMicrosoft(deps: OneDriveConnectDeps = {}): Promise<SignInResult> {
  const outcome = await (deps.signIn ?? createMicrosoftSignIn())();
  if (!outcome.ok) return { ok: false, category: outcome.category, detail: outcome.detail };
  try {
    const layout = await (deps.bootstrap ?? defaultBootstrap)(outcome.tokens.accessToken);
    return {
      ok: true,
      source: {
        binding: { kind: 'onedrive', refreshToken: outcome.tokens.refreshToken, accountEmail: layout.accountEmail, ...layout.ids },
        accessToken: outcome.tokens.accessToken,
        expiresAt: outcome.tokens.expiresAt,
      },
    };
  } catch (error) {
    return { ok: false, ...classifyStore(error, 'not_onedrive') };
  }
}

/** `probeWebdav`'s OneDrive counterpart (same rules: v2 + aes-gcm only). */
export async function probeOneDrive(source: OneDriveSource, deps: OneDriveConnectDeps = {}): Promise<ProbeResult> {
  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const store = oneDriveStore(source, deps, credentialStore);
  let stored: Uint8Array | null;
  try {
    await store.ensureLayout();
    stored = await store.get(META_KEY);
  } catch (error) {
    return { kind: 'error', ...classifyStore(error, 'not_onedrive') };
  }
  if (stored === null) return { kind: 'empty' };
  try {
    const meta = parseVaultMeta(decoder.decode(stored), APPEND_PROTOCOL_VERSION);
    if (meta.encryption !== 'aes-gcm') return { kind: 'error', category: 'meta_corrupt', detail: 'unencrypted_store_vault' };
    return { kind: 'existing-encrypted', meta };
  } catch (error) {
    return { kind: 'error', ...classifyStore(error, 'not_onedrive') };
  }
}

/** `connectWebdav`'s OneDrive counterpart. */
export async function connectOneDrive(
  input: Readonly<{ source: OneDriveSource; probe: ConnectableProbe; password?: string; passwordConfirm?: string }>,
  deps: OneDriveConnectDeps = {},
): Promise<ConnectResult> {
  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const store = oneDriveStore(input.source, deps, credentialStore);
  let meta: VaultMeta;
  let masterKey: Uint8Array;
  try {
    if (input.probe.kind === 'empty') {
      const invalid = validateNewPassword(input.password, input.passwordConfirm);
      if (invalid) return { ok: false, ...invalid };
      ({ meta, masterKey } = await createStoreVaultOrAdopt(store, input.password!));
    } else {
      if (input.probe.meta.encryption !== 'aes-gcm') return { ok: false, category: 'meta_corrupt', detail: 'unencrypted_store_vault' };
      meta = input.probe.meta;
      const opened = await openVaultWithPassword(meta, input.password ?? null);
      if (opened === null) return { ok: false, category: 'wrong_password' };
      masterKey = opened;
    }
  } catch (error) {
    return { ok: false, ...classifyStore(error, 'not_onedrive') };
  }
  const sessionCache = deps.sessionCache ?? createByosSessionCache();
  // The unlock path builds its source from the STORED binding and the probe
  // may have refreshed (= rotated) the token and written it back through the
  // store; that newer token must survive this save. A fresh connect has
  // nothing stored, so the sign-in's own token is saved.
  const stored = await credentialStore.loadBinding();
  const refreshToken = stored?.kind === 'onedrive' && stored.rootFolderId === input.source.binding.rootFolderId
    ? stored.refreshToken
    : input.source.binding.refreshToken;
  await credentialStore.saveBinding({ ...input.source.binding, refreshToken });
  await sessionCache.save({ masterKeyB64: encodeBase64(masterKey), vaultId: meta.vaultId, encryption: 'aes-gcm' });
  return { ok: true, vaultId: meta.vaultId, encryption: 'aes-gcm' };
}

/**
 * Spec §4.2 补裁 3: after `reauth_required`, sign in again and replace ONLY
 * the refresh token. Folder ids and the library password session are kept,
 * so the device is back exactly where it was. A different Microsoft account
 * is refused — its OneDrive does not hold this library.
 */
export async function reauthOneDrive(deps: OneDriveConnectDeps = {}): Promise<ReauthResult> {
  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const stored = await credentialStore.loadBinding();
  if (stored?.kind !== 'onedrive') return { ok: false, category: 'credential_rejected', detail: 'no_stored_credentials' };
  const outcome = await (deps.signIn ?? createMicrosoftSignIn())();
  if (!outcome.ok) return { ok: false, category: outcome.category, detail: outcome.detail };
  let layout: OneDriveBootstrap;
  try {
    layout = await (deps.bootstrap ?? defaultBootstrap)(outcome.tokens.accessToken);
  } catch (error) {
    return { ok: false, ...classifyStore(error, 'not_onedrive') };
  }
  if (layout.ids.rootFolderId !== stored.rootFolderId) return { ok: false, category: 'credential_rejected', detail: 'account_mismatch' };
  await credentialStore.saveBinding({ ...stored, refreshToken: outcome.tokens.refreshToken, accountEmail: layout.accountEmail });
  return { ok: true };
}

/** `OneDriveSource`'s Google Drive twin: a signed-in account + its `Waifu Deck` folder ids, before or after it is persisted. `accessToken` is seeded from the sign-in so probe/connect spend no refresh before the binding is saved. */
export type GdriveSource = Readonly<{ binding: GoogleDriveBinding; accessToken: string | null; expiresAt: number }>;

export type GdriveSignInResult = { ok: true; source: GdriveSource } | ({ ok: false } & ByosConnectFailure);

type GdriveBootstrap = Awaited<ReturnType<typeof bootstrapGoogleDriveLayout>>;

export type GdriveConnectDeps = Readonly<{
  createStore?: (source: GdriveSource) => CloudObjectStore;
  signIn?: GoogleSignInPort;
  bootstrap?: (accessToken: string) => Promise<GdriveBootstrap>;
  credentialStore?: ByosCredentialStore;
  sessionCache?: ByosSessionCache;
}>;

const defaultGdriveBootstrap = (accessToken: string): Promise<GdriveBootstrap> =>
  bootstrapGoogleDriveLayout(cloudFetch, accessToken);

/** Unlike OneDrive there is no credential store to thread: Google does not rotate refresh tokens (spec 补裁 3), so the store never writes one back. */
function gdriveStore(source: GdriveSource, deps: GdriveConnectDeps): CloudObjectStore {
  return deps.createStore
    ? deps.createStore(source)
    : createProductionGoogleDriveStore(source.binding, { accessToken: source.accessToken ?? undefined, expiresAt: source.expiresAt });
}

/** Browser sign-in, then the `Waifu Deck` folder bootstrap: yields the binding-to-be. Persists nothing. */
export async function signInWithGoogle(deps: GdriveConnectDeps = {}): Promise<GdriveSignInResult> {
  const outcome = await (deps.signIn ?? createGoogleSignIn())();
  if (!outcome.ok) return { ok: false, category: outcome.category, detail: outcome.detail };
  try {
    const layout = await (deps.bootstrap ?? defaultGdriveBootstrap)(outcome.tokens.accessToken);
    return {
      ok: true,
      source: {
        binding: { kind: 'gdrive', refreshToken: outcome.tokens.refreshToken, accountEmail: layout.accountEmail, ...layout.ids },
        accessToken: outcome.tokens.accessToken,
        expiresAt: outcome.tokens.expiresAt,
      },
    };
  } catch (error) {
    return { ok: false, ...classifyStore(error, 'not_gdrive') };
  }
}

/** `probeWebdav`'s Google Drive counterpart (same rules: v2 + aes-gcm only). */
export async function probeGdrive(source: GdriveSource, deps: GdriveConnectDeps = {}): Promise<ProbeResult> {
  const store = gdriveStore(source, deps);
  let stored: Uint8Array | null;
  try {
    await store.ensureLayout();
    stored = await store.get(META_KEY);
  } catch (error) {
    return { kind: 'error', ...classifyStore(error, 'not_gdrive') };
  }
  if (stored === null) return { kind: 'empty' };
  try {
    const meta = parseVaultMeta(decoder.decode(stored), APPEND_PROTOCOL_VERSION);
    if (meta.encryption !== 'aes-gcm') return { kind: 'error', category: 'meta_corrupt', detail: 'unencrypted_store_vault' };
    return { kind: 'existing-encrypted', meta };
  } catch (error) {
    return { kind: 'error', ...classifyStore(error, 'not_gdrive') };
  }
}

/**
 * `connectWebdav`'s Google Drive counterpart. The source's own binding is
 * saved as-is: OneDrive's "a stored, possibly rotated refresh token wins"
 * reconciliation has nothing to reconcile here (补裁 3: no rotation).
 */
export async function connectGdrive(
  input: Readonly<{ source: GdriveSource; probe: ConnectableProbe; password?: string; passwordConfirm?: string }>,
  deps: GdriveConnectDeps = {},
): Promise<ConnectResult> {
  const store = gdriveStore(input.source, deps);
  let meta: VaultMeta;
  let masterKey: Uint8Array;
  try {
    if (input.probe.kind === 'empty') {
      const invalid = validateNewPassword(input.password, input.passwordConfirm);
      if (invalid) return { ok: false, ...invalid };
      ({ meta, masterKey } = await createStoreVaultOrAdopt(store, input.password!));
    } else {
      if (input.probe.meta.encryption !== 'aes-gcm') return { ok: false, category: 'meta_corrupt', detail: 'unencrypted_store_vault' };
      meta = input.probe.meta;
      const opened = await openVaultWithPassword(meta, input.password ?? null);
      if (opened === null) return { ok: false, category: 'wrong_password' };
      masterKey = opened;
    }
  } catch (error) {
    return { ok: false, ...classifyStore(error, 'not_gdrive') };
  }
  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const sessionCache = deps.sessionCache ?? createByosSessionCache();
  await credentialStore.saveBinding(input.source.binding);
  await sessionCache.save({ masterKeyB64: encodeBase64(masterKey), vaultId: meta.vaultId, encryption: 'aes-gcm' });
  return { ok: true, vaultId: meta.vaultId, encryption: 'aes-gcm' };
}

/**
 * `reauthOneDrive`'s Google Drive counterpart: after `reauth_required`, sign
 * in again and replace ONLY the refresh token. Folder ids, the account
 * e-mail and the library password session are kept, so the device is back
 * exactly where it was.
 *
 * A different Google account is refused by comparing the bootstrapped
 * `Waifu Deck` folder id with the stored one, as OneDrive compares its app
 * folder. What that proves: the account signed in now can see THIS library's
 * folder under `drive.file`, which only the account that created it can — so
 * a re-sign-in to the same account compares equal, which is the feature, and
 * another account (which would bootstrap, i.e. create, its own folder) does
 * not. What it does not prove: it is not an identity check. The e-mail is
 * not compared, and if the user deleted the folder in Drive the same account
 * is refused too (its bootstrap creates a new id); disconnect-and-connect is
 * the way out of that state either way. Side effect of a refused re-sign-in:
 * the other account's bootstrap has already created an empty `Waifu Deck`
 * folder in that account's Drive, and it is left there (harmless, the user's
 * to delete; OneDrive's reauth behaves the same).
 */
export async function reauthGdrive(deps: GdriveConnectDeps = {}): Promise<ReauthResult> {
  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const stored = await credentialStore.loadBinding();
  if (stored?.kind !== 'gdrive') return { ok: false, category: 'credential_rejected', detail: 'no_stored_credentials' };
  const outcome = await (deps.signIn ?? createGoogleSignIn())();
  if (!outcome.ok) return { ok: false, category: outcome.category, detail: outcome.detail };
  let layout: GdriveBootstrap;
  try {
    layout = await (deps.bootstrap ?? defaultGdriveBootstrap)(outcome.tokens.accessToken);
  } catch (error) {
    return { ok: false, ...classifyStore(error, 'not_gdrive') };
  }
  if (layout.ids.rootFolderId !== stored.rootFolderId) return { ok: false, category: 'credential_rejected', detail: 'account_mismatch' };
  await credentialStore.saveBinding({ ...stored, refreshToken: outcome.tokens.refreshToken });
  return { ok: true };
}

/**
 * Disconnect this device only (D2: clear credentials + session + storage
 * mode; the bucket and other devices are untouched).
 *
 * All three stores are always attempted, even if one rejects: a half-disconnect
 * that leaves cached key material behind would be worse than either clean
 * outcome. The first failure is rethrown afterwards so the UI can say the
 * disconnect did not fully complete.
 */
export async function disconnectDevice(deps: ByosConnectDeps = {}): Promise<void> {
  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const sessionCache = deps.sessionCache ?? createByosSessionCache();
  const storageMode = deps.storageMode ?? createLibraryStorageModeStore();
  const outcomes = await Promise.allSettled([
    credentialStore.clear(),
    sessionCache.clear(),
    // Board #27 S3 (spec §5.8): 仅云端 survives neither 断开此设备 nor 删除全部应用数据
    storageMode.clear(),
  ]);
  const failure = outcomes.find((o) => o.status === 'rejected');
  if (failure) throw (failure as PromiseRejectedResult).reason;
}
