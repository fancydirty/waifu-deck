import { APP_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { SearchRequest } from '@/features/search/types';
import { IMAGE_PROVIDER_ORDER, isImageProviderKey } from '@/features/waifu/types';
import type {
  AppSettings,
  ImageProviderKey,
  NsfwMode,
  Orientation,
} from '@/features/waifu/types';
import i18n, { translationResources } from '@/i18n';

import { providerLabel } from './provider-label';
import type { ProviderAvailability } from './provider-adapter';
import {
  PROVIDER_REGISTRY,
  buildRegistry,
  providerByKey,
} from './provider-registry';

const ALL_KEYS: ImageProviderKey[] = [
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
];

function settingsWith(overrides: Partial<AppSettings['providers']>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    providers: { ...DEFAULT_SETTINGS.providers, ...overrides },
  };
}

test('registry has exactly one adapter per provider key, in fan-out order', () => {
  expect(PROVIDER_REGISTRY.map((a) => a.key)).toEqual(ALL_KEYS);
  const keys = new Set(PROVIDER_REGISTRY.map((a) => a.key));
  expect(keys.size).toBe(PROVIDER_REGISTRY.length);
});

test('each adapter declares its settings sub-page group', () => {
  const groups = Object.fromEntries(PROVIDER_REGISTRY.map((a) => [a.key, a.settingsGroup]));
  expect(groups).toEqual({
    waifu_im: 'general',
    nekos_api: 'general',
    danbooru: 'booru',
    safebooru: 'booru',
    yandere: 'booru',
    konachan: 'booru',
    e621: 'furry',
    e926: 'furry',
    gelbooru: 'booru',
    rule34: 'booru',
  });
});

test('providerByKey resolves every key and returns undefined for unknown', () => {
  for (const key of ALL_KEYS) {
    expect(providerByKey(key)?.key).toBe(key);
  }
  expect(providerByKey('nope' as ImageProviderKey)).toBeUndefined();
});

test('labels match the legacy PROVIDER_LABELS values', () => {
  const expected: Record<ImageProviderKey, string> = {
    waifu_im: 'Waifu.im',
    nekos_api: 'Nekos API',
    danbooru: 'Danbooru',
    safebooru: 'Safebooru',
    yandere: 'Yande.re',
    konachan: 'Konachan',
    e621: 'e621',
    e926: 'e926',
    gelbooru: 'Gelbooru',
    rule34: 'Rule34',
  };
  for (const adapter of PROVIDER_REGISTRY) {
    expect(adapter.label).toBe(expected[adapter.key]);
  }
});

