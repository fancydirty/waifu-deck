import { fetchDanbooruBatch, fetchDanbooruSearchPage } from '@/features/danbooru/danbooru-client';
import { normalizeProviderTag } from '@/features/providers/candidate-filter';
import { fetchE621Batch, fetchE621SearchPage } from '@/features/e621/e621-client';
import { fetchE926Batch, fetchE926SearchPage } from '@/features/e926/e926-client';
import {
  fetchGelbooruBatch,
  fetchGelbooruSearchPage,
  GELBOORU_IMAGE_HEADERS,
} from '@/features/gelbooru/gelbooru-client';
import { fetchKonachanBatch, fetchKonachanSearchPage } from '@/features/konachan/konachan-client';
import { fetchNekosBatch, fetchNekosSearchPage } from '@/features/nekos/nekos-client';
import { fetchRule34Batch, fetchRule34SearchPage } from '@/features/rule34/rule34-client';
import { fetchSafebooruBatch, fetchSafebooruSearchPage } from '@/features/safebooru/safebooru-client';
import { fetchYandereBatch, fetchYandereSearchPage } from '@/features/yandere/yandere-client';
import { fetchWaifuBatch, fetchWaifuSearchPage } from '@/features/waifu/waifu-client';
import type { ProviderCursor } from '@/features/search/types';
import type { AppSettings, ImageProviderKey } from '@/features/waifu/types';

import type { ProviderAdapter, ProviderAvailability } from './provider-adapter';

/** Shared singleton for the common case — avoids re-allocating per call. */
const AVAILABLE: ProviderAvailability = Object.freeze({ state: 'available' });

/** 恒可用（不依赖设置）——5 个语料结构上不受 orientation/nsfwMode 限制的源共用。 */
function alwaysAvailable(): ProviderAvailability {
  return AVAILABLE;
}

/** R8.23 —— 屏蔽 furry 时 e621/e926 整体退出首页的判定。 */
const FURRY_BLOCKED: ProviderAvailability = Object.freeze({
  state: 'unavailable',
  reasonKey: 'furryBlocked',
});

/**
 * R8.23: e621/e926 官方作废了 `furry` 标签——整个语料都是兽人（200 帖 e926
 * 随机样本：88% anthro/feral/animal_humanoid，3% not_furry），所以 `-furry`
 * 和本地标签过滤在这两站都匹配不到东西。用户屏蔽 furry 时，正确做法是让这两
 * 站整体不参与首页，而不是发一个没用的 `-furry`。
 *
 * 只认字面 slug `furry`（与过滤器同一套归一化），不做 anthro/feral taxonomy
 * 扩展；搜索是按源发起的，不读 `availabilityFor`，因此不受影响。
 */
function blocksFurry(settings: AppSettings): boolean {
  return settings.excludedTags.some((tag) => normalizeProviderTag(tag) === 'furry');
}

function e926HasNoCorpusFor(mode: AppSettings['nsfwMode']): boolean {
  return mode === 'nsfw';
}

function konachanHasNoCorpusFor(mode: AppSettings['nsfwMode']): boolean {
  return mode === 'nsfw';
}

export type RegistryOverrides = {
  fetchWaifu?: typeof fetchWaifuBatch;
  fetchNekos?: typeof fetchNekosBatch;
  fetchDanbooru?: typeof fetchDanbooruBatch;
  fetchSafebooru?: typeof fetchSafebooruBatch;
  fetchYandere?: typeof fetchYandereBatch;
  fetchKonachan?: typeof fetchKonachanBatch;
  fetchE621?: typeof fetchE621Batch;
  fetchE926?: typeof fetchE926Batch;
  fetchGelbooru?: typeof fetchGelbooruBatch;
  fetchRule34?: typeof fetchRule34Batch;
  fetchWaifuSearch?: typeof fetchWaifuSearchPage;
  fetchNekosSearch?: typeof fetchNekosSearchPage;
  fetchDanbooruSearch?: typeof fetchDanbooruSearchPage;
  fetchSafebooruSearch?: typeof fetchSafebooruSearchPage;
  fetchYandereSearch?: typeof fetchYandereSearchPage;
  fetchKonachanSearch?: typeof fetchKonachanSearchPage;
  fetchE621Search?: typeof fetchE621SearchPage;
  fetchE926Search?: typeof fetchE926SearchPage;
  fetchGelbooruSearch?: typeof fetchGelbooruSearchPage;
  fetchRule34Search?: typeof fetchRule34SearchPage;
};

