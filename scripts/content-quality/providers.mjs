export const USER_AGENT = 'WaifuDeck-ContentAudit/0.1 (+https://github.com/fancydirty)';

export const PROVIDER_LABELS = {
  waifu_im: 'Waifu.im v7',
  nekos_api: 'Nekos API v5',
  danbooru: 'Danbooru',
};

function waifuRequest(mode) {
  const params = new URLSearchParams({
    IsNsfw: mode === 'mixed' ? 'All' : mode === 'nsfw' ? 'True' : 'False',
    PageSize: '1',
    IsAnimated: 'False',
    Orientation: 'Portrait',
  });
  params.append('IncludedTags', 'waifu');
  return {
    url: `https://api.waifu.im/images?${params.toString()}`,
    headers: {
      Accept: 'application/json',
      'Accept-Version': 'v7',
      'User-Agent': USER_AGENT,
    },
  };
}

function nekosRequest(mode) {
  const ratings = mode === 'sfw'
    ? ['safe']
    : mode === 'nsfw'
      ? ['explicit']
      : ['safe', 'suggestive', 'borderline', 'explicit'];
  const params = new URLSearchParams();
  for (const rating of ratings) params.append('rating', rating);
  return {
    url: `https://api.nekosapi.com/v5/images/random?${params.toString()}`,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  };
}

function danbooruRequest(mode) {
  const tags = ['1girl'];
  if (mode === 'sfw') tags.push('rating:general');
  if (mode === 'nsfw') tags.push('is:nsfw');
  const params = new URLSearchParams({ tags: tags.join(' ') });
  return {
    url: `https://danbooru.donmai.us/posts/random.json?${params.toString()}`,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  };
}

export function providerRequest(provider, mode) {
  if (provider === 'waifu_im') return waifuRequest(mode);
  if (provider === 'nekos_api') return nekosRequest(mode);
  if (provider === 'danbooru') return danbooruRequest(mode);
  throw new Error(`Unsupported provider: ${provider}`);
}