test('every adapter forwards the planned count verbatim to its client', () => {
  // Replaces the old `discoveryBatchSize always uses the provided
  // desiredPerProvider` test, which G3c task2 deleted along with the hook it
  // exercised: all 8 implementations had degenerated to the identity
  // `({ desiredPerProvider }) => desiredPerProvider`, and the share plan is
  // already per-source (it reads `maxDiscoveryBatch` and `availabilityFor`),
  // so the hook could add no information. What that deletion makes
  // load-bearing is stated here instead, and for all 8 sources rather than
  // one: nothing sits between the plan's share and the client's request, so
  // `provider-client.ts` asserting a per-adapter count is asserting the real
  // outbound width. Waifu.im renames the field to `pageSize`; everyone else
  // keeps `count`.
  const calls: { key: ImageProviderKey; seen: jest.Mock }[] = [];
  const batch = () => jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchWaifu = batch();
  const fetchNekos = batch();
  const fetchDanbooru = batch();
  const fetchSafebooru = batch();
  const fetchYandere = batch();
  const fetchKonachan = batch();
  const fetchE621 = batch();
  const fetchE926 = batch();
  const registry = buildRegistry({
    fetchWaifu, fetchNekos, fetchDanbooru, fetchSafebooru,
    fetchYandere, fetchKonachan, fetchE621, fetchE926,
  });
  calls.push(
    { key: 'waifu_im', seen: fetchWaifu },
    { key: 'nekos_api', seen: fetchNekos },
    { key: 'danbooru', seen: fetchDanbooru },
    { key: 'safebooru', seen: fetchSafebooru },
    { key: 'yandere', seen: fetchYandere },
    { key: 'konachan', seen: fetchKonachan },
    { key: 'e621', seen: fetchE621 },
    { key: 'e926', seen: fetchE926 },
  );

  return Promise.all(calls.map(async ({ key, seen }, index) => {
    const adapter = registry.find((a) => a.key === key)!;
    // A different count per source, so a mixed-up wiring cannot pass.
    const count = index + 2;
    await adapter.fetchDiscoveryBatch({
      settings: settingsWith({}),
      excludedProviderIds: {},
      count,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining(
      key === 'waifu_im' ? { pageSize: count } : { count },
    ));
  }));
});

test('every registry adapter declares maxDiscoveryBatch per G3 spec §2.2', () => {
  const expected: Record<ImageProviderKey, number> = {
    waifu_im: 20,
    nekos_api: 8,
    safebooru: 8,
    yandere: 12,
    konachan: 12,
    danbooru: 6,
    e621: 2,
    e926: 2,
    gelbooru: 8,
    rule34: 8,
  };
  for (const adapter of PROVIDER_REGISTRY) {
    expect(adapter.maxDiscoveryBatch).toBe(expected[adapter.key]);
  }
});

test('buildRegistry threads an injected fetchBatch into the adapter', async () => {
  const fetchBatch = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const registry = buildRegistry({ fetchDanbooru: fetchBatch });
  const danbooru = registry.find((a) => a.key === 'danbooru')!;
  await danbooru.fetchDiscoveryBatch({
    settings: settingsWith({}),
    excludedProviderIds: {},
    count: 4,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(fetchBatch).toHaveBeenCalledTimes(1);
});

test('waifu_im adapter parses excludedIds to numbers and renames count to pageSize', async () => {
  const fetchBatch = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const registry = buildRegistry({ fetchWaifu: fetchBatch });
  const waifu = registry.find((a) => a.key === 'waifu_im')!;
  await waifu.fetchDiscoveryBatch({
    settings: settingsWith({}),
    excludedProviderIds: { waifu_im: ['12', 'abc', '34'] },
    count: 9,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(fetchBatch).toHaveBeenCalledTimes(1);
  expect(fetchBatch).toHaveBeenCalledWith(
    expect.objectContaining({ excludedIds: [12, 34], pageSize: 9 }),
  );
});

test('providerLabel matches registry labels for every key', () => {
  for (const adapter of PROVIDER_REGISTRY) {
    expect(providerLabel(adapter.key)).toBe(adapter.label);
  }
});

test('every adapter exposes a settingsSlug matching the legacy testID slug', () => {
  const expected: Record<ImageProviderKey, string> = {
    waifu_im: 'waifu',
    nekos_api: 'nekos',
    danbooru: 'danbooru',
    safebooru: 'safebooru',
    yandere: 'yandere',
    konachan: 'konachan',
    e621: 'e621',
    e926: 'e926',
    gelbooru: 'gelbooru',
    rule34: 'rule34',
  };
  for (const adapter of PROVIDER_REGISTRY) {
    expect(adapter.settingsSlug).toBe(expected[adapter.key]);
  }
});

function settingsWithFilters(
  overrides: Partial<Pick<AppSettings, 'orientation' | 'nsfwMode' | 'excludedTags'>>,
): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

type FurryBlock = 'off' | 'on';

const AVAILABLE_EXPECTATION = { state: 'available' } as const;
const FURRY_BLOCKED_EXPECTATION = { state: 'unavailable', reasonKey: 'furryBlocked' } as const;
const E926_SFW_ONLY_EXPECTATION = { state: 'unavailable', reasonKey: 'e926SfwOnly' } as const;
const KONACHAN_NO_PORTRAIT_EXPECTATION = { state: 'unavailable', reasonKey: 'konachanNoPortrait' } as const;
const KONACHAN_SFW_ONLY_EXPECTATION = { state: 'unavailable', reasonKey: 'konachanSfwOnly' } as const;
const RULE34_NSFW_ONLY_EXPECTATION = { state: 'unavailable', reasonKey: 'rule34NsfwOnly' } as const;

const AVAILABILITY_EXPECTATIONS: Record<
  ImageProviderKey,
  Record<NsfwMode, Record<FurryBlock, Record<Orientation, ProviderAvailability>>>
> = {
  waifu_im: {
    sfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    nsfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
  },
  nekos_api: {
    sfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    nsfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
  },
  danbooru: {
    sfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    nsfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
  },
  safebooru: {
    sfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    nsfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
  },
  yandere: {
    sfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    nsfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
  },
  konachan: {
    sfw: {
      off: { portrait: KONACHAN_NO_PORTRAIT_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: KONACHAN_NO_PORTRAIT_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    mixed: {
      off: { portrait: KONACHAN_NO_PORTRAIT_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: KONACHAN_NO_PORTRAIT_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    nsfw: {
      off: { portrait: KONACHAN_NO_PORTRAIT_EXPECTATION, landscape: KONACHAN_SFW_ONLY_EXPECTATION, any: KONACHAN_SFW_ONLY_EXPECTATION },
      on: { portrait: KONACHAN_NO_PORTRAIT_EXPECTATION, landscape: KONACHAN_SFW_ONLY_EXPECTATION, any: KONACHAN_SFW_ONLY_EXPECTATION },
    },
  },
  e621: {
    sfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: FURRY_BLOCKED_EXPECTATION, landscape: FURRY_BLOCKED_EXPECTATION, any: FURRY_BLOCKED_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: FURRY_BLOCKED_EXPECTATION, landscape: FURRY_BLOCKED_EXPECTATION, any: FURRY_BLOCKED_EXPECTATION },
    },
    nsfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: FURRY_BLOCKED_EXPECTATION, landscape: FURRY_BLOCKED_EXPECTATION, any: FURRY_BLOCKED_EXPECTATION },
    },
  },
  e926: {
    sfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: FURRY_BLOCKED_EXPECTATION, landscape: FURRY_BLOCKED_EXPECTATION, any: FURRY_BLOCKED_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: FURRY_BLOCKED_EXPECTATION, landscape: FURRY_BLOCKED_EXPECTATION, any: FURRY_BLOCKED_EXPECTATION },
    },
    nsfw: {
      off: { portrait: E926_SFW_ONLY_EXPECTATION, landscape: E926_SFW_ONLY_EXPECTATION, any: E926_SFW_ONLY_EXPECTATION },
      on: { portrait: FURRY_BLOCKED_EXPECTATION, landscape: FURRY_BLOCKED_EXPECTATION, any: FURRY_BLOCKED_EXPECTATION },
    },
  },
  gelbooru: {
    sfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    nsfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
  },
  rule34: {
    sfw: {
      off: { portrait: RULE34_NSFW_ONLY_EXPECTATION, landscape: RULE34_NSFW_ONLY_EXPECTATION, any: RULE34_NSFW_ONLY_EXPECTATION },
      on: { portrait: RULE34_NSFW_ONLY_EXPECTATION, landscape: RULE34_NSFW_ONLY_EXPECTATION, any: RULE34_NSFW_ONLY_EXPECTATION },
    },
    mixed: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
    nsfw: {
      off: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
      on: { portrait: AVAILABLE_EXPECTATION, landscape: AVAILABLE_EXPECTATION, any: AVAILABLE_EXPECTATION },
    },
  },
};

test("availabilityFor matches today's result for every source × content mode × furry block × orientation", () => {
  expect(Object.keys(AVAILABILITY_EXPECTATIONS).sort()).toEqual(
    PROVIDER_REGISTRY.map((adapter) => adapter.key).sort(),
  );

  const modes: NsfwMode[] = ['sfw', 'mixed', 'nsfw'];
  const furryBlocks: { key: FurryBlock; excludedTags: string[] }[] = [
    { key: 'off', excludedTags: [] },
    { key: 'on', excludedTags: ['furry'] },
  ];
  const orientations: Orientation[] = ['portrait', 'landscape', 'any'];

  for (const adapter of PROVIDER_REGISTRY) {
    for (const nsfwMode of modes) {
      for (const furryBlock of furryBlocks) {
        for (const orientation of orientations) {
          expect(adapter.availabilityFor(settingsWithFilters({
            nsfwMode,
            orientation,
            excludedTags: furryBlock.excludedTags,
          }))).toEqual(
            AVAILABILITY_EXPECTATIONS[adapter.key][nsfwMode][furryBlock.key][orientation],
          );
        }
      }
    }
  }
});

describe('availabilityFor (G3a capability-aware admission)', () => {
  const ALWAYS_AVAILABLE_KEYS: ImageProviderKey[] = [
    'waifu_im',
    'nekos_api',
    'danbooru',
    'yandere',
    'e621',
  ];

  test('the 5 structurally-unconstrained adapters are always available', () => {
    const combos: AppSettings[] = [
      settingsWithFilters({ orientation: 'portrait', nsfwMode: 'sfw' }),
      settingsWithFilters({ orientation: 'portrait', nsfwMode: 'mixed' }),
      settingsWithFilters({ orientation: 'portrait', nsfwMode: 'nsfw' }),
      settingsWithFilters({ orientation: 'landscape', nsfwMode: 'sfw' }),
      settingsWithFilters({ orientation: 'landscape', nsfwMode: 'nsfw' }),
      settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw' }),
      settingsWithFilters({ orientation: 'any', nsfwMode: 'nsfw' }),
    ];
    for (const key of ALWAYS_AVAILABLE_KEYS) {
      const adapter = providerByKey(key)!;
      for (const settings of combos) {
        expect(adapter.availabilityFor(settings)).toEqual({ state: 'available' });
      }
    }
  });

  test('konachan is unavailable under portrait and nsfw, available under landscape/any sfw', () => {
    const konachan = providerByKey('konachan')!;
    expect(konachan.availabilityFor(settingsWithFilters({ orientation: 'portrait', nsfwMode: 'sfw' })))
      .toEqual({ state: 'unavailable', reasonKey: 'konachanNoPortrait' });
    expect(konachan.availabilityFor(settingsWithFilters({ orientation: 'landscape', nsfwMode: 'sfw' })))
      .toEqual({ state: 'available' });
    expect(konachan.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw' })))
      .toEqual({ state: 'available' });
    expect(konachan.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'nsfw' })))
      .toEqual({ state: 'unavailable', reasonKey: 'konachanSfwOnly' });
    // Portrait takes the existing orientation-specific reason, even in nsfw mode.
    expect(konachan.availabilityFor(settingsWithFilters({ orientation: 'portrait', nsfwMode: 'nsfw' })))
      .toEqual({ state: 'unavailable', reasonKey: 'konachanNoPortrait' });
    for (const nsfwMode of ['sfw', 'mixed', 'nsfw'] as const) {
      expect(konachan.availabilityFor(settingsWithFilters({ orientation: 'portrait', nsfwMode })))
        .toEqual({ state: 'unavailable', reasonKey: 'konachanNoPortrait' });
      for (const orientation of ['landscape', 'any'] as const) {
        expect(konachan.availabilityFor(settingsWithFilters({ orientation, nsfwMode })))
          .toEqual(nsfwMode === 'nsfw'
            ? { state: 'unavailable', reasonKey: 'konachanSfwOnly' }
            : { state: 'available' });
      }
    }
  });

  test('e926 is unavailable under nsfw, available under sfw/mixed', () => {
    const e926 = providerByKey('e926')!;
    expect(e926.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'nsfw' })))
      .toEqual({ state: 'unavailable', reasonKey: 'e926SfwOnly' });
    expect(e926.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw' })))
      .toEqual({ state: 'available' });
    expect(e926.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'mixed' })))
      .toEqual({ state: 'available' });
    // nsfwMode is the only trigger — orientation shouldn't change the verdict.
    expect(e926.availabilityFor(settingsWithFilters({ orientation: 'portrait', nsfwMode: 'nsfw' })))
      .toEqual({ state: 'unavailable', reasonKey: 'e926SfwOnly' });
    for (const nsfwMode of ['sfw', 'mixed', 'nsfw'] as const) {
      expect(e926.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode, excludedTags: ['furry'] })))
        .toEqual({ state: 'unavailable', reasonKey: 'furryBlocked' });
      expect(e926.availabilityFor(settingsWithFilters({ orientation: 'portrait', nsfwMode })))
        .toEqual(nsfwMode === 'nsfw'
          ? { state: 'unavailable', reasonKey: 'e926SfwOnly' }
          : { state: 'available' });
    }
  });

  test('Rule34 is unavailable in 仅 SFW and available in 混合 and 仅 NSFW', () => {
    const rule34 = providerByKey('rule34')!;
    expect(rule34.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw' })))
      .toEqual({ state: 'unavailable', reasonKey: 'rule34NsfwOnly' });
    expect(rule34.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'mixed' })))
      .toEqual({ state: 'available' });
    expect(rule34.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'nsfw' })))
      .toEqual({ state: 'available' });
  });

  test('e621 and e926 sit out of Discover when furry is a blocked tag (R8.23)', () => {
    // Owner ruling 2026-09-09: e621/e926 officially invalidated the `furry`
    // tag because the whole corpus is furry (200-post random e926 sample: 88%
    // anthro/feral/animal_humanoid, 3% not_furry), so `-furry` and the local
    // tag filter both match nothing there. Blocking `furry` therefore means
    // sitting these two sources out of Discover, not sending a useless
    // negation.
    const blocked = settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw', excludedTags: ['furry'] });
    expect(providerByKey('e621')!.availabilityFor(blocked))
      .toEqual({ state: 'unavailable', reasonKey: 'furryBlocked' });
    expect(providerByKey('e926')!.availabilityFor(blocked))
      .toEqual({ state: 'unavailable', reasonKey: 'furryBlocked' });
    // Only the literal slug, normalized the same way the filter normalizes it.
    expect(providerByKey('e621')!.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw', excludedTags: ['Furry'] })))
      .toEqual({ state: 'unavailable', reasonKey: 'furryBlocked' });
    expect(providerByKey('e621')!.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw', excludedTags: ['maid'] })))
      .toEqual({ state: 'available' });
    // A blocked tag among others still triggers the skip.
    expect(providerByKey('e621')!.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw', excludedTags: ['maid', 'furry'] })))
      .toEqual({ state: 'unavailable', reasonKey: 'furryBlocked' });

    // STOP LINE (plan 2026-09-09-r823): the trigger is the literal slug
    // `furry`, never a substring of it and never a furry-adjacent taxonomy.
    // `isBlockableTagSlug` accepts any `^[a-z0-9]+([-_][a-z0-9]+)*$`, so a
    // user really can block `not_furry` (a real e621 tag), `furry_only`, or
    // `anti-furry`; a substring test (`.includes('furry')`) would silently
    // drop e621 AND e926 out of Discover for every one of them. `anthro` /
    // `feral` are the taxonomy expansion the ruling explicitly rejected.
    const NON_TRIGGERS = ['not_furry', 'furry_only', 'anti-furry', 'furryfied', 'anthro', 'feral'] as const;
    for (const tag of NON_TRIGGERS) {
      const onlyThatTag = settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw', excludedTags: [tag] });
      expect([tag, providerByKey('e621')!.availabilityFor(onlyThatTag)])
        .toEqual([tag, { state: 'available' }]);
      expect([tag, providerByKey('e926')!.availabilityFor(onlyThatTag)])
        .toEqual([tag, { state: 'available' }]);
    }
    // Other sources keep their own verdicts — furry is a real tag there and -furry works.
    // Asserted on the whole verdict rather than `.reasonKey` (which the
    // `available` union member does not carry), so an `available` source is
    // still checked instead of narrowed out of the assertion.
    for (const key of ['danbooru', 'safebooru', 'yandere', 'konachan', 'waifu_im', 'nekos_api'] as const) {
      const adapter = providerByKey(key);
      if (adapter) {
        expect(adapter.availabilityFor(blocked))
          .not.toEqual(expect.objectContaining({ reasonKey: 'furryBlocked' }));
      }
    }
  });

  test('safebooru is available under every nsfw mode (board #19 D3 = B: questionable under nsfw)', () => {
    const safebooru = providerByKey('safebooru')!;
    expect(safebooru.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'nsfw' })))
      .toEqual({ state: 'available' });
    expect(safebooru.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'sfw' })))
      .toEqual({ state: 'available' });
    expect(safebooru.availabilityFor(settingsWithFilters({ orientation: 'any', nsfwMode: 'mixed' })))
      .toEqual({ state: 'available' });
  });

  test('every registry adapter declares availabilityFor as a function', () => {
    for (const adapter of PROVIDER_REGISTRY) {
      expect(typeof adapter.availabilityFor).toBe('function');
    }
  });

  test('rendered unavailable reasonKeys resolve to real copy in all 4 locales', () => {
    // settings-screen.tsx only renders a note for `state === 'unavailable'`
    // (`t(\`settings.provider.${reasonKey}\`)`), so only those reasonKeys need
    // copy today. No source produces a `degraded` reasonKey any more; add
    // one to this list if a future cut renders degraded notes, so a raw-key
    // leak can't ship silently.
    const RENDERED_REASON_KEYS = ['konachanNoPortrait', 'konachanSfwOnly', 'e926SfwOnly', 'furryBlocked', 'rule34NsfwOnly'] as const;
    const languages = Object.keys(translationResources) as (keyof typeof translationResources)[];
    for (const reasonKey of RENDERED_REASON_KEYS) {
      const key = `settings.provider.${reasonKey}`;
      for (const language of languages) {
        expect(i18n.exists(key, { lng: language })).toBe(true);
        expect(i18n.t(key, { lng: language })).not.toBe(key);
      }
    }
  });
});

