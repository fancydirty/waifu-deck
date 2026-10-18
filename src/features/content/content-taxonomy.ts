import type {
  ContentRating,
  ImageCandidate,
  ImageProviderKey,
  NsfwMode,
} from '@/features/waifu/types';

export type ContentTagDefinition = {
  slug: string;
  label: string;
  aliases: readonly string[];
  providerTags: Partial<Record<ImageProviderKey, string>>;
};

export const CONTENT_TAGS: readonly ContentTagDefinition[] = [
  {
    slug: 'girl',
    label: '女性角色',
    aliases: ['girl', '1girl', '女孩', '女生', '少女'],
    providerTags: { waifu_im: 'waifu', nekos_api: 'Girl', danbooru: '1girl', e621: '1girl', e926: '1girl', safebooru: '1girl' },
  },
  {
    slug: 'solo',
    label: '单人',
    aliases: ['solo', 'single character', '单人', '单角色'],
    providerTags: { waifu_im: 'solo', nekos_api: 'Solo', danbooru: 'solo', e621: 'solo', e926: 'solo', safebooru: 'solo' },
  },
  {
    slug: 'maid',
    label: '女仆',
    aliases: ['maid', '女仆', '女仆装'],
    providerTags: { waifu_im: 'maid', nekos_api: 'Maid', danbooru: 'maid', e621: 'maid', e926: 'maid', safebooru: 'maid' },
  },
  {
    slug: 'school_uniform',
    label: '校服',
    aliases: ['school uniform', 'school_uniform', 'uniform', '制服', '校服'],
    providerTags: {
      waifu_im: 'uniform',
      nekos_api: 'School Uniform',
      danbooru: 'school_uniform', e621: 'school_uniform', e926: 'school_uniform',
      safebooru: 'school_uniform',
    },
  },
  {
    slug: 'catgirl',
    label: '猫娘',
    aliases: ['catgirl', 'cat girl', 'cat_girl', '猫娘', '猫耳'],
    providerTags: { nekos_api: 'Catgirl', danbooru: 'cat_girl', e621: 'cat_girl', e926: 'cat_girl', safebooru: 'cat_girl' },
  },
  {
    slug: 'bikini',
    label: '比基尼',
    aliases: ['bikini', '泳装', '比基尼'],
    providerTags: { nekos_api: 'Bikini', danbooru: 'bikini', e621: 'bikini', e926: 'bikini', safebooru: 'bikini' },
  },
  {
    slug: 'dress',
    label: '连衣裙',
    aliases: ['dress', '连衣裙', '裙装'],
    providerTags: { nekos_api: 'Dress', danbooru: 'dress', e621: 'dress', e926: 'dress', safebooru: 'dress' },
  },
  {
    slug: 'glasses',
    label: '眼镜',
    aliases: ['glasses', '眼镜'],
    providerTags: { nekos_api: 'Glasses', danbooru: 'glasses', e621: 'glasses', e926: 'glasses', safebooru: 'glasses' },
  },
  {
    slug: 'weapon',
    label: '武器',
    aliases: ['weapon', 'weapons', '武器'],
    providerTags: { nekos_api: 'Weapon', danbooru: 'weapon', e621: 'weapon', e926: 'weapon', safebooru: 'weapon' },
  },
  {
    slug: 'beach',
    label: '海边',
    aliases: ['beach', '海边', '沙滩'],
    providerTags: { nekos_api: 'Beach', danbooru: 'beach', e621: 'beach', e926: 'beach', safebooru: 'beach' },
  },
  {
    slug: 'yuri',
    label: '百合',
    aliases: ['yuri', '百合'],
    providerTags: { nekos_api: 'Yuri', danbooru: 'yuri', e621: 'yuri', e926: 'yuri', safebooru: 'yuri' },
  },
  {
    slug: 'large_breasts',
    label: '巨乳',
    aliases: ['large breasts', 'large_breasts', 'oppai', '巨乳'],
    providerTags: {
      waifu_im: 'oppai',
      nekos_api: 'Large breasts',
      danbooru: 'large_breasts', e621: 'large_breasts', e926: 'large_breasts',
      safebooru: 'large_breasts',
    },
  },
  ...([
    ['black_hair', '黑发', 'Black hair'],
    ['blonde_hair', '金发', 'Blonde hair'],
    ['blue_hair', '蓝发', 'Blue Hair'],
    ['brown_hair', '棕发', 'Brown Hair'],
    ['pink_hair', '粉发', 'Pink hair'],
    ['purple_hair', '紫发', 'Purple hair'],
    ['red_hair', '红发', 'Red hair'],
    ['white_hair', '白发', 'White hair'],
  ] as const).map(([slug, label, nekosTag]) => ({
    slug,
    label,
    aliases: [slug, slug.replace(/_/g, ' '), label],
    providerTags: { nekos_api: nekosTag, danbooru: slug, e621: slug, e926: slug, safebooru: slug },
  })),
  {
    slug: 'genshin_impact',
    label: '原神',
    aliases: ['genshin impact', 'genshin_impact', '原神'],
    providerTags: { waifu_im: 'genshin-impact', danbooru: 'genshin_impact', e621: 'genshin_impact', e926: 'genshin_impact', safebooru: 'genshin_impact' },
  },
  {
    slug: 'raiden_shogun',
    label: '雷电将军',
    aliases: ['raiden shogun', 'raiden_shogun', '雷电将军', '雷神'],
    providerTags: { waifu_im: 'raiden-shogun', danbooru: 'raiden_shogun', e621: 'raiden_shogun', e926: 'raiden_shogun', safebooru: 'raiden_shogun' },
  },
  {
    slug: 'rem_re_zero',
    label: '蕾姆',
    aliases: ['rem', 'rem re zero', 'rem_(re:zero)', '蕾姆'],
    providerTags: { waifu_im: 'rem', danbooru: 'rem_(re:zero)', e621: 'rem_(re:zero)', e926: 'rem_(re:zero)', safebooru: 'rem_(re:zero)' },
  },
  {
    slug: 'gundam',
    label: '高达',
    aliases: ['gundam', 'mobile suit gundam', '高达', '机动战士高达'],
    providerTags: { danbooru: 'gundam', e621: 'gundam', e926: 'gundam', safebooru: 'gundam' },
  },
  {
    slug: 'one_piece',
    label: '海贼王',
    aliases: ['one piece', 'one_piece', '海贼王', '航海王'],
    providerTags: { waifu_im: 'one-piece', danbooru: 'one_piece', e621: 'one_piece', e926: 'one_piece', safebooru: 'one_piece' },
  },
];

