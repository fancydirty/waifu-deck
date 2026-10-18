import { fetch as expoFetch } from 'expo/fetch';

import type { S3FetchPort } from './s3-transport';

const CACHE_CONTROL = 'no-cache, no-store';

function mergeHeaders(headers: HeadersInit | undefined): HeadersInit {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const merged = new Headers(headers);
    merged.set('cache-control', CACHE_CONTROL);
    return merged;
  }

  if (Array.isArray(headers)) {
    return [
      ...headers.filter(([name]) => name.toLowerCase() !== 'cache-control'),
      ['cache-control', CACHE_CONTROL],
    ];
  }

  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'cache-control') merged[name] = value;
  }
  merged['cache-control'] = CACHE_CONTROL;
  return merged;
}

export const cloudFetch: S3FetchPort = (input, init) => (
  expoFetch(input, { ...init, headers: mergeHeaders(init?.headers) }) as unknown as Promise<Response>
);
