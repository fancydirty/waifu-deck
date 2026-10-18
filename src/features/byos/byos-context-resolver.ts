import { sha256 } from '@noble/hashes/sha2.js';
import { CloudStoreError, type CloudObjectStore } from '@/features/cloud-store/cloud-object-store';
import { createProductionGoogleDriveStore } from '@/features/cloud-store/gdrive-store-production';
import { createProductionOneDriveStore } from '@/features/cloud-store/onedrive-store-production';
import { createProductionWebdavStore } from '@/features/cloud-store/webdav-store-production';
import type { ByosResolvedContext } from '@/features/library/library-integration-types';

import { decodeBase64 } from './base64';
import { BYOS_DEFAULT_REGION, type ByosConnectError } from './byos-connect-flow';
import { cloudFetch } from './cloud-fetch';
import {
  createByosCredentialStore,
  type ByosBinding, type ByosCredentials, type ByosCredentialStore, type GoogleDriveBinding, type OneDriveBinding, type WebdavBinding,
} from './byos-credentials';
import { createDeviceIdStore, type DeviceIdStore } from './byos-device-id';
import {
  createByosSessionCache, type ByosSessionCache,
} from './byos-session-cache';
import {
  APPEND_PROTOCOL_VERSION, parseVaultMeta, VaultMetaError, type VaultMeta,
} from './byos-vault-meta';
import { createS3Transport, type S3FetchPort } from './s3-transport';
import { S3TransportError } from './s3-transport-types';

/**
 * Resolves the BYOS (bring-your-own-storage) vault state for the current app
 * session (design D3, `2026-08-30-byos-settings-ui-design.md`).
 *
 * Start-up asks one question — "can this device use its vault right now?" —
 * and gets one of three answers, never a silent downgrade (the P3C-3 M2
 * carry-over): `unconfigured` (BYOS was never set up here), `ready` (a
 * fully-assembled `ByosResolvedContext` for `createLibraryIntegration`), or
 * `locked` with a reason the settings section and the library's "unavailable"
 * row show the user verbatim-ish (D7). "Configured but broken" must never
 * render as "not configured".
 *
 * Every remote failure is returned as a `locked` status; this function does
 * not throw for network, credential, or vault-meta problems. Local
 * SecureStore faults still reject, because a device that cannot read its own
 * keychain has no honest status to report.
 *
 * Two branches assemble a context: an `s3` binding through the CAS transport
 * (`assembleContext`, protocol 1), and a `webdav`, `onedrive` or `gdrive`
 * binding through a `CloudObjectStore` (`resolveStoreBinding`, board #12
 * P12-B/C/D, append protocol 2). Every binding kind this build can parse
 * resolves; a stored binding it cannot parse (including a `kind` it does not
 * know) reads as `unconfigured` — see `resolveByosStatus`.
 */

const META_KEY = 'vault-meta.json';

/**
 * `unconfigured` and `ready` need no refinement; every lock reason but
 * `password_required` carries a remote `detail` (`vault_unreachable`,
 * `meta_corrupt`).
 */
export type ByosLockedReason = 'password_required' | 'vault_unreachable' | 'meta_corrupt';

/** Every binding a `CloudObjectStore` adapter exists for (P12-B WebDAV, P12-C OneDrive, P12-D Google Drive). */
export type StoreBackedBinding = WebdavBinding | OneDriveBinding | GoogleDriveBinding;

/**
 * Why the vault could not be reached, in the *same* vocabulary the connect
 * flow reports (`ByosConnectError`), so one D7 string table serves both the
 * connect-time and the start-up-time presentation of the identical failures.
 * `Extract` makes that alignment a compile-time fact: these are exactly the
 * connect categories a vault-meta GET can produce.
 */
export type ByosUnreachableDetail =
  Extract<ByosConnectError, 'network' | 'credential_rejected' | 'not_s3' | 'not_webdav' | 'not_onedrive' | 'not_gdrive' | 'reauth_required'>;

/**
 * Why the vault-meta could not be used. `meta_absent` is the "bucket was
 * wiped or re-created empty" case — this device holds credentials for a vault
 * that no longer exists, which reads as corruption to the user but deserves
 * its own copy; the other two are `VaultMetaError.code` values reachable from
 * `parseVaultMeta`.
 */