test('fetchSearchPage delegates to the injected client search fetcher and returns its page', async () => {
  const page = {
    providerKey: 'danbooru' as const,
    items: [],
    nextCursor: { beforeId: 42 },
  };
  const fetchSearch = jest.fn(async () => page);
  const registry = buildRegistry({ fetchDanbooruSearch: fetchSearch });
  const danbooru = registry.find((a) => a.key === 'danbooru')!;
  const request = { tags: ['catgirl'], excludedTags: [], nsfwMode: 'sfw', orientation: 'any', animationMode: 'include', minWidth: 0, maxBytes: 0 } as SearchRequest;
  const result = await danbooru.fetchSearchPage(request, { beforeId: 7 }, {});
  expect(fetchSearch).toHaveBeenCalledTimes(1);
  expect(result).toBe(page);
});

test("Rule34's search page in 仅 SFW is empty and exhausted without a request", async () => {
  const page = { providerKey: 'rule34' as const, items: [], nextCursor: null };
  const fetchSearch = jest.fn(async (..._args: unknown[]) => page);
  const registry = buildRegistry({ fetchRule34Search: fetchSearch });
  const rule34 = registry.find((adapter) => adapter.key === 'rule34')!;
  const request: SearchRequest = {
    tags: ['catgirl'],
    excludedTags: [],
    nsfwMode: 'sfw',
    orientation: 'any',
    animationMode: 'include',
    minWidth: 0,
    maxBytes: 0,
  };

  await expect(rule34.fetchSearchPage(request, undefined, {})).resolves.toEqual(page);
  expect(fetchSearch).not.toHaveBeenCalled();
});

