import { useState } from 'react';
import { Text, View, type StyleProp, type TextStyle } from 'react-native';

import type {
  ByosConnectFailure,
  ConnectableProbe,
  ConnectResult,
  OneDriveSource,
  ProbeResult,
  SignInResult,
} from '@/features/byos/byos-connect-flow';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { signInFlowErrorKey } from '@/screens/settings/byos-error-key';
import { SettingsBlock } from '@/screens/settings/ui/settings-block';
import { SettingsField } from '@/screens/settings/ui/settings-field';
import { SettingsGroup } from '@/screens/settings/ui/settings-group';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { ConfirmModal } from '@/screens/settings/settings-dialogs';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

type OneDriveConnectInput = Readonly<{
  source: OneDriveSource;
  probe: ConnectableProbe;
  password?: string;
  passwordConfirm?: string;
}>;

/**
 * The OneDrive counterpart of the section's S3/WebDAV connect blocks (board
 * #12 P12-C, Task 11). There is no field entry at all: `signIn` opens the
 * system browser for a Microsoft account and resolves a bound
 * `OneDriveSource` (refresh token plus the app's scoped folder ids), which
 * this form probes immediately after — there is no separate "check" step
 * because there is nothing left for the user to type. Same probe → branch →
 * connect flow and the same local D9 password gate before the
 * unrecoverable-password warning as the WebDAV form (`webdav-connect-form.tsx`);
 * no encryption toggle for the same spec §6 reason (every cloud-drive backend
 * is always encrypted).
 */
export function OneDriveConnectForm({
  signIn,
  probe,
  connect,
  onConnected,
  busy,
  setBusy,
}: {
  signIn: () => Promise<SignInResult>;
  probe: (source: OneDriveSource) => Promise<ProbeResult>;
  connect: (input: OneDriveConnectInput) => Promise<ConnectResult>;
  onConnected: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const [source, setSource] = useState<OneDriveSource | null>(null);
  const [probeResult, setProbeResult] = useState<ConnectableProbe | null>(null);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState<ByosConnectFailure | null>(null);
  const [warningVisible, setWarningVisible] = useState(false);

  async function runSignIn() {
    // A retry starts clean (board row 15, aligned with the Drive form): the
    // last attempt's error is about an attempt that is over.
    setError(null);
    setBusy(true);
    try {
      const result = await signIn();
      if (!result.ok) {
        setError({ category: result.category, detail: result.detail });
        return;
      }
      setSource(result.source);
      const probed = await probe(result.source);
      if (probed.kind === 'error') {
        setProbeResult(null);
        setError({ category: probed.category, detail: probed.detail });
      } else {
        setProbeResult(probed);
      }
    } finally {
      setBusy(false);
    }
  }

  // Same local D9 gate as the S3/WebDAV forms: the unrecoverable-password
  // warning is never shown for input the create would reject anyway (an
  // empty password or a mismatched confirmation).
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
    if (source === null || probeResult === null) return;
    setBusy(true);
    try {
      const result = await connect({ source, probe: probeResult, ...input });
      if (result.ok) {
        onConnected();
      } else {
        setError({ category: result.category, detail: result.detail });
      }
    } finally {
      setBusy(false);
    }
  }

  // U4-design visual pass: the supplement's .wd-p prose (13/600/1.55).
  const hintStyle: StyleProp<TextStyle> = [settingsTypography.connectHint,
    { color: theme.textSecondary, paddingHorizontal: metrics.contentPadding }];
  const cardHint: StyleProp<TextStyle> = [settingsTypography.connectHint, { color: theme.textSecondary }];

  return (
    <View testID="onedrive-connect-form">
      <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
        <SettingsBlock>
          <Text style={cardHint}>{t('settings.byos.onedrive.intro')}</Text>
        </SettingsBlock>
      </SettingsGroup>
      {source === null ? (
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
          <SettingsRow
            testID="onedrive-sign-in"
            label={t('settings.byos.onedrive.signIn')}
            chevron
            disabled={busy}
            onPress={() => void runSignIn()}
          />
        </SettingsGroup>
      ) : (
        <Text testID="onedrive-account" style={hintStyle}>
          {t('settings.byos.onedrive.signedInAs', { email: source.binding.accountEmail })}
        </Text>
      )}
      {error ? (
        <Text testID="byos-error" style={[settingsTypography.detail, { color: theme.danger, paddingHorizontal: metrics.contentPadding }]}>
          {t(signInFlowErrorKey(error, 'onedrive'))}
        </Text>
      ) : null}
      {probeResult?.kind === 'empty' ? (
        <>
          <Text testID="onedrive-probe-empty" style={hintStyle}>
            {t('settings.byos.onedrive.probeEmpty')}
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
