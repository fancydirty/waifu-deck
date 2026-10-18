import { createLibraryObjectCipher } from '@/features/library/library-object-crypto';
import { createPassthroughLibraryCipher } from '@/features/library/library-passthrough-cipher';
import { createFakeLibraryFilePort } from '@/features/library/library-test-support';
import {
  createJsFileDecryptor,
  createNativeFileDecryptor,
  LibraryCopySourceMissingError,
  LibraryLocalStorageError,
} from '@/features/library/library-file-decryptor';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

const MASTER_KEY = new Uint8Array(32).fill(7);
const ASSET_ID = 'a'.repeat(64);
const INPUT = {
  masterKey: MASTER_KEY,
  assetId: ASSET_ID,
  scope: 'original' as const,
  envelopeUri: 'file:///cache/library-stream/cipher.part',
  plaintextUri: 'file:///cache/library-stream/plain.part',
};

describe('library file decryptor', () => {
  test('native AES uses a decrypt task id and returns the native result', async () => {
    const native = {
      decryptLibraryObjectToFile: jest.fn(async () => ({
        plaintextBytes: 3,
        plaintextSha256: 'b'.repeat(64),
      })),
      cancelDecrypt: jest.fn(async () => undefined),
      copyFileToFileWithSha256: jest.fn(),
    };

    const result = await createNativeFileDecryptor(native).openToFile(INPUT);

    expect(native.decryptLibraryObjectToFile).toHaveBeenCalledWith(
      expect.stringMatching(/^decrypt-/u),
      '/cache/library-stream/cipher.part',
      '/cache/library-stream/plain.part',
      MASTER_KEY,
      ASSET_ID,
      'original',
    );
    expect(result).toEqual({ plaintextBytes: 3, plaintextSha256: 'b'.repeat(64) });
  });

  test('native passthrough uses the file copy task', async () => {
    const native = {
      decryptLibraryObjectToFile: jest.fn(),
      cancelDecrypt: jest.fn(async () => undefined),
      copyFileToFileWithSha256: jest.fn(async () => ({
        plaintextBytes: 3,
        plaintextSha256: 'b'.repeat(64),
      })),
    };

    const result = await createNativeFileDecryptor(native, true).openToFile({
      ...INPUT,
      masterKey: new Uint8Array(32),
      assetId: ASSET_ID,
      scope: 'original',
    });

    expect(native.copyFileToFileWithSha256).toHaveBeenCalledWith(
      expect.stringMatching(/^copy-/u),
      '/cache/library-stream/cipher.part',
      '/cache/library-stream/plain.part',
    );
    expect(result.plaintextBytes).toBe(3);
  });

  test.each([
    ['ERR_LIBRARY_FORMAT', Error],
    ['ERR_LIBRARY_INTEGRITY', Error],
  ])('maps %s to the cipher failure type', async (code, Type) => {
    const native = {
      decryptLibraryObjectToFile: jest.fn(async () => {
        const error = new Error('bad envelope') as Error & { code: string };
        error.code = code;
        throw error;
      }),
      cancelDecrypt: jest.fn(async () => undefined),
      copyFileToFileWithSha256: jest.fn(),
    };

    await expect(createNativeFileDecryptor(native).openToFile(INPUT))
      .rejects.toBeInstanceOf(Type);
  });

  test('maps native local I/O and interruption to their typed errors', async () => {
    for (const code of ['ERR_LIBRARY_IO', 'ERR_LIBRARY_CANCELLED', 'ERR_TASK_DUPLICATE']) {
      const native = {
        decryptLibraryObjectToFile: jest.fn(async () => {
          const error = new Error(code) as Error & { code: string };
          error.code = code;
          throw error;
        }),
        cancelDecrypt: jest.fn(async () => undefined),
        copyFileToFileWithSha256: jest.fn(),
      };

      const failure = createNativeFileDecryptor(native).openToFile(INPUT);
      if (code === 'ERR_LIBRARY_IO') {
        await expect(failure).rejects.toBeInstanceOf(LibraryLocalStorageError);
      } else {
        await expect(failure).rejects.toMatchObject({
          name: 'LibraryCloudError',
          code: 'file_decrypt_interrupted',
          category: 'offline',
          outcomeKnown: false,
        });
      }
    }
  });

  test('JS fallback decrypts to a file and returns its digest', async () => {
    const port = createFakeLibraryFilePort();
    const cipher = createLibraryObjectCipher();
    const plaintext = Uint8Array.from([1, 2, 3, 4]);
    const envelope = await cipher.seal({
      masterKey: MASTER_KEY,
      assetId: ASSET_ID,
      scope: 'original',
      plaintext,
    });
    port.files.set(INPUT.envelopeUri, envelope);
    const digest = jest.fn(async () => 'c'.repeat(64));
    const decryptor = createJsFileDecryptor(cipher, port, digest);

    await expect(decryptor.openToFile(INPUT)).resolves.toEqual({
      plaintextBytes: plaintext.byteLength,
      plaintextSha256: 'c'.repeat(64),
    });
    expect(await port.readBytes(INPUT.plaintextUri)).toEqual(plaintext);
  });

  test('JS fallback removes a failed output after a flipped envelope byte', async () => {
    const port = createFakeLibraryFilePort();
    const cipher = createLibraryObjectCipher();
    const envelope = await cipher.seal({
      masterKey: MASTER_KEY,
      assetId: ASSET_ID,
      scope: 'original',
      plaintext: Uint8Array.from([1, 2, 3]),
    });
    envelope[envelope.length - 1] ^= 1;
    port.files.set(INPUT.envelopeUri, envelope);

    await expect(createJsFileDecryptor(cipher, port).openToFile(INPUT))
      .rejects.toThrow();
    expect(port.files.has(INPUT.plaintextUri)).toBe(false);
  });

  test('JS fallback maps plaintext file writes to local storage errors', async () => {
    const port = createFakeLibraryFilePort();
    const cipher = createLibraryObjectCipher();
    const envelope = await cipher.seal({
      masterKey: MASTER_KEY,
      assetId: ASSET_ID,
      scope: 'original',
      plaintext: Uint8Array.from([1, 2, 3]),
    });
    port.files.set(INPUT.envelopeUri, envelope);
    port.failWrites = true;

    await expect(createJsFileDecryptor(cipher, port).openToFile(INPUT))
      .rejects.toBeInstanceOf(LibraryLocalStorageError);
    expect(port.files.has(INPUT.plaintextUri)).toBe(false);
  });

  test('JS fallback removes output when digesting the plaintext fails', async () => {
    const port = createFakeLibraryFilePort();
    const cipher = createPassthroughLibraryCipher();
    port.files.set(INPUT.envelopeUri, Uint8Array.from([1, 2, 3]));
    const digest = jest.fn(async () => {
      throw new Error('digest failed');
    });

    await expect(createJsFileDecryptor(cipher, port, digest).openToFile(INPUT))
      .rejects.toThrow('digest failed');
    expect(port.files.has(INPUT.plaintextUri)).toBe(false);
  });

  test('JS passthrough still rejects an empty output', async () => {
    const port = createFakeLibraryFilePort();
    port.files.set(INPUT.envelopeUri, new Uint8Array());
    await expect(createJsFileDecryptor(createPassthroughLibraryCipher(), port)
      .openToFile(INPUT))
      .rejects.toBeInstanceOf(Error);
    expect(port.files.has(INPUT.plaintextUri)).toBe(false);
  });

  test('JS copyToFile hashes the source into the destination', async () => {
    const port = createFakeLibraryFilePort();
    const plaintext = Uint8Array.from([4, 5, 6, 7]);
    const source = 'file:///cache/library-cache/plain.bin';
    const destination = 'file:///cache/library-stream/copy.part';
    port.files.set(source, plaintext);
    const digest = jest.fn(async () => 'd'.repeat(64));

    await expect(createJsFileDecryptor(createPassthroughLibraryCipher(), port, digest)
      .copyToFile({ sourceUri: source, destinationUri: destination }))
      .resolves.toEqual({ bytes: plaintext.byteLength, sha256: 'd'.repeat(64) });
    expect(await port.readBytes(destination)).toEqual(plaintext);
    expect(digest).toHaveBeenCalledTimes(1);
  });

  test('JS copyToFile reports a missing source and a failed write', async () => {
    const port = createFakeLibraryFilePort();
    const decryptor = createJsFileDecryptor(createPassthroughLibraryCipher(), port);
    const destination = 'file:///cache/library-stream/copy.part';

    await expect(decryptor.copyToFile({
      sourceUri: 'file:///cache/library-cache/missing.bin',
      destinationUri: destination,
    })).rejects.toBeInstanceOf(LibraryCopySourceMissingError);
    expect(port.files.has(destination)).toBe(false);

    port.files.set('file:///cache/library-cache/plain.bin', Uint8Array.from([1]));
    port.failWrites = true;
    await expect(decryptor.copyToFile({
      sourceUri: 'file:///cache/library-cache/plain.bin',
      destinationUri: destination,
    })).rejects.toBeInstanceOf(LibraryLocalStorageError);
    expect(port.files.has(destination)).toBe(false);
  });

  test('native copyToFile uses copyFileToFileWithSha256', async () => {
    const native = {
      decryptLibraryObjectToFile: jest.fn(),
      cancelDecrypt: jest.fn(async () => undefined),
      copyFileToFileWithSha256: jest.fn(async () => ({
        plaintextBytes: 4,
        plaintextSha256: 'e'.repeat(64),
      })),
    };

    await expect(createNativeFileDecryptor(native).copyToFile({
      sourceUri: 'file:///cache/library-cache/plain.bin',
      destinationUri: 'file:///cache/library-stream/copy.part',
    })).resolves.toEqual({ bytes: 4, sha256: 'e'.repeat(64) });
    expect(native.copyFileToFileWithSha256).toHaveBeenCalledWith(
      expect.stringMatching(/^copy-/u),
      '/cache/library-cache/plain.bin',
      '/cache/library-stream/copy.part',
    );
    expect(native.decryptLibraryObjectToFile).not.toHaveBeenCalled();
  });

  test('native copyToFile reports a missing source from probe without touching the native copy', async () => {
    const native = {
      decryptLibraryObjectToFile: jest.fn(),
      cancelDecrypt: jest.fn(async () => undefined),
      copyFileToFileWithSha256: jest.fn(async () => ({
        plaintextBytes: 4,
        plaintextSha256: 'e'.repeat(64),
      })),
    };
    const files = {
      delete: jest.fn(async () => undefined),
      probe: jest.fn(async () => 'absent' as const),
    };

    await expect(createNativeFileDecryptor(native, false, files).copyToFile({
      sourceUri: 'file:///cache/library-cache/gone.bin',
      destinationUri: 'file:///cache/library-stream/copy.part',
    })).rejects.toBeInstanceOf(LibraryCopySourceMissingError);
    expect(files.probe).toHaveBeenCalledWith('file:///cache/library-cache/gone.bin');
    expect(native.copyFileToFileWithSha256).not.toHaveBeenCalled();
  });

  test('interruption remains a LibraryCloudError', () => {
    expect(new LibraryCloudError(0, 'file_decrypt_interrupted', 'offline', 'x', false))
      .toBeInstanceOf(Error);
  });

  test('native sealToFile uses encryptLibraryObjectToFile for AES-GCM and copyFileToFileWithSha256 for passthrough', async () => {
    const native = {
      decryptLibraryObjectToFile: jest.fn(),
      cancelDecrypt: jest.fn(async () => undefined),
      copyFileToFileWithSha256: jest.fn(async () => ({
        plaintextBytes: 67_108_768,
        plaintextSha256: 'c'.repeat(64),
      })),
      encryptLibraryObjectToFile: jest.fn(async () => ({
        plaintextBytes: 67_108_768,
        envelopeBytes: 67_108_864,
        plaintextSha256: 'a'.repeat(64),
        envelopeSha256: 'b'.repeat(64),
      })),
    };

    const aes = await createNativeFileDecryptor(native).sealToFile!({
      masterKey: MASTER_KEY,
      assetId: ASSET_ID,
      scope: 'original',
      plaintextUri: 'file:///data/library/originals/plain.png',
      envelopeUri: 'file:///cache/library-stream/sealed.part',
    });
    expect(native.encryptLibraryObjectToFile).toHaveBeenCalledWith(
      expect.stringMatching(/^encrypt-/u),
      '/data/library/originals/plain.png',
      '/cache/library-stream/sealed.part',
      MASTER_KEY,
      ASSET_ID,
      'original',
    );
    expect(aes).toEqual({
      plaintextBytes: 67_108_768,
      envelopeBytes: 67_108_864,
      plaintextSha256: 'a'.repeat(64),
      envelopeSha256: 'b'.repeat(64),
    });

    const pass = await createNativeFileDecryptor(native, true).sealToFile!({
      masterKey: new Uint8Array(32),
      assetId: ASSET_ID,
      scope: 'original',
      plaintextUri: 'file:///data/library/originals/plain.png',
      envelopeUri: 'file:///cache/library-stream/pass.part',
    });
    expect(pass).toEqual({
      plaintextBytes: 67_108_768,
      envelopeBytes: 67_108_768,
      plaintextSha256: 'c'.repeat(64),
      envelopeSha256: 'c'.repeat(64),
    });
  });

  test('JS sealToFile seals and hashes to the destination file and cleans up on write failure', async () => {
    const port = createFakeLibraryFilePort();
    const cipher = createLibraryObjectCipher();
    const plaintext = Uint8Array.from([10, 20, 30, 40]);
    const plainUri = 'file:///data/library/originals/plain.png';
    const envUri = 'file:///cache/library-stream/env.part';
    port.files.set(plainUri, plaintext);

    const decryptor = createJsFileDecryptor(cipher, port);
    const sealed = await decryptor.sealToFile!({
      masterKey: MASTER_KEY,
      assetId: ASSET_ID,
      scope: 'original',
      plaintextUri: plainUri,
      envelopeUri: envUri,
    });
    expect(sealed.plaintextBytes).toBe(4);
    expect(sealed.envelopeBytes).toBe(4 + 96);
    expect(port.files.has(envUri)).toBe(true);

    port.failWrites = true;
    const failEnvUri = 'file:///cache/library-stream/fail-env.part';
    await expect(
      decryptor.sealToFile!({
        masterKey: MASTER_KEY,
        assetId: ASSET_ID,
        scope: 'original',
        plaintextUri: plainUri,
        envelopeUri: failEnvUri,
      }),
    ).rejects.toBeInstanceOf(LibraryLocalStorageError);
    expect(port.files.has(failEnvUri)).toBe(false);
  });
});
