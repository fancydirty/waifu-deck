import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlBindValue, SqlDatabasePort } from '@/db/sql-port';
import type { LibraryRestorableSource } from '@/features/library/library-actions-types';
import { LIBRARY_MAX_METADATA_PLAINTEXT_BYTES } from '@/features/library/library-object-crypto';
import {
  buildLibraryEncryptedMetadata,
  readSourceMetadata,
  resolveEnvelopeImportClassification,
  restorableImageFrom,
} from '@/features/library/library-source-metadata';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

type ImageColumns = Readonly<Record<string, SqlBindValue>>;

const BASE_ROW: ImageColumns = {
  provider_key: 'danbooru',
  provider_item_id: '1',
  canonical_source_key: null,
  perceptual_hash: null,
  md5: null,
  remote_url: 'https://example.test/base.jpg',
  sample_url: null,
  source_url: null,
  artist_name: null,
  artist_url: null,
  width: 100,
  height: 200,
  byte_size: 4321,
  extension: 'jpg',
  dominant_color: '#112233',
  content_rating: 'safe',
  native_rating: null,
  is_nsfw: 0,
  is_animated: 0,
  tags_json: '[]',
  decision: 'saved',
  presented_at: 1,
  decided_at: 2,
  queue_ordinal: 1,
  decision_ordinal: 1,
  local_uri: 'file:///saved.jpg',
  download_state: 'ready',
  download_error: null,
};

const BASE_SOURCE: LibraryRestorableSource = {
  providerKey: 'danbooru',
  providerItemId: '12345',
  canonicalSourceKey: 'danbooru:12345',
  perceptualHash: null,
  md5: null,
  remoteUrl: 'https://example.test/o.jpg',
  sampleUrl: 'https://example.test/s.jpg',
  sourceUrl: null,
  artistName: null,
  artistUrl: null,
  extension: 'jpg',
  dominantColor: '#AABBCC',
  contentRating: 'safe',
  nativeRating: null,
  isNsfw: false,
  isAnimated: false,
  tags: ['maid'],
};

const openDatabases: DatabaseSync[] = [];

