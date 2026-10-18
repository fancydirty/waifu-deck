import { createContext, use, useEffect } from 'react';

/**
 * Board #27 S1b (spec §5.5): who republishes a row the library just took over.
 * 收藏 and the viewer publish it themselves, after their own entries read (the
 * row must not turn `mirrored` before its entry is in hand); this counts how
 * many of them are mounted, so the provider republishes only when none is.
 */
export type HandedOverPublishers = Readonly<{
  /** Registers one mounted publisher; the returned release is idempotent. */
  register(): () => void;
  count(): number;
}>;

/**
 * The channel from a screen's container to its view: the ids whose hand-over a
 * finished entries read just published. A new object with the next `seq` each
 * time, so the view can tell one publication from the next.
 */
export type HandedOver = Readonly<{ seq: number; imageIds: readonly number[] }>;

export function createHandedOverPublishers(): HandedOverPublishers {
  let registered = 0;
  return {
    register() {
      registered += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        registered -= 1;
      };
    },
    count: () => registered,
  };
}

/** The default, for a screen rendered without the provider: registers nothing. */
const INERT_PUBLISHERS: HandedOverPublishers = {
  register: () => () => undefined,
  count: () => 0,
};

export const HandedOverPublishersContext = createContext<HandedOverPublishers>(
  INERT_PUBLISHERS,
);

/** Registers the calling component as a hand-over publisher while it is mounted. */
export function useHandedOverPublisher(): void {
  const publishers = use(HandedOverPublishersContext);
  useEffect(() => publishers.register(), [publishers]);
}
