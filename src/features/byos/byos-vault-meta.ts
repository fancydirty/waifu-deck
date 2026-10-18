import { hexToBytes } from '@noble/hashes/utils.js';
import { getRandomBytesAsync } from 'expo-crypto';
// vaultId is derived from getRandomBytesAsync rather than expo-crypto's
// randomUUID(): jest-expo's implicit native-module automock (used by any
// test file that does not `jest.mock('expo-crypto', ...)`, e.g.
// byos-vault-init.test.ts) resolves randomUUID() to `undefined`, but still
// resolves getRandomBytesAsync() to a real (all-zero) Uint8Array. Deriving
// from bytes keeps buildVaultMeta working under both the explicit
// expo-crypto-double mock and the implicit automock.

import { decodeBase64, encodeBase64 } from './base64';
import {
  computeKeyCheck, deriveVaultKey, DEFAULT_SCRYPT_PARAMS, type ScryptParams,
} from './byos-keys';

export const SUPPORTED_PROTOCOL_VERSION = 1;
/**
 * Spec §3.4: a vault-meta written by the append-only (cloud-drive) layout.
 * S3 vaults stay at 1, and the S3 path keeps parsing with the default ceiling,
 * so a v2 meta can never be mistaken for a CAS-protocol bucket.
 */
export const APPEND_PROTOCOL_VERSION = 2;
export type VaultEncryption = 'aes-gcm' | 'none';

export type VaultMeta = {
  format: 'waifu-deck-byos';
  protocolVersion: number;
  encryption: VaultEncryption;
  vaultId: string;
  kdf: { algo: 'scrypt'; N: number; r: number; p: number; saltB64: string };
  keyCheckB64: string;
  createdAt: string;
};

export class VaultMetaError extends Error {
  constructor(message: string, readonly code:
    'malformed' | 'unsupported-version' | 'wrong-password' = 'malformed') {
    super(message);
    this.name = 'VaultMetaError';
  }
}

const SCRYPT_N_MIN = 2 ** 10;
const SCRYPT_N_MAX = 2 ** 20;
const SCRYPT_R_MIN = 1;
const SCRYPT_R_MAX = 32;
const SCRYPT_P_MIN = 1;
const SCRYPT_P_MAX = 16;

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function toB64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}
function fromB64(value: string): Uint8Array {
  return decodeBase64(value);
}

function bytesToUuidV4(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
  const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function buildVaultMeta(
  password: string | null,
  encryption: VaultEncryption,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
  protocolVersion: number = SUPPORTED_PROTOCOL_VERSION,
): Promise<{ meta: VaultMeta; masterKey: Uint8Array | null }> {
  const salt = await getRandomBytesAsync(16);
  const vaultId = bytesToUuidV4(await getRandomBytesAsync(16));
  let keyCheckB64 = '';
  let masterKey: Uint8Array | null = null;
  if (encryption === 'aes-gcm') {
    if (password === null) {
      throw new VaultMetaError('Password required for aes-gcm vault.');
    }
    masterKey = await deriveVaultKey(password, salt, params);
    keyCheckB64 = toB64(hexToBytes(computeKeyCheck(masterKey)));
  }
  const meta: VaultMeta = {
    format: 'waifu-deck-byos',
    protocolVersion,
    encryption,
    vaultId,
    kdf: { algo: 'scrypt', N: params.N, r: params.r, p: params.p, saltB64: toB64(salt) },
    keyCheckB64,
    createdAt: new Date().toISOString(),
  };
  return { meta, masterKey };
}

export function parseVaultMeta(json: string, maxProtocolVersion: number = SUPPORTED_PROTOCOL_VERSION): VaultMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new VaultMetaError('vault-meta.json is not valid JSON.');
  }
  const m = raw as Partial<VaultMeta>;
  if (m.format !== 'waifu-deck-byos' || typeof m.protocolVersion !== 'number') {
    throw new VaultMetaError('vault-meta.json is missing required fields.');
  }
  if (m.protocolVersion > maxProtocolVersion) {
    throw new VaultMetaError(
      `vault-meta.json protocolVersion ${m.protocolVersion} is newer than this app supports.`,
      'unsupported-version',
    );
  }
  if (m.encryption !== 'aes-gcm' && m.encryption !== 'none') {
    throw new VaultMetaError('vault-meta.json has an unknown encryption mode.');
  }
  if (typeof m.vaultId !== 'string' || m.vaultId.length === 0) {
    throw new VaultMetaError('vault-meta.json is missing a vaultId.');
  }
  if (!m.kdf || m.kdf.algo !== 'scrypt' || typeof m.kdf.saltB64 !== 'string') {
    throw new VaultMetaError('vault-meta.json has an invalid kdf block.');
  }
  const { N, r, p } = m.kdf;
  const nValid = Number.isInteger(N) && isPowerOfTwo(N) && N >= SCRYPT_N_MIN && N <= SCRYPT_N_MAX;
  const rValid = Number.isInteger(r) && r >= SCRYPT_R_MIN && r <= SCRYPT_R_MAX;
  const pValid = Number.isInteger(p) && p >= SCRYPT_P_MIN && p <= SCRYPT_P_MAX;
  if (!nValid || !rValid || !pValid) {
    throw new VaultMetaError('vault-meta.json has out-of-range scrypt parameters.');
  }
  return m as VaultMeta;
}

export async function openVaultWithPassword(
  meta: VaultMeta,
  password: string | null,
): Promise<Uint8Array | null> {
  if (meta.encryption === 'none') return null;
  if (password === null) {
    throw new VaultMetaError('Password required.', 'wrong-password');
  }
  const salt = fromB64(meta.kdf.saltB64);
  const masterKey = await deriveVaultKey(password, salt, {
    N: meta.kdf.N, r: meta.kdf.r, p: meta.kdf.p,
  });
  const expected = toB64(hexToBytes(computeKeyCheck(masterKey)));
  if (expected !== meta.keyCheckB64) {
    throw new VaultMetaError('Password does not match this vault.', 'wrong-password');
  }
  return masterKey;
}
