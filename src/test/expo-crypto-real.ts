/**
 * Real AES-GCM stand-in for the `expo-crypto` surface, backed by Node's
 * WebCrypto. Unlike `expo-crypto-double.ts` (a reversible toy cipher that
 * exists so unit suites can assert tamper rejection without a native module),
 * this shim performs genuine AES-256-GCM, so an integration suite mapped onto
 * it proves the production envelope survives real cryptography.
 *
 * ## Combined-format fidelity
 *
 * The bytes this shim produces must be byte-for-byte what a real device
 * produces, or an envelope sealed by this gate would be undecipherable by the
 * shipped app. `expo-crypto@56.0.4`'s combined layout is:
 *
 *     IV (12 bytes, default) || ciphertext (n) || tag (16 bytes, default)
 *
 * verified on all three implementations:
 *
 * - Android: `android/.../aes/objects/SealedData.kt` — the class doc reads
 *   "a contiguous memory area containing concatenated IV || ciphertext || tag",
 *   and `constructor(iv, ciphertextWithTag, tagLength)` stores
 *   `content = iv + ciphertextWithTag`. Defaults live in `aes/AesConfig.kt`:
 *   `DEFAULT_IV_SIZE = 12`, `DEFAULT_TAG_SIZE = 16`,
 *   `CIPHER_TRANSFORMATION_NAME = "AES/GCM/NoPadding"`.
 * - Apple: `ios/AES/SealedData.swift` — wraps `AES.GCM.SealedBox(combined:)`
 *   (CryptoKit's `combined` is nonce||ciphertext||tag and, per the comment
 *   there, "works only if IV length is 12"), with the non-default-IV path
 *   spelled out explicitly as `self.iv + inner.ciphertext + self.tag`.
 * - Web: `src/aes/ExpoCryptoAES.web.ts` — `encryptAsync` hands WebCrypto's
 *   `ciphertextWithTag` to `SealedData.fromParts(iv, ciphertextWithTag,
 *   tagLength)`, whose numeric-tag branch writes `combined = iv ||
 *   ciphertextWithTag`. `DEFAULT_IV_LENGTH = 12`, `DEFAULT_TAG_LENGTH = 16`.
 *
 * That is the same layout WebCrypto yields natively — `subtle.encrypt` appends
 * the tag to the ciphertext — so this shim prepends the IV and nothing else.
 *
 * The wrapper in `src/aes/index.ts` is what production actually calls: it maps
 * `options.nonce` (`{ length } | { bytes }`, per `aes/aes.types.ts`
 * `GCMNonceParam`) onto the native module and defaults `tagLength` to 16. Both
 * nonce shapes are honoured below.
 */
import { randomBytes, randomUUID as nodeRandomUUID, webcrypto } from 'node:crypto';

const DEFAULT_IV_LENGTH = 12;
const DEFAULT_TAG_LENGTH = 16;

const subtle = webcrypto.subtle;

type SealedDataConfig = { ivLength: number; tagLength: number };

/**
 * WebCrypto's typings want an `ArrayBuffer`-backed `BufferSource`, while a
 * `Uint8Array` may be backed by `ArrayBufferLike` (possibly shared). Copying
 * the exact byte range out is the narrowing, and it also protects the caller's
 * buffer from later mutation.
 */
function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Structural stand-in for `AesGcmParams`, which Node does not re-export. */
type GcmParams = {
  name: 'AES-GCM';
  iv: ArrayBuffer;
  tagLength: number;
  additionalData?: ArrayBuffer;
};

const defaultConfig: SealedDataConfig = {
  ivLength: DEFAULT_IV_LENGTH,
  tagLength: DEFAULT_TAG_LENGTH,
};

/**
 * There is deliberately no `resetExpoCryptoReal()` counterpart to
 * `resetExpoCryptoDouble()`: the double's reset rewinds its nonce/UUID
 * counters, and no integration suite calls it (only unit suites do). Real
 * randomness is the point of this shim, so seeding it would reintroduce the
 * determinism the double already provides.
 */
export async function getRandomBytesAsync(length: number): Promise<Uint8Array> {
  return new Uint8Array(randomBytes(length));
}

/**
 * The synchronous twin, added for P12-B: the append-only note-name codec mints
 * its ULID tail with `getRandomValues` (`library-note-name.ts`), which the
 * S3-only integration suites never reached. Without it the WebDAV two-device
 * gate saw every write isolated as `corrupt_remote_state` — a test-shim gap
 * that looked exactly like a protocol defect.
 */
export function getRandomValues<T extends Uint8Array>(array: T): T {
  array.set(randomBytes(array.length));
  return array;
}

export function randomUUID(): string {
  return nodeRandomUUID();
}

