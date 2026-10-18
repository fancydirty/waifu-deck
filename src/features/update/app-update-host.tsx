import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { AppUpdateModal } from '@/screens/settings/app-update-modal';
import {
  AppUpdateProvider,
  createAppUpdateService,
  useAppUpdateSnapshot,
  type AppUpdateService,
} from './app-update-context';

export function AppUpdateHost({
  service: injectedService,
  children,
}: {
  service?: AppUpdateService;
  children: React.ReactNode;
}) {
  const [defaultService] = useState<AppUpdateService>(() =>
    createAppUpdateService(),
  );
  const service = injectedService ?? defaultService;
  const snapshot = useAppUpdateSnapshot(service);

  useEffect(() => {
    void service.initialize(true).catch(() => undefined);

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void service.onForegroundResume(true).catch(() => undefined);
      }
    });

    return () => {
      appStateSub.remove();
    };
  }, [service]);

  return (
    <AppUpdateProvider service={service}>
      {children}
      <AppUpdateModal
        visible={snapshot.modalVisible && snapshot.offer !== null}
        release={snapshot.offer?.release ?? null}
        phase={snapshot.modalPhase}
        onLater={() => {
          void service.dismissModal().catch(() => undefined);
        }}
        onConfirmUpdate={() => {
          void service.startDownloadAndInstall().catch(() => undefined);
        }}
        onCancelDownload={() => {
          service.cancelDownload();
        }}
        onOpenUnknownSources={() => {
          void service.openUnknownSourcesSettings().catch(() => undefined);
        }}
        onOpenBrowser={() => {
          void service.openInBrowser().catch(() => undefined);
        }}
      />
    </AppUpdateProvider>
  );
}
