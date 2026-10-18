import type { EventSubscription } from 'expo-modules-core';

/**
 * Fires `onReturn` on the edge where the device's connectivity goes from
 * not-connected to connected. Edge-triggered, not level: a stream of
 * "connected" events (the OS re-emits on every network change) must not spam a
 * sync. The removed residue timer used to catch network recovery implicitly;
 * this is the explicit real event the sync trigger's own comment promised.
 */
export type LibraryNetworkRecoveryPort = Readonly<{
  subscribe(onReturn: () => void): () => void;
}>;

type NetworkModule = typeof import('expo-network');

export function createExpoLibraryNetworkRecovery(
  load: () => NetworkModule = () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-network') as NetworkModule,
): LibraryNetworkRecoveryPort {
  return {
    subscribe(onReturn) {
      // Unknown (`undefined`) counts as connected so a device with a coarse
      // network state is never treated as permanently offline; the edge then
      // only fires when we were *definitely* offline (`false`) and are not any
      // more.
      let connected = true;
      let eventSeen = false;
      let active = true;
      let subscription: EventSubscription | null = null;
      try {
        const network = load();
        subscription = network.addNetworkStateListener((event) => {
          if (!active) return;
          eventSeen = true;
          const nowConnected = event.isConnected !== false;
          if (!connected && nowConnected) onReturn();
          connected = nowConnected;
        });

        try {
          const getNetworkStateAsync = network.getNetworkStateAsync;
          if (typeof getNetworkStateAsync === 'function') {
            void Promise.resolve(getNetworkStateAsync.call(network)).then((state) => {
              if (!active || eventSeen) return;
              connected = state.isConnected !== false;
            }).catch(() => undefined);
          }
        } catch {
          // A synchronous seed failure must not discard the listener we already installed.
        }
      } catch {
        // No network module (web, tests): the guard is an optimization, not a
        // correctness requirement — the other triggers still drive sync.
        subscription = null;
      }
      return () => {
        active = false;
        try {
          // jest-expo and some runtimes return a subscription without `remove`.
          subscription?.remove?.();
        } catch {
          // Unsubscribing is best-effort; a missing/failing remove never breaks
          // teardown.
        }
        subscription = null;
      };
    },
  };
}