/** Mirrors the real module's enum; only SHA-256 is used by this codebase. */
export const CryptoDigestAlgorithm = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA384: 'SHA-384',
  SHA512: 'SHA-512',
  MD5: 'MD5',
} as const;

/**
 * Real SHA-256 over Node WebCrypto — the same digest the native module
 * computes. K6-1e routes SigV4's `x-amz-content-sha256` through this port, and
 * MinIO/R2 verify that header on every write, so this shim is what makes the
 * integration gate a genuine proof of the native hash path rather than a
 * restatement of the pure-JS one.
 */
export async function digest(
  algorithm: string,
  data: Uint8Array,
): Promise<ArrayBuffer> {
  return subtle.digest(algorithm, bufferSource(data));
}

export class AESEncryptionKey {
  private constructor(readonly key: webcrypto.CryptoKey) {}

  static async import(bytes: Uint8Array): Promise<AESEncryptionKey> {
    const key = await subtle.importKey('raw', bufferSource(bytes), 'AES-GCM', true, [
      'encrypt',
      'decrypt',
    ]);
    return new AESEncryptionKey(key);
  }
}

export class AESSealedData {
  private constructor(
    readonly combinedBytes: Uint8Array,
    readonly config: SealedDataConfig,
  ) {}

  static fromCombined(
    combined: Uint8Array,
    config: SealedDataConfig = defaultConfig,
  ): AESSealedData {
    return new AESSealedData(Uint8Array.from(combined), config);
  }

  /** Mirrors the real `fromParts(iv, ciphertextWithTag, tagLength)` overload. */
  static fromParts(
    iv: Uint8Array,
    ciphertextWithTag: Uint8Array,
    tagLength: number = DEFAULT_TAG_LENGTH,
  ): AESSealedData {
    const combined = new Uint8Array(iv.byteLength + ciphertextWithTag.byteLength);
    combined.set(iv);
    combined.set(ciphertextWithTag, iv.byteLength);
    return new AESSealedData(combined, { ivLength: iv.byteLength, tagLength });
  }

  get ivSize(): number {
    return this.config.ivLength;
  }

  get tagSize(): number {
    return this.config.tagLength;
  }

  get combinedSize(): number {
    return this.combinedBytes.byteLength;
  }

  async iv(): Promise<Uint8Array> {
    return this.combinedBytes.slice(0, this.ivSize);
  }

  /** The tagged ciphertext WebCrypto wants back: everything after the IV. */
  taggedCiphertext(): Uint8Array {
    return this.combinedBytes.slice(this.ivSize);
  }

  async combined(encoding?: 'bytes' | 'base64'): Promise<Uint8Array | string> {
    return encoding === 'base64'
      ? Buffer.from(this.combinedBytes).toString('base64')
      : this.combinedBytes;
  }
}

type EncryptOptions = {
  nonce?: { bytes: Uint8Array } | { length: number };
  tagLength?: number;
  additionalData?: Uint8Array;
};

export async function aesEncryptAsync(
  plaintext: Uint8Array,
  key: AESEncryptionKey,
  options: EncryptOptions = {},
): Promise<AESSealedData> {
  const { nonce, tagLength = DEFAULT_TAG_LENGTH, additionalData } = options;
  const iv = nonce && 'bytes' in nonce
    ? Uint8Array.from(nonce.bytes)
    : await getRandomBytesAsync(nonce?.length ?? DEFAULT_IV_LENGTH);

  const params: GcmParams = {
    name: 'AES-GCM',
    iv: bufferSource(iv),
    tagLength: tagLength * 8,
    // The real module only sets `additionalData` when it is truthy (its own
    // "invalid AAD format error when it's present but undefined" workaround).
    ...(additionalData ? { additionalData: bufferSource(additionalData) } : {}),
  };
  const ciphertextWithTag = new Uint8Array(
    await subtle.encrypt(params, key.key, bufferSource(plaintext)),
  );
  return AESSealedData.fromParts(iv, ciphertextWithTag, tagLength);
}

export async function aesDecryptAsync(
  sealed: AESSealedData,
  key: AESEncryptionKey,
  options: { additionalData?: Uint8Array; output?: 'bytes' | 'base64' } = {},
): Promise<Uint8Array | string> {
  const { additionalData, output } = options;
  const params: GcmParams = {
    name: 'AES-GCM',
    iv: bufferSource(await sealed.iv()),
    tagLength: sealed.tagSize * 8,
    ...(additionalData ? { additionalData: bufferSource(additionalData) } : {}),
  };
  const plaintext = new Uint8Array(
    await subtle.decrypt(params, key.key, bufferSource(sealed.taggedCiphertext())),
  );
  return output === 'base64'
    ? Buffer.from(plaintext).toString('base64')
    : plaintext;
}
