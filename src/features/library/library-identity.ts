import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const LIBRARY_ASSET_ID_PATTERN = /^[0-9a-f]{64}$/u;

const MASTER_KEY_BYTES = 32;
const ACCOUNT_SCOPE_HEX_LENGTH = 32;
const ACCOUNT_SCOPE_LABEL = 'waifu-deck:library:account-scope:v1';
const encoder = new TextEncoder();

function lowercaseHex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function assertMasterKey(masterKey: Uint8Array): Uint8Array {
  if (masterKey.byteLength !== MASTER_KEY_BYTES) {
    throw new Error('Invalid Vault master key length.');
  }
  return masterKey;
}

function digestBytes(plaintextSha256Hex: string): Uint8Array {
  if (!LIBRARY_ASSET_ID_PATTERN.test(plaintextSha256Hex)) {
    throw new Error('Invalid plaintext digest.');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(
      plaintextSha256Hex.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

/**
 * Layer A identity. No key, no account, no network: this is the local content
 * id, the durable file name stem, and the `device_library_assets` primary key.
 */
export function sha256PlaintextHex(plaintext: Uint8Array): string {
  return lowercaseHex(sha256(plaintext));
}

/**
 * Layer B only. Vault-scoped keyed identity from the program map:
 * `hmac(sha256, accountVaultKey, plaintextSha256)` over the raw digest bytes.
 * Equal plaintext in two different accounts yields two unrelated ids.
 */
export function deriveLibraryAssetId(
  accountVaultKey: Uint8Array,
  plaintextSha256Hex: string,
): string {
  return lowercaseHex(hmac(
    sha256,
    assertMasterKey(accountVaultKey),
    digestBytes(plaintextSha256Hex),
  ));
}

/**
 * Layer B only. Local database partition tag; it never leaves the device,
 * because SP8 submits the real session account id. It exists so a device that
 * signs into a second account keeps its account rows separate without storing
 * the account id in the library tables. Layer A rows have no scope at all.
 */
export function deriveLibraryAccountScope(
  accountVaultKey: Uint8Array,
): string {
  return lowercaseHex(hmac(
    sha256,
    assertMasterKey(accountVaultKey),
    encoder.encode(ACCOUNT_SCOPE_LABEL),
  )).slice(0, ACCOUNT_SCOPE_HEX_LENGTH);
}
