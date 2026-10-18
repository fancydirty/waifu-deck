import { randomUUID } from 'expo-crypto';

import type {
  NativeDecryptResponse,
  NativeEncryptResponse,
} from '../../../modules/waifu-sync-service';
import { LibraryCloudError as TypedLibraryCloudError } from '@/features/library/library-cloud-errors';
import {
  createNativeDigest,
  type DigestPort,
} from '@/features/library/library-digest';
import type { LibraryFilePort } from '@/features/library/library-file-store';
import type { LibraryObjectCipher } from '@/features/library/library-object-crypto';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';

export type LibraryFileDecryptorInput = Readonly<{
  masterKey: Uint8Array;
  assetId: string;
  scope: 'original' | 'thumbnail' | 'preview';
  envelopeUri: string;
  plaintextUri: string;
}>;

export type LibraryFileDecryptorResult = NativeDecryptResponse;

export type LibraryFileEncryptorInput = Readonly<{
  masterKey: Uint8Array;
  assetId: string;
  scope: 'original' | 'thumbnail' | 'preview';
  plaintextUri: string;
  envelopeUri: string;
}>;

export type LibraryFileEncryptorResult = NativeEncryptResponse;

export type LibraryCopyToFileInput = Readonly<{
  sourceUri: string;
  destinationUri: string;
}>;

export type LibraryCopyToFileResult = Readonly<{
  bytes: number;
  sha256: string;
}>;

export type LibraryFileDecryptor = Readonly<{
  openToFile(input: LibraryFileDecryptorInput): Promise<LibraryFileDecryptorResult>;
  copyToFile(input: LibraryCopyToFileInput): Promise<LibraryCopyToFileResult>;
  sealToFile?(input: LibraryFileEncryptorInput): Promise<LibraryFileEncryptorResult>;
}>;

export type NativeFileDecryptor = Readonly<{
  decryptLibraryObjectToFile(
    taskId: string,
    sourcePath: string,
    destPath: string,
    masterKey: Uint8Array,
    assetId: string,
    scope: LibraryFileDecryptorInput['scope'],
  ): Promise<NativeDecryptResponse>;
  cancelDecrypt(taskId: string): Promise<void>;
  copyFileToFileWithSha256(
    taskId: string,
    sourcePath: string,
    destPath: string,
  ): Promise<NativeDecryptResponse>;
  encryptLibraryObjectToFile?(
    taskId: string,
    sourcePath: string,
    destPath: string,
    masterKey: Uint8Array,
    assetId: string,
    scope: LibraryFileDecryptorInput['scope'],
  ): Promise<NativeEncryptResponse>;
}>;

export class LibraryLocalStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LibraryLocalStorageError';
    Object.setPrototypeOf(this, LibraryLocalStorageError.prototype);
  }
}

/** The verified-copy source is gone. Distinct from a full disk so the caller can fetch. */
export class LibraryCopySourceMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryCopySourceMissingError';
    Object.setPrototypeOf(this, LibraryCopySourceMissingError.prototype);
  }
}

type FileOutputPort = Pick<LibraryFilePort, 'readBytes' | 'writeBytes' | 'delete'>;

function isMissingSource(error: unknown): boolean {
  if ((error as { code?: string }).code === 'ENOENT') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('missing file ');
}

