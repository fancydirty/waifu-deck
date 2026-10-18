import { useState } from 'react';
import { Text, View, type StyleProp, type TextStyle } from 'react-native';
import * as Linking from 'expo-linking';

import type {
  ByosConnectFailure,
  ConnectableProbe,
  ConnectResult,
  ProbeResult,
  WebdavConnectFields,
} from '@/features/byos/byos-connect-flow';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { errorKey } from '@/screens/settings/byos-error-key';
import { SettingsBlock } from '@/screens/settings/ui/settings-block';
import { SettingsField } from '@/screens/settings/ui/settings-field';
import { SettingsGroup } from '@/screens/settings/ui/settings-group';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { ConfirmModal } from '@/screens/settings/settings-dialogs';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

/** The community-maintained directory Task 9's guidance block links out to. */
export const AWESOME_WEBDAV_URL = 'https://github.com/fstanis/awesome-webdav#cloud-providers';

const EMPTY_FIELDS: WebdavConnectFields = { baseUrl: '', username: '', password: '' };

type WebdavConnectInput = Readonly<{
  fields: WebdavConnectFields;
  probe: ConnectableProbe;
  password?: string;
  passwordConfirm?: string;
}>;

/**
 * The WebDAV counterpart of the section's S3 connect block (board #12
 * P12-B, Task 9). Lives in its own file because the section is already the
 * largest settings surface and this form has its own field set, but it keeps
 * the S3 block's shape on purpose — same `SettingsField`/`SettingRow`/`ConfirmModal`
 * vocabulary, same probe → branch → connect flow, same local D9 password gate
 * before the unrecoverable-password warning — so the two locations feel like
 * one feature. Differences are all spec-driven: an https-only address, the
 * community awesome-webdav directory row above the address field, and no
 * encryption toggle since spec §6 forces encryption on every cloud-drive
 * backend. The per-provider help block (123 云盘 / NAS) and the root-path
 * field are gone (U4-design owner ruling 2026-10-12): the app uses the default
 * root and creates its 「Waifu Deck」 folder there. `existing-plain` never
 * arrives from `probeWebdav` (a plaintext meta is reported as `meta_corrupt`),
 * so the form has no branch for it.
 */
