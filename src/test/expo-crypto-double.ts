/**
 * A deterministic, reversible, authenticated stand-in for the `expo-crypto`
 * AES-GCM surface, for Jest only. It is not cryptography: it exists so tests
 * can prove real round-trips, additional-data binding, and tamper rejection
 * without a native module.
 *
 * `digest` below is the one exception: it is genuine SHA-256. Under
 * `jest-expo` the unmocked native module answers `digest` with a 32-byte
 * ZERO buffer, which would let a wrong SigV4 payload hash pass every unit
 * test and only fail against a real backend, so any suite that exercises the
 * S3 transport's default hash port must map `expo-crypto` here.
 */
import { sha256 } from '@noble/hashes/sha2.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

let nonceSequence = 0;
let uuidSequence = 0;

export function resetExpoCryptoDouble(): void {
  nonceSequence = 0;
  uuidSequence = 0;
}

export async function getRandomBytesAsync(length: number): Promise<Uint8Array> {
  nonceSequence += 1;
  return Uint8Array.from(
    { length },
    (_, index) => (nonceSequence * 31 + index * 7) % 256,
  );
}

/** Board #12: the ULID minter's random tail. Test-only; not cryptographic. */
export function getRandomValues<T extends Uint8Array>(array: T): T {
  for (let i = 0; i < array.length; i += 1) array[i] = Math.floor(Math.random() * 256);
  return array;
}

export function randomUUID(): string {
  uuidSequence += 1;
  const suffix = uuidSequence.toString().padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
}

/** Mirrors the real module's enum; only SHA-256 is used by this codebase. */
export const CryptoDigestAlgorithm = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA384: 'SHA-384',
  SHA512: 'SHA-512',
  MD5: 'MD5',
} as const;

/** Real SHA-256, matching what the native module computes on device. */
export async function digest(
  algorithm: string,
  data: Uint8Array,
): Promise<ArrayBuffer> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) {
    throw new Error(`expo-crypto double only implements SHA-256, got ${algorithm}`);
  }
  const out = sha256(data);
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength,
  ) as ArrayBuffer;
}

export class AESEncryptionKey {
  private constructor(readonly bytes: Uint8Array) {}

  static async import(bytes: Uint8Array): Promise<AESEncryptionKey> {
    if (bytes.byteLength !== 32) throw new Error('key must be 32 bytes');
    return new AESEncryptionKey(Uint8Array.from(bytes));
  }
}

function keystream(
  key: Uint8Array,
  nonce: Uint8Array,
  length: number,
): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] =
      (key[index % key.length]! + nonce[index % nonce.length]! + index) % 256;
  }
  return out;
}

function tag(
  key: Uint8Array,
  nonce: Uint8Array,
  additionalData: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(TAG_BYTES);
  const feed = [key, nonce, additionalData, ciphertext];
  let position = 0;
  for (const part of feed) {
    for (const byte of part) {
      out[position % TAG_BYTES] = (out[position % TAG_BYTES]! * 3 + byte) % 251;
      position += 1;
    }
    position += 1;
  }
  return out;
}

export class AESSealedData {
  constructor(readonly combinedBytes: Uint8Array) {}

  static fromCombined(combined: Uint8Array): AESSealedData {
    return new AESSealedData(Uint8Array.from(combined));
  }

  async combined(_output: 'bytes'): Promise<Uint8Array> {
    return this.combinedBytes;
  }
}

export async function aesEncryptAsync(
  plaintext: Uint8Array,
  key: AESEncryptionKey,
  options: { additionalData?: Uint8Array; nonce?: { bytes: Uint8Array } },
): Promise<AESSealedData> {
  const nonce = options.nonce?.bytes ?? (await getRandomBytesAsync(NONCE_BYTES));
  const additionalData = options.additionalData ?? new Uint8Array();
  const stream = keystream(key.bytes, nonce, plaintext.byteLength);
  const ciphertext = Uint8Array.from(
    plaintext,
    (byte, index) => byte ^ stream[index]!,
  );
  const authentication = tag(key.bytes, nonce, additionalData, ciphertext);
  const combined = new Uint8Array(
    nonce.byteLength + ciphertext.byteLength + TAG_BYTES,
  );
  combined.set(nonce);
  combined.set(ciphertext, nonce.byteLength);
  combined.set(authentication, nonce.byteLength + ciphertext.byteLength);
  return new AESSealedData(combined);
}

export async function aesDecryptAsync(
  sealed: AESSealedData,
  key: AESEncryptionKey,
  options: { additionalData?: Uint8Array; output?: 'bytes' },
): Promise<Uint8Array> {
  const combined = sealed.combinedBytes;
  if (combined.byteLength < NONCE_BYTES + TAG_BYTES) {
    throw new Error('sealed data is truncated');
  }
  const nonce = combined.slice(0, NONCE_BYTES);
  const ciphertext = combined.slice(NONCE_BYTES, combined.byteLength - TAG_BYTES);
  const authentication = combined.slice(combined.byteLength - TAG_BYTES);
  const additionalData = options.additionalData ?? new Uint8Array();
  const expected = tag(key.bytes, nonce, additionalData, ciphertext);
  if (authentication.some((byte, index) => byte !== expected[index])) {
    throw new Error('authentication failed');
  }
  const stream = keystream(key.bytes, nonce, ciphertext.byteLength);
  return Uint8Array.from(ciphertext, (byte, index) => byte ^ stream[index]!);
}