test("Rule34's search page in 混合 asks the host", async () => {
  const page = { providerKey: 'rule34' as const, items: [], nextCursor: null };
  const fetchSearch = jest.fn(async (..._args: unknown[]) => page);
  const registry = buildRegistry({ fetchRule34Search: fetchSearch });
  const rule34 = registry.find((adapter) => adapter.key === 'rule34')!;
  const request: SearchRequest = {
    tags: ['catgirl'],
    excludedTags: [],
    nsfwMode: 'mixed',
    orientation: 'any',
    animationMode: 'include',
    minWidth: 0,
    maxBytes: 0,
  };

  await expect(rule34.fetchSearchPage(request, undefined, {})).resolves.toEqual(page);
  expect(fetchSearch).toHaveBeenCalledTimes(1);
  expect(fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ request }));
});

test("e926's search page in 仅 NSFW is empty and exhausted without a request", async () => {
  const page = { providerKey: 'e926' as const, items: [], nextCursor: null };
  const fetchSearch = jest.fn(async (..._args: unknown[]) => page);
  const registry = buildRegistry({ fetchE926Search: fetchSearch });
  const e926 = registry.find((adapter) => adapter.key === 'e926')!;
  const request: SearchRequest = {
    tags: ['catgirl'],
    excludedTags: [],
    nsfwMode: 'nsfw',
    orientation: 'any',
    animationMode: 'include',
    minWidth: 0,
    maxBytes: 0,
  };

  await expect(e926.fetchSearchPage(request, undefined, {})).resolves.toEqual(page);
  expect(fetchSearch).not.toHaveBeenCalled();
});

