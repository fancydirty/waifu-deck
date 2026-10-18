import type { DistributionPolicy } from '@/features/distribution/distribution-policy';
import type { ProviderRoundOutcome } from '@/features/providers/provider-yield-ledger';
import type { ProviderCredential } from '@/features/providers/provider-credentials';
import type { ProviderRequestGovernor } from '@/features/providers/provider-resilience';
import type {
  ProviderCursor,
  ProviderSearchPage,
  SearchRequest,
} from '@/features/search/types';
import type { WaifuBatch } from '@/features/waifu/waifu-client';
import type {
  AppSettings,
  ImageProviderKey,
} from '@/features/waifu/types';

/**
 * 单源在一轮 discovery 中的记账元数据（G3 spec §4）。**只读附加**：它复述
 * fetcher 已经做过的决定，fetcher 自身不回读它——调度逐字节不变。G3b 只写不读，
 * 消费者是 G3c 的均衡器。
 */
export type DiscoveryProviderRound = {
  readonly providerKey: ImageProviderKey;
  /** 本轮分给该源的份额；被能力门跳过时为 0（它没有消耗份额）。 */
  readonly requested: number;
  /** 该源 batch 的 `totalCount`：引擎见到的原始帖数，客户端过滤前。 */
  readonly returned: number;
  /** 该源自身过滤后返回的候选数（跨源去重与合并上限之前）。 */
  readonly admitted: number;
  readonly outcome: ProviderRoundOutcome;
  /**
   * 非 `ok` 轮的**原因**，仅供诊断。均衡器与账本只看 `outcome`，绝不分支这两个
   * 字段（`ProviderYieldLedger` 亦不读）。
   *
   * `outcome` 只能说「这源没出货」，说不出它是压根没被问、被拒、超时，还是回了
   * 解析不了的东西——在设备上这几种在 SQLite 里长得一模一样，§6.5 的
   * 「konachan 贡献零卡」正是因此久诊不下：`providerFailure()` 已经算出原因，
   * `provider-client` 还用它区分 `cooldown` 与 `failed`，但除非**每个**源都失败
   * （只有全败路径抛 `DiscoveryProviderError`），这原因就被丢掉。8 源里 7 源正常
   * 时，唯一那个真原因从未离开函数。
   */
  readonly failureCode?: string;
  readonly failureStatus?: number;
};

/** discovery 一批候选的统一结果形态（结构等同各 client 的 *Batch）。 */
export type DiscoveryBatch = WaifuBatch & {
  /**
   * 本轮每个「已启用」源的记账元数据，含被能力门跳过者。可选：单源 adapter 直接
   * 返回自己的 `*Batch` 时不带该字段；只有聚合层 `provider-client` 会填充。
   */
  readonly providerRounds?: readonly DiscoveryProviderRound[];
};

/** 每源被排除的 provider item id（保持 provider-client 现有语义）。 */
export type ProviderExclusions = Partial<
  Record<ImageProviderKey, readonly string[]>
>;

/** 统一的 discovery 拉取入参；adapter 内部映射到各 client 的具体参数名。 */
export type DiscoveryFetchInput = {
  /** 已应用分发策略后的设置。 */
  settings: AppSettings;
  excludedProviderIds: ProviderExclusions;
  /**
   * 本轮分给该源的批量大小，由 `provider-client.ts` 的
   * `planProviderShares` 份额计划直接给出（G3c task2）。
   *
   * 曾经这里的值要先过一层 `adapter.discoveryBatchSize(context)` 钩子。
   * 该钩子在 G3b/S10 之后 8 个 adapter 全部退化成
   * `({ desiredPerProvider }) => desiredPerProvider`——恒等函数——而 G3c 的
   * 份额计划本来就是**逐源**的（它已经读了 `maxDiscoveryBatch` 做 cap、
   * 读了 `availabilityFor` 做权重）,所以按源覆写的接缝已经在计划里,钩子
   * 再无信息可加。故钩子与 `DiscoveryBatchSizeContext` 一并删除:
   * 份额直接落到本字段。
   */
  count: number;
  signal?: AbortSignal;
  distributionPolicy: DistributionPolicy;
  governor?: ProviderRequestGovernor;
  // G4 — per-user credential for a credentialed source (spec §2.2); injected per
  // call by provider-client from the secure-store map, absent for keyless
  // sources. Engines must never log it.
  credential?: ProviderCredential;
};

