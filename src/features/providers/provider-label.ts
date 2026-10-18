import { providerByKey } from '@/features/providers/provider-registry';
import type { ImageProviderKey } from '@/features/waifu/types';

export function providerLabel(provider: ImageProviderKey): string {
  return providerByKey(provider)?.label ?? provider;
}
