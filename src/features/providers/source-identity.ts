function normalizedUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isHostOrSubdomainOfAny(hostname: string, domains: readonly string[]): boolean {
  return domains.some((domain) => isHostOrSubdomain(hostname, domain));
}

/**
 * Builds the conservative generic `url:` fallback key: https-normalize the
 * protocol, strip a leading `www.` host label, and keep the query string
 * intact (dropping it risks false-positive cross-URL merges). Trailing
 * slash/hash normalization already happened in `normalizedUrl`.
 */
function genericUrlKey(url: URL): string {
  const hostname = url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname;
  const port = url.port.length > 0 ? `:${url.port}` : '';
  const path = url.pathname + url.search;
  return `url:https://${hostname}${port}${path}`;
}

export function canonicalizeSourceUrl(value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  const url = normalizedUrl(value.trim());
  if (url === null) return null;

  const pixiv = url.pathname.match(/\/(?:en\/)?artworks\/(\d+)/i);
  if (isHostOrSubdomain(url.hostname, 'pixiv.net') && pixiv) {
    return `pixiv:${pixiv[1]}`;
  }

  if (
    isHostOrSubdomain(url.hostname, 'pixiv.net') &&
    /member_illust\.php/i.test(url.pathname)
  ) {
    const illustId = url.searchParams.get('illust_id');
    if (illustId !== null && /^\d+$/.test(illustId)) {
      return `pixiv:${illustId}`;
    }
  }

  const pixivCdn = url.pathname.match(/\/(\d+)_p\d+\.[a-z0-9]+$/i);
  if (isHostOrSubdomain(url.hostname, 'pximg.net') && pixivCdn) {
    return `pixiv:${pixivCdn[1]}`;
  }

  const socialPost = url.pathname.match(/\/status\/(\d+)/i);
  if (
    socialPost &&
    ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'].includes(url.hostname)
  ) {
    return `x:${socialPost[1]}`;
  }

  const danbooru = url.pathname.match(/\/(?:posts|post\/show)\/(\d+)(?:\/|$)/i);
  if (isHostOrSubdomain(url.hostname, 'donmai.us') && danbooru) {
    return `danbooru:${danbooru[1]}`;
  }

  const e621Post = url.pathname.match(/\/posts\/(\d+)(?:\/|$)/i);
  if (isHostOrSubdomainOfAny(url.hostname, ['e621.net', 'e926.net']) && e621Post) {
    return `e621:${e621Post[1]}`;
  }

  const boardPost = url.pathname.match(/\/post\/show\/(\d+)(?:\/|$)/i);
  if (isHostOrSubdomainOfAny(url.hostname, ['konachan.com', 'konachan.net']) && boardPost) {
    return `konachan:${boardPost[1]}`;
  }
  if (isHostOrSubdomain(url.hostname, 'yande.re') && boardPost) {
    return `yandere:${boardPost[1]}`;
  }

  if (
    url.searchParams.get('page') === 'post' &&
    url.searchParams.get('s') === 'view'
  ) {
    const postId = url.searchParams.get('id');
    if (postId !== null && /^\d+$/.test(postId)) {
      if (isHostOrSubdomain(url.hostname, 'safebooru.org')) {
        return `safebooru:${postId}`;
      }
      if (isHostOrSubdomain(url.hostname, 'gelbooru.com')) {
        return `gelbooru:${postId}`;
      }
    }
  }

  return genericUrlKey(url);
}

const MD5_HEX = /^[0-9a-f]{32}$/;

/**
 * Normalizes a provider-supplied MD5 to lowercase hex, rejecting anything that
 * is not exactly 32 hex characters. Sentinels ("0", "none", truncated digests)
 * must never enter the byte-exact dedup arm — a false merge there silently
 * hides images, the inverse of the reappearance bug the arm exists to fix.
 */
export function normalizedMd5Hex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  return MD5_HEX.test(candidate) ? candidate : null;
}
