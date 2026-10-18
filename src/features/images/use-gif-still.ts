import { useEffect, useState } from 'react';

import {
  defaultGifStillStore,
  type GifStillResult,
  type GifStillStore,
} from '@/features/images/gif-first-frame';

/**
 * Board #16: the first-frame still of a gif too large to animate, for one
 * render site. `pending` holds the caller on its colour block, and nothing may
 * load the original meanwhile. `uri` stays null when no still could be cut.
 * `missing` means the source file itself is gone, so the viewer runs its repair.
 */
export type GifStillState = Readonly<{ uri: string | null; pending: boolean; missing: boolean }>;

const IDLE: GifStillState = { uri: null, pending: false, missing: false };
const PENDING: GifStillState = { uri: null, pending: true, missing: false };
const NO_STILL: GifStillResult = { uri: null, missing: false };

/** `sourceUri` null = nothing to cut; the store is not asked. */
export function useGifStill(
  sourceUri: string | null,
  byteSize: number,
  store: GifStillStore = defaultGifStillStore(),
): GifStillState {
  const key = sourceUri === null ? null : `${sourceUri}|${byteSize}`;
  const [settled, setSettled] = useState<{ key: string | null; result: GifStillResult | null }>(
    () => ({ key, result: null }),
  );
  // A new source forgets the old answer during render, so a source that goes
  // away and comes back (the viewer's missing → repair → same uri) is asked
  // again and never replays its stale `missing`.
  if (settled.key !== key) setSettled({ key, result: null });

  useEffect(() => {
    if (sourceUri === null) return;
    const requestKey = `${sourceUri}|${byteSize}`;
    // Cleared when the source changes or the view goes away, so an answer for
    // an earlier request — even one for this same uri — never lands.
    let live = true;
    const settle = (result: GifStillResult) => {
      if (live) setSettled({ key: requestKey, result });
    };
    store.stillFor(sourceUri, byteSize).then(settle, () => settle(NO_STILL));
    return () => {
      live = false;
    };
  }, [sourceUri, byteSize, store]);

  if (key === null) return IDLE;
  if (settled.key !== key || settled.result === null) return PENDING;
  return { uri: settled.result.uri, pending: false, missing: settled.result.missing };
}
