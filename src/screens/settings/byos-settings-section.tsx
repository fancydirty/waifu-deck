import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';

import {
  provisionS3FromApiKey,
  type ByosConnectFields,
  type ByosConnectFailure,
  type ConnectableProbe,
  type ConnectInput,
  type ConnectResult,
  type GdriveSignInResult,
  type GdriveSource,
  type OneDriveSource,
  type ProbeResult,
  type ReauthResult,
  type S3ApiKeyErrorCode,
  type S3ApiKeyProvider,
  type S3ApiKeyProvisionResult,
  type SignInResult,
  type WebdavConnectFields,
} from '@/features/byos/byos-connect-flow';
import type { ByosSignInProvider, ByosStatus } from '@/features/byos/byos-context-resolver';
import type { ByosBinding } from '@/features/byos/byos-credentials';
import type { VaultEncryption } from '@/features/byos/byos-vault-meta';
import type { LibraryStorageModeControl } from '@/features/library/library-integration-types';
import type { CloudLibraryData } from './use-cloud-library-data';
import type { LibraryStorageMode } from '@/features/library/library-storage-mode';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { errorKey } from '@/screens/settings/byos-error-key';
import { deriveCloudActionMessageKey } from './cloud-library-model';
import { ByosReadyView } from './byos-ready-view';
import { ByosLockedView } from './byos-locked-view';
import { SettingsBlock } from '@/screens/settings/ui/settings-block';
import { SettingsField } from '@/screens/settings/ui/settings-field';
import { GdriveConnectForm } from '@/screens/settings/gdrive-connect-form';
import { OneDriveConnectForm } from '@/screens/settings/onedrive-connect-form';
import { SettingsGroup } from '@/screens/settings/ui/settings-group';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { ChoiceModal, ConfirmModal } from '@/screens/settings/settings-dialogs';
import { StorageHelpCircleMark } from '@/screens/settings/cloud-marks';
import {
  S3ApiKeyQuickSetupModal,
  StorageAdviceFaqModal,
} from '@/screens/settings/s3-quick-setup-modals';
import { StorageLocationPicker } from '@/screens/settings/storage-location-picker';
import { WebdavConnectForm } from '@/screens/settings/webdav-connect-form';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { cloudTypography, settingsTypography } from '@/theme/typography';

/**
 * The connect-flow surface the section drives, injected so the section's tests
 * need no bucket, keychain, or transport. The neutral slot
 * (`byos-settings-slot.tsx`) binds these to the real `byos-connect-flow`
 * functions; `unlock` is the slot-composed "re-open the already-configured
 * vault with a password" path (load stored credentials → probe → open), which
 * the locked/`password_required` state uses. All remote failures arrive as
 * data (`{kind:'error'}` / `{ok:false}`), never thrown.
 */
export type ByosConnectFlow = {
  probeBucket(fields: ByosConnectFields): Promise<ProbeResult>;
  connectToBucket(input: ConnectInput): Promise<ConnectResult>;
  provisionS3FromApiKey?(
    rawInput: string,
    selectedProviderOverride?: S3ApiKeyProvider | null,
  ): Promise<S3ApiKeyProvisionResult>;
  probeWebdav(fields: WebdavConnectFields): Promise<ProbeResult>;
  connectWebdav(input: Readonly<{
    fields: WebdavConnectFields;
    probe: ConnectableProbe;
    password?: string;
    passwordConfirm?: string;
  }>): Promise<ConnectResult>;
  signInWithMicrosoft(): Promise<SignInResult>;
  probeOneDrive(source: OneDriveSource): Promise<ProbeResult>;
  connectOneDrive(input: Readonly<{
    source: OneDriveSource;
    probe: ConnectableProbe;
    password?: string;
    passwordConfirm?: string;
  }>): Promise<ConnectResult>;
  reauthOneDrive(): Promise<ReauthResult>;
  signInWithGoogle(): Promise<GdriveSignInResult>;
  probeGdrive(source: GdriveSource): Promise<ProbeResult>;
  connectGdrive(input: Readonly<{
    source: GdriveSource;
    probe: ConnectableProbe;
    password?: string;
    passwordConfirm?: string;
  }>): Promise<ConnectResult>;
  reauthGdrive(): Promise<ReauthResult>;
  unlock(password: string): Promise<ConnectResult>;
  disconnectDevice(): Promise<void>;
};

