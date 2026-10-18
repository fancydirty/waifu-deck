import { providerByKey } from '@/features/providers/provider-registry';
import type { ImageProviderKey } from '@/features/waifu/types';

/**
 * R8.28 —— 取该源图片字节时必须附带的 HTTP 头，没有则 `undefined`。
 *
 * 唯一声明处是 adapter 的 `imageRequestHeaders`（见 `provider-adapter.ts`）；
 * 本函数只是把它从注册表里读出来，不做任何判断。
 */
export function providerImageHeaders(
  provider: ImageProviderKey,
): Readonly<Record<string, string>> | undefined {
  return providerByKey(provider)?.imageRequestHeaders;
}

/**
 * 把一个远程图片 URL 包成 expo-image 的 `ImageSource`，附上该源要求的请求头。
 *
 * 源不声明头时返回的对象**只有** `uri` 一个键——不是 `headers: undefined`。
 * 这让「加一个防盗链源」对其余九个源的渲染路径逐字节无影响（`toEqual({ uri })`
 * 这类既有断言原样通过）。
 *
 * 只用于 provider 的远程图片。本地 file:// 与 library 覆写源不经过这里：它们
 * 不是 provider 的字节，附头没有意义。
 */
export function providerImageSource(
  uri: string,
  provider: ImageProviderKey,
): { uri: string; headers?: Readonly<Record<string, string>> } {
  const headers = providerImageHeaders(provider);
  return headers ? { uri, headers } : { uri };
}
