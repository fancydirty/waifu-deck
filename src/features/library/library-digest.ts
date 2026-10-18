import { bytesToHex } from '@noble/hashes/utils.js';
import { CryptoDigestAlgorithm, digest, randomUUID } from 'expo-crypto';

export type NativeFileHasher = Readonly<{
  copyFileToFileWithSha256?: (
    taskId: string,
    sourcePath: string,
    destPath: string,
  ) => Promise<Readonly<{ plaintextBytes: number; plaintextSha256: string }>>;
}>;

function loadDefaultNativeFileHasher(): NativeFileHasher | null {
  try {
    // Lazy require keeps the Node/MinIO integration gate free of
    // `expo-modules-core` / `react-native` top-level evaluation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WaifuSyncService } = require('../../../modules/waifu-sync-service') as typeof import('../../../modules/waifu-sync-service');
    return WaifuSyncService;
  } catch {
    return null;
  }
}

/** Lowercase hex SHA-256 of a plaintext image, computed off the JS thread. */
export type DigestPort = (bytes: Uint8Array) => Promise<string>;

export type FileDigestResult = Readonly<{
  byteSize: number;
  plaintextSha256: string;
}>;

/**
 * Lowercase hex SHA-256 + byte length of a file on disk, computed without
 * reading the entire file into a JS/Java heap buffer (prevents 64 MiB Dalvik
 * heap OOM on import of exact-cap originals).
 */
export type FileDigestPort = (
  uri: string,
  destinationTempUri: string,
) => Promise<FileDigestResult>;

/**
 * Production default for every hot-path SHA-256 over image bytes: the native
 * `expo-crypto` digest, the same primitive K6-1e put under the S3 transport's
 * `x-amz-content-sha256`.
 *
 * `sha256PlaintextHex` (pure-JS @noble) stays the identity contract and the
 * definition of the value — it is still right for small inputs and for tests —
 * but on Hermes, which has no JIT, it cost 1334 ms of JS thread for a 6 MB
 * image (measured 2026-09-13 23:50). That time is not merely slow: it is a
 * single uninterruptible JS task, so it also delays every other continuation
 * on the loop (a neighbouring image's `state.json` commit was measured 2 s
 * late) and freezes the UI. The native digest runs off the JS heap and returns
 * the identical value, so ids, file names, and integrity verdicts are
 * unchanged.
 */
export function createNativeDigest(): DigestPort {
  return async (bytes) => {
    // TypeScript models `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which
    // does not satisfy `BufferSource`'s `ArrayBufferView<ArrayBuffer>` even
    // though every image buffer this app hashes is ArrayBuffer-backed. Copying
    // to narrow the type would memcpy multiple megabytes on exactly the path
    // this exists to shorten, so narrow by assertion — and never rebuild from
    // `bytes.buffer`, which would hash past the end of a subarray view.
    const source = bytes as unknown as BufferSource;
    return bytesToHex(
      new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, source)),
    );
  };
}

const plainPath = (uri: string): string => (
  uri.startsWith('file://') ? uri.slice('file://'.length) : uri
);

/**
 * Streams `uri` to `destinationTempUri` via native `copyFileToFileWithSha256`
 * (64 KiB buffer in `LibraryObjectStreamCrypto.copyWithSha256`) and deletes the
 * temporary copy in `finally`, returning `{ byteSize, plaintextSha256 }` with
 * zero whole-file Java/JS heap allocation. Returns `null` when the native
 * module is absent (Node/Jest/web).
 */
export function createNativeFileDigest(
  native: NativeFileHasher | null = loadDefaultNativeFileHasher(),
  deleteFile?: (uri: string) => void,
): FileDigestPort | null {
  if (
    native === null
    || typeof native.copyFileToFileWithSha256 !== 'function'
  ) {
    return null;
  }
  const removeIfPresent = deleteFile ?? ((uri: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File } = require('expo-file-system') as typeof import('expo-file-system');
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  });
  return async (uri: string, destinationTempUri: string): Promise<FileDigestResult> => {
    removeIfPresent(destinationTempUri);
    try {
      const result = await native.copyFileToFileWithSha256!(
        `hash-${randomUUID()}`,
        plainPath(uri),
        plainPath(destinationTempUri),
      );
      return {
        byteSize: result.plaintextBytes,
        plaintextSha256: result.plaintextSha256,
      };
    } finally {
      try {
        removeIfPresent(destinationTempUri);
      } catch {
        // Best-effort temp cleanup.
      }
    }
  };
}

