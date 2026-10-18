import { useCallback, useEffect, useRef, useState } from 'react';

export const REMOTE_LOAD_RETRY_DELAYS_MS = [1000, 3000, 8000] as const;

/**
 * Bounded backoff for a remote image load that failed transiently (DNS flap,
 * stalled CDN). `attempt` increments after each scheduled delay; callers put it
 * in the element `key` so expo-image re-issues the load. Resets when `sourceKey`
 * changes; never exceeds the delay table length.
 *
 * Without this, a tile or viewer whose single remote fetch failed stayed on its
 * dominant-colour background until the row gained a local file or the view was
 * recreated — the "solid colour thumbnail" symptom (R8.19).
 */
export function useRemoteLoadRetry(sourceKey: string): {
  attempt: number;
  scheduleRetry: () => void;
} {
  const [state, setState] = useState({ key: sourceKey, attempt: 0 });
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Derived rather than reset in an effect, so a new source renders with a
  // fresh attempt immediately instead of one frame late.
  const attempt = state.key === sourceKey ? state.attempt : 0;

  useEffect(() => {
    attemptRef.current = 0;
    return () => {
      // A pending reload for the previous source must never land on the new
      // one, and must not outlive the view.
      if (timerRef.current === null) return;
      clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [sourceKey]);

  const scheduleRetry = useCallback(() => {
    if (timerRef.current !== null) return;
    const delay = REMOTE_LOAD_RETRY_DELAYS_MS[attemptRef.current];
    if (delay === undefined) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const next = attemptRef.current + 1;
      attemptRef.current = next;
      setState({ key: sourceKey, attempt: next });
    }, delay);
  }, [sourceKey]);

  return { attempt, scheduleRetry };
}
