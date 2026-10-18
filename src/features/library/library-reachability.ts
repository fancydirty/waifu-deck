export type LibraryReachabilityPort = Readonly<{
  /** False only when the device is known to be offline. Unknown counts as reachable. */
  isReachable(): Promise<boolean>;
}>;

export function createExpoLibraryReachability(
  load: () => typeof import('expo-network') = () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-network') as typeof import('expo-network'),
): LibraryReachabilityPort {
  return {
    async isReachable() {
      try {
        const state = await load().getNetworkStateAsync();
        // `isInternetReachable` is undefined on some Android states; treat an
        // unknown answer as reachable so a working device is never told it is
        // offline. A real failure then surfaces as the fetch's own category.
        return state.isConnected !== false && state.isInternetReachable !== false;
      } catch {
        return true;
      }
    },
  };
}