export type ByosSettingsSectionProps = {
  byosStatus: ByosStatus;
  connectFlow: ByosConnectFlow;
  onReload: () => void;
  /** The sole provider owns all passive reads and freshness. */
  data: CloudLibraryData;
  /**
   * Board #27 S3b: the composition's 本机存储 control. Absent on a locked or
   * unconfigured device, where the row is not shown.
   */
  storageMode?: LibraryStorageModeControl;
  /** Present when the Android foreground-service module is linked. */
  backgroundSync?: import('@/screens/settings/background-upload-row').BackgroundUploadPort;
  renderCloudMessage: (model: import('./cloud-library-model').CloudLibraryModel) => ReactNode;
};

// Keyed by provider (not a two-way ternary) so a third sign-in provider is a
// compile error here rather than silently getting OneDrive's action.
const REAUTH_BY_PROVIDER: Record<ByosSignInProvider, (flow: ByosConnectFlow) => ReturnType<ByosConnectFlow['reauthOneDrive']>> = {
  onedrive: (flow) => flow.reauthOneDrive(),
  gdrive: (flow) => flow.reauthGdrive(),
};

const DEFAULT_FIELDS: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secret: string;
  region: string;
} = {
  endpoint: '',
  bucket: '',
  accessKey: '',
  secret: '',
  region: '',
};

/**
 * MB (decimal-adjacent label, binary-divided) for a quota row's `used`/
 * `total` interpolation values, matching the rest of the app's storage rows
 * (e.g. `storage.collectionUsage`). One decimal place: a backend's own
 * accounting lags writes, so `12.3 MB` reads as an estimate rather than
 * implying false precision.
 */
function formatMebibytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Direct-only settings surface for BYOS sync (design D1/D7/D8). A three-state
 * machine over `byosStatus`:
 *
 * - `unconfigured` → the two-step connect form: four fields (+ region) →
 *   "check bucket" (probe) → a branch by what the bucket holds
 *   (join an existing encrypted/plain vault, or create a new one with an
 *   encryption switch, password, and an unrecoverable-password warning before
 *   create).
 * - `ready` → a status row (bucket + encryption), an optional "sync now", and
 *   "disconnect this device".
 * - `locked` → the reason shown to the user verbatim-ish (never disguised as
 *   "not configured"); `password_required` adds a password field and "unlock".
 *
 * On any successful connect / unlock / disconnect the section persists nothing
 * itself — the connect flow already wrote credentials + session — and calls
 * `onReload` so app-services rebuilds and the resolver picks the new state up
 * (D4). Config-time failures render inline (D7), never as a global notice.
 */