const normalizeText = (value: string): string => value
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');

const tagByAlias = new Map<string, ContentTagDefinition>();
for (const tag of CONTENT_TAGS) {
  tagByAlias.set(normalizeText(tag.slug), tag);
  tagByAlias.set(normalizeText(tag.label), tag);
  for (const alias of tag.aliases) tagByAlias.set(normalizeText(alias), tag);
  for (const providerTag of Object.values(tag.providerTags)) {
    if (providerTag) tagByAlias.set(normalizeText(providerTag), tag);
  }
}

export function normalizeContentTag(value: string): string {
  return tagByAlias.get(normalizeText(value))?.slug ?? normalizeText(value);
}

export function contentTagDefinition(value: string): ContentTagDefinition | null {
  return tagByAlias.get(normalizeText(value)) ?? null;
}

export function contentTagLabel(value: string): string {
  const definition = contentTagDefinition(value);
  return definition?.label ?? normalizeContentTag(value).replace(/_/g, ' ');
}

export function providerTagFor(
  providerKey: ImageProviderKey,
  value: string,
): string | null {
  const definition = contentTagDefinition(value);
  if (definition) return definition.providerTags[providerKey] ?? null;
  return null;
}

export function suggestContentTags(
  query: string,
  limit = 8,
): ContentTagDefinition[] {
  const normalized = normalizeText(query);
  const ranked = CONTENT_TAGS.flatMap((tag, index) => {
    const searchable = [tag.label, tag.slug, ...tag.aliases].map(normalizeText);
    const exact = searchable.includes(normalized);
    const prefix = searchable.some((value) => value.startsWith(normalized));
    const includes = searchable.some((value) => value.includes(normalized));
    const rank = normalized.length === 0 ? 3 : exact ? 0 : prefix ? 1 : includes ? 2 : 4;
    return rank < 4 ? [{ tag, rank, index }] : [];
  });
  return ranked
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map(({ tag }) => tag);
}

export function waifuContentRating(
  isNsfw: boolean,
): ContentRating {
  return isNsfw ? 'nsfw_unspecified' : 'safe';
}

export function nekosContentRating(
  rating: 'safe' | 'suggestive' | 'borderline' | 'explicit',
  hasNsfwTag = false,
): ContentRating {
  if (rating === 'safe') return hasNsfwTag ? 'nsfw_unspecified' : 'safe';
  if (rating === 'suggestive') return 'suggestive';
  if (rating === 'borderline') return 'nsfw_unspecified';
  return 'explicit';
}

export function danbooruContentRating(
  rating: 'g' | 's' | 'q' | 'e',
): ContentRating {
  if (rating === 'g') return 'safe';
  if (rating === 's') return 'suggestive';
  if (rating === 'q') return 'nsfw_unspecified';
  return 'explicit';
}

export function moebooruContentRating(
  rating: 's' | 'q' | 'e',
): ContentRating {
  if (rating === 's') return 'safe';
  if (rating === 'q') return 'nsfw_unspecified';
  return 'explicit';
}

/** Back-compat alias; Moebooru sources (Yande.re, Konachan) share this 3-value map. */
export const yandereContentRating = moebooruContentRating;

/**
 * e621/e926 use the 3-value `s/q/e` rating vocabulary (no Danbooru `g`). The
 * mapping mirrors {@link moebooruContentRating}; e926 (SFW-only mirror) reuses it.
 */
export function e621ContentRating(
  rating: 's' | 'q' | 'e',
): ContentRating {
  if (rating === 's') return 'safe';
  if (rating === 'q') return 'nsfw_unspecified';
  return 'explicit';
}

export function safebooruContentRating(
  rating: 'general' | 'safe' | 'questionable',
): ContentRating {
  if (rating === 'general' || rating === 'safe') return 'safe';
  return 'nsfw_unspecified';
}

export function candidateContentRating(
  image: Pick<ImageCandidate, 'contentRating' | 'isNsfw' | 'tags'>,
): ContentRating {
  if (image.contentRating) return image.contentRating;
  return image.isNsfw ? 'nsfw_unspecified' : 'safe';
}

export function matchesContentMode(
  rating: ContentRating,
  mode: NsfwMode,
): boolean {
  if (mode === 'sfw') return rating === 'safe';
  if (mode === 'nsfw') return rating !== 'safe' && rating !== 'unknown';
  return true;
}

const RATING_RANK: Record<ContentRating, number> = {
  safe: 0,
  suggestive: 1,
  nsfw_unspecified: 2,
  explicit: 3,
  unknown: -1,
};

export function strongerContentRating(
  left: ContentRating,
  right: ContentRating,
): ContentRating {
  if (left === 'unknown') return right;
  if (right === 'unknown') return left;
  return RATING_RANK[left] >= RATING_RANK[right] ? left : right;
}