function localStorageError(error: unknown): LibraryLocalStorageError {
  return new LibraryLocalStorageError(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

const plainPath = (uri: string): string => (
  uri.startsWith('file://') ? uri.slice('file://'.length) : uri
);

function nativeFailure(error: unknown): never {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ERR_LIBRARY_IO') {
    throw new LibraryLocalStorageError(message, { cause: error });
  }
  if (code === 'ERR_LIBRARY_CANCELLED' || code === 'ERR_TASK_DUPLICATE') {
    throw new TypedLibraryCloudError(
      0,
      'file_decrypt_interrupted',
      'offline',
      message,
      false,
    );
  }
  if (code === 'ERR_LIBRARY_FORMAT' || code === 'ERR_LIBRARY_INTEGRITY') {
    throw new Error(message);
  }
  throw error;
}

function deleteOutput(files: Pick<LibraryFilePort, 'delete'> | undefined, uri: string): Promise<void> {
  return files?.delete(uri).catch(() => undefined) ?? Promise.resolve();
}

/** Native file decrypt/copy adapter. The boolean selects encryption-off passthrough. */
export function createNativeFileDecryptor(
  native: NativeFileDecryptor,
  passthrough = false,
  files?: Pick<LibraryFilePort, 'delete'> & Partial<Pick<LibraryFilePort, 'probe'>>,
): LibraryFileDecryptor {
  return {
    async copyToFile(input) {
      if (files?.probe !== undefined) {
        let presence: 'present' | 'absent';
        try {
          presence = await files.probe(input.sourceUri);
        } catch (error) {
          throw localStorageError(error);
        }
        if (presence === 'absent') {
          throw new LibraryCopySourceMissingError(`missing file ${input.sourceUri}`);
        }
      }
      try {
        const result = await native.copyFileToFileWithSha256(
          `copy-${randomUUID()}`,
          plainPath(input.sourceUri),
          plainPath(input.destinationUri),
        );
        return { bytes: result.plaintextBytes, sha256: result.plaintextSha256 };
      } catch (error) {
        nativeFailure(error);
      }
    },
    async openToFile(input) {
      try {
        const result = passthrough
          ? await native.copyFileToFileWithSha256(
            `copy-${randomUUID()}`,
            plainPath(input.envelopeUri),
            plainPath(input.plaintextUri),
          )
          : await native.decryptLibraryObjectToFile(
            `decrypt-${randomUUID()}`,
            plainPath(input.envelopeUri),
            plainPath(input.plaintextUri),
            input.masterKey,
            input.assetId,
            input.scope,
          );
        if (
          passthrough
          && (result.plaintextBytes <= 0
            || result.plaintextBytes > LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES)
        ) {
          await deleteOutput(files, input.plaintextUri);
          throw new Error('Library object plaintext exceeds the protocol limit.');
        }
        return result;
      } catch (error) {
        nativeFailure(error);
      }
    },
    ...(passthrough || typeof native.encryptLibraryObjectToFile === 'function'
      ? {
          async sealToFile(input: LibraryFileEncryptorInput): Promise<LibraryFileEncryptorResult> {
            try {
              if (passthrough) {
                const copied = await native.copyFileToFileWithSha256(
                  `copy-${randomUUID()}`,
                  plainPath(input.plaintextUri),
                  plainPath(input.envelopeUri),
                );
                if (
                  copied.plaintextBytes <= 0
                  || copied.plaintextBytes > LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES
                ) {
                  await deleteOutput(files, input.envelopeUri);
                  throw new Error('Library object plaintext exceeds the protocol limit.');
                }
                return {
                  plaintextBytes: copied.plaintextBytes,
                  envelopeBytes: copied.plaintextBytes,
                  plaintextSha256: copied.plaintextSha256,
                  envelopeSha256: copied.plaintextSha256,
                };
              }
              return await native.encryptLibraryObjectToFile!(
                `encrypt-${randomUUID()}`,
                plainPath(input.plaintextUri),
                plainPath(input.envelopeUri),
                input.masterKey,
                input.assetId,
                input.scope,
              );
            } catch (error) {
              nativeFailure(error);
            }
          },
        }
      : {}),
  };
}

export function createJsFileDecryptor(
  cipher: LibraryObjectCipher,
  files: FileOutputPort,
  digest: DigestPort = createNativeDigest(),
): LibraryFileDecryptor {
  return {
    async copyToFile(input) {
      let plaintext: Uint8Array;
      try {
        plaintext = await files.readBytes(input.sourceUri);
      } catch (error) {
        if (isMissingSource(error)) {
          throw new LibraryCopySourceMissingError(
            error instanceof Error ? error.message : `missing file ${input.sourceUri}`,
          );
        }
        throw localStorageError(error);
      }
      const sha256 = await digest(plaintext);
      try {
        await files.writeBytes(input.destinationUri, plaintext);
      } catch (error) {
        await files.delete(input.destinationUri).catch(() => undefined);
        throw localStorageError(error);
      }
      return { bytes: plaintext.byteLength, sha256 };
    },
    async openToFile(input) {
      try {
        const envelope = await files.readBytes(input.envelopeUri);
        const plaintext = await cipher.open({
          masterKey: input.masterKey,
          assetId: input.assetId,
          scope: input.scope,
          envelope,
        });
        if (
          plaintext.byteLength <= 0
          || plaintext.byteLength > LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES
        ) {
          throw new Error('Library object plaintext exceeds the protocol limit.');
        }
        try {
          await files.writeBytes(input.plaintextUri, plaintext);
        } catch (error) {
          throw new LibraryLocalStorageError(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        return {
          plaintextBytes: plaintext.byteLength,
          plaintextSha256: await digest(plaintext),
        };
      } catch (error) {
        await files.delete(input.plaintextUri).catch(() => undefined);
        throw error;
      }
    },
    async sealToFile(input) {
      try {
        const plaintext = await files.readBytes(input.plaintextUri);
        if (
          plaintext.byteLength <= 0
          || plaintext.byteLength > LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES
        ) {
          throw new Error('Library object plaintext exceeds the protocol limit.');
        }
        const envelope = await cipher.seal({
          masterKey: input.masterKey,
          assetId: input.assetId,
          scope: input.scope,
          plaintext,
        });
        try {
          await files.writeBytes(input.envelopeUri, envelope);
        } catch (error) {
          throw new LibraryLocalStorageError(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        return {
          plaintextBytes: plaintext.byteLength,
          envelopeBytes: envelope.byteLength,
          plaintextSha256: await digest(plaintext),
          envelopeSha256: await digest(envelope),
        };
      } catch (error) {
        await files.delete(input.envelopeUri).catch(() => undefined);
        throw error;
      }
    },
  };
}

export type SelectFileDecryptorInput = Readonly<{
  cipher: LibraryObjectCipher;
  encryption: 'aes-gcm' | 'none';
  native: NativeFileDecryptor | null;
  files: FileOutputPort & Partial<Pick<LibraryFilePort, 'probe'>>;
  digest?: DigestPort;
}>;

export function selectFileDecryptor({
  cipher,
  encryption,
  native,
  files,
  digest,
}: SelectFileDecryptorInput): LibraryFileDecryptor {
  if (native !== null) {
    return createNativeFileDecryptor(native, encryption === 'none', files);
  }
  return createJsFileDecryptor(cipher, files, digest);
}

// Keep the public error import surface convenient for callers and tests.
export { LibraryCloudError } from '@/features/library/library-cloud-errors';