async function seedImage(
  overrides: ImageColumns = {},
): Promise<{ database: SqlDatabasePort; imageId: number }> {
  const native = new DatabaseSync(':memory:');
  openDatabases.push(native);
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  const row = { ...BASE_ROW, ...overrides };
  const columns = Object.keys(row);
  const { lastInsertRowId } = await database.run(
    `INSERT INTO images (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => row[column] ?? null),
  );
  return { database, imageId: lastInsertRowId };
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('library source metadata', () => {
  it('projects an images row into the v2 source block', async () => {
    const { database, imageId } = await seedImage({
      provider_key: 'danbooru',
      provider_item_id: '12345',
      remote_url: 'https://example.test/o.jpg',
      sample_url: 'https://example.test/s.jpg',
      source_url: 'https://example.test/post',
      artist_name: 'someone',
      artist_url: 'https://example.test/artist',
      dominant_color: '#AABBCC',
      content_rating: 'explicit',
      native_rating: 'e',
      is_nsfw: 1,
      is_animated: 0,
      tags_json: JSON.stringify(['maid', 'solo']),
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      canonical_source_key: 'danbooru:12345',
      perceptual_hash: null,
      extension: 'jpg',
    });

    expect(await readSourceMetadata(database, imageId)).toEqual({
      providerKey: 'danbooru',
      providerItemId: '12345',
      canonicalSourceKey: 'danbooru:12345',
      perceptualHash: null,
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      remoteUrl: 'https://example.test/o.jpg',
      sampleUrl: 'https://example.test/s.jpg',
      sourceUrl: 'https://example.test/post',
      artistName: 'someone',
      artistUrl: 'https://example.test/artist',
      extension: 'jpg',
      dominantColor: '#AABBCC',
      contentRating: 'explicit',
      nativeRating: 'e',
      isNsfw: true,
      isAnimated: false,
      tags: ['maid', 'solo'],
    });
  });

  it('preserves a source that published no sample, artist, or digests', async () => {
    const { database, imageId } = await seedImage({
      provider_key: 'waifu_im',
      provider_item_id: 'w-9',
      is_animated: 1,
    });

    expect(await readSourceMetadata(database, imageId)).toMatchObject({
      providerKey: 'waifu_im',
      sampleUrl: null,
      md5: null,
      canonicalSourceKey: null,
      artistName: null,
      artistUrl: null,
      sourceUrl: null,
      nativeRating: null,
      isAnimated: true,
      tags: [],
    });
  });

  it('returns null for a missing or null sourceImageId', async () => {
    const { database } = await seedImage({ provider_key: 'danbooru' });
    expect(await readSourceMetadata(database, null)).toBeNull();
    expect(await readSourceMetadata(database, 999999)).toBeNull();
  });

  it('rebuilds the insertable image fields from a v2 envelope', () => {
    const source = BASE_SOURCE;
    const rebuilt = restorableImageFrom({
      version: 2, plaintextSha256: 'a'.repeat(64), format: 'jpeg',
      canonicalExtension: 'jpg', byteSize: 1234, width: 100, height: 200,
      origin: 'provider', sourceImageId: 7, collectedAt: 1700000000000,
      tags: ['maid'], source,
    });
    expect(rebuilt).toEqual({
      ...source, width: 100, height: 200, byteSize: 1234,
    });
  });

  it('returns null for a v1 envelope, which carries no source block', () => {
    // A device may still hold a locally-queued v1 collect intent, so reading a
    // v1 envelope degrades to "no source" rather than throwing.
    expect(restorableImageFrom({
      version: 1, plaintextSha256: 'a'.repeat(64), format: 'jpeg',
      canonicalExtension: 'jpg', byteSize: 1, width: 1, height: 1,
      origin: 'import', sourceImageId: 7, collectedAt: 1, tags: ['maid'],
    })).toBeNull();
  });

  it('returns null for an envelope whose source block is not a usable source', () => {
    // The opened envelope is an attacker-reachable input after decryption
    // (`library-sync-apply.ts`), and C3b inserts an `images` row from whatever
    // this returns. A null, non-object, or field-missing `source` is therefore
    // "no source", never a half-built row.
    const v1Fields = {
      version: 2 as const, plaintextSha256: 'a'.repeat(64), format: 'jpeg' as const,
      canonicalExtension: 'jpg' as const, byteSize: 9, width: 1, height: 2,
      origin: 'provider' as const, sourceImageId: 7, collectedAt: 1, tags: ['maid'],
    };
    const unusable: readonly unknown[] = [
      null,
      'danbooru:1',
      42,
      {},
      { providerKey: 'not_a_provider', providerItemId: '1' },
      { ...BASE_SOURCE, providerKey: 'not_a_provider' },
      { ...BASE_SOURCE, providerItemId: '' },
      { ...BASE_SOURCE, remoteUrl: null },
      { ...BASE_SOURCE, tags: 'maid' },
    ];
    for (const source of unusable) {
      expect(restorableImageFrom({
        ...v1Fields,
        source: source as never,
      })).toBeNull();
    }
  });

  it('builds a v3 payload with a stable key order for both seal sites', () => {
    // `sealMetadata` seals `JSON.stringify(payload)`, so key order IS the byte
    // shape. This pins the order both seal sites depend on.
    const base = {
      plaintextSha256: 'a'.repeat(64),
      format: 'jpeg' as const,
      canonicalExtension: 'jpg' as const,
      byteSize: 4,
      width: 10,
      height: 20,
      origin: 'import' as const,
      sourceImageId: null,
      collectedAt: 99,
    };
    expect(Object.keys(buildLibraryEncryptedMetadata(base, null))).toEqual([
      'version', 'plaintextSha256', 'format', 'canonicalExtension', 'byteSize',
      'width', 'height', 'origin', 'sourceImageId', 'collectedAt',
      'importClassification', 'tags',
    ]);
    expect(buildLibraryEncryptedMetadata(base, null)).toMatchObject({
      version: 3, importClassification: 'unknown', tags: [],
    });
    expect(buildLibraryEncryptedMetadata(base, null).source).toBeUndefined();
  });

  it('takes the envelope tags from the source row, never inventing them', async () => {
    const { database, imageId } = await seedImage({
      tags_json: JSON.stringify(['Solo', 'maid', 'maid']),
    });
    const source = await readSourceMetadata(database, imageId);
    const payload = buildLibraryEncryptedMetadata(
      {
        plaintextSha256: 'a'.repeat(64),
        format: 'jpeg',
        canonicalExtension: 'jpg',
        byteSize: 4,
        width: 10,
        height: 20,
        origin: 'provider',
        sourceImageId: imageId,
        collectedAt: 99,
      },
      source,
    );
    // Normalized and de-duplicated by the repository's own tag parser.
    expect(payload.tags).toEqual(['maid', 'solo']);
    expect(payload.source?.tags).toEqual(['maid', 'solo']);
  });
});

describe('library encrypted metadata fits the protocol limit', () => {
  const INPUT = {
    plaintextSha256: 'a'.repeat(64),
    format: 'jpeg' as const,
    canonicalExtension: 'jpg' as const,
    byteSize: 7_800_000,
    width: 1000,
    height: 2000,
    origin: 'provider' as const,
    sourceImageId: 3495,
    collectedAt: 1_700_000_000_000,
  };

  const utf8Bytes = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value), 'utf8');

  const untrimmed = (source: LibraryRestorableSource) => ({
    version: 3 as const,
    ...INPUT,
    importClassification: 'unknown' as const,
    tags: source.tags,
    source,
  });

  it('a payload that fits is unchanged', () => {
    const payload = buildLibraryEncryptedMetadata(INPUT, BASE_SOURCE);
    const expected = untrimmed(BASE_SOURCE);
    expect(payload).toEqual(expected);
    expect(JSON.stringify(payload)).toBe(JSON.stringify(expected));
  });

  it('a long tag list is trimmed from its end until the payload fits', () => {
    const tags = Array.from(
      { length: 250 },
      (_, index) => `tag_${index.toString().padStart(4, '0')}`,
    );
    const source = { ...BASE_SOURCE, tags };
    expect(utf8Bytes(untrimmed(source))).toBeGreaterThan(5000);

    const payload = buildLibraryEncryptedMetadata(INPUT, source);

    expect(utf8Bytes(payload)).toBeLessThanOrEqual(LIBRARY_MAX_METADATA_PLAINTEXT_BYTES);
    expect(payload.source).toBeDefined();
    expect(payload.tags).toEqual(payload.source?.tags);
    const kept = payload.tags.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(tags.length);
    expect(payload.tags).toEqual(tags.slice(0, kept));
    // Maximal: one more tag would no longer fit.
    const oneMore = tags.slice(0, kept + 1);
    expect(utf8Bytes(untrimmed({ ...source, tags: oneMore }))).toBeGreaterThan(
      LIBRARY_MAX_METADATA_PLAINTEXT_BYTES,
    );
    expect(Object.keys(payload)).toEqual(Object.keys(untrimmed(source)));
    expect(Object.keys(payload.source!)).toEqual(Object.keys(source));
  });

  it('byte length is measured in UTF-8', () => {
    // 3 bytes per CJK character: the UTF-16 length is a third of the byte length.
    const tags = Array.from(
      { length: 120 },
      (_, index) => `标签${String.fromCharCode(0x4e00 + index)}${'字'.repeat(7)}`,
    );
    const source = { ...BASE_SOURCE, tags };
    const stringLength = JSON.stringify(untrimmed(source)).length;
    expect(stringLength).toBeLessThanOrEqual(LIBRARY_MAX_METADATA_PLAINTEXT_BYTES);
    expect(utf8Bytes(untrimmed(source))).toBeGreaterThan(
      LIBRARY_MAX_METADATA_PLAINTEXT_BYTES,
    );

    const payload = buildLibraryEncryptedMetadata(INPUT, source);

    expect(utf8Bytes(payload)).toBeLessThanOrEqual(LIBRARY_MAX_METADATA_PLAINTEXT_BYTES);
    expect(payload.tags).toEqual(payload.source?.tags);
    expect(payload.tags.length).toBeLessThan(tags.length);
  });

  it('a payload of exactly the limit is unchanged and one byte more is trimmed', () => {
    const withPad = (pad: number) => ({
      ...BASE_SOURCE,
      sourceUrl: 'u'.repeat(pad),
    });
    const pad = LIBRARY_MAX_METADATA_PLAINTEXT_BYTES - utf8Bytes(untrimmed(withPad(0)));

    const exact = buildLibraryEncryptedMetadata(INPUT, withPad(pad));
    expect(utf8Bytes(exact)).toBe(LIBRARY_MAX_METADATA_PLAINTEXT_BYTES);
    expect(exact).toEqual(untrimmed(withPad(pad)));

    const over = buildLibraryEncryptedMetadata(INPUT, withPad(pad + 1));
    expect(over.tags).toEqual([]);
    expect(over.source?.tags).toEqual([]);
  });

  it('the kept tag list is the longest prefix that fits, across tag counts and lengths', () => {
    const makeTag = (kind: 'ascii' | 'cjk', length: number, index: number): string =>
      kind === 'ascii'
        ? `t${index.toString().padStart(3, '0')}`.padEnd(length + (index % 5), 'x')
        : String.fromCharCode(0x4e00 + index) + '字'.repeat(length - 1 + (index % 5));
    const longestFittingPrefix = (source: LibraryRestorableSource): number => {
      let kept = 0;
      while (
        kept < source.tags.length
        && utf8Bytes(untrimmed({ ...source, tags: source.tags.slice(0, kept + 1) }))
          <= LIBRARY_MAX_METADATA_PLAINTEXT_BYTES
      ) kept += 1;
      return kept;
    };

    let overflowing = 0;
    for (const kind of ['ascii', 'cjk'] as const) {
      for (const length of [4, 7, 12, 25, 60]) {
        for (const count of [60, 101, 150, 173, 250, 400]) {
          const tags = Array.from({ length: count }, (_, index) =>
            makeTag(kind, length, index));
          const source = { ...BASE_SOURCE, tags };
          if (utf8Bytes(untrimmed(source)) <= LIBRARY_MAX_METADATA_PLAINTEXT_BYTES) continue;
          overflowing += 1;

          const payload = buildLibraryEncryptedMetadata(INPUT, source);
          const expected = tags.slice(0, longestFittingPrefix(source));

          expect({ kind, length, count, tags: payload.tags }).toEqual({
            kind, length, count, tags: expected,
          });
          expect(payload.source?.tags).toEqual(expected);
          expect(utf8Bytes(payload)).toBeLessThanOrEqual(
            LIBRARY_MAX_METADATA_PLAINTEXT_BYTES,
          );
        }
      }
    }
    expect(overflowing).toBeGreaterThan(20);
  });

  it('a source too large without any tag falls back to the v1 shape', () => {
    const source = {
      ...BASE_SOURCE,
      remoteUrl: `https://example.test/${'r'.repeat(2500)}.jpg`,
      sampleUrl: `https://example.test/${'s'.repeat(2500)}.jpg`,
      tags: ['maid', 'solo'],
    };
    expect(utf8Bytes(untrimmed({ ...source, tags: [] }))).toBeGreaterThan(
      LIBRARY_MAX_METADATA_PLAINTEXT_BYTES,
    );

    const payload = buildLibraryEncryptedMetadata(INPUT, source);

    expect(payload.source).toBeUndefined();
    expect(Object.keys(payload)).not.toContain('source');
    expect(payload.tags).toEqual([]);
    expect(utf8Bytes(payload)).toBeLessThanOrEqual(LIBRARY_MAX_METADATA_PLAINTEXT_BYTES);
    expect(payload).toEqual(buildLibraryEncryptedMetadata(INPUT, null));
  });

  it.each(['safe', 'adult', 'unknown'] as const)(
    'preserves importClassification=%s when tags are truncated and when source block overflows',
    (importClassification) => {
      const inputWithClassification = { ...INPUT, importClassification };
      const tags = Array.from(
        { length: 250 },
        (_, index) => `tag_${index.toString().padStart(4, '0')}`,
      );
      const truncated = buildLibraryEncryptedMetadata(
        inputWithClassification,
        { ...BASE_SOURCE, tags },
      );
      expect(truncated.version).toBe(3);
      expect(truncated.importClassification).toBe(importClassification);
      expect(truncated.tags.length).toBeGreaterThan(0);
      expect(truncated.tags.length).toBeLessThan(tags.length);

      const oversizeSource = {
        ...BASE_SOURCE,
        remoteUrl: `https://example.test/${'r'.repeat(2500)}.jpg`,
        sampleUrl: `https://example.test/${'s'.repeat(2500)}.jpg`,
        tags: ['maid'],
      };
      const fallback = buildLibraryEncryptedMetadata(
        inputWithClassification,
        oversizeSource,
      );
      expect(fallback.version).toBe(3);
      expect(fallback.importClassification).toBe(importClassification);
      expect(fallback.source).toBeUndefined();
    },
  );
});

describe('resolveEnvelopeImportClassification (N6-A1)', () => {
  it('decodes v1 and v2 payloads without importClassification as unknown', () => {
    expect(resolveEnvelopeImportClassification({ version: 1 })).toBe('unknown');
    expect(resolveEnvelopeImportClassification({ version: 2 })).toBe('unknown');
    expect(resolveEnvelopeImportClassification({ version: 3 })).toBe('unknown');
  });

  it.each(['safe', 'adult', 'unknown'] as const)(
    'accepts valid importClassification=%s',
    (classification) => {
      expect(
        resolveEnvelopeImportClassification({ importClassification: classification }),
      ).toBe(classification);
    },
  );

  it.each([
    'nsfw',
    'SAFE',
    '',
    null,
    123,
    {},
    ['safe'],
  ])('returns null for present invalid importClassification=%p', (invalid) => {
    expect(
      resolveEnvelopeImportClassification({ importClassification: invalid }),
    ).toBeNull();
  });
});