export function ByosSettingsSection({
  byosStatus,
  connectFlow,
  onReload,
  data,
  storageMode,
  backgroundSync,
  renderCloudMessage,
}: ByosSettingsSectionProps) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();

  const [fields, setFields] = useState(DEFAULT_FIELDS);
  const [probe, setProbe] = useState<ConnectableProbe | null>(null);
  const [encryption, setEncryption] = useState<VaultEncryption>('aes-gcm');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [unlockPassword, setUnlockPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ByosConnectFailure | null>(null);
  const [warningVisible, setWarningVisible] = useState(false);
  const [disconnectVisible, setDisconnectVisible] = useState(false);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const mirrorCounts = data.counts.state === 'read' ? data.counts.value : null;
  const { refreshStorageMode } = data;
  const storageModeValue = data.mode.state === 'read' && data.mode.fresh ? data.mode.value : null;
  const [picked, setPicked] = useState<ByosBinding['kind'] | null>(null);
  const [storageModeSheetVisible, setStorageModeSheetVisible] = useState(false);
  const [storageModeConfirm, setStorageModeConfirm] = useState<LibraryStorageMode | null>(null);
  const [faqVisible, setFaqVisible] = useState(false);
  const [apiKeyDialogVisible, setApiKeyDialogVisible] = useState(false);
  const [apiKeyDialogOpenSeq, setApiKeyDialogOpenSeq] = useState(0);
  const [apiKeyInitialProvider, setApiKeyInitialProvider] = useState<S3ApiKeyProvider | null>(null);
  const [apiKeyErrorCode, setApiKeyErrorCode] = useState<S3ApiKeyErrorCode | null>(null);

  const isReady = byosStatus.status === 'ready';
  const statusKey = byosStatus.status === 'locked'
    ? `${byosStatus.reason}/${'detail' in byosStatus ? byosStatus.detail : ''}/${'provider' in byosStatus ? byosStatus.provider : ''}`
    : byosStatus.status;

  const onStorageModePicked = useCallback((value: number | string) => {
    setStorageModeSheetVisible(false);
    if (value !== 'both' && value !== 'cloud-only') return;
    if (value === storageModeValue) return;
    // Spec §5.14: turning 仅云端 on warns; turning it off confirms the download.
    setStorageModeConfirm(value);
  }, [storageModeValue]);

  const applyStorageMode = useCallback(async (mode: LibraryStorageMode) => {
    setStorageModeConfirm(null);
    if (storageMode === undefined) return;
    setBusy(true);
    try {
      // `set` writes, then starts the round that evicts (§5.10) or downloads
      // (§5.13). A write that fails leaves the row on what is stored.
      await storageMode.set(mode).catch(() => undefined);
      await refreshStorageMode();
    } finally {
      setBusy(false);
    }
  }, [storageMode, refreshStorageMode]);

  // Prop-contract hygiene, not today's production mechanism: this component
  // promises a clean picker whenever `byosStatus.status` changes, so
  // `picked`, `probe`, and `error` — which only belong to the current,
  // continuous run of a single status — are cleared on every transition.
  // Manual reload, restore and delete-all go through `reloadAppServices` or
  // their own restart, which drops the provider to `loading` and remounts
  // this subtree. A network recovery rebinds in place and leaves the section
  // mounted, so this effect is what clears the picker then — the same path
  // this file's tests take via `rerender`.
  useEffect(() => {
    // A one-shot reset on a status transition, not a derived-state cascade:
    // every setter bails out when already null, and the resolver's status is
    // the external system this local UI state follows (the same synchronous
    // clear `library-cloud-slot-impl.tsx:22-27` uses when its controller
    // disappears mid-mount). The rule below reports once per effect, on the
    // first setState line, so this one directive covers all three setters.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPicked(null);
    setProbe(null);
    setError(null);
    setFaqVisible(false);
    setApiKeyDialogVisible(false);
    setApiKeyErrorCode(null);
  }, [statusKey]);

  const setField = useCallback(
    (key: keyof typeof DEFAULT_FIELDS) => (value: string) => {
      setError(null);
      setProbe(null);
      setFields((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  // Memoized because the connect callbacks below close over it: a fresh object
  // each render would rebuild every one of them on every keystroke. No `prefix`
  // key: the folder-prefix field is gone (U4-design ruling 2026-10-12), and an
  // absent prefix keeps meaning `BYOS_DEFAULT_PREFIX` ('waifu-deck/') — the
  // same target the field's empty value produced (pinned in
  // byos-connect-flow.test.ts).
  const currentFields: ByosConnectFields = useMemo(() => ({
    endpoint: fields.endpoint,
    bucket: fields.bucket,
    accessKey: fields.accessKey,
    secret: fields.secret,
    region: fields.region === '' ? undefined : fields.region,
  }), [fields]);

  const runCheck = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await connectFlow.probeBucket(currentFields);
      if (result.kind === 'error') {
        setError({ category: result.category, detail: result.detail });
        setProbe(null);
      } else {
        setProbe(result);
      }
    } finally {
      setBusy(false);
    }
  }, [connectFlow, currentFields]);

  const runConnectWithApiKey = useCallback(async (
    rawKey: string,
    provider: S3ApiKeyProvider,
  ) => {
    setBusy(true);
    setApiKeyErrorCode(null);
    setError(null);
    try {
      const provisionFn = connectFlow.provisionS3FromApiKey ?? provisionS3FromApiKey;
      const provisioned = await provisionFn(rawKey, provider);
      if (!provisioned.ok) {
        setApiKeyErrorCode(provisioned.errorCode);
        return;
      }
      let probed = await connectFlow.probeBucket(provisioned.fields);
      // Newly created Bunny S3 storage zones take ~1–3s to propagate to the regional S3 gateway
      const BUNNY_NEW_ZONE_RETRY_ATTEMPTS = 4;
      const BUNNY_NEW_ZONE_RETRY_DELAY_MS = 1200;
      if (
        probed.kind === 'error' &&
        probed.category !== 'network' &&
        provisioned.provider === 'bunny' &&
        provisioned.createdNewBucket
      ) {
        for (
          let attempt = 0;
          attempt < BUNNY_NEW_ZONE_RETRY_ATTEMPTS &&
          probed.kind === 'error' &&
          probed.category !== 'network';
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, BUNNY_NEW_ZONE_RETRY_DELAY_MS));
          probed = await connectFlow.probeBucket(provisioned.fields);
        }
      }
      if (probed.kind === 'error') {
        setApiKeyErrorCode(probed.category === 'network' ? 'network_error' : 'provider_error');
        return;
      }
      const nextFields = {
        endpoint: provisioned.fields.endpoint,
        bucket: provisioned.fields.bucket,
        accessKey: provisioned.fields.accessKey,
        secret: provisioned.fields.secret,
        region: provisioned.fields.region ?? '',
      };
      setFields(nextFields);
      setApiKeyDialogVisible(false);
      setPicked('s3');
      setProbe(probed);
    } finally {
      setBusy(false);
    }
  }, [connectFlow]);

  const finishConnect = useCallback((result: ConnectResult) => {
    if (result.ok) {
      onReload();
    } else {
      setError({ category: result.category, detail: result.detail });
    }
  }, [onReload]);

  const runConnect = useCallback(async (input: ConnectInput) => {
    setBusy(true);
    setError(null);
    try {
      finishConnect(await connectFlow.connectToBucket(input));
    } finally {
      setBusy(false);
    }
  }, [connectFlow, finishConnect]);

  const runCreate = useCallback(async () => {
    setWarningVisible(false);
    if (probe === null || probe.kind !== 'empty') return;
    await runConnect({
      fields: currentFields,
      probe,
      encryption,
      password: encryption === 'aes-gcm' ? password : undefined,
      passwordConfirm: encryption === 'aes-gcm' ? passwordConfirm : undefined,
    });
  }, [currentFields, encryption, password, passwordConfirm, probe, runConnect]);

  const onCreatePressed = useCallback(() => {
    // Encryption off: there is no password to forget, so the unrecoverable-
    // password warning does not apply. Creating a plaintext vault in an empty
    // bucket is a non-destructive, reversible action — like the join paths, it
    // proceeds directly on press with no confirmation gate (D8: no new design
    // language, and a confirm with no honest warning to show would be friction
    // for no safety reason).
    if (encryption !== 'aes-gcm') {
      setError(null);
      void runCreate();
      return;
    }
    // Local D9 validation before the warning: a create only proceeds with a
    // non-empty password typed the same way twice (mirrors the connect flow's
    // own `validateNewPassword`, so the warning is never shown for input the
    // create would reject anyway).
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
  }, [encryption, password, passwordConfirm, runCreate]);

  const runUnlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      finishConnect(await connectFlow.unlock(unlockPassword));
    } finally {
      setBusy(false);
    }
  }, [connectFlow, finishConnect, unlockPassword]);

  const runReauth = useCallback(async (provider: ByosSignInProvider) => {
    // A retry starts clean (the P12-C f3c24f2 finding, on this row): the last
    // attempt's error is about an attempt that is over.
    setError(null);
    setBusy(true);
    try {
      const result = await REAUTH_BY_PROVIDER[provider](connectFlow);
      if (result.ok) {
        onReload();
      } else {
        setError({ category: result.category, detail: result.detail });
      }
    } finally {
      setBusy(false);
    }
  }, [connectFlow, onReload]);

  const runDisconnect = useCallback(async () => {
    setDisconnectVisible(false);
    setDisconnectFailed(false);
    setBusy(true);
    try {
      await connectFlow.disconnectDevice();
      onReload();
    } catch {
      // Board #27 S4 (S3b T1 drift M5; spec §5.4): every store was attempted
      // and one refused. Nothing reloads and 断开此设备 can simply run again.
      // The mode store may have been cleared (the running composition then
      // reads 本地+云端 on its next round, R-S3-5), so the row re-reads what
      // is stored rather than keep showing the old choice.
      setDisconnectFailed(true);
      if (storageMode !== undefined) {
        await refreshStorageMode();
      }
    } finally {
      setBusy(false);
    }
  }, [connectFlow, onReload, storageMode, refreshStorageMode]);

  const errorRow = error === null ? null : (
    <Text
      testID="byos-error"
      style={[settingsTypography.detail, {
        color: theme.danger,
        paddingHorizontal: metrics.contentPadding,
        paddingVertical: metrics.spacing.small,
      }]}>
      {t(errorKey(error))}
    </Text>
  );

  // One factory invocation: action feedback replaces the status model only
  // for this page. Home retains the provider's original status snapshot.
  const actionError = byosStatus.status === 'locked' ? error : null;
  const cloudMessage = renderCloudMessage(actionError === null ? data.model
    : { ...data.model, messageKey: deriveCloudActionMessageKey(actionError) });
  const pageMessage = (
    <View
      testID={actionError === null ? undefined : 'byos-error'}
      accessibilityLiveRegion={actionError === null ? 'none' : 'polite'}>
      {cloudMessage}
    </View>
  );

  // U4-design visual pass (mockup §2-5): the back row is its own row card and
  // leads with the mockup's .wd-chev-l — the forward chevron flipped on X —
  // instead of a trailing forward chevron (owner-approved back treatment).
  const backRow = (
    <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.spacing.medium }}>
      <SettingsRow
        testID="storage-pick-back"
        label={t('settings.byos.locations.back')}
        icon={<View style={{ transform: [{ scaleX: -1 }] }}>
          <ChevronRight accessible={false} color={theme.textSecondary} size={18} />
        </View>}
        disabled={busy}
        onPress={() => {
          setPicked(null);
          setProbe(null);
          setError(null);
        }}
      />
    </SettingsGroup>
  );

  const disconnectRow = (
    <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
      <SettingsRow
        testID="byos-disconnect"
        label={t('settings.byos.disconnect')}
        detail={t('settings.byos.disconnectDetail')}
        destructive
        disabled={busy}
        onPress={() => setDisconnectVisible(true)}
      />
      {disconnectFailed ? (
        <Text
          testID="byos-disconnect-failed"
          style={[settingsTypography.detail, {
            color: theme.danger,
            paddingHorizontal: metrics.settingsGutter,
            paddingVertical: metrics.spacing.medium,
          }]}>
          {t('settings.byos.disconnectFailed')}
        </Text>
      ) : null}
    </SettingsGroup>
  );

  const disconnectModal = (
    <ConfirmModal
      visible={disconnectVisible}
      title={t('settings.byos.disconnectConfirm.title')}
      message={isReady && storageModeValue === 'cloud-only' && mirrorCounts !== null && mirrorCounts.inCloud > 0
        // Spec §5.16 (O1: warn and allow): only while ready, where the mode
        // and the count are known; one modal also serves the locked card.
        ? `${t('settings.byos.disconnectConfirm.message')}\n${t(
            'settings.byos.storageMode.disconnectExtra',
            { count: mirrorCounts.inCloud },
          )}`
        : t('settings.byos.disconnectConfirm.message')}
      confirmLabel={t('settings.byos.disconnectConfirm.confirm')}
      onCancel={() => setDisconnectVisible(false)}
      onConfirm={() => void runDisconnect()}
    />
  );

  return (
    <View testID="byos-section" style={{ gap: metrics.spacing.small }}>
      {/* No in-page 云库 label: the page head (app-bar) owns the page title
          (U4-design ruling 4, 2026-10-12) — the content never repeats it. */}

      {byosStatus.status === 'unconfigured' && picked === null ? (
        <View testID="cloud-unconfigured" style={{ gap: metrics.spacing.small, paddingHorizontal: metrics.contentPadding }}>
          <Text style={{ ...cloudTypography.provider, color: theme.text }}>
            {t('settings.cloudLibrary.heroTitle')}
          </Text>
          {pageMessage}
          <Pressable
            testID="cloud-storage-faq-button"
            onPress={() => setFaqVisible(true)}
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: theme.saveSoft,
              marginTop: 2,
              opacity: pressed ? 0.72 : 1,
            })}>
            <StorageHelpCircleMark size={15} color={theme.saveDeep} />
            <Text style={[cloudTypography.pill, { color: theme.saveDeep }]}>
              {t('settings.cloudLibrary.faq.trigger')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {byosStatus.status === 'unconfigured' ? (
        picked === null ? (
          <StorageLocationPicker
            onPick={setPicked}
            onOpenApiKeyDialog={(provider) => {
              setApiKeyErrorCode(null);
              setApiKeyInitialProvider(provider ?? null);
              setApiKeyDialogOpenSeq((seq) => seq + 1);
              setApiKeyDialogVisible(true);
            }}
          />
        ) : picked === 's3' ? (
          <View>
            {/* The S3 flow's single exit: rendered on the form step and the
                probe-result step alike (the latter has no other way back),
                it owns `probe`'s (and `error`'s) whole lifecycle so
                `picked === null` can never coexist with a stale probe
                result — without this reset, re-picking S3 would land back
                on that old probe/password step instead of a fresh form. */}
            {backRow}
            {probe === null ? (
              <>
                <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
                  <SettingsBlock paddingHorizontal={metrics.settingsConnect.fieldCardPaddingH}>
                    <View style={{ gap: metrics.settingsConnect.stackGap }}>
                      <SettingsField
                        testID="byos-field-endpoint"
                        accessibilityLabel={t('settings.byos.fields.endpoint')}
                        keyboardType="url"
                        placeholder={t('settings.byos.fields.endpointPlaceholder')}
                        value={fields.endpoint}
                        onChangeText={setField('endpoint')}
                        paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
                      />
                      <SettingsField
                        testID="byos-field-bucket"
                        accessibilityLabel={t('settings.byos.fields.bucket')}
                        placeholder={t('settings.byos.fields.bucket')}
                        value={fields.bucket}
                        onChangeText={setField('bucket')}
                        paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
                      />
                      <SettingsField
                        testID="byos-field-access-key"
                        accessibilityLabel={t('settings.byos.fields.accessKey')}
                        placeholder={t('settings.byos.fields.accessKey')}
                        value={fields.accessKey}
                        onChangeText={setField('accessKey')}
                        paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
                      />
                      <SettingsField
                        testID="byos-field-secret"
                        accessibilityLabel={t('settings.byos.fields.secret')}
                        secureTextEntry
                        placeholder={t('settings.byos.fields.secret')}
                        value={fields.secret}
                        onChangeText={setField('secret')}
                        paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
                      />
                      <SettingsField
                        testID="byos-field-region"
                        accessibilityLabel={t('settings.byos.fields.region')}
                        placeholder={t('settings.byos.fields.regionPlaceholder')}
                        value={fields.region}
                        onChangeText={setField('region')}
                        paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
                      />
                      <Text style={[settingsTypography.connectHint, { color: theme.textSecondary }]}>
                        {t('settings.byos.fields.regionHint')}
                      </Text>
                    </View>
                  </SettingsBlock>
                </SettingsGroup>
                {errorRow}
                <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
                  <SettingsRow
                    testID="byos-check"
                    label={t('settings.byos.check')}
                    chevron
                    disabled={busy}
                    onPress={() => void runCheck()}
                  />
                </SettingsGroup>
              </>
            ) : probe.kind === 'existing-encrypted' ? (
              <>
                <Text
                  testID="byos-probe-existing-encrypted"
                  style={[settingsTypography.connectHint, {
                    color: theme.text,
                    paddingHorizontal: metrics.contentPadding,
                  }]}>
                  {t('settings.byos.probe.existingEncrypted')}
                </Text>
                <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
                  <SettingsBlock paddingHorizontal={metrics.settingsConnect.fieldCardPaddingH}>
                    <View style={{ gap: metrics.settingsConnect.stackGap }}>
                      <SettingsField
                        testID="byos-field-password"
                        accessibilityLabel={t('settings.byos.password')}
                        secureTextEntry
                        placeholder={t('settings.byos.password')}
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
                {errorRow}
                <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
                  <SettingsRow
                    testID="byos-join"
                    label={t('settings.byos.join')}
                    chevron
                    disabled={busy}
                    onPress={() => void runConnect({ fields: currentFields, probe, password })}
                  />
                </SettingsGroup>
              </>
            ) : probe.kind === 'existing-plain' ? (
              <>
                <Text
                  testID="byos-probe-existing-plain"
                  style={[settingsTypography.connectHint, {
                    color: theme.text,
                    paddingHorizontal: metrics.contentPadding,
                  }]}>
                  {t('settings.byos.probe.existingPlain')}
                </Text>
                {errorRow}
                <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
                  <SettingsRow
                    testID="byos-join"
                    label={t('settings.byos.join')}
                    chevron
                    disabled={busy}
                    onPress={() => void runConnect({ fields: currentFields, probe })}
                  />
                </SettingsGroup>
              </>
            ) : (
              <>
                <Text
                  testID="byos-probe-empty"
                  style={[settingsTypography.connectHint, {
                    color: theme.text,
                    paddingHorizontal: metrics.contentPadding,
                  }]}>
                  {t('settings.byos.probe.empty')}
                </Text>
                <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
                  <SettingsRow
                    label={t('settings.byos.encryptionLabel')}
                    detail={t('settings.byos.encryptionDetail')}
                    trailing={(
                      <Switch
                        testID="byos-encryption-toggle"
                        accessibilityLabel={t('settings.byos.encryptionLabel')}
                        trackColor={{ false: theme.border, true: theme.save }}
                        thumbColor={theme.switchThumb}
                        disabled={busy}
                        value={encryption === 'aes-gcm'}
                        onValueChange={(on) => {
                          setError(null);
                          setEncryption(on ? 'aes-gcm' : 'none');
                        }}
                      />
                    )}
                  />
                </SettingsGroup>
                {encryption === 'aes-gcm' ? (
                  <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
                    <SettingsBlock paddingHorizontal={metrics.settingsConnect.fieldCardPaddingH}>
                      <View style={{ gap: metrics.settingsConnect.stackGap }}>
                        <SettingsField
                          testID="byos-field-password"
                          accessibilityLabel={t('settings.byos.password')}
                          secureTextEntry
                          placeholder={t('settings.byos.password')}
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
                          secureTextEntry
                          placeholder={t('settings.byos.passwordConfirm')}
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
                ) : null}
                {errorRow}
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
            )}
          </View>
        ) : picked === 'webdav' ? (
          <View>
            {backRow}
            <WebdavConnectForm
              probe={connectFlow.probeWebdav}
              connect={connectFlow.connectWebdav}
              onConnected={onReload}
              busy={busy}
              setBusy={setBusy}
            />
          </View>
        ) : picked === 'onedrive' ? (
          <View>
            {backRow}
            <OneDriveConnectForm
              signIn={connectFlow.signInWithMicrosoft}
              probe={connectFlow.probeOneDrive}
              connect={connectFlow.connectOneDrive}
              onConnected={onReload}
              busy={busy}
              setBusy={setBusy}
            />
          </View>
        ) : picked === 'gdrive' ? (
          <View>
            {backRow}
            <GdriveConnectForm
              signIn={connectFlow.signInWithGoogle}
              probe={connectFlow.probeGdrive}
              connect={connectFlow.connectGdrive}
              onConnected={onReload}
              busy={busy}
              setBusy={setBusy}
            />
          </View>
        ) : null
      ) : null}

      {byosStatus.status === 'ready' ? (
        <ByosReadyView
          data={data}
          modeControlPresent={storageMode !== undefined && storageModeValue !== null && mirrorCounts !== null}
          busy={busy}
          onStorageModePress={() => setStorageModeSheetVisible(true)}
          backgroundSync={backgroundSync}
          disconnect={disconnectRow}
        />
      ) : null}

      {byosStatus.status === 'locked' ? (
        <ByosLockedView
          data={data}
          password={unlockPassword}
          busy={busy}
          onPasswordChange={(value) => {
            setError(null);
            setUnlockPassword(value);
          }}
          onUnlock={() => void runUnlock()}
          onReauth={(provider) => void runReauth(provider)}
          backgroundSync={backgroundSync}
          disconnect={disconnectRow}
          message={pageMessage}
        />
      ) : null}

      <ConfirmModal
        visible={warningVisible}
        title={t('settings.byos.warning.title')}
        message={t('settings.byos.warning.message')}
        confirmLabel={t('settings.byos.warning.confirm')}
        onCancel={() => setWarningVisible(false)}
        onConfirm={() => void runCreate()}
      />
      <ChoiceModal
        visible={storageModeSheetVisible}
        title={t('settings.byos.storageMode.label')}
        options={[
          { label: t('settings.byos.storageMode.both'), value: 'both' },
          { label: t('settings.byos.storageMode.cloudOnly'), value: 'cloud-only' },
        ]}
        selectedValue={storageModeValue}
        onClose={() => setStorageModeSheetVisible(false)}
        onSelect={onStorageModePicked}
      />
      <ConfirmModal
        visible={storageModeConfirm === 'cloud-only'}
        title={t('settings.byos.storageMode.warn.title')}
        message={t('settings.byos.storageMode.warn.message')}
        confirmLabel={t('settings.byos.storageMode.warn.confirm')}
        onCancel={() => setStorageModeConfirm(null)}
        onConfirm={() => void applyStorageMode('cloud-only')}
      />
      <ConfirmModal
        visible={storageModeConfirm === 'both'}
        title={t('settings.byos.storageMode.back.title')}
        message={t('settings.byos.storageMode.back.message', {
          count: mirrorCounts?.inCloud ?? 0,
          size: formatMebibytes(mirrorCounts?.inCloudBytes ?? 0),
        })}
        confirmLabel={t('settings.byos.storageMode.back.confirm')}
        onCancel={() => setStorageModeConfirm(null)}
        onConfirm={() => void applyStorageMode('both')}
      />
      {disconnectModal}
      <StorageAdviceFaqModal
        visible={faqVisible}
        onClose={() => setFaqVisible(false)}
      />
      <S3ApiKeyQuickSetupModal
        key={apiKeyDialogOpenSeq}
        visible={apiKeyDialogVisible}
        initialProvider={apiKeyInitialProvider}
        busy={busy}
        errorCode={apiKeyErrorCode}
        onClearError={() => setApiKeyErrorCode(null)}
        onClose={() => {
          if (!busy) setApiKeyDialogVisible(false);
        }}
        onConnect={(rawKey, provider) => void runConnectWithApiKey(rawKey, provider)}
      />
    </View>
  );
}
