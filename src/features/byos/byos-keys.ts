import { scryptAsync } from '@noble/hashes/scrypt.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export type ScryptParams = { N: number; r: number; p: number };
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 32;
const KEY_CHECK_LABEL = 'waifu-deck-keycheck-v1';

export async function deriveVaultKey(
  password: string,
  salt: Uint8Array,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<Uint8Array> {
  return await scryptAsync(utf8ToBytes(password), salt, {
    N: params.N, r: params.r, p: params.p, dkLen: KEY_BYTES,
  });
}

export function computeKeyCheck(masterKey: Uint8Array): string {
  return bytesToHex(hmac(sha256, masterKey, utf8ToBytes(KEY_CHECK_LABEL)));
}