test("Konachan's search page in 仅 NSFW is empty and exhausted without a request", async () => {
  const page = { providerKey: 'konachan' as const, items: [], nextCursor: null };
  const fetchSearch = jest.fn(async (..._args: unknown[]) => page);
  const registry = buildRegistry({ fetchKonachanSearch: fetchSearch });
  const konachan = registry.find((adapter) => adapter.key === 'konachan')!;
  const request: SearchRequest = {
    tags: ['catgirl'],
    excludedTags: [],
    nsfwMode: 'nsfw',
    orientation: 'any',
    animationMode: 'include',
    minWidth: 0,
    maxBytes: 0,
  };

  await expect(konachan.fetchSearchPage(request, undefined, {})).resolves.toEqual(page);
  expect(fetchSearch).not.toHaveBeenCalled();
});

test('IMAGE_PROVIDER_ORDER matches PROVIDER_REGISTRY order (§3.3 tie-break source)', () => {
  // candidate-dedupe takes the provider order as an injected array (it cannot
  // import the registry — that would be a cycle). This pins the leaf array to the
  // registry so the dupe-survivor tie-break never silently diverges.
  const registryKeys = PROVIDER_REGISTRY.map((adapter) => adapter.key);
  expect(IMAGE_PROVIDER_ORDER).toEqual(registryKeys);
});

test('gelbooru is a registered provider key and disabled by default', () => {
  expect(isImageProviderKey('gelbooru')).toBe(true);
  expect(DEFAULT_SETTINGS.providers.gelbooru).toBe(false);
});

test('rule34 is a registered provider key, ordered last, disabled by default', () => {
  expect(isImageProviderKey('rule34')).toBe(true);
  expect(IMAGE_PROVIDER_ORDER[IMAGE_PROVIDER_ORDER.length - 1]).toBe('rule34');
  expect(DEFAULT_SETTINGS.providers.rule34).toBe(false);
});

test('R8.28: only gelbooru declares imageRequestHeaders, and it is the Referer', () => {
  // img*.gelbooru.com answers 302 → gelbooru.com/hotlink.php (HTML) without it.
  const withHeaders = PROVIDER_REGISTRY.filter((a) => a.imageRequestHeaders !== undefined);
  expect(withHeaders.map((a) => a.key)).toEqual(['gelbooru']);
  expect(withHeaders[0].imageRequestHeaders).toEqual({ Referer: 'https://gelbooru.com/' });
});
