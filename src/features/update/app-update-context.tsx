import { createContext, use, useCallback, useSyncExternalStore } from 'react';

import {
  createAppUpdateService,
  type AppUpdateService,
  type AppUpdateSnapshot,
} from './app-update-service';

const AppUpdateContext = createContext<AppUpdateService | null>(null);

export function AppUpdateProvider({
  service,
  children,
}: {
  service: AppUpdateService;
  children: React.ReactNode;
}) {
  return <AppUpdateContext value={service}>{children}</AppUpdateContext>;
}

export function useOptionalAppUpdateService(): AppUpdateService | null {
  return use(AppUpdateContext);
}

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = () => null;

export function useAppUpdateSnapshot(service: AppUpdateService): AppUpdateSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => service.subscribe(onStoreChange),
    [service],
  );
  const getSnapshot = useCallback(
    (): AppUpdateSnapshot => service.getSnapshot(),
    [service],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useOptionalAppUpdateSnapshot(): {
  service: AppUpdateService | null;
  snapshot: AppUpdateSnapshot | null;
} {
  const service = use(AppUpdateContext);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      service ? service.subscribe(onStoreChange) : NOOP_SUBSCRIBE(),
    [service],
  );
  const getSnapshot = useCallback(
    () => (service ? service.getSnapshot() : NULL_SNAPSHOT()),
    [service],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { service, snapshot };
}

export { createAppUpdateService, type AppUpdateService, type AppUpdateSnapshot };
