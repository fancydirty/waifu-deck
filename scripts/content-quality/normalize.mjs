const NEKOS_RATINGS = new Set(['safe', 'suggestive', 'borderline', 'explicit']);
const DANBOORU_RATINGS = new Set(['g', 's', 'q', 'e']);
const DANBOORU_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

export class NormalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NormalizationError';
    this.code = 'invalid_response';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function identifier(value) {
  const text = nonEmptyString(value);
  if (text !== null) return text;
  const number = positiveNumber(value);
  return number === null ? null : String(number);
}

function sourceUrl(value) {
  const raw = nonEmptyString(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');

    const isHostOrSubdomain = (domain) =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`);
    const pixiv = url.pathname.match(/\/(?:en\/)?artworks\/(\d+)/i);
    if (isHostOrSubdomain('pixiv.net') && pixiv) return `pixiv:${pixiv[1]}`;
    const pixivCdn = url.pathname.match(/\/(\d+)_p\d+\.[a-z0-9]+$/i);
    if (isHostOrSubdomain('pximg.net') && pixivCdn) return `pixiv:${pixivCdn[1]}`;
    const socialPost = url.pathname.match(/\/status\/(\d+)/i);
    if (socialPost && ['twitter.com', 'x.com'].some(isHostOrSubdomain)) {
      return `x:${socialPost[1]}`;
    }
    const danbooru = url.pathname.match(/\/(?:posts|post\/show)\/(\d+)/i);
    if (isHostOrSubdomain('donmai.us') && danbooru) {
      return `danbooru:${danbooru[1]}`;
    }
    return `url:${url.toString()}`;
  } catch {
    return null;
  }
}

function validImageUrl(value) {
  const raw = nonEmptyString(value);
  if (raw === null) return false;
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanTags(values) {
  return [...new Set(values.map((value) => nonEmptyString(value))
    .filter((value) => value !== null)
    .map((value) => value.toLowerCase().replaceAll(' ', '_')))];
}

function observation(fields) {
  return {
    provider: fields.provider,
    providerId: fields.providerId,
    sourceId: fields.sourceId,
    sourceUrl: fields.sourceUrl,
    width: fields.width,
    height: fields.height,
    rawRating: fields.rawRating,
    safety: fields.safety,
    tags: fields.tags,
    hasNsfwTag: fields.hasNsfwTag,
  };
}

function normalizeWaifuItem(value) {
  if (!isRecord(value)) return { rejection: 'invalid_metadata' };
  const id = positiveNumber(value.id);
  const width = positiveNumber(value.width);
  const height = positiveNumber(value.height);
  const byteSize = positiveNumber(value.byteSize);
  if (
    id === null ||
    width === null ||
    height === null ||
    byteSize === null ||
    !validImageUrl(value.url) ||
    typeof value.isNsfw !== 'boolean'
  ) {
    return { rejection: 'invalid_metadata' };
  }
  const tags = Array.isArray(value.tags)
    ? cleanTags(value.tags.flatMap((tag) => isRecord(tag) ? [tag.slug] : []))
    : [];
  return {
    record: observation({
      provider: 'waifu_im',
      providerId: String(id),
      sourceId: null,
      sourceUrl: sourceUrl(value.source),
      width,
      height,
      rawRating: value.isNsfw ? 'nsfw' : 'sfw',
      safety: value.isNsfw ? 'nsfw_unspecified' : 'safe',
      tags,
      hasNsfwTag: false,
    }),
  };
}

function normalizeWaifu(value) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new NormalizationError('Waifu.im returned invalid metadata');
  }
  if (value.items.length === 0) return { observations: [], rejections: ['empty_response'] };
  const normalized = value.items.map(normalizeWaifuItem);
  return {
    observations: normalized.flatMap((item) => item.record === undefined ? [] : [item.record]),
    rejections: normalized.flatMap((item) => item.rejection === undefined ? [] : [item.rejection]),
  };
}

function normalizeNekos(value) {
  if (!isRecord(value)) throw new NormalizationError('Nekos API returned invalid metadata');
  const id = nonEmptyString(value.id);
  const rating = nonEmptyString(value.rating);
  if (id === null || rating === null || !NEKOS_RATINGS.has(rating) || !validImageUrl(value.url)) {
    return { observations: [], rejections: ['invalid_metadata'] };
  }
  const parsedTags = Array.isArray(value.tags)
    ? value.tags.flatMap((tag) => {
        if (!isRecord(tag)) return [];
        const name = nonEmptyString(tag.name);
        return name === null ? [] : [{ name, isNsfw: tag.is_nsfw === true }];
      })
    : [];
  const hasNsfwTag = parsedTags.some((tag) => tag.isNsfw);
  const safety = rating === 'safe'
    ? hasNsfwTag ? 'nsfw_unspecified' : 'safe'
    : rating === 'suggestive'
      ? 'suggestive'
      : rating === 'borderline'
        ? 'nsfw_unspecified'
        : 'explicit';
  const width = positiveNumber(value.width ?? value.image_width);
  const height = positiveNumber(value.height ?? value.image_height);
  return {
    observations: [observation({
      provider: 'nekos_api',
      providerId: id,
      sourceId: identifier(value.source_id),
      sourceUrl: sourceUrl(value.source_url),
      width,
      height,
      rawRating: rating,
      safety,
      tags: cleanTags(parsedTags.map((tag) => tag.name)),
      hasNsfwTag,
    })],
    rejections: [],
  };
}

function normalizeDanbooru(value) {
  if (!isRecord(value)) throw new NormalizationError('Danbooru returned invalid metadata');
  const id = positiveNumber(value.id);
  const width = positiveNumber(value.image_width);
  const height = positiveNumber(value.image_height);
  const fileSize = positiveNumber(value.file_size);
  const extension = nonEmptyString(value.file_ext)?.toLowerCase() ?? null;
  const rating = nonEmptyString(value.rating);
  if (
    id === null ||
    width === null ||
    height === null ||
    fileSize === null ||
    extension === null ||
    rating === null ||
    !DANBOORU_RATINGS.has(rating) ||
    !validImageUrl(value.file_url)
  ) {
    return { observations: [], rejections: ['invalid_metadata'] };
  }
  if (!DANBOORU_EXTENSIONS.has(extension)) {
    return { observations: [], rejections: ['unsupported_extension'] };
  }
  const tags = cleanTags((nonEmptyString(value.tag_string) ?? '').split(/\s+/));
  const safety = {
    g: 'safe',
    s: 'suggestive',
    q: 'nsfw_unspecified',
    e: 'explicit',
  }[rating];
  return {
    observations: [observation({
      provider: 'danbooru',
      providerId: String(id),
      sourceId: identifier(value.pixiv_id),
      sourceUrl: sourceUrl(value.source),
      width,
      height,
      rawRating: rating,
      safety,
      tags,
      hasNsfwTag: false,
    })],
    rejections: [],
  };
}

export function normalizeProviderPayload(provider, value) {
  if (provider === 'waifu_im') return normalizeWaifu(value);
  if (provider === 'nekos_api') return normalizeNekos(value);
  if (provider === 'danbooru') return normalizeDanbooru(value);
  throw new NormalizationError(`Unsupported provider: ${provider}`);
}

export function matchesMode(record, mode) {
  if (mode === 'mixed') return true;
  if (mode === 'sfw') return record.safety === 'safe';
  return record.safety !== 'safe' && record.safety !== 'unknown';
}