export function WebdavConnectForm({
  probe,
  connect,
  onConnected,
  busy,
  setBusy,
}: {
  probe: (fields: WebdavConnectFields) => Promise<ProbeResult>;
  connect: (input: WebdavConnectInput) => Promise<ConnectResult>;
  onConnected: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const [fields, setFields] = useState<WebdavConnectFields>(EMPTY_FIELDS);
  const [probeResult, setProbeResult] = useState<ConnectableProbe | null>(null);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState<ByosConnectFailure | null>(null);
  const [warningVisible, setWarningVisible] = useState(false);

  function updateField(key: keyof WebdavConnectFields, value: string) {
    setFields((current) => ({ ...current, [key]: value }));
    setProbeResult(null);
    setError(null);
  }

  async function runCheck() {
    setBusy(true);
    try {
      const result = await probe(fields);
      if (result.kind === 'error') {
        setProbeResult(null);
        setError({ category: result.category, detail: result.detail });
      } else {
        setProbeResult(result);
        setError(null);
      }
    } finally {
      setBusy(false);
    }
  }

  // Same local D9 gate as the S3 form: the unrecoverable-password warning is
  // never shown for input the create would reject anyway (an empty password
  // or a mismatched confirmation), so the scariest modal in the app only ever
  // precedes a create that can actually proceed.
  function onCreatePressed(): void {
    if (password === '') {
      setError({ category: 'password_mismatch', detail: 'password_required' });
      return;
    }
    if (password !== passwordConfirm) {
      setError({ category: 'password_mismatch', detail: 'confirmation_mismatch' });
      return;
    }
    setError(null);
    setWarningVisible(true);
  }

  async function finishConnect(input: { password?: string; passwordConfirm?: string }) {
    if (probeResult === null) return;
    setBusy(true);
    try {
      const result = await connect({ fields, probe: probeResult, ...input });
      if (result.ok) {
        onConnected();
      } else {
        setError({ category: result.category, detail: result.detail });
      }
    } finally {
      setBusy(false);
    }
  }

  // U4-design visual pass: the supplement's .wd-p prose (13/600/1.55) for the
  // page-level notes; the card footnotes share the token without the inset.
  const hintStyle: StyleProp<TextStyle> = [settingsTypography.connectHint,
    { color: theme.textSecondary, paddingHorizontal: metrics.contentPadding }];

  return (
    <View testID="webdav-connect-form">
      <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
        <SettingsRow
          testID="webdav-guide-link"
          label={t('settings.byos.webdav.guideMore')}
          chevron
          onPress={() => {
            Linking.openURL(AWESOME_WEBDAV_URL).catch(() => undefined);
          }}
        />
      </SettingsGroup>
      <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
        <SettingsBlock paddingHorizontal={metrics.settingsConnect.fieldCardPaddingH}>
          <View style={{ gap: metrics.settingsConnect.stackGap }}>
            <SettingsField
              testID="webdav-field-url"
              accessibilityLabel={t('settings.byos.webdav.serverUrl')}
              placeholder={t('settings.byos.webdav.serverUrlPlaceholder')}
              keyboardType="url"
              disabled={busy}
              value={fields.baseUrl}
              onChangeText={(value) => updateField('baseUrl', value)}
              paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
            />
            <SettingsField
              testID="webdav-field-username"
              accessibilityLabel={t('settings.byos.webdav.username')}
              placeholder={t('settings.byos.webdav.username')}
              disabled={busy}
              value={fields.username}
              onChangeText={(value) => updateField('username', value)}
              paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
            />
            <SettingsField
              testID="webdav-field-password"
              accessibilityLabel={t('settings.byos.webdav.password')}
              placeholder={t('settings.byos.webdav.password')}
              secureTextEntry
              disabled={busy}
              value={fields.password}
              onChangeText={(value) => updateField('password', value)}
              paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
            />
            <Text style={[settingsTypography.connectHint, { color: theme.textSecondary }]}>
              {t('settings.byos.webdav.httpsHint')}
            </Text>
            <Text style={[settingsTypography.connectHint, { color: theme.textSecondary }]}>
              {t('settings.byos.webdav.securityHint')}
            </Text>
          </View>
        </SettingsBlock>
      </SettingsGroup>
      {error ? (
        <Text testID="byos-error" style={[settingsTypography.detail, { color: theme.danger, paddingHorizontal: metrics.contentPadding }]}>
          {t(errorKey(error))}
        </Text>
      ) : null}
      <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
        <SettingsRow
          testID="webdav-check"
          label={t('settings.byos.webdav.check')}
          chevron
          disabled={busy}
          onPress={() => void runCheck()}
        />
      </SettingsGroup>
      {probeResult?.kind === 'empty' ? (
        <>
          <Text testID="webdav-probe-empty" style={hintStyle}>
            {t('settings.byos.webdav.probeEmpty')}
          </Text>
          <Text style={hintStyle}>{t('settings.byos.webdav.encryptedNote')}</Text>
          <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
            <SettingsBlock paddingHorizontal={metrics.settingsConnect.fieldCardPaddingH}>
              <View style={{ gap: metrics.settingsConnect.stackGap }}>
                <SettingsField
                  testID="byos-field-password"
                  accessibilityLabel={t('settings.byos.password')}
                  placeholder={t('settings.byos.password')}
                  secureTextEntry
                  disabled={busy}
                  value={password}
                  onChangeText={(value) => {
                    setError(null);
                    setPassword(value);
                  }}
                  paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
                />
                <SettingsField
                  testID="byos-field-password-confirm"
                  accessibilityLabel={t('settings.byos.passwordConfirm')}
                  placeholder={t('settings.byos.passwordConfirm')}
                  secureTextEntry
                  disabled={busy}
                  value={passwordConfirm}
                  onChangeText={(value) => {
                    setError(null);
                    setPasswordConfirm(value);
                  }}
                  paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
                />
              </View>
            </SettingsBlock>
          </SettingsGroup>
          <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
            <SettingsRow
              testID="byos-create"
              label={t('settings.byos.create')}
              chevron
              disabled={busy}
              onPress={onCreatePressed}
            />
          </SettingsGroup>
        </>
      ) : null}
      {probeResult?.kind === 'existing-encrypted' ? (
        <>
          <Text testID="byos-probe-existing-encrypted" style={hintStyle}>
            {t('settings.byos.probe.existingEncrypted')}
          </Text>
          <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
            <SettingsBlock paddingHorizontal={metrics.settingsConnect.fieldCardPaddingH}>
              <View style={{ gap: metrics.settingsConnect.stackGap }}>
                <SettingsField
                  testID="byos-field-password"
                  accessibilityLabel={t('settings.byos.password')}
                  placeholder={t('settings.byos.password')}
                  secureTextEntry
                  disabled={busy}
                  value={password}
                  onChangeText={(value) => {
                    setError(null);
                    setPassword(value);
                  }}
                  paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
                />
              </View>
            </SettingsBlock>
          </SettingsGroup>
          <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
            <SettingsRow
              testID="byos-join"
              label={t('settings.byos.join')}
              chevron
              disabled={busy}
              onPress={() => void finishConnect({ password })}
            />
          </SettingsGroup>
        </>
      ) : null}
      <ConfirmModal
        visible={warningVisible}
        title={t('settings.byos.warning.title')}
        message={t('settings.byos.warning.message')}
        confirmLabel={t('settings.byos.warning.confirm')}
        onCancel={() => setWarningVisible(false)}
        onConfirm={() => {
          setWarningVisible(false);
          void finishConnect({ password, passwordConfirm });
        }}
      />
    </View>
  );
}
