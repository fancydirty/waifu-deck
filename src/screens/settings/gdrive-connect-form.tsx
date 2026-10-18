import { useState } from 'react';
import { Text, View, type StyleProp, type TextStyle } from 'react-native';

import type {
  ByosConnectFailure,
  ConnectableProbe,
  ConnectResult,
  GdriveSignInResult,
  GdriveSource,
  ProbeResult,
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

type GdriveConnectInput = Readonly<{
  source: GdriveSource;
  probe: ConnectableProbe;
  password?: string;
  passwordConfirm?: string;
}>;

/**
 * The Google Drive twin of `OneDriveConnectForm` (board #12 P12-D, Task 11):
 * `signIn` opens the system browser for a Google account and resolves a
 * `GdriveSource` (refresh token plus the app's own `Waifu Deck` folder ids),
 * which is probed straight away — nothing is left for the user to type. Same
 * probe → branch → connect flow, the same local D9 password gate before the
 * unrecoverable-password warning, and no encryption toggle (spec §6: every
 * cloud-drive backend is always encrypted).
 *
 * The one difference is the 补裁 12 caveat, 「需要能访问 Google」: Google is
 * unreachable from mainland China and this build does not probe for it, so
 * the card says so up front. OneDrive has no such line on purpose — its
 * reachability was measured on the owner's network (P12-C); Drive's was not.
 */
export function GdriveConnectForm({
  signIn,
  probe,
  connect,
  onConnected,
  busy,
  setBusy,
}: {
  signIn: () => Promise<GdriveSignInResult>;
  probe: (source: GdriveSource) => Promise<ProbeResult>;
  connect: (input: GdriveConnectInput) => Promise<ConnectResult>;
  onConnected: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const [source, setSource] = useState<GdriveSource | null>(null);
  const [probeResult, setProbeResult] = useState<ConnectableProbe | null>(null);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState<ByosConnectFailure | null>(null);
  const [warningVisible, setWarningVisible] = useState(false);

  async function runSignIn() {
    // A retry starts clean: the previous attempt's error describes an attempt
    // that is over, and leaving it up while the browser is open reads as if
    // this one had already failed.
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

  // Same local D9 gate as the other forms: the unrecoverable-password warning
  // is never shown for input the create would reject anyway.
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
    <View testID="gdrive-connect-form">
      <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
        <SettingsBlock>
          <View style={{ gap: metrics.settingsConnect.stackGap }}>
            <Text style={cardHint}>{t('settings.byos.gdrive.intro')}</Text>
            <Text testID="gdrive-needs-google" style={cardHint}>{t('settings.byos.gdrive.needsGoogle')}</Text>
          </View>
        </SettingsBlock>
      </SettingsGroup>
      {source === null ? (
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
          <SettingsRow
            testID="gdrive-sign-in"
            label={t('settings.byos.gdrive.signIn')}
            chevron
            disabled={busy}
            onPress={() => void runSignIn()}
          />
        </SettingsGroup>
      ) : (
        <Text testID="gdrive-account" style={hintStyle}>
          {t('settings.byos.gdrive.signedInAs', { email: source.binding.accountEmail })}
        </Text>
      )}
      {error ? (
        <Text testID="byos-error" style={[settingsTypography.detail, { color: theme.danger, paddingHorizontal: metrics.contentPadding }]}>
          {t(signInFlowErrorKey(error, 'gdrive'))}
        </Text>
      ) : null}
      {probeResult?.kind === 'empty' ? (
        <>
          <Text testID="gdrive-probe-empty" style={hintStyle}>
            {t('settings.byos.gdrive.probeEmpty')}
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
