/**
 * The port under test defaults to `expo-crypto`'s native `digest`. Under
 * `jest-expo` the unmocked native module answers `digest` with a 32-byte ZERO
 * buffer (K6-1e's finding), which would turn every expectation below into a
 * comparison against `0000…` and would let a broken implementation pass, so
 * map `expo-crypto` onto the double's genuine SHA-256.
 */
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createNativeDigest,
  createNativeFileDigest,
} from '@/features/library/library-digest';
import { sha256PlaintextHex } from '@/features/library/library-identity';

/** SHA-256 of the empty byte string. */
const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** SHA-256 of the three ASCII bytes `abc`. */
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('native library digest port', () => {
  it('answers the documented SHA-256 vector for the empty byte string', async () => {
    const digest = createNativeDigest();

    await expect(digest(new Uint8Array())).resolves.toBe(EMPTY_SHA256);
  });

  it('answers the documented SHA-256 vector for "abc"', async () => {
    const digest = createNativeDigest();

    await expect(digest(new TextEncoder().encode('abc'))).resolves.toBe(
      ABC_SHA256,
    );
  });

  it('agrees with the pure-JS identity hash on a 1 MB input', async () => {
    // The whole cut is "same bytes, same id, different engine": every durable
    // file name and `device_library_assets` primary key already written by
    // `sha256PlaintextHex` must keep resolving to the same asset.
    const bytes = Uint8Array.from(
      { length: 1024 * 1024 },
      (_, index) => (index * 31 + (index % 7)) % 256,
    );
    const digest = createNativeDigest();

    await expect(digest(bytes)).resolves.toBe(sha256PlaintextHex(bytes));
  });

  it('hashes only the requested window of a larger buffer', async () => {
    // A staged file read can hand back a view into a pooled buffer. Narrowing
    // the type by rebuilding from `bytes.buffer` would silently hash the whole
    // pool; this pins the view's own bytes.
    const backing = new Uint8Array([9, 9, 9, 97, 98, 99, 9, 9]);
    const view = backing.subarray(3, 6);
    const digest = createNativeDigest();

    expect(sha256PlaintextHex(view)).toBe(ABC_SHA256);
    await expect(digest(view)).resolves.toBe(ABC_SHA256);
  });

  it('createNativeFileDigest returns null when native copyFileToFileWithSha256 is unavailable', () => {
    expect(createNativeFileDigest(null)).toBeNull();
    expect(createNativeFileDigest({})).toBeNull();
  });

  it('createNativeFileDigest streams file-to-file SHA-256 and cleans the destination temp file in finally', async () => {
    const cleaned: string[] = [];
    const copyFileToFileWithSha256 = jest.fn(async () => ({
      plaintextBytes: 67_108_768,
      plaintextSha256: ABC_SHA256,
    }));
    const port = createNativeFileDigest(
      { copyFileToFileWithSha256 },
      (uri) => { cleaned.push(uri); },
    );
    expect(port).not.toBeNull();

    await expect(
      port!('file:///cache/ImagePicker/exactcap.png', 'file:///cache/library-stream/hash.part'),
    ).resolves.toEqual({
      byteSize: 67_108_768,
      plaintextSha256: ABC_SHA256,
    });
    expect(copyFileToFileWithSha256).toHaveBeenCalledWith(
      expect.stringMatching(/^hash-/u),
      '/cache/ImagePicker/exactcap.png',
      '/cache/library-stream/hash.part',
    );
    expect(cleaned).toEqual([
      'file:///cache/library-stream/hash.part',
      'file:///cache/library-stream/hash.part',
    ]);
  });

  it('createNativeFileDigest cleans the destination temp file even when the native copy rejects', async () => {
    const cleaned: string[] = [];
    const port = createNativeFileDigest(
      {
        copyFileToFileWithSha256: async () => {
          throw new Error('disk full');
        },
      },
      (uri) => { cleaned.push(uri); },
    );

    await expect(
      port!('file:///cache/ImagePicker/bad.png', 'file:///cache/library-stream/hash.part'),
    ).rejects.toThrow('disk full');
    expect(cleaned).toEqual([
      'file:///cache/library-stream/hash.part',
      'file:///cache/library-stream/hash.part',
    ]);
  });
});