export type ByosMetaCorruptDetail = 'meta_absent' | 'malformed' | 'unsupported-version';

/**
 * The binding kinds whose sign-in can expire and be redone in a browser —
 * the two drive providers. Declared here (not imported from the settings
 * layer's `SignInProvider`, which is the same `Extract`) so the resolver stays
 * UI-free.
 */
export type ByosSignInProvider = Extract<ByosBinding['kind'], 'onedrive' | 'gdrive'>;

export type ByosStatus =
  | { readonly status: 'unconfigured' }
  | { readonly status: 'ready'; readonly context: ByosResolvedContext }
  | {
      readonly status: 'locked';
      readonly reason: 'vault_unreachable';
      readonly detail: Exclude<ByosUnreachableDetail, 'reauth_required'>;
    }
  | {
      // P12-D Task 11: the settings row under this lock offers exactly one
      // action — sign in again with the provider that is bound — so the lock
      // carries which one. Without it the row had to guess, and it guessed
      // Microsoft (the Task 8 drift review's Important finding).
      readonly status: 'locked';
      readonly reason: 'vault_unreachable';
      readonly detail: 'reauth_required';
      readonly provider: ByosSignInProvider;
    }
  | {
      readonly status: 'locked';
      readonly reason: 'meta_corrupt';
      readonly detail: ByosMetaCorruptDetail;
    }
  | { readonly status: 'locked'; readonly reason: 'password_required' };

/**
 * The single object this resolver reads. Narrower than the connect flow's
 * `ByosTransportPort` (no `putObject`): resolving never writes to the bucket,
 * and a real `createS3Transport` satisfies both structurally.
 */
export type ByosResolverTransportPort = {
  getObject(key: string): Promise<{ body: Uint8Array } | null>;
};

export type ByosResolveDeps = Readonly<{
  credentialStore?: ByosCredentialStore;
  sessionCache?: ByosSessionCache;
  deviceIdStore?: DeviceIdStore;
  /** Replaces transport construction wholesale (unit tests). */
  createTransport?: (credentials: ByosCredentials) => ByosResolverTransportPort;
  /** Keeps production transport construction, swaps only its HTTP client. */
  fetchImpl?: S3FetchPort;
  /** Replaces WebDAV/OneDrive/Google Drive store construction wholesale (unit tests). */
  createStore?: (binding: StoreBackedBinding) => CloudObjectStore;
}>;

/**
 * React Native's global fetch mangles binary bodies; `expo/fetch` is the
 * supported native client. Same injection as the Direct composition
 * (`library-integration-impl.ts`) and the connect flow.
 *
 * Stored credentials always carry a region (the connect flow defaults it, and
 * the credential store rejects an entry without one), so the fallback below
 * only covers a user who typed nothing but whitespace into an overridable
 * region field. It resolves to the same `BYOS_DEFAULT_REGION` the connect
 * flow signs with, so a bucket that connected can always be re-read.
 */
