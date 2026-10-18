jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createActionsHarness,
  TEST_MASTER_KEY,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import { buildEngine } from '@/features/library/library-sync-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

/**
 * C3a: the two seal sites — `library-protect-action.ts`'s `metadataFor` (the
 * immediate protect path) and `library-sync-engine.ts`'s `sealCollectMetadata`
 * (the deferred outbox drain) — must serialize to *byte-identical* plaintext for
 * the same asset. They run on different devices and at different times against
 * one bucket; if their JSON key order or field set diverged, the same asset
 * would seal to different plaintext and a reader could see fields appear and
 * disappear depending on which path happened to win. (The sealed ciphertext
 * itself differs every time — `seal` draws a fresh random nonce — so parity is
 * asserted on the opened envelope's serialization, not on the base64url.)
 */
describe('metadata envelope seal parity', () => {
  let harness: ActionsHarness;
  const bytes = Uint8Array.from([11, 22, 33, 44, 55]);
  const digest = sha256PlaintextHex(bytes);

  beforeEach(async () => {
    resetExpoCryptoDouble();
    harness = await createActionsHarness();
  });

  afterEach(() => {
    harness.close();
  });

  /**
   * The opened envelope of the one `collect` mutation this cycle submitted.
   * `collect` is the only kind that carries `meta`: it is a carried field, so a
   * later `protect` deliberately never re-seals it.
   */
  const openedCollect = async (): Promise<LibraryEncryptedMetadata> => {
    const mutations = harness.cloud.submitted.filter(
      (mutation) => mutation.kind === 'collect',
    );
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0]!;
    const sealed = mutation.meta;
    if (typeof sealed !== 'string') {
      throw new Error(`mutation ${mutation.kind} carried no sealed meta`);
    }
    return harness.cipher.openMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId: mutation.assetId,
      sealed,
    });
  };

  it('seals the source block on the protect path', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    const sourceImageId = await harness.seedSourceImage({
      plaintextSha256: digest,
    });

    const action = createLibraryProtectAction(harness.protectDependencies);
    expect(await action.protect(digest)).toEqual({ status: 'applied' });

    expect(await openedCollect()).toMatchObject({
      version: 3,
      plaintextSha256: digest,
      origin: 'provider',
      sourceImageId,
      importClassification: 'unknown',
      tags: ['maid', 'solo'],
      source: {
        providerKey: 'danbooru',
        contentRating: 'explicit',
        isNsfw: true,
        isAnimated: false,
        tags: ['maid', 'solo'],
      },
    });
  });

  it('seals the same source block on the sync engine drain path', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    const sourceImageId = await harness.seedSourceImage({
      plaintextSha256: digest,
    });

    // The engine drains the durable `collect` intent the ingest left behind,
    // reading the provider row through the same projection.
    await buildEngine(harness).sync();

    expect(await openedCollect()).toMatchObject({
      version: 3,
      plaintextSha256: digest,
      origin: 'provider',
      sourceImageId,
      importClassification: 'unknown',
      tags: ['maid', 'solo'],
      source: {
        providerKey: 'danbooru',
        contentRating: 'explicit',
        isNsfw: true,
        isAnimated: false,
        tags: ['maid', 'solo'],
      },
    });
  });

  it('serializes byte-identically from both seal sites for one asset', async () => {
    const fromProtect = await (async () => {
      await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
      await harness.seedSourceImage({ plaintextSha256: digest });
      const action = createLibraryProtectAction(harness.protectDependencies);
      expect(await action.protect(digest)).toEqual({ status: 'applied' });
      return await openedCollect();
    })();

    // A second device, same asset, same provider row, but the deferred path.
    harness.close();
    harness = await createActionsHarness();
    const fromEngine = await (async () => {
      await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
      await harness.seedSourceImage({ plaintextSha256: digest });
      await buildEngine(harness).sync();
      return await openedCollect();
    })();

    // Byte identity of the WHOLE payload, not deep equality and with nothing
    // normalized away: `sealMetadata` seals `JSON.stringify(metadata)`, so key
    // ORDER is part of the sealed bytes and a reordered-but-equal object would
    // still be a different envelope. `collectedAt` is included deliberately —
    // in production both sites read it from the same asset row (`metadataFor`
    // takes `asset.createdAt`; the engine takes the `collectedAt` the ingest
    // wrote into the durable intent from that same `createdAt`), so the two
    // paths agreeing on it is a real contract, not a test artifact to exclude.
    const canonical = (metadata: LibraryEncryptedMetadata): string =>
      JSON.stringify(metadata);
    expect(canonical(fromEngine)).toBe(canonical(fromProtect));
    expect(fromProtect.source).toBeDefined();
    expect(fromEngine.source).toBeDefined();
  });

  it('emits a v3 envelope with no source block for an imported asset', async () => {
    // No `images` row: a local import has no provider identity to carry, and
    // the seal site must never invent one.
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });

    const action = createLibraryProtectAction(harness.protectDependencies);
    expect(await action.protect(digest)).toEqual({ status: 'applied' });

    const opened = await openedCollect();
    expect(opened).toMatchObject({
      version: 3,
      origin: 'import',
      sourceImageId: null,
      importClassification: 'unknown',
      tags: [],
    });
    expect(opened.source).toBeUndefined();
    expect(Object.keys(opened)).not.toContain('source');
  });

  it.each(['safe', 'adult', 'unknown'] as const)(
    'serializes byte-identically across both seal sites for importClassification=%s',
    async (importClassification) => {
      const fromProtect = await (async () => {
        await harness.seedLocalAsset({
          plaintextSha256: digest,
          bytes,
          importClassification,
        });
        const action = createLibraryProtectAction(harness.protectDependencies);
        expect(await action.protect(digest)).toEqual({ status: 'applied' });
        return await openedCollect();
      })();

      harness.close();
      harness = await createActionsHarness();
      const fromEngine = await (async () => {
        await harness.seedLocalAsset({
          plaintextSha256: digest,
          bytes,
          importClassification,
        });
        await buildEngine(harness).sync();
        return await openedCollect();
      })();

      expect(fromProtect.version).toBe(3);
      expect(fromProtect.importClassification).toBe(importClassification);
      expect(JSON.stringify(fromEngine)).toBe(JSON.stringify(fromProtect));
    },
  );
});
