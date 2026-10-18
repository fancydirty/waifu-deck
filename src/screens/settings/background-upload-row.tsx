import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';

import { useAppTranslation } from '@/i18n/use-app-translation';
import { SettingsButton } from '@/screens/settings/ui/settings-button';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { StatusPill } from '@/screens/settings/status-pill';
import { metrics } from '@/theme/metrics';

export type BackgroundUploadPort = {
  isBatteryOptimizationIgnored(): boolean;
  requestIgnoreBatteryOptimizations(): Promise<void>;
};

type SubscribeAppActive = (listener: () => void) => () => void;

export function subscribeAppActiveDefault(listener: () => void): () => void {
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') listener();
  });
  return () => subscription.remove();
}

export type BackgroundUploadRowProps = {
  backgroundSync: BackgroundUploadPort;
  subscribeAppActive?: SubscribeAppActive;
  disabled?: boolean;
};

export function BackgroundUploadRow({
  backgroundSync,
  subscribeAppActive = subscribeAppActiveDefault,
  disabled = false,
}: BackgroundUploadRowProps) {
  const { t } = useAppTranslation();
  const [allowed, setAllowed] = useState(() => backgroundSync.isBatteryOptimizationIgnored());

  useEffect(() => {
    const refresh = () => setAllowed(backgroundSync.isBatteryOptimizationIgnored());
    return subscribeAppActive(refresh);
  }, [backgroundSync, subscribeAppActive]);

  const requestAllowance = async () => {
    try {
      await backgroundSync.requestIgnoreBatteryOptimizations();
    } catch {
      // Keep the last read state when no system settings activity can open.
    }
  };

  return (
    <SettingsRow
      testID="byos-background-sync"
      label={t('settings.byos.backgroundSync.label')}
      detail={allowed ? undefined : t('settings.byos.backgroundSync.restrictedDetail')}
      trailing={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: metrics.spacing.small }}>
          <StatusPill
            testID="byos-background-sync-state"
            tone={allowed ? 'ok' : 'warn'}
            label={t(allowed ? 'settings.byos.backgroundSync.allowed' : 'settings.byos.backgroundSync.restricted')}
          />
          {allowed ? null : (
            <SettingsButton
              testID="byos-background-sync-allow"
              variant="primary"
              disabled={disabled}
              onPress={() => { void requestAllowance(); }}>
              {t('settings.byos.backgroundSync.allow')}
            </SettingsButton>
          )}
        </View>
      }
    />
  );
}