function createWaifuAdapter(
  deps: {
    fetchBatch?: typeof fetchWaifuBatch;
    fetchSearch?: typeof fetchWaifuSearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchWaifuBatch;
  const fetchSearch = deps.fetchSearch ?? fetchWaifuSearchPage;
  return {
    key: 'waifu_im',
    label: 'Waifu.im',
    settingsSlug: 'waifu',
    settingsGroup: 'general',
    maxDiscoveryBatch: 20,
    fetchDiscoveryBatch: ({
      settings,
      excludedProviderIds,
      count,
      signal,
      distributionPolicy,
      governor,
    }) => {
      const excludedIds = (excludedProviderIds.waifu_im ?? []).flatMap((id) => {
        const parsed = Number(id);
        return /^\d+$/.test(id) && Number.isSafeInteger(parsed) ? [parsed] : [];
      });
      return fetchBatch({
        settings,
        excludedIds,
        pageSize: count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
      });
    },
    fetchSearchPage: (request, cursor, { signal, governor }) =>
      fetchSearch({
        request,
        cursor: cursor as ProviderCursor['waifu_im'] | undefined,
        signal,
        governor,
      }),
    availabilityFor: alwaysAvailable,
  };
}

function createNekosAdapter(
  deps: {
    fetchBatch?: typeof fetchNekosBatch;
    fetchSearch?: typeof fetchNekosSearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchNekosBatch;
  const fetchSearch = deps.fetchSearch ?? fetchNekosSearchPage;
  return {
    key: 'nekos_api',
    label: 'Nekos API',
    settingsSlug: 'nekos',
    settingsGroup: 'general',
    maxDiscoveryBatch: 8,
    fetchDiscoveryBatch: ({
      settings,
      excludedProviderIds,
      count,
      signal,
      distributionPolicy,
      governor,
    }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.nekos_api ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor }) =>
      fetchSearch({
        request,
        cursor: cursor as ProviderCursor['nekos_api'] | undefined,
        signal,
        governor,
      }),
    availabilityFor: alwaysAvailable,
  };
}

function createDanbooruAdapter(
  deps: {
    fetchBatch?: typeof fetchDanbooruBatch;
    fetchSearch?: typeof fetchDanbooruSearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchDanbooruBatch;
  const fetchSearch = deps.fetchSearch ?? fetchDanbooruSearchPage;
  return {
    key: 'danbooru',
    label: 'Danbooru',
    settingsSlug: 'danbooru',
    settingsGroup: 'booru',
    // 声明 6 —— 份额计划可以给到 6,但 danbooru-client.ts 的引擎 config 仍
    // clamp 到 4,所以实际最多发 4 个子请求(见 provider-adapter.ts 的
    // maxDiscoveryBatch JSDoc)。放开引擎 clamp 是独立调度变更,本刀不做。
    maxDiscoveryBatch: 6,
    fetchDiscoveryBatch: ({
      settings,
      excludedProviderIds,
      count,
      signal,
      distributionPolicy,
      governor,
    }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.danbooru ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor }) =>
      fetchSearch({
        request,
        cursor: cursor as ProviderCursor['danbooru'] | undefined,
        signal,
        governor,
      }),
    availabilityFor: alwaysAvailable,
  };
}

function createSafebooruAdapter(
  deps: {
    fetchBatch?: typeof fetchSafebooruBatch;
    fetchSearch?: typeof fetchSafebooruSearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchSafebooruBatch;
  const fetchSearch = deps.fetchSearch ?? fetchSafebooruSearchPage;
  return {
    key: 'safebooru',
    label: 'Safebooru',
    settingsSlug: 'safebooru',
    settingsGroup: 'booru',
    maxDiscoveryBatch: 8,
    fetchDiscoveryBatch: ({
      settings,
      excludedProviderIds,
      count,
      signal,
      distributionPolicy,
      governor,
    }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.safebooru ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor }) =>
      fetchSearch({
        request,
        cursor: cursor as ProviderCursor['safebooru'] | undefined,
        signal,
        governor,
      }),
    // Board #19 D3 = B: under 仅 NSFW Safebooru is asked for
    // rating:questionable (a real corpus), so it is plainly available in
    // every mode — no longer `degraded`.
    availabilityFor: () => AVAILABLE,
  };
}

function createYandereAdapter(
  deps: {
    fetchBatch?: typeof fetchYandereBatch;
    fetchSearch?: typeof fetchYandereSearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchYandereBatch;
  const fetchSearch = deps.fetchSearch ?? fetchYandereSearchPage;
  return {
    key: 'yandere',
    label: 'Yande.re',
    settingsSlug: 'yandere',
    settingsGroup: 'booru',
    maxDiscoveryBatch: 12,
    fetchDiscoveryBatch: ({
      settings,
      excludedProviderIds,
      count,
      signal,
      distributionPolicy,
      governor,
    }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.yandere ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor }) =>
      fetchSearch({
        request,
        cursor: cursor as ProviderCursor['yandere'] | undefined,
        signal,
        governor,
      }),
    availabilityFor: alwaysAvailable,
  };
}

function createKonachanAdapter(
  deps: {
    fetchBatch?: typeof fetchKonachanBatch;
    fetchSearch?: typeof fetchKonachanSearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchKonachanBatch;
  const fetchSearch = deps.fetchSearch ?? fetchKonachanSearchPage;
  return {
    key: 'konachan',
    label: 'Konachan',
    settingsSlug: 'konachan',
    settingsGroup: 'booru',
    maxDiscoveryBatch: 12,
    fetchDiscoveryBatch: ({
      settings,
      excludedProviderIds,
      count,
      signal,
      distributionPolicy,
      governor,
    }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.konachan ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor }) => {
      if (konachanHasNoCorpusFor(request.nsfwMode)) {
        return Promise.resolve({
          providerKey: 'konachan' as const,
          items: [],
          nextCursor: null,
        });
      }
      return fetchSearch({
        request,
        cursor: cursor as ProviderCursor['konachan'] | undefined,
        signal,
        governor,
      });
    },
    // 探针证:konachan 竖屏波段（height:1200.. width:..1100）board 级 n=0——
    // 壁纸站语料结构性横图。竖屏设置下诚实跳过，不吃份额（G3a spec §2.1）。
    // 端点为 konachan.net（SFW 镜像）——konachan.com 被 Cloudflare 质询挡死 403，
    // 详见 konachan-client.ts。语料同源，横图属性不变。
    availabilityFor: (settings: AppSettings) => {
      if (settings.orientation === 'portrait') {
        return { state: 'unavailable', reasonKey: 'konachanNoPortrait' };
      }
      if (konachanHasNoCorpusFor(settings.nsfwMode)) {
        return { state: 'unavailable', reasonKey: 'konachanSfwOnly' };
      }
      return AVAILABLE;
    },
  };
}

function createE621Adapter(
  deps: {
    fetchBatch?: typeof fetchE621Batch;
    fetchSearch?: typeof fetchE621SearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchE621Batch;
  const fetchSearch = deps.fetchSearch ?? fetchE621SearchPage;
  return {
    key: 'e621',
    label: 'e621',
    settingsSlug: 'e621',
    settingsGroup: 'furry',
    // 声明 2 —— G3c task2 起本字段就是生效的调度上限:份额恒 ≤ 2,且两波
    // 相加也不会超过 2（补拉波的 cap 是**剩余** headroom）。注意不是「永不
    // 补拉」:只有 share 恰好等于 2 时 headroom 才为 0;源多时 base 可能只有
    // 1,那时 e621 有 1 的 headroom,是合法补拉目标。`e621-client.ts` 的
    // engine config `discoveryBatchSize: 2`（含 503 安全 rationale）保留为
    // 纵深防御。
    maxDiscoveryBatch: 2,
    fetchDiscoveryBatch: ({
      settings,
      excludedProviderIds,
      count,
      signal,
      distributionPolicy,
      governor,
    }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.e621 ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor }) =>
      fetchSearch({
        request,
        cursor: cursor as ProviderCursor['e621'] | undefined,
        signal,
        governor,
      }),
    // R8.23 —— 见 `blocksFurry`：屏蔽 furry 时整站退出首页。
    availabilityFor: (settings: AppSettings) =>
      blocksFurry(settings) ? FURRY_BLOCKED : AVAILABLE,
  };
}

function createE926Adapter(
  deps: {
    fetchBatch?: typeof fetchE926Batch;
    fetchSearch?: typeof fetchE926SearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchE926Batch;
  const fetchSearch = deps.fetchSearch ?? fetchE926SearchPage;
  return {
    key: 'e926',
    label: 'e926',
    settingsSlug: 'e926',
    settingsGroup: 'furry',
    // 声明 2 —— e926 与 e621 共享同一 `createE621FamilyConfig`
    // (`e621-client.ts`);同上,G3c task2 起本字段是生效的调度上限,那份
    // engine config 的 `discoveryBatchSize: 2` 保留为纵深防御。
    maxDiscoveryBatch: 2,
    fetchDiscoveryBatch: ({
      settings,
      excludedProviderIds,
      count,
      signal,
      distributionPolicy,
      governor,
    }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.e926 ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor }) => {
      if (e926HasNoCorpusFor(request.nsfwMode)) {
        return Promise.resolve({
          providerKey: 'e926' as const,
          items: [],
          nextCursor: null,
        });
      }
      return fetchSearch({
        request,
        cursor: cursor as ProviderCursor['e926'] | undefined,
        signal,
        governor,
      });
    },
    // e926 板只有 s（SFW）评级——nsfw 模式下语料为空，诚实跳过而非返回 0。
    // R8.23 —— 用户显式屏蔽 furry 比模式规则更能解释这次跳过，故先判它。
    availabilityFor: (settings: AppSettings) =>
      blocksFurry(settings)
        ? FURRY_BLOCKED
        : e926HasNoCorpusFor(settings.nsfwMode)
          ? { state: 'unavailable', reasonKey: 'e926SfwOnly' }
          : AVAILABLE,
  };
}

function createGelbooruAdapter(
  deps: {
    fetchBatch?: typeof fetchGelbooruBatch;
    fetchSearch?: typeof fetchGelbooruSearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchGelbooruBatch;
  const fetchSearch = deps.fetchSearch ?? fetchGelbooruSearchPage;
  return {
    key: 'gelbooru',
    label: 'Gelbooru',
    settingsSlug: 'gelbooru',
    settingsGroup: 'booru',
    maxDiscoveryBatch: 8,
    fetchDiscoveryBatch: ({ settings, excludedProviderIds, count, signal, distributionPolicy, governor, credential }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.gelbooru ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
        ...(credential ? { credential } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor, credential }) =>
      fetchSearch({
        request,
        cursor: cursor as ProviderCursor['gelbooru'] | undefined,
        signal,
        governor,
        ...(credential ? { credential } : {}),
      }),
    // Key↔enable coupling (G4 spec §2.2/§2.3): a keyless gelbooru is simply
    // providers.gelbooru=false → never admitted, so availability here only
    // reflects settings-level capability, same contract as every other source.
    availabilityFor: () => ({ state: 'available' }),
    // R8.28 —— Gelbooru 的图床有防盗链：不带 Referer 时
    // `img*.gelbooru.com/samples|images/…` 一律 302 到
    // `gelbooru.com/hotlink.php`（text/html），Glide 拿到 HTML 只报
    // `setDataSourceCallback failed`，卡片就永远停在底色上；带
    // `Referer: https://gelbooru.com/` 时同一 URL 返回 200 image/jpeg。
    // （2026-09-09 curl 实证；User-Agent 无关。Rule34 的 api-cdn.rule34.xxx
    // 不需要任何头，所以只有本源声明。）
    imageRequestHeaders: GELBOORU_IMAGE_HEADERS,
  };
}

// E3: live probes found no Rule34 posts for rating:general or rating:safe,
// so its corpus is empty whenever the app requests SFW-only results.
function rule34HasNoCorpusFor(mode: AppSettings['nsfwMode']): boolean {
  return mode === 'sfw';
}

function createRule34Adapter(
  deps: {
    fetchBatch?: typeof fetchRule34Batch;
    fetchSearch?: typeof fetchRule34SearchPage;
  } = {},
): ProviderAdapter {
  const fetchBatch = deps.fetchBatch ?? fetchRule34Batch;
  const fetchSearch = deps.fetchSearch ?? fetchRule34SearchPage;
  return {
    key: 'rule34',
    label: 'Rule34',
    settingsSlug: 'rule34',
    settingsGroup: 'booru',
    maxDiscoveryBatch: 8,
    fetchDiscoveryBatch: ({ settings, excludedProviderIds, count, signal, distributionPolicy, governor, credential }) =>
      fetchBatch({
        settings,
        excludedIds: excludedProviderIds.rule34 ?? [],
        count,
        signal,
        distributionPolicy,
        ...(governor ? { governor } : {}),
        ...(credential ? { credential } : {}),
      }),
    fetchSearchPage: (request, cursor, { signal, governor, credential }) => {
      if (rule34HasNoCorpusFor(request.nsfwMode)) {
        // Search is source-owned; Discover's other gates must not reach it (R8.23).
        return Promise.resolve({
          providerKey: 'rule34' as const,
          items: [],
          nextCursor: null,
        });
      }
      return fetchSearch({
        request,
        cursor: cursor as ProviderCursor['rule34'] | undefined,
        signal,
        governor,
        ...(credential ? { credential } : {}),
      });
    },
    // Rule34 has no SFW corpus: live probes returned zero posts for both
    // rating:general and rating:safe (E3, 2026-10-02). Skip it in SFW-only
    // Discover instead of spending a share on a source that cannot answer.
    // Key↔enable coupling still keeps a keyless rule34 out of admission.
    availabilityFor: (settings: AppSettings) =>
      rule34HasNoCorpusFor(settings.nsfwMode)
        ? { state: 'unavailable', reasonKey: 'rule34NsfwOnly' }
        : AVAILABLE,
  };
}

/** 唯一「列出所有源」的地方。加一个源 = 这里加一行工厂调用。 */
export function buildRegistry(
  overrides: RegistryOverrides = {},
): readonly ProviderAdapter[] {
  return [
    createWaifuAdapter({
      fetchBatch: overrides.fetchWaifu,
      fetchSearch: overrides.fetchWaifuSearch,
    }),
    createNekosAdapter({
      fetchBatch: overrides.fetchNekos,
      fetchSearch: overrides.fetchNekosSearch,
    }),
    createDanbooruAdapter({
      fetchBatch: overrides.fetchDanbooru,
      fetchSearch: overrides.fetchDanbooruSearch,
    }),
    createSafebooruAdapter({
      fetchBatch: overrides.fetchSafebooru,
      fetchSearch: overrides.fetchSafebooruSearch,
    }),
    createYandereAdapter({
      fetchBatch: overrides.fetchYandere,
      fetchSearch: overrides.fetchYandereSearch,
    }),
    createKonachanAdapter({
      fetchBatch: overrides.fetchKonachan,
      fetchSearch: overrides.fetchKonachanSearch,
    }),
    createE621Adapter({
      fetchBatch: overrides.fetchE621,
      fetchSearch: overrides.fetchE621Search,
    }),
    createE926Adapter({
      fetchBatch: overrides.fetchE926,
      fetchSearch: overrides.fetchE926Search,
    }),
    createGelbooruAdapter({
      fetchBatch: overrides.fetchGelbooru,
      fetchSearch: overrides.fetchGelbooruSearch,
    }),
    createRule34Adapter({
      fetchBatch: overrides.fetchRule34,
      fetchSearch: overrides.fetchRule34Search,
    }),
  ];
}

export const PROVIDER_REGISTRY: readonly ProviderAdapter[] = buildRegistry();

const REGISTRY_BY_KEY = new Map<ImageProviderKey, ProviderAdapter>(
  PROVIDER_REGISTRY.map((adapter) => [adapter.key, adapter]),
);

export function providerByKey(
  key: ImageProviderKey,
): ProviderAdapter | undefined {
  return REGISTRY_BY_KEY.get(key);
}
