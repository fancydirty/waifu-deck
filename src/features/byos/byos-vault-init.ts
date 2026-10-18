import type { CloudObjectStore } from '@/features/cloud-store/cloud-object-store';

import {
  APPEND_PROTOCOL_VERSION, buildVaultMeta, openVaultWithPassword, parseVaultMeta, VaultMetaError,
  type VaultEncryption, type VaultMeta,
} from './byos-vault-meta';

const META_KEY = 'vault-meta.json';

/**
 * Matches the real P3A `createS3Transport` return shape (see s3-transport.ts):
 * getObject resolves `null` on 404; putObject requires an options object
 * (each field itself optional) and its etag may be null if the store omits
 * the header.
 */
type VaultTransport = {
  getObject(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  putObject(
    key: string,
    body: Uint8Array,
    options: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<{ etag: string | null }>;
};

function isPreconditionError(err: unknown): boolean {
  return !!err && (err as { category?: string }).category === 'precondition';
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Create the vault, or adopt the one another device created first.
 *
 * One conditional PUT (`If-None-Match: *`). A 412 means a vault already
 * exists: read it and open it with `password`. K7 ㉟: the read that used to
 * precede the PUT duplicated `probeBucket`'s GET (the caller has already
 * probed) and the PUT's own precondition, and cost a full round trip on a
 * connection that may have gone cold while the user typed a password.
 *
 * Precondition: `encryption === 'aes-gcm'` requires a non-null `password`
 * (`connectToBucket` validates it first); otherwise `buildVaultMeta` throws a
 * `VaultMetaError` before any request is made.
 */
export async function createVaultOrAdopt(
  transport: VaultTransport,
  prefix: string,
  password: string | null,
  encryption: VaultEncryption,
): Promise<{ meta: VaultMeta; masterKey: Uint8Array | null }> {
  const key = `${prefix}${META_KEY}`;
  const built = await buildVaultMeta(password, encryption);
  try {
    await transport.putObject(
      key, encoder.encode(JSON.stringify(built.meta)), { ifNoneMatch: '*' },
    );
    return built;
  } catch (err) {
    if (!isPreconditionError(err)) throw err;
    const existing = await transport.getObject(key);
    if (existing === null) throw err;
    const meta = parseVaultMeta(decoder.decode(existing.body));
    return { meta, masterKey: await openVaultWithPassword(meta, password) };
  }
}

/**
 * Board #12 / spec §3.4 + §6: the store variant of `parseVaultMeta`. A
 * store-backed vault is exactly `protocolVersion` 2 — the value that MARKS the
 * append-only layout (spec §3.4). Anything else is refused: a newer version is
 * this app being too old (`unsupported-version`), and a version-1 meta is an
 * S3 CAS-layout vault that a 4-action store cannot serve (`malformed`), so it
 * must never be adopted as an append-only one. Spec §6 then forces encryption:
 * an unencrypted vault-meta on a store backend is malformed, not adoptable.
 */
function parseStoreVaultMeta(json: string): VaultMeta {
  const meta = parseVaultMeta(json, APPEND_PROTOCOL_VERSION);
  if (meta.protocolVersion !== APPEND_PROTOCOL_VERSION) {
    throw new VaultMetaError(
      `Store-backed vaults use protocolVersion ${APPEND_PROTOCOL_VERSION}; this vault-meta.json (version ${meta.protocolVersion}) was written by the S3 layout.`,
    );
  }
  if (meta.encryption !== 'aes-gcm') {
    throw new VaultMetaError(
      'Store-backed vaults must be encrypted (spec §6); refusing to adopt an unencrypted vault-meta.json.',
    );
  }
  return meta;
}

/**
 * `openVaultWithPassword` returns null only for `encryption: 'none'`, which
 * `parseStoreVaultMeta` has already refused — so the null branch is
 * unreachable here, and this turns that invariant into a thrown guarantee
 * instead of a silent `!`, giving `createStoreVaultOrAdopt` a non-null key.
 */
async function requireStoreVaultKey(meta: VaultMeta, password: string): Promise<Uint8Array> {
  const masterKey = await openVaultWithPassword(meta, password);
  if (masterKey === null) {
    throw new VaultMetaError('Store-backed vault produced no key despite aes-gcm encryption.');
  }
  return masterKey;
}

/**
 * Create the vault, or adopt the one another device created first — for the
 * 4-action `CloudObjectStore` port (WebDAV / OneDrive / Google Drive), which
 * has no conditional write and no ETag.
 *
 * Read, then write, then read back: since a second writer can land its own
 * `put` of the same name between our write and our read, the object this
 * function ends up trusting is whatever the read-back actually contains, not
 * necessarily the bytes we just sent — so a losing race re-derives its key
 * from the winner's meta rather than the caller's own build. Spec §6 forces
 * `encryption: 'aes-gcm'` unconditionally: there is no `encryption` parameter
 * because a store-backed vault is never created unencrypted.
 */
export async function createStoreVaultOrAdopt(
  store: Pick<CloudObjectStore, 'get' | 'put'>,
  password: string,
): Promise<{ meta: VaultMeta; masterKey: Uint8Array }> {
  const existing = await store.get(META_KEY);
  if (existing !== null) {
    const meta = parseStoreVaultMeta(decoder.decode(existing));
    return { meta, masterKey: await requireStoreVaultKey(meta, password) };
  }

  const built = await buildVaultMeta(password, 'aes-gcm', undefined, APPEND_PROTOCOL_VERSION);
  await store.put(META_KEY, encoder.encode(JSON.stringify(built.meta)), 'application/json');

  // No conditional write on this port: trust whatever a read-back actually
  // contains, since another device's PUT of the same name may have landed
  // between our write and this read.
  const readBack = await store.get(META_KEY);
  if (readBack === null) {
    throw new VaultMetaError('vault-meta.json disappeared immediately after being written.');
  }
  const meta = parseStoreVaultMeta(decoder.decode(readBack));
  // Our own bytes came back: the key is already derived, so skip a second
  // scrypt. Any other body is the winner of a race and opens with ITS salt.
  if (meta.vaultId === built.meta.vaultId) return { meta: built.meta, masterKey: built.masterKey! };
  return { meta, masterKey: await requireStoreVaultKey(meta, password) };
}
