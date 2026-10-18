import {
  aesDecryptAsync,
  aesEncryptAsync,
  AESEncryptionKey,
  AESSealedData,
  getRandomBytesAsync,
} from 'expo-crypto';

import type {
  LibraryEncryptedMetadata,
  LibraryObjectRole,
} from '@/features/library/library-actions-types';
import {
  LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES,
  LIBRARY_MAX_OBJECT_ENVELOPE_BYTES,
} from '@/features/library/library-limits';
import { decodeBase64Url, encodeBase64Url } from '@/features/vault/base64url';

export const LIBRARY_OBJECT_ENVELOPE_MAGIC = 'WDLIB001';
export const LIBRARY_MAX_METADATA_PLAINTEXT_BYTES = 4 * 1024;

const MAGIC = new TextEncoder().encode(LIBRARY_OBJECT_ENVELOPE_MAGIC);
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const WRAPPED_KEY_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * `metadata` shares the envelope so one reader handles every account-layer
 * ciphertext; only the three image roles are ever stored as R2 objects.
 */
export type LibraryEnvelopeScope = LibraryObjectRole | 'metadata';

export type LibraryObjectCipher = Readonly<{
  seal(input: Readonly<{
    masterKey: Uint8Array;
    assetId: string;
    scope: LibraryEnvelopeScope;
    plaintext: Uint8Array;
  }>): Promise<Uint8Array>;
  open(input: Readonly<{
    masterKey: Uint8Array;
    assetId: string;
    scope: LibraryEnvelopeScope;
    envelope: Uint8Array;
  }>): Promise<Uint8Array>;
  sealMetadata(input: Readonly<{
    masterKey: Uint8Array;
    assetId: string;
    metadata: LibraryEncryptedMetadata;
  }>): Promise<string>;
  openMetadata(input: Readonly<{
    masterKey: Uint8Array;
    assetId: string;
    sealed: string;
  }>): Promise<LibraryEncryptedMetadata>;
}>;

function assertMasterKey(masterKey: Uint8Array): Uint8Array {
  if (masterKey.byteLength !== KEY_BYTES) {
    throw new Error('Invalid Vault master key length.');
  }
  return masterKey;
}

function assertAssetId(assetId: string): string {
  if (!/^[0-9a-f]{64}$/u.test(assetId)) {
    throw new Error('Invalid library asset id.');
  }
  return assetId;
}

function keyAdditionalData(assetId: string, scope: LibraryEnvelopeScope): Uint8Array {
  return encoder.encode(
    `waifu-deck:library:v3:object-key:${assetAndScope(assetId, scope)}`,
  );
}

function payloadAdditionalData(
  assetId: string,
  scope: LibraryEnvelopeScope,
  plaintextBytes: number,
): Uint8Array {
  return encoder.encode(
    `waifu-deck:library:v3:object:${assetAndScope(assetId, scope)}:${plaintextBytes}`,
  );
}

function assetAndScope(assetId: string, scope: LibraryEnvelopeScope): string {
  return `${assertAssetId(assetId)}:${scope}`;
}

async function importKey(bytes: Uint8Array): Promise<AESEncryptionKey> {
  return AESEncryptionKey.import(bytes) as unknown as Promise<AESEncryptionKey>;
}

async function sealPart(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const nonce = await getRandomBytesAsync(NONCE_BYTES);
  const sealed = await aesEncryptAsync(plaintext, await importKey(keyBytes), {
    additionalData,
    nonce: { bytes: nonce },
    tagLength: TAG_BYTES,
  });
  return sealed.combined('bytes') as unknown as Promise<Uint8Array>;
}

async function openPart(
  combined: Uint8Array,
  keyBytes: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const sealed = AESSealedData.fromCombined(combined, {
    ivLength: NONCE_BYTES,
    tagLength: TAG_BYTES,
  });
  return aesDecryptAsync(sealed, await importKey(keyBytes), {
    additionalData,
    output: 'bytes',
  }) as unknown as Promise<Uint8Array>;
}

export function createLibraryObjectCipher(): LibraryObjectCipher {
  const seal: LibraryObjectCipher['seal'] = async ({
    masterKey,
    assetId,
    scope,
    plaintext,
  }) => {
    assertMasterKey(masterKey);
    if (plaintext.byteLength === 0) {
      throw new Error('Library object plaintext is empty.');
    }
    const limit = scope === 'metadata'
      ? LIBRARY_MAX_METADATA_PLAINTEXT_BYTES
      : LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES;
    if (plaintext.byteLength > limit) {
      throw new Error('Library object plaintext exceeds the protocol limit.');
    }
    // Design § Key Hierarchy: a random per-object data key, wrapped by the
    // account Vault master key. The master key never encrypts image bytes.
    const dataKey = await getRandomBytesAsync(KEY_BYTES);
    const wrapped = await sealPart(
      dataKey,
      masterKey,
      keyAdditionalData(assetId, scope),
    );
    if (wrapped.byteLength !== WRAPPED_KEY_BYTES) {
      throw new Error('Library object key wrap has an unexpected size.');
    }
    const payload = await sealPart(
      plaintext,
      dataKey,
      payloadAdditionalData(assetId, scope, plaintext.byteLength),
    );
    const envelope = new Uint8Array(
      MAGIC.byteLength + wrapped.byteLength + payload.byteLength,
    );
    envelope.set(MAGIC);
    envelope.set(wrapped, MAGIC.byteLength);
    envelope.set(payload, MAGIC.byteLength + wrapped.byteLength);
    if (envelope.byteLength > LIBRARY_MAX_OBJECT_ENVELOPE_BYTES) {
      throw new Error('Library object envelope exceeds the protocol limit.');
    }
    return envelope;
  };

  const open: LibraryObjectCipher['open'] = async ({
    masterKey,
    assetId,
    scope,
    envelope,
  }) => {
    assertMasterKey(masterKey);
    const minimum = MAGIC.byteLength + WRAPPED_KEY_BYTES + NONCE_BYTES + TAG_BYTES;
    if (
      envelope.byteLength < minimum
      || envelope.byteLength > LIBRARY_MAX_OBJECT_ENVELOPE_BYTES
    ) {
      throw new Error('Library object envelope is truncated or oversized.');
    }
    for (let index = 0; index < MAGIC.byteLength; index += 1) {
      if (envelope[index] !== MAGIC[index]) {
        throw new Error('Unsupported library object envelope.');
      }
    }
    const wrapped = envelope.slice(
      MAGIC.byteLength,
      MAGIC.byteLength + WRAPPED_KEY_BYTES,
    );
    const payload = envelope.slice(MAGIC.byteLength + WRAPPED_KEY_BYTES);
    const dataKey = await openPart(
      wrapped,
      masterKey,
      keyAdditionalData(assetId, scope),
    );
    const plaintextBytes = payload.byteLength - NONCE_BYTES - TAG_BYTES;
    return openPart(
      payload,
      dataKey,
      payloadAdditionalData(assetId, scope, plaintextBytes),
    );
  };

  return {
    seal,
    open,

    async sealMetadata({ masterKey, assetId, metadata }) {
      const envelope = await seal({
        masterKey,
        assetId,
        scope: 'metadata',
        plaintext: encoder.encode(JSON.stringify(metadata)),
      });
      return encodeBase64Url(envelope);
    },

    async openMetadata({ masterKey, assetId, sealed }) {
      const plaintext = await open({
        masterKey,
        assetId,
        scope: 'metadata',
        envelope: decodeBase64Url(sealed),
      });
      return JSON.parse(decoder.decode(plaintext)) as LibraryEncryptedMetadata;
    },
  };
}