function defaultCreateTransport(
  credentials: ByosCredentials,
  fetchImpl: S3FetchPort | undefined,
): ByosResolverTransportPort {
  return createS3Transport(
    credentials.region === '' ? { ...credentials, region: BYOS_DEFAULT_REGION } : credentials,
    { fetchImpl: fetchImpl ?? cloudFetch },
  );
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Decision #21's pseudo master key for `encryption: 'none'` vaults:
 * `sha256(utf8(vaultId))`. Identity, account scope, and asset-id derivation
 * all need 32 bytes even with encryption off ("no encryption" must not
 * silently become "no sync"), and this value is not key material — the
 * `'none'` dispatch in `library-integration-impl.ts` hands it only to
 * the passthrough cipher.
 *
 * Deliberately re-derived here rather than cached (see `byos-session-cache`):
 * it is a pure function of `vaultId`, so storing it would invent a second
 * place it could drift. It reproduces `library-session-port.ts`'s private
 * `vaultIdIdentityDigest`; both must stay `sha256(utf8(vaultId))` or a
 * `'none'` vault's account scope would change under it.
 */
function deriveNoneVaultMasterKey(vaultId: string): Uint8Array {
  return sha256(encoder.encode(vaultId));
}

/**
 * The meta GET's failure funnel. Mirrors the connect flow's `classify` for
 * the categories a GET can raise:
 *
 * | source                           | detail              |
 * |----------------------------------|---------------------|
 * | S3TransportError 'network'       | network             |
 * | S3TransportError 'rate_limited'  | network             |
 * | S3TransportError 'credential'    | credential_rejected |
 * | S3TransportError 'client'/'server'/'precondition' | not_s3 |
 * | anything else (e.g. `new URL` on a corrupt stored endpoint) | not_s3 |
 *
 * `not_found` never arrives here: `getObject` resolves null for a 404, which
 * this resolver reads as `meta_absent` rather than unreachable.
 */
function classifyUnreachable(error: unknown): Exclude<ByosUnreachableDetail, 'reauth_required'> {
  if (error instanceof S3TransportError) {
    switch (error.category) {
      case 'network':
      case 'rate_limited':
        return 'network';
      case 'credential':
        return 'credential_rejected';
      default:
        return 'not_s3';
    }
  }
  return 'not_s3';
}

function classifyMetaError(error: unknown): ByosMetaCorruptDetail {
  // `parseVaultMeta` only ever throws VaultMetaError, and only with
  // 'malformed' or 'unsupported-version' ('wrong-password' comes from
  // opening, which this resolver never does).
  return error instanceof VaultMetaError && error.code === 'unsupported-version'
    ? 'unsupported-version'
    : 'malformed';
}

/**
 * The store meta GET's failure funnel — `classifyUnreachable`'s counterpart
 * for a `CloudObjectStore` (board #12 P12-B/C/D). `rate_limited` reads as
 * `network` for the same reason as the S3 mapping (reachable, not usefully
 * answering); `not_found` never arrives here (`get` resolves null for an
 * absent key, read as `meta_absent`, not unreachable). `auth` whose message
 * names `reauth_required` is the OneDrive or Google token source saying the
 * saved sign-in is gone (spec §4.2/§4.3) — its own lock, carrying the bound
 * provider, so the settings page can offer that provider's 「重新登录」 instead
 * of a password field. A WebDAV binding has no sign-in, and N9 ruled its
 * `auth` reads as `network` (a 401/403 may be the store's own transient
 * misbehavior, never an accusation of the stored credentials).
 * Everything else that is neither
 * transport nor auth reads as "answered, but not like a usable <backend>" in
 * the backend's own vocabulary.
 */
function classifyStoreUnreachable(error: unknown, kind: StoreBackedBinding['kind']): ByosStatus & { status: 'locked'; reason: 'vault_unreachable' } {
  const locked = (detail: Exclude<ByosUnreachableDetail, 'reauth_required'>) =>
    ({ status: 'locked', reason: 'vault_unreachable', detail }) as const;
  if (error instanceof CloudStoreError) {
    if (error.category === 'network' || error.category === 'rate_limited') return locked('network');
    if (error.category === 'auth') {
      // Only a drive provider has a sign-in to redo; a WebDAV 401 is its own
      // stored username/password being refused.
      if (error.message.includes('reauth_required') && kind !== 'webdav') {
        return { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: kind };
      }
      // N9 (owner 2026-10-12): a WebDAV 401/403 is indistinguishable from the
      // store's transient misbehavior — 123 云盘 answered 401 for two minutes
      // and healed itself — so the locked card says 暂时连不上 and reconnects
      // on its own, never blaming the stored credentials.
      if (kind === 'webdav') return locked('network');
      return locked('credential_rejected');
    }
  }
  switch (kind) {
    case 'webdav': return locked('not_webdav');
    case 'onedrive': return locked('not_onedrive');
    case 'gdrive': return locked('not_gdrive');
  }
}

/**
 * The three adapters need different construction inputs, so this dispatches
 * per kind: WebDAV and Google Drive need nothing beyond the binding; OneDrive
 * also takes the resolver's own credential store (see the inline comment
 * below for why).
 */
function productionStore(binding: StoreBackedBinding, credentialStore: ByosCredentialStore): CloudObjectStore {
  switch (binding.kind) {
    case 'webdav':
      return createProductionWebdavStore(binding);
    case 'onedrive':
      // The resolver's credential store is the rotation write-back target: a
      // refresh during the meta GET must persist the new token through the
      // same store the binding was read from.
      return createProductionOneDriveStore(binding, { credentialStore });
    case 'gdrive':
      // No credential store on purpose: Google refresh tokens do not rotate
      // (spec 补裁 3), so there is nothing to write back.
      return createProductionGoogleDriveStore(binding);
  }
}

/**
 * The `webdav`/`onedrive`/`gdrive` (store-backed) binding's branch of
 * {@link resolveByosStatus}: same three-question shape as the S3 path —
 * reachable, has a meta, the meta unlocks — over a `CloudObjectStore` instead
 * of the CAS transport, and pinned to the append-only protocol (v2,
 * `byos-vault-meta.ts`) and forced `aes-gcm` encryption (spec §6: cloud-drive
 * backends do not offer an unencrypted vault).
 */
async function resolveStoreBinding(
  binding: StoreBackedBinding,
  deps: ByosResolveDeps,
  credentialStore: ByosCredentialStore,
): Promise<ByosStatus> {
  // Construction sits inside the try on purpose: this resolver never throws
  // for remote or config trouble, and a stored binding can be corrupt in ways
  // the factory rejects (a baseUrl `new URL` refuses) — that is a lock, not a crash.
  let store: CloudObjectStore;
  let stored: Uint8Array | null;
  try {
    store = deps.createStore ? deps.createStore(binding) : productionStore(binding, credentialStore);
    stored = await store.get(META_KEY);
  } catch (error) {
    return classifyStoreUnreachable(error, binding.kind);
  }
  if (stored === null) {
    return { status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent' };
  }

  let meta: VaultMeta;
  try {
    meta = parseVaultMeta(decoder.decode(stored), APPEND_PROTOCOL_VERSION);
  } catch (error) {
    return { status: 'locked', reason: 'meta_corrupt', detail: classifyMetaError(error) };
  }
  if (meta.protocolVersion !== APPEND_PROTOCOL_VERSION || meta.encryption !== 'aes-gcm') {
    // Either an S3-protocol (v1) meta bound as webdav, or an unencrypted
    // meta — spec §6 forces encryption for every cloud-drive backend, so this
    // is not a password_required case, it is a malformed vault.
    return { status: 'locked', reason: 'meta_corrupt', detail: 'malformed' };
  }

  const sessionCache = deps.sessionCache ?? createByosSessionCache();
  const cached = await sessionCache.load();
  if (
    cached === null
    || cached.vaultId !== meta.vaultId
    || cached.encryption !== 'aes-gcm'
    || cached.masterKeyB64 === null
  ) {
    return { status: 'locked', reason: 'password_required' };
  }

  const deviceIdStore = deps.deviceIdStore ?? createDeviceIdStore();
  return {
    status: 'ready',
    context: {
      kind: 'store',
      binding,
      store,
      meta,
      masterKey: decodeBase64(cached.masterKeyB64),
      deviceId: await deviceIdStore.get(),
    },
  };
}

export async function resolveByosStatus(
  deps: ByosResolveDeps = {},
): Promise<ByosStatus> {
  // 1. Credentials. Absent means BYOS was never configured on this device (or
  //    was disconnected), which is the only status that costs no network.
  //    `loadBinding` also answers null for a stored binding it cannot parse —
  //    including a `kind` this build does not know — so that reads as
  //    unconfigured too: nothing was stored that this build can name. There
  //    is deliberately no "known but unavailable" lock (the pre-P12-D
  //    `backend_unavailable`): every kind in `ByosBinding` resolves below, and
  //    a future backend arrives with its own adapter, not a placeholder lock.
  const credentialStore = deps.credentialStore ?? createByosCredentialStore();
  const binding = await credentialStore.loadBinding();
  if (binding === null) return { status: 'unconfigured' };
  if (binding.kind === 'webdav' || binding.kind === 'onedrive' || binding.kind === 'gdrive') {
    return resolveStoreBinding(binding, deps, credentialStore);
  }
  const credentials = binding;

  // 2. Vault-meta. This GET is unconditional — it is also the liveness probe,
  //    and skipping it on a cache hit is what would let a wiped bucket, dead
  //    endpoint, or revoked key masquerade as a healthy vault until the first
  //    sync. Re-deriving the key is what the cache saves (D2), not the read.
  let stored: { body: Uint8Array } | null;
  try {
    const transport = deps.createTransport
      ? deps.createTransport(credentials)
      : defaultCreateTransport(credentials, deps.fetchImpl);
    stored = await transport.getObject(`${credentials.prefix}${META_KEY}`);
  } catch (error) {
    return {
      status: 'locked',
      reason: 'vault_unreachable',
      detail: classifyUnreachable(error),
    };
  }
  if (stored === null) {
    return { status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent' };
  }

  let meta: VaultMeta;
  try {
    meta = parseVaultMeta(decoder.decode(stored.body));
  } catch (error) {
    return {
      status: 'locked',
      reason: 'meta_corrupt',
      detail: classifyMetaError(error),
    };
  }

  // 3/4. Session. The bucket's meta is authoritative: a cached session for a
  //      different vaultId (bucket re-created) or a different encryption mode
  //      does not describe this vault and is ignored.
  const sessionCache = deps.sessionCache ?? createByosSessionCache();
  const cached = await sessionCache.load();
  const session = cached !== null
    && cached.vaultId === meta.vaultId
    && cached.encryption === meta.encryption
    ? cached
    : null;

  if (meta.encryption === 'none') {
    // No password exists to require, so a cache miss is not a lock — the
    // pseudo key is derivable from meta alone. Backfilling keeps the cached
    // session an accurate record of what this device is connected to
    // (disconnect clears both), but ready-ness never depends on it, so a
    // keychain write failure must not deny the user their vault.
    if (session === null) {
      try {
        await sessionCache.save({
          masterKeyB64: null,
          vaultId: meta.vaultId,
          encryption: 'none',
        });
      } catch {
        // Best-effort cache warm; the next start re-derives identically.
      }
    }
    return {
      status: 'ready',
      context: await assembleContext(
        credentials, meta, deriveNoneVaultMasterKey(meta.vaultId), deps,
      ),
    };
  }

  // aes-gcm without usable cached key material: only the user's password can
  // unlock this, which is the settings section's job (D1 unlock path).
  // `masterKeyB64` is non-null for every aes-gcm entry the session cache
  // admits; the check keeps that invariant local rather than assumed.
  if (session === null || session.masterKeyB64 === null) {
    return { status: 'locked', reason: 'password_required' };
  }
  // `decodeBase64` returns a standalone Uint8Array (built via
  // `Uint8Array.from(number[])`), not a view into a shared/pooled ArrayBuffer,
  // so this key handed to crypto code owns its own bytes.
  const masterKey = decodeBase64(session.masterKeyB64);
  return {
    status: 'ready',
    context: await assembleContext(credentials, meta, masterKey, deps),
  };
}

/**
 * Device identity is read only here: minting a device id for a vault this
 * device cannot open would put an id in SecureStore for a session that never
 * happened.
 */
async function assembleContext(
  credentials: ByosCredentials,
  meta: VaultMeta,
  masterKey: Uint8Array,
  deps: ByosResolveDeps,
): Promise<ByosResolvedContext> {
  const deviceIdStore = deps.deviceIdStore ?? createDeviceIdStore();
  const deviceId = await deviceIdStore.get();
  return { kind: 's3', credentials, meta, masterKey, deviceId };
}

/**
 * Ready-or-null view of {@link resolveByosStatus}, matching what
 * `createLibraryIntegration` accepts (`LibraryIntegrationInput.byos`,
 * decision #23): a `locked` vault composes the same local-only core as an
 * unconfigured one, because there is nothing to talk to the bucket with
 * either way.
 *
 * Callers that show the user anything must use `resolveByosStatus` instead —
 * this wrapper deliberately discards the reason, and presenting `locked` as
 * `unconfigured` is the exact silent downgrade D3 forbids.
 */
export async function resolveByosContext(
  deps: ByosResolveDeps = {},
): Promise<ByosResolvedContext | null> {
  const resolved = await resolveByosStatus(deps);
  return resolved.status === 'ready' ? resolved.context : null;
}
