import {
  browseCollectionImages,
  browseCollectionItems,
  buildCollectionItems,
  collectionItemSourceOptions,
  collectionSourceOptions,
  compareCollectionItems,
  countCollectionImagesByMode,
  countCollectionItemsByMode,
  DEFAULT_COLLECTION_QUERY,
  filterCollectionItemsByMode,
  isCollectionProvider,
  normalizeCollectionBrowserQuery,
  type CollectionItem,
  type CollectionSearchField,
  type CollectionSort,
} from '@/features/collection/collection-filter';
import {
  DIRECT_DISTRIBUTION_POLICY,
  STORE_DISTRIBUTION_POLICY,
} from '@/features/distribution/distribution-policy';
import type { StoredImage } from '@/features/images/image-repository';
import type { LibraryEntry } from '@/features/library/library-view-model';
import { viewDigest } from '@/features/library/library-view-test-support';

function image(id: number, overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: null,
    artistName: `Artist ${id}`,
    artistUrl: null,
    width: 900,
    height: 1200,
    byteSize: 500_000,
    extension: 'jpg',
    dominantColor: '#726A7D',
    contentRating: 'safe',
    nativeRating: null,
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
    decision: 'saved',
    presentedAt: 1,
    decidedAt: id * 100,
    queueOrdinal: id,
    decisionOrdinal: id,
    localUri: null,
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

test('filters by content mode and provider before sorting newest first', () => {
  const images = [
    image(1, { providerKey: 'danbooru', decidedAt: 100 }),
    image(2, { providerKey: 'danbooru', decidedAt: 300, isNsfw: true }),
    image(3, { providerKey: 'nekos_api', decidedAt: 200 }),
  ];

  expect(browseCollectionImages(images, {
    ...DEFAULT_COLLECTION_QUERY,
    mode: 'sfw',
    provider: 'danbooru',
  }).map(({ id }) => id)).toEqual([1]);
});

test('does not let absent route values overwrite collection defaults', () => {
  expect(normalizeCollectionBrowserQuery({
    text: '',
    field: undefined,
    mode: undefined,
    provider: undefined,
    sort: undefined,
  })).toEqual(DEFAULT_COLLECTION_QUERY);
});

test('coerces Store gallery queries to SFW and excludes adult rows', () => {
  expect(normalizeCollectionBrowserQuery({
    mode: 'nsfw',
  }, STORE_DISTRIBUTION_POLICY).mode).toBe('sfw');
  expect(browseCollectionImages([
    image(1),
    image(2, { isNsfw: true, contentRating: 'explicit' }),
  ], {
    ...DEFAULT_COLLECTION_QUERY,
    mode: 'mixed',
  }, STORE_DISTRIBUTION_POLICY).map(({ id }) => id)).toEqual([1]);
});

test('matches normalized artist, tag, and provider names locally', () => {
  const images = [
    image(1, { artistName: 'Mika Pikazo', tags: ['blue_hair'] }),
    image(2, { providerKey: 'nekos_api', artistName: null, tags: ['cat girl'] }),
    image(3, { providerKey: 'danbooru', artistName: '別の作者', tags: ['solo'] }),
  ];

  expect(browseCollectionImages(images, {
    ...DEFAULT_COLLECTION_QUERY,
    text: '  MIKA   blue ',
  }).map(({ id }) => id)).toEqual([1]);
  expect(browseCollectionImages(images, {
    ...DEFAULT_COLLECTION_QUERY,
    text: 'nekos.api',
  }).map(({ id }) => id)).toEqual([2]);
  expect(browseCollectionImages(images, {
    ...DEFAULT_COLLECTION_QUERY,
    text: '別の',
    field: 'artist',
  }).map(({ id }) => id)).toEqual([3]);
  expect(browseCollectionImages(images, {
    ...DEFAULT_COLLECTION_QUERY,
    text: 'solo',
    field: 'tag',
  }).map(({ id }) => id)).toEqual([3]);
});

test('supports oldest, resolution, and file-size sort with stable fallbacks', () => {
  const images = [
    image(1, { decidedAt: 100, width: 1000, height: 1000, byteSize: 900 }),
    image(2, { decidedAt: 300, width: 2000, height: 1000, byteSize: 700 }),
    image(3, { decidedAt: 200, width: 1000, height: 1000, byteSize: 1200 }),
  ];

  expect(browseCollectionImages(images, {
    ...DEFAULT_COLLECTION_QUERY,
    sort: 'oldest',
  }).map(({ id }) => id)).toEqual([1, 3, 2]);
  expect(browseCollectionImages(images, {
    ...DEFAULT_COLLECTION_QUERY,
    sort: 'resolution',
  }).map(({ id }) => id)).toEqual([2, 3, 1]);
  expect(browseCollectionImages(images, {
    ...DEFAULT_COLLECTION_QUERY,
    sort: 'fileSize',
  }).map(({ id }) => id)).toEqual([3, 1, 2]);
});

test('R8.27: counts collection rows per rating mode for the chip row', () => {
  const images = [
    image(1),
    image(2),
    image(3),
    image(4, { isNsfw: true, contentRating: 'explicit' }),
  ];

  expect(countCollectionImagesByMode(images, DIRECT_DISTRIBUTION_POLICY))
    .toEqual({ mixed: 4, sfw: 3, nsfw: 1 });

  const store = countCollectionImagesByMode(images, STORE_DISTRIBUTION_POLICY);
  expect(store.nsfw).toBe(0);
  expect(store.mixed).toBe(store.sfw);
  expect(store.sfw).toBe(3);
});

describe('ledger N2: collectionSourceOptions', () => {
  const order = ['waifu_im', 'nekos_api', 'danbooru', 'safebooru', 'yandere', 'konachan', 'e621', 'e926', 'gelbooru', 'rule34'] as const;

  test('lists 全部 then every present provider, most first, ties in registry order', () => {
    const images = [
      image(1, { providerKey: 'yandere' }), image(2, { providerKey: 'yandere' }),
      image(3, { providerKey: 'gelbooru' }), image(4, { providerKey: 'danbooru' }),
    ];
    expect(collectionSourceOptions(images, 0, 'all', order)).toEqual([
      { provider: 'all', count: 4 },
      { provider: 'yandere', count: 2 },
      { provider: 'danbooru', count: 1 },
      { provider: 'gelbooru', count: 1 },
    ]);
  });

  test('tiles without a source count only toward 全部', () => {
    expect(collectionSourceOptions([image(1, { providerKey: 'konachan' })], 3, 'all', order)).toEqual([
      { provider: 'all', count: 4 },
      { provider: 'konachan', count: 1 },
    ]);
  });

  test('keeps the current selection listed at 0', () => {
    expect(collectionSourceOptions([image(1, { providerKey: 'danbooru' })], 0, 'rule34', order)).toEqual([
      { provider: 'all', count: 1 },
      { provider: 'danbooru', count: 1 },
      { provider: 'rule34', count: 0 },
    ]);
  });

  test('an empty list is just 全部 at 0', () => {
    expect(collectionSourceOptions([], 0, 'all', order)).toEqual([{ provider: 'all', count: 0 }]);
  });
});

/**
 * K7 cut 5b (audit ㉚) oracle: the pre-cache text predicate, kept verbatim so
 * the precomputed haystack is proved to select exactly the same rows.
 */
const ORACLE_PROVIDER_NAMES: Record<string, readonly string[]> = {
  waifu_im: ['waifu.im', 'waifu im', 'waifu_im'],
  nekos_api: ['nekos.api', 'nekos api', 'nekos_api'],
  danbooru: ['danbooru'],
  safebooru: ['safebooru', 'safe booru'],
  yandere: ['yande.re', 'yandere', 'yande re'],
  konachan: ['konachan'],
  e621: ['e621'],
  e926: ['e926'],
  gelbooru: ['gelbooru'],
  rule34: ['rule34'],
};

function oracleNormalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function oracleMatchesText(
  target: StoredImage,
  text: string,
  field: CollectionSearchField,
): boolean {
  const terms = oracleNormalize(text).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const values = field === 'artist'
    ? (target.artistName ? [target.artistName] : [])
    : field === 'tag'
      ? target.tags
      : [
          ...(target.artistName ? [target.artistName] : []),
          ...target.tags,
          ...ORACLE_PROVIDER_NAMES[target.providerKey],
        ];
  const haystack = values.map(oracleNormalize).join('\n');
  return terms.every((term) => haystack.includes(term));
}

function oracleIds(
  images: readonly StoredImage[],
  text: string,
  field: CollectionSearchField,
): number[] {
  return images
    .filter((candidate) => oracleMatchesText(candidate, text, field))
    .slice()
    .sort((left, right) => (right.decidedAt ?? 0) - (left.decidedAt ?? 0))
    .map(({ id }) => id);
}

describe('K7 ㉚: collection search normalizes each row once per images reference', () => {
  // A keystroke used to re-run `normalize('NFKC').trim().toLocaleLowerCase()`
  // over every searchable field of every image — on a JNI-backed Hermes
  // intrinsic, with a controlled TextInput waiting on the result.
  const KEYSTROKES = ['m', 'mi', 'mik', 'mika', 'mika '];

  function library(): StoredImage[] {
    return Array.from({ length: 20 }, (_, index) => image(index + 1, {
      // 1 artist + 2 tags + 3 provider names = 6 normalized values per row.
      artistName: index === 0 ? 'Mika Pikazo' : `Artist ${index}`,
      tags: ['waifu', index % 2 === 0 ? 'blue_hair' : 'solo'],
      decidedAt: (index + 1) * 100,
    }));
  }

  // 20 rows x 6 values.
  const FIELD_VALUES = 120;

  let normalizeSpy: jest.SpyInstance;

  beforeEach(() => {
    normalizeSpy = jest.spyOn(String.prototype, 'normalize');
  });

  afterEach(() => {
    normalizeSpy.mockRestore();
  });

  test('five keystrokes on one images reference normalize the rows once', () => {
    const images = library();

    normalizeSpy.mockClear();
    browseCollectionImages(images, { ...DEFAULT_COLLECTION_QUERY, text: KEYSTROKES[0] });
    // First keystroke: one pass over the rows plus the query itself.
    expect(normalizeSpy).toHaveBeenCalledTimes(FIELD_VALUES + 1);

    for (const text of KEYSTROKES.slice(1)) {
      normalizeSpy.mockClear();
      browseCollectionImages(images, { ...DEFAULT_COLLECTION_QUERY, text });
      // Every later keystroke normalizes the query and nothing else.
      expect(normalizeSpy).toHaveBeenCalledTimes(1);
    }
  });

  test('the cached haystack selects exactly the rows the old predicate did', () => {
    const images = library();
    const queries: [string, CollectionSearchField][] = [
      ['', 'all'],
      ['mika', 'all'],
      ['MIKA   blue', 'all'],
      ['waifu.im', 'all'],
      ['artist 3', 'artist'],
      ['mika', 'artist'],
      ['solo', 'tag'],
      ['waifu.im', 'tag'],
      ['  ', 'all'],
      ['nothing-here', 'all'],
    ];

    for (const [text, field] of queries) {
      expect(browseCollectionImages(images, {
        ...DEFAULT_COLLECTION_QUERY,
        text,
        field,
      }).map(({ id }) => id)).toEqual(oracleIds(images, text, field));
    }
  });

  test('a different images reference is normalized on its own, not served stale', () => {
    const first = library();
    browseCollectionImages(first, { ...DEFAULT_COLLECTION_QUERY, text: 'mika' });

    const second = library().map((row) => ({ ...row, artistName: 'Somebody Else' }));
    normalizeSpy.mockClear();
    expect(browseCollectionImages(second, {
      ...DEFAULT_COLLECTION_QUERY,
      text: 'mika',
    })).toEqual([]);
    expect(normalizeSpy).toHaveBeenCalledTimes(FIELD_VALUES + 1);
    expect(browseCollectionImages(second, {
      ...DEFAULT_COLLECTION_QUERY,
      text: 'somebody',
    }).map(({ id }) => id)).toEqual(oracleIds(second, 'somebody', 'all'));
  });

  test('switching the search field on one reference does not reuse the other field\'s haystack', () => {
    const images = library();

    // 'waifu.im' is a provider name: it belongs to the 'all' haystack only.
    expect(browseCollectionImages(images, {
      ...DEFAULT_COLLECTION_QUERY,
      text: 'waifu.im',
      field: 'all',
    }).map(({ id }) => id)).toEqual(oracleIds(images, 'waifu.im', 'all'));
    expect(browseCollectionImages(images, {
      ...DEFAULT_COLLECTION_QUERY,
      text: 'waifu.im',
      field: 'tag',
    })).toEqual([]);
    expect(browseCollectionImages(images, {
      ...DEFAULT_COLLECTION_QUERY,
      text: 'mika',
      field: 'artist',
    }).map(({ id }) => id)).toEqual(oracleIds(images, 'mika', 'artist'));
  });

  test('the mode and provider filters still apply on top of a cached haystack', () => {
    const images = [
      image(1, { artistName: 'Mika Pikazo', providerKey: 'danbooru', decidedAt: 100 }),
      image(2, {
        artistName: 'Mika Pikazo',
        providerKey: 'danbooru',
        decidedAt: 300,
        isNsfw: true,
        contentRating: 'explicit',
      }),
      image(3, { artistName: 'Mika Pikazo', providerKey: 'nekos_api', decidedAt: 200 }),
    ];

    expect(browseCollectionImages(images, {
      ...DEFAULT_COLLECTION_QUERY,
      text: 'mika',
      mode: 'sfw',
      provider: 'danbooru',
    }).map(({ id }) => id)).toEqual([1]);
    expect(browseCollectionImages(images, {
      ...DEFAULT_COLLECTION_QUERY,
      text: 'mika',
    }).map(({ id }) => id)).toEqual([2, 3, 1]);
  });
});

function importEntry(
  tag: string,
  overrides: Partial<LibraryEntry> = {},
): LibraryEntry {
  return {
    plaintextSha256: viewDigest(tag),
    sourceImageId: null,
    origin: 'import',
    importClassification: 'safe',
    importDeletedAt: null,
    hasImportMembership: true,
    format: 'jpeg',
    byteSize: 420_000,
    width: 1200,
    height: 1600,
    residency: 'local-original',
    lifecycle: 'active',
    protection: 'unprotected',
    failureCategory: null,
    hasLocalOriginal: true,
    localOriginalUri: `file:///data/library/originals/${viewDigest(tag)}.jpg`,
    originalGenerationId: null,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('N6-B1: unified collection items, mixed sorts, filters, and counts', () => {
  const registryOrder = [
    'waifu_im',
    'nekos_api',
    'danbooru',
    'safebooru',
    'yandere',
    'konachan',
    'e621',
    'e926',
    'gelbooru',
    'rule34',
  ] as const;

  test('isCollectionProvider recognizes all, imports, and registry providers only', () => {
    expect(isCollectionProvider('all')).toBe(true);
    expect(isCollectionProvider('imports')).toBe(true);
    expect(isCollectionProvider('danbooru')).toBe(true);
    expect(isCollectionProvider('unknown_source')).toBe(false);
  });

  test('buildCollectionItems creates image, import, and legacy items without duplicating provider attachments, and renders both members for the §4.4 two-member case', () => {
    const providerImg1 = image(10, { decidedAt: 500 });
    const providerImg2 = image(20, { decidedAt: 600, isNsfw: true });
    // Provider-only library entry attached to image 10 -> not a second tile:
    const attachedEntry = importEntry('attached-10', {
      sourceImageId: 10,
      origin: 'provider',
      hasImportMembership: false,
    });
    // Two-member digest: linked to image 20 AND has active import membership -> renders both!
    const twoMemberEntry = importEntry('two-member-20', {
      sourceImageId: 20,
      origin: 'import',
      importClassification: 'safe',
      hasImportMembership: true,
      createdAt: 700,
    });
    // Standalone import:
    const standaloneImport = importEntry('standalone-imp', {
      createdAt: 800,
    });
    // Legacy opaque provider fallback (origin='provider', sourceImageId=null):
    const legacyFallback = importEntry('legacy-fallback', {
      origin: 'provider',
      sourceImageId: null,
      hasImportMembership: false,
      createdAt: 400,
    });

    const items = buildCollectionItems(
      [providerImg1, providerImg2],
      [attachedEntry, twoMemberEntry, standaloneImport, legacyFallback],
    );

    expect(items.map((item) => item.key)).toEqual([
      'image:10',
      'image:20',
      `import:${twoMemberEntry.plaintextSha256}`,
      `import:${standaloneImport.plaintextSha256}`,
      `legacy:${legacyFallback.plaintextSha256}`,
    ]);
  });

  test('mixed sorts (newest, oldest, resolution, fileSize) interleave provider saves and imports by shared primary value and tie rules', () => {
    const imgA = image(1, {
      decidedAt: 200,
      decisionOrdinal: 1,
      width: 1000,
      height: 1000, // 1,000,000
      byteSize: 500_000,
    });
    const impB = importEntry('imp-b', {
      createdAt: 300,
      width: 1500,
      height: 1000, // 1,500,000
      byteSize: 300_000,
    });
    const imgC = image(2, {
      decidedAt: 400,
      decisionOrdinal: 2,
      width: 800,
      height: 800, // 640,000
      byteSize: 900_000,
    });
    const impD = importEntry('imp-d', {
      createdAt: 100,
      width: 2000,
      height: 2000, // 4,000,000
      byteSize: 700_000,
    });

    const items = buildCollectionItems([imgA, imgC], [impB, impD]);

    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        sort: 'newest',
      }).map((i) => i.key),
    ).toEqual([
      'image:2',
      `import:${impB.plaintextSha256}`,
      'image:1',
      `import:${impD.plaintextSha256}`,
    ]);

    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        sort: 'oldest',
      }).map((i) => i.key),
    ).toEqual([
      `import:${impD.plaintextSha256}`,
      'image:1',
      `import:${impB.plaintextSha256}`,
      'image:2',
    ]);

    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        sort: 'resolution',
      }).map((i) => i.key),
    ).toEqual([
      `import:${impD.plaintextSha256}`,
      `import:${impB.plaintextSha256}`,
      'image:1',
      'image:2',
    ]);

    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        sort: 'fileSize',
      }).map((i) => i.key),
    ).toEqual([
      'image:2',
      `import:${impD.plaintextSha256}`,
      'image:1',
      `import:${impB.plaintextSha256}`,
    ]);
  });

  test('three-way ties (provider vs import vs legacy) and comparator transitivity across all 4 sorts', () => {
    const img1 = image(1, {
      decidedAt: 500,
      decisionOrdinal: 1,
      width: 1000,
      height: 1000,
      byteSize: 500_000,
    });
    const img2 = image(2, {
      decidedAt: 500,
      decisionOrdinal: 2,
      width: 1000,
      height: 1000,
      byteSize: 500_000,
    });
    const impEarly = importEntry('a', {
      plaintextSha256: '1'.repeat(64),
      createdAt: 500,
      width: 1000,
      height: 1000,
      byteSize: 500_000,
    });
    const impLate = importEntry('b', {
      plaintextSha256: '2'.repeat(64),
      createdAt: 500,
      width: 1000,
      height: 1000,
      byteSize: 500_000,
    });
    const legacy = importEntry('c', {
      plaintextSha256: '0'.repeat(64),
      origin: 'provider',
      sourceImageId: null,
      hasImportMembership: false,
      createdAt: 500,
      width: 1000,
      height: 1000,
      byteSize: 500_000,
    });

    const items = buildCollectionItems([img1, img2], [impLate, impEarly, legacy]);

    // On equal time=500:
    // - newest / resolution / fileSize: provider image (ordinal desc: 2 then 1), then import (digest asc: 11.. then 22..), then legacy (00..)
    for (const sort of ['newest', 'resolution', 'fileSize'] as CollectionSort[]) {
      expect(
        browseCollectionItems(items, {
          ...DEFAULT_COLLECTION_QUERY,
          sort,
        }).map((i) => i.key),
      ).toEqual([
        'image:2',
        'image:1',
        `import:${'1'.repeat(64)}`,
        `import:${'2'.repeat(64)}`,
        `legacy:${'0'.repeat(64)}`,
      ]);
    }

    // - oldest: provider image (ordinal asc: 1 then 2), then import (digest asc: 11.. then 22..), then legacy (00..)
    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        sort: 'oldest',
      }).map((i) => i.key),
    ).toEqual([
      'image:1',
      'image:2',
      `import:${'1'.repeat(64)}`,
      `import:${'2'.repeat(64)}`,
      `legacy:${'0'.repeat(64)}`,
    ]);

    // Verify strict total order (antisymmetry + transitivity) across all triples and sorts:
    for (const sort of ['newest', 'oldest', 'resolution', 'fileSize'] as CollectionSort[]) {
      for (const a of items) {
        expect(compareCollectionItems(a, a, sort)).toBe(0);
        for (const b of items) {
          const ab = Math.sign(compareCollectionItems(a, b, sort));
          const ba = Math.sign(compareCollectionItems(b, a, sort));
          expect(ab + ba).toBe(0);
          if (a.key !== b.key) expect(ab).not.toBe(0);
          for (const c of items) {
            const bc = Math.sign(compareCollectionItems(b, c, sort));
            const ac = Math.sign(compareCollectionItems(a, c, sort));
            if (ab < 0 && bc < 0) expect(ac).toBe(-1);
            if (ab > 0 && bc > 0) expect(ac).toBe(1);
          }
        }
      }
    }
  });

  test('content mode filtering and counts treat safe as SFW and both adult and unknown as NSFW', () => {
    const sfwProvider = image(1, { isNsfw: false });
    const nsfwProvider = image(2, { isNsfw: true, contentRating: 'explicit' });
    const safeImport = importEntry('safe-imp', { importClassification: 'safe' });
    const adultImport = importEntry('adult-imp', { importClassification: 'adult' });
    const unknownImport = importEntry('unknown-imp', { importClassification: 'unknown' });

    const items = buildCollectionItems(
      [sfwProvider, nsfwProvider],
      [safeImport, adultImport, unknownImport],
    );

    expect(
      countCollectionItemsByMode(items, DIRECT_DISTRIBUTION_POLICY),
    ).toEqual({
      mixed: 5,
      sfw: 2,
      nsfw: 3,
    });

    expect(
      filterCollectionItemsByMode(items, 'sfw', DIRECT_DISTRIBUTION_POLICY).map(
        (i) => i.key,
      ),
    ).toEqual(['image:1', `import:${safeImport.plaintextSha256}`]);

    expect(
      filterCollectionItemsByMode(items, 'nsfw', DIRECT_DISTRIBUTION_POLICY).map(
        (i) => i.key,
      ),
    ).toEqual([
      'image:2',
      `import:${adultImport.plaintextSha256}`,
      `import:${unknownImport.plaintextSha256}`,
    ]);

    // Store policy coerces to SFW only:
    expect(
      countCollectionItemsByMode(items, STORE_DISTRIBUTION_POLICY),
    ).toEqual({
      mixed: 2,
      sfw: 2,
      nsfw: 0,
    });
  });

  test('source options include imports (sorted after registryOrder on ties, kept at 0 when selected) and exclude legacy opaque fallbacks from 我的导入', () => {
    const danbooruImg = image(1, { providerKey: 'danbooru' });
    const safeImp = importEntry('imp-1', { importClassification: 'safe' });
    const legacyRow = importEntry('leg-1', {
      origin: 'provider',
      sourceImageId: null,
      hasImportMembership: false,
    });

    const items = buildCollectionItems([danbooruImg], [safeImp, legacyRow]);

    // Equal count=1 between danbooru and imports -> danbooru first, imports after registry sources;
    // 全部 equals items.length (3, including legacy fallback), and legacy does NOT increment imports.
    expect(collectionItemSourceOptions(items, 'all', registryOrder)).toEqual([
      { provider: 'all', count: 3 },
      { provider: 'danbooru', count: 1 },
      { provider: 'imports', count: 1 },
    ]);

    // When imports has higher count than providers, imports sorts ahead of lower-count providers:
    const twoImports = buildCollectionItems(
      [danbooruImg],
      [safeImp, importEntry('imp-2', { importClassification: 'adult' })],
    );
    expect(collectionItemSourceOptions(twoImports, 'all', registryOrder)).toEqual([
      { provider: 'all', count: 3 },
      { provider: 'imports', count: 2 },
      { provider: 'danbooru', count: 1 },
    ]);

    // Under non-empty search or SFW filter where imports count is 0, a selected 'imports' stays listed at 0:
    const onlyProvider = buildCollectionItems([danbooruImg], []);
    expect(collectionItemSourceOptions(onlyProvider, 'imports', registryOrder)).toEqual([
      { provider: 'all', count: 1 },
      { provider: 'danbooru', count: 1 },
      { provider: 'imports', count: 0 },
    ]);

    // Filtering by provider='imports' shows only import items, hiding provider saves and legacy fallback:
    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        provider: 'imports',
      }).map((i) => i.key),
    ).toEqual([`import:${safeImp.plaintextSha256}`]);

    // Filtering by a specific provider hides imports:
    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        provider: 'danbooru',
      }).map((i) => i.key),
    ).toEqual(['image:1']);
  });

  test('non-empty normalized search hides imports across all/artist/tag fields (including searching 我的导入), while whitespace-only keeps them', () => {
    const providerImg = image(1, {
      artistName: 'Mika Pikazo',
      tags: ['solo', '我的导入'],
    });
    const imp = importEntry('search-imp');
    const items = buildCollectionItems([providerImg], [imp]);

    // Whitespace-only acts as empty:
    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        text: '   \t  ',
      }).map((i) => i.key),
    ).toContain(`import:${imp.plaintextSha256}`);

    for (const field of ['all', 'artist', 'tag'] as CollectionSearchField[]) {
      expect(
        browseCollectionItems(items, {
          ...DEFAULT_COLLECTION_QUERY,
          text: 'mika',
          field,
        }).map((i) => i.key),
      ).not.toContain(`import:${imp.plaintextSha256}`);
    }

    // Searching "我的导入" does NOT match imports:
    expect(
      browseCollectionItems(items, {
        ...DEFAULT_COLLECTION_QUERY,
        text: '我的导入',
      }).map((i) => i.key),
    ).toEqual(['image:1']);
  });

  test('500-item mixed collection (400 provider saves + 100 imports) computes unified query, sort, mode counts, and source options within 25 ms and does 0 extra haystack normalizations on subsequent keystrokes', () => {
    const images500 = Array.from({ length: 400 }, (_, i) =>
      image(i + 1, {
        providerKey: i % 2 === 0 ? 'danbooru' : 'waifu_im',
        artistName: `Artist_${i % 25}`,
        tags: [`tag_${i % 50}`, 'genshin_impact', 'blue_archive'],
        decidedAt: 10_000 + i * 10,
        decisionOrdinal: i + 1,
        width: 1000 + (i % 10) * 100,
        height: 1500 + (i % 10) * 100,
        byteSize: 300_000 + i * 1_000,
        isNsfw: i % 3 === 0,
        contentRating: i % 3 === 0 ? 'explicit' : 'safe',
      }),
    );
    const imports100 = Array.from({ length: 100 }, (_, i) =>
      importEntry(`perf-imp-${String(i).padStart(4, '0')}`, {
        plaintextSha256: (i + 1).toString(16).padStart(64, 'a'),
        importClassification: i % 3 === 0 ? 'adult' : i % 3 === 1 ? 'safe' : 'unknown',
        createdAt: 10_005 + i * 40,
        width: 1200 + (i % 8) * 100,
        height: 1600 + (i % 8) * 100,
        byteSize: 400_000 + i * 2_000,
      }),
    );

    const allItems = buildCollectionItems(images500, imports100);
    expect(allItems).toHaveLength(500);

    // Warm up haystack cache on first keystroke:
    browseCollectionItems(
      allItems,
      { ...DEFAULT_COLLECTION_QUERY, text: 'a', field: 'all' },
      DIRECT_DISTRIBUTION_POLICY,
    );

    const normalizeSpy = jest.spyOn(String.prototype, 'normalize');
    try {
      normalizeSpy.mockClear();
      const start = performance.now();
      const searched = browseCollectionItems(
        allItems,
        { ...DEFAULT_COLLECTION_QUERY, text: 'artist_1', field: 'all', sort: 'resolution' },
        DIRECT_DISTRIBUTION_POLICY,
      );
      const visible = filterCollectionItemsByMode(searched, 'mixed', DIRECT_DISTRIBUTION_POLICY);
      const counts = countCollectionItemsByMode(searched, DIRECT_DISTRIBUTION_POLICY);
      const sources = collectionItemSourceOptions(allItems, 'all', registryOrder);
      const elapsedMs = performance.now() - start;

      expect(visible.length).toBeGreaterThan(0);
      expect(counts.mixed).toBe(visible.length);
      expect(sources.find((s) => s.provider === 'imports')?.count).toBe(100);
      // Only the query string itself is normalized on subsequent keystrokes (0 haystack re-normalizations):
      expect(normalizeSpy).toHaveBeenCalledTimes(1);
      expect(elapsedMs).toBeLessThanOrEqual(25);
    } finally {
      normalizeSpy.mockRestore();
    }
  });
});
