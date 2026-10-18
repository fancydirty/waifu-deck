import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import { restoreCandidateFrom } from '@/features/library/library-restore-image';

const SOURCE = {
  providerKey: 'danbooru' as const,
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
  contentRating: 'explicit' as const,
  nativeRating: 'e',
  isNsfw: true,
  isAnimated: false,
  tags: ['maid', 'solo'] as readonly string[],
};

const V2: LibraryEncryptedMetadata = {
  version: 2,
  plaintextSha256: 'a'.repeat(64),
  format: 'jpeg',
  canonicalExtension: 'jpg',
  byteSize: 1234,
  width: 100,
  height: 200,
  origin: 'provider',
  sourceImageId: 7,
  collectedAt: 1_700_000_000_000,
  tags: ['maid', 'solo'],
  source: SOURCE,
};

describe('restoreCandidateFrom', () => {
  it('projects a v2 envelope into an insertable candidate at its original collect time', () => {
    expect(restoreCandidateFrom(V2)).toEqual({
      savedAt: 1_700_000_000_000,
      candidate: {
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
        width: 100,
        height: 200,
        byteSize: 1234,
        extension: 'jpg',
        dominantColor: '#AABBCC',
        contentRating: 'explicit',
        nativeRating: 'e',
        isNsfw: true,
        isAnimated: false,
        tags: ['maid', 'solo'],
      },
    });
  });

  it('omits sampleUrl entirely when the source has none', () => {
    const candidate = restoreCandidateFrom({
      ...V2, source: { ...SOURCE, sampleUrl: null },
    });
    expect(candidate).not.toBeNull();
    expect('sampleUrl' in candidate!.candidate).toBe(false);
  });

  it('returns a mutable tags array the repository can keep', () => {
    const { candidate } = restoreCandidateFrom(V2)!;
    expect(() => candidate.tags.push('extra')).not.toThrow();
    expect(V2.source!.tags).toEqual(['maid', 'solo']);
  });

  it('returns null for a v1 envelope and for a v2 envelope with no source', () => {
    expect(restoreCandidateFrom({ ...V2, version: 1, source: undefined })).toBeNull();
    expect(restoreCandidateFrom({ ...V2, source: undefined })).toBeNull();
  });

  it('never produces a restore candidate when origin is import, even if a stray source block is present', () => {
    expect(
      restoreCandidateFrom({
        ...V2,
        version: 3,
        origin: 'import',
        sourceImageId: null,
        importClassification: 'safe',
        source: SOURCE,
      }),
    ).toBeNull();
  });
});
