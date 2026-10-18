import { DEFAULT_SETTINGS } from '../features/settings/settings';
import {
  fetchWaifuBatch,
  WaifuApiError,
} from '../features/waifu/waifu-client';

export type WaifuImage = {
  id: number;
  url: string;
  width: number;
  height: number;
  dominantColor: string;
  source: string | null;
  artist: string | null;
};

export async function fetchWaifuImages(
  excludedIds: number[] = [],
  signal?: AbortSignal,
): Promise<WaifuImage[]> {
  try {
    const batch = await fetchWaifuBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds,
      signal,
    });

    return batch.items.map((image) => ({
      id: Number(image.providerItemId),
      url: image.remoteUrl,
      width: image.width,
      height: image.height,
      dominantColor: image.dominantColor,
      source: image.sourceUrl,
      artist: image.artistName,
    }));
  } catch (error) {
    if (error instanceof WaifuApiError && error.code === 'aborted') {
      const abortError = new Error(error.message);
      abortError.name = 'AbortError';
      abortError.cause = error;
      throw abortError;
    }
    throw error;
  }
}
