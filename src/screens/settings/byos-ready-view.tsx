import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { SectionHeading } from './section-heading';
import { SettingsGroup } from './ui/settings-group';
import { SettingsRow } from './ui/settings-row';
import { BackgroundUploadRow, type BackgroundUploadPort } from './background-upload-row';
import { CloudLibraryCardBody } from './cloud-library-card';
import { CloudQuotaBar } from './cloud-quota-bar';
import type { CloudLibraryData } from './use-cloud-library-data';
import { metrics } from '@/theme/metrics';
import { LOCATION_LABEL_KEY } from './storage-location-picker';

export type ByosReadyViewProps = Readonly<{
  data: CloudLibraryData;
  modeControlPresent: boolean;
  busy: boolean;
  onStorageModePress(): void;
  backgroundSync?: BackgroundUploadPort;
  disconnect: ReactNode;
}>;

/**
 * The 云库 page lower half in the ready layout (mockup v4 §2 "云库页：卡片下面两组，
 * 断开此设备单独一张卡"): 本机存储 + 后台上传 under 这台手机, 加密 + 存储位置
 * under 这个云库, and the danger row in its own card. The card body and quota
 * bar above keep their measured look; the disconnect node arrives already
 * grouped from the section.
 */
export function ByosReadyView({ data, modeControlPresent, busy, onStorageModePress, backgroundSync, disconnect }: ByosReadyViewProps): ReactElement {
  const { t } = useAppTranslation();
  const mode = data.model.storageMode;
  const storageKind = data.model.identity === null
    ? t('settings.byos.heading')
    : t(LOCATION_LABEL_KEY[data.model.identity.kind]);
  const modeValue = mode === 'cloud-only'
    ? t('settings.byos.storageMode.cloudOnly') : t('settings.byos.storageMode.both');
  const storageModeRow = modeControlPresent && mode !== null;
  return (
    <View testID="byos-ready-view">
      <View style={{ gap: metrics.spacing.small }}>
        <CloudLibraryCardBody
          model={data.model}
          nowMs={data.viewNowMs}
          testID="byos-status"
          statsTestID={data.counts.state === 'read' ? 'byos-mirror-progress' : 'cloud-unread-stats'}
          statIdPrefix="cloud-stat"
          footerTestID={data.model.footer?.kind === 'quota-full' ? 'byos-quota-full'
            : data.model.footer?.kind === 'synced' || data.model.footer?.kind === 'never-synced' ? 'byos-last-sync' : 'byos-cloud-footer'}
        />
        {data.quota === null ? null : <CloudQuotaBar quota={data.quota} />}
      </View>
      <View testID="byos-phone-group">
        <SectionHeading>{t('settings.cloudLibrary.phoneGroup')}</SectionHeading>
      </View>
      {storageModeRow || backgroundSync !== undefined ? (
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
          {storageModeRow ? (
            <SettingsRow
              testID="byos-storage-mode"
              label={t('settings.byos.storageMode.label')}
              detail={t('settings.byos.storageMode.detail')}
              value={modeValue}
              disabled={busy}
              chevron
              onPress={onStorageModePress}
            />
          ) : null}
          {backgroundSync === undefined ? null : <BackgroundUploadRow backgroundSync={backgroundSync} disabled={busy} />}
        </SettingsGroup>
      ) : null}
      <View testID="byos-library-group">
        <SectionHeading>{t('settings.cloudLibrary.libraryGroup')}</SectionHeading>
      </View>
      <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
        {data.model.encryption === null ? null : (
          <SettingsRow
            testID="byos-encryption"
            label={t('settings.cloudLibrary.encryption')}
            value={data.model.encryption === 'aes-gcm' ? t('settings.byos.status.encryptionOn') : t('settings.byos.status.encryptionOff')}
          />
        )}
        <SettingsRow
          testID="storage-kind-badge"
          label={t('settings.byos.locations.title')}
          value={storageKind}
        />
      </SettingsGroup>
      {disconnect}
    </View>
  );
}