/** 所有源 cursor 的联合（每源运行时只见自己的形态）。 */
export type ProviderCursorValue = ProviderCursor[keyof ProviderCursor];

export type SearchFetchContext = {
  signal?: AbortSignal;
  governor?: ProviderRequestGovernor;
  credential?: ProviderCredential;
};

/**
 * 某源在当前设置下的能力可用性。声明式判定，零网络探测：
 * - `available`：正常参与 discovery 份额分配与请求。
 * - `degraded`：语料稀薄但仍参与（本刀不消费该状态做权重调整，G3c 才用）。
 * - `unavailable`：语料结构性无法满足当前设置（如 Konachan 无竖屏图），
 *   整体跳过——不发请求、不计入份额分母（G3a spec §2.1）。
 */
export type ProviderAvailability =
  | { state: 'available' }
  | { state: 'degraded'; reasonKey: string }
  | { state: 'unavailable'; reasonKey: string };

/**
 * 单个图源的统一契约。G1a 只覆盖 discovery/label/key；capabilities 由
 * G1c 扩展本接口。search/settingsSlug 由 G1b 覆盖。
 */
export interface ProviderAdapter {
  readonly key: ImageProviderKey;
  readonly label: string;
  /**
   * 该源每轮 discovery 的**声明**上限（G3 spec §2.2）。
   *
   * (a) G3c task2 起这是**生效的调度上限**：`provider-client.ts` 把它作为
   *     `planProviderShares` 的 `cap[k]`,份额永不超过它,补拉波也只打
   *     `cap − share > 0` 的源;
   * (b) 各引擎内部既有的 clamp（如 waifu min(20,…)、danbooru min(4,…)、
   *     e621/e926 min(2,…)）**原样保留**,现在是纵深防御而非策略。声明值可能
   *     **高于**引擎当前 clamp——例如 danbooru 这里声明 6,但
   *     `danbooru-client.ts` 的引擎 config 仍 clamp 到 4:计划可以给 danbooru
   *     6,引擎只会发 4 个子请求。这不是 bug,只是「声明上限尚未在引擎侧放开」;
   *     放开引擎 clamp 是独立的调度变更,不属于本刀。
   */
  readonly maxDiscoveryBatch: number;
  /** 拉一批 discovery 候选（封装该源的 excludedIds/参数名 quirk）。 */
  fetchDiscoveryBatch(input: DiscoveryFetchInput): Promise<DiscoveryBatch>;
  /** 该源在设置页/testID/i18n key 的短名（如 'waifu'、'nekos'）。 */
  readonly settingsSlug: string;
  /**
   * Redesign 2026-09-15: which group the source shows under on the 图片来源
   * sub-page. `general` = 综合动漫图站, `booru` = 标签图站, `furry` = 兽人图站.
   * Static — never read at fetch time, only by the settings sub-page.
   */
  readonly settingsGroup: 'general' | 'booru' | 'furry';
  /** 拉一页搜索结果；封装各 client 的 fetch<X>SearchPage 与其签名 quirk。 */
  fetchSearchPage(
    request: SearchRequest,
    cursor: ProviderCursorValue | undefined,
    context: SearchFetchContext,
  ): Promise<ProviderSearchPage>;
  /** 该源在当前设置下的能力可用性（声明式，不做网络探测）。 */
  availabilityFor(settings: AppSettings): ProviderAvailability;
  /**
   * R8.28 —— 取**该源图片字节**时必须附带的 HTTP 头（不是 API 请求头，与
   * credential 无关）。绝大多数源的图床直接放行，故本字段 `undefined`；只有
   * 防盗链的源才声明它。消费者是 `provider-image-source.ts`，它把这里的值搬到
   * expo-image 的 `ImageSource.headers` / `ImagePrefetchOptions.headers` 和
   * expo-file-system 下载任务的 `headers` 上。
   *
   * 未声明时下游产出的 source 对象**逐字节不变**（不会多出 `headers` 键），
   * 所以给一个源加防盗链头不会动到其它源的渲染路径。
   */
  readonly imageRequestHeaders?: Readonly<Record<string, string>>;
}
