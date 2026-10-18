import { useMemo, type ComponentProps } from 'react';
import { act, fireEvent, render as rntlRender, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type {
  ConnectInput,
  ConnectResult,
  GdriveSignInResult,
  ProbeResult,
  ReauthResult,
  SignInResult,
} from '@/features/byos/byos-connect-flow';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { GoogleDriveBinding, OneDriveBinding } from '@/features/byos/byos-credentials';
import type { VaultEncryption, VaultMeta } from '@/features/byos/byos-vault-meta';
import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import type { LibraryStorageModeControl } from '@/features/library/library-integration-types';
import type { LibraryMirrorCounts } from '@/features/library/library-protection-repository';
import type { LibraryStorageMode } from '@/features/library/library-storage-mode';
import i18n from '@/i18n';
import {
  ByosSettingsSection as Section,
  type ByosConnectFlow,
} from '@/screens/settings/byos-settings-section';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

import { cloudCounts, cloudRead, cloudSnapshot } from '@/test/cloud-library-fixtures';
import { useCloudLibraryData } from './use-cloud-library-data';
import { renderCloudMessage } from '@/test/cloud-message-fixture';

jest.mock('lucide-react-native', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  const Icon = () => null;
  // The row chevron renders a findable host (settings-row.test.tsx pattern):
  // the U4-design back-row pin reads its slot and its flip transform.
  const ChevronRight = (props: Record<string, unknown>) =>
    React.createElement(View, { ...props, testID: 'chevron', accessible: false });
  return { Check: Icon, ChevronRight, Cloud: Icon, Lock: Icon, Server: Icon };
});

async function render(element: React.ReactElement<FixtureProps>) {
  let current = element;
  const status = element.props.byosStatus;
  if (status?.status === 'ready' && status.context.kind === 'store' && element.props.data === undefined) {
    const quota = await status.context.store.quota().catch(() => null);
    current = <ByosSettingsSection {...element.props} data={cloudSnapshot(status, { quota })} />;
  }
  return rntlRender(current);
}

type FixtureProps = Omit<ComponentProps<typeof Section>, 'data' | 'renderCloudMessage'> & {
  data?: ComponentProps<typeof Section>['data'];
  counts?: LibraryMirrorCounts;
};
function ByosSettingsSection(props: FixtureProps) {
  const readers = useMemo(() => ({ readStoredIdentity: async () => null,
    readMirrorCounts: props.counts === undefined ? undefined : async () => props.counts!,
    readStorageMode: props.storageMode === undefined ? undefined : () => props.storageMode!.read(),
  }), [props.counts, props.storageMode]);
  const modeData = useCloudLibraryData({ byosStatus: props.byosStatus, readers, enabled: props.storageMode !== undefined });
  const data = props.data ?? (props.storageMode ? modeData : cloudSnapshot(props.byosStatus));
  return <Section {...props} data={data} renderCloudMessage={renderCloudMessage} />;
}

function flow(overrides: Partial<ByosConnectFlow> = {}): ByosConnectFlow {
  return {
    probeBucket: jest.fn(async () => ({ kind: 'empty' }) as ProbeResult),
    connectToBucket: jest.fn(
      async () => ({ ok: true, vaultId: 'v1', encryption: 'aes-gcm' }) as ConnectResult,
    ),
    probeWebdav: jest.fn(async () => ({ kind: 'empty' }) as ProbeResult),
    connectWebdav: jest.fn(
      async () => ({ ok: true, vaultId: 'v1', encryption: 'aes-gcm' }) as ConnectResult,
    ),
    signInWithMicrosoft: jest.fn(
      async () => ({
        ok: true,
        source: { binding: ONEDRIVE_BINDING, accessToken: 'access-token', expiresAt: Date.now() + 3600_000 },
      }) as SignInResult,
    ),
    probeOneDrive: jest.fn(async () => ({ kind: 'empty' }) as ProbeResult),
    connectOneDrive: jest.fn(
      async () => ({ ok: true, vaultId: 'v1', encryption: 'aes-gcm' }) as ConnectResult,
    ),
    reauthOneDrive: jest.fn(async () => ({ ok: true }) as ReauthResult),
    signInWithGoogle: jest.fn(
      async () => ({
        ok: true,
        source: { binding: GDRIVE_BINDING, accessToken: 'access-token', expiresAt: Date.now() + 3600_000 },
      }) as GdriveSignInResult,
    ),
    probeGdrive: jest.fn(async () => ({ kind: 'empty' }) as ProbeResult),
    connectGdrive: jest.fn(
      async () => ({ ok: true, vaultId: 'v1', encryption: 'aes-gcm' }) as ConnectResult,
    ),
    reauthGdrive: jest.fn(async () => ({ ok: true }) as ReauthResult),
    unlock: jest.fn(
      async () => ({ ok: true, vaultId: 'v1', encryption: 'aes-gcm' }) as ConnectResult,
    ),
    disconnectDevice: jest.fn(async () => undefined),
    ...overrides,
  };
}

function meta(encryption: VaultEncryption): VaultMeta {
  return {
    format: 'waifu-deck-byos',
    protocolVersion: 1,
    encryption,
    vaultId: 'v1',
    kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'c2FsdA==' },
    keyCheckB64: 'a2V5',
    createdAt: '2026-08-30T00:00:00.000Z',
  };
}

function readyStatus(encryption: VaultEncryption = 'aes-gcm'): ByosStatus {
  return {
    status: 'ready',
    context: {
      kind: 's3',
      credentials: {
        kind: 's3',
        endpoint: 'https://example.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'my-bucket',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        prefix: 'waifu-deck/',
      },
      meta: meta(encryption),
      masterKey: new Uint8Array(32),
      deviceId: 'device-1',
    },
  };
}

const UNCONFIGURED: ByosStatus = { status: 'unconfigured' };

const ONEDRIVE_BINDING: OneDriveBinding = {
  kind: 'onedrive',
  refreshToken: 'stored-refresh-token',
  accountEmail: 'owner@example.com',
  rootFolderId: 'F1',
  stateFolderId: 'F2',
  blobsFolderId: 'F3',
};

const GDRIVE_BINDING: GoogleDriveBinding = {
  kind: 'gdrive',
  refreshToken: 'stored-google-refresh-token',
  accountEmail: 'owner@gmail.com',
  rootFolderId: 'G1',
  stateFolderId: 'G2',
  blobsFolderId: 'G3',
};

const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const;
// t() falls back to English; the per-locale assertions read each locale's own resource.
const own = (lng: string, key: string) => i18n.getResource(lng, 'translation', key) as string;
const MICROSOFT = /OneDrive|Microsoft|微软|微軟|マイクロソフト/;
const GOOGLE = /Google|谷歌|グーグル/;

async function fillForm() {
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('byos-field-endpoint'), 'https://e.example.com');
    await fireEvent.changeText(screen.getByTestId('byos-field-bucket'), 'my-bucket');
    await fireEvent.changeText(screen.getByTestId('byos-field-access-key'), 'key');
    await fireEvent.changeText(screen.getByTestId('byos-field-secret'), 'secret');
  });
}

async function typeInto(testID: string, value: string) {
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId(testID), value);
  });
}

/** The v4 group cards on the connect surfaces (U4-design visual pass). */
function connectCards() {
  return screen.container.queryAll((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.borderRadius === metrics.radius.card && style?.marginHorizontal === metrics.settingsGutter;
  });
}

async function openS3Form(
  connectFlow: ByosConnectFlow = flow(),
  onReload: () => void = jest.fn(),
) {
  await render(
    <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={onReload} />,
  );
  await act(async () => {
    await fireEvent.press(screen.getByTestId('storage-pick-s3'));
  });
}

describe('BYOS settings section', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('snapshot freshness suppresses the old always-visible sync line', async () => {
    const status = readyStatus();
    const counts = { state: 'read' as const, fresh: false, roundId: 2, value: {
      backedUp: 2, backedUpTotal: 2, downloaded: 2, downloadedTotal: 2,
      inCloud: 0, inCloudBytes: 0, totalBytes: 150, pending: 0,
    } };
    await render(<ByosSettingsSection byosStatus={status} connectFlow={flow()} onReload={jest.fn()}
      data={{ counts, lastSyncedAt: { state: 'read', value: 100, fresh: true, roundId: 2 },
        quotaFullCount: { state: 'read', value: 0, fresh: true, roundId: 2 },
        mode: { state: 'read', value: 'both', fresh: true, roundId: null },
        quota: null, readRoundId: 2, viewNowMs: 1000, refreshStorageMode: jest.fn(),
        model: { state: 'ready', identity: null, tone: 'ok', messageKey: null,
          reauthProvider: null, stats: { inCloud: 2, totalBytes: 150, pending: 0 },
          footer: null, storageMode: 'both', encryption: 'aes-gcm' } }}
      />);
    expect(screen.queryByTestId('byos-last-sync')).toBeNull();
    expect(screen.getByTestId('cloud-stat-in-cloud')).toHaveTextContent('2 images');
  });

  it.each(['en', 'ja', 'zh-Hans', 'zh-Hant'])(
    '%s: the whole unconfigured section shows no scoped-folder explanation (§4.10)',
    async (lng) => {
      await i18n.changeLanguage(lng);
      const view = await render(
        <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
      );
      // The hero, picker groups and subtitles help the user choose; none of them
      // may explain the app's dedicated-folder mechanism (review finding 6 / R6e).
      expect(JSON.stringify(view.toJSON())).not.toMatch(/folder|文件夹|資料夾|フォルダ/i);
    },
  );

  it('renders the connect form when unconfigured', async () => {
    await openS3Form();
    expect(screen.getByTestId('byos-field-endpoint')).toBeTruthy();
    expect(screen.getByTestId('byos-field-secret')).toBeTruthy();
    expect(screen.getByTestId('byos-check')).toBeTruthy();
  });

  it('U4-design visual pass: the five S3 fields sit in ONE v4 field card, the region hint at the card foot', async () => {
    await openS3Form();
    const fieldIds = ['byos-field-endpoint', 'byos-field-bucket', 'byos-field-access-key',
      'byos-field-secret', 'byos-field-region'];
    const fieldCards = connectCards().filter((card) => within(card).queryByTestId('byos-field-endpoint') !== null);
    expect(fieldCards).toHaveLength(1);
    const card = fieldCards[0]!;
    for (const id of fieldIds) expect(within(card).getByTestId(id)).toBeOnTheScreen();
    // The region hint belongs to the fields card (its foot), not the page.
    const hint = i18n.t('settings.byos.fields.regionHint');
    expect(within(card).getByText(hint)).toBeOnTheScreen();
    expect(screen.getByTestId('byos-field-region').parent).toHaveStyle({
      gap: metrics.settingsConnect.stackGap,
    });
    const cardJson = JSON.stringify(card);
    expect(cardJson.indexOf('byos-field-region')).toBeLessThan(cardJson.indexOf(hint));
    // The v4 field box, with the mockup's card-context fit compensation
    // (.wd-input padding 12 → 8) in place of the plain field default.
    const field = screen.getByTestId('byos-field-endpoint');
    expect(field).toHaveStyle({
      ...settingsTypography.field,
      minHeight: metrics.minimumHitArea,
      borderWidth: metrics.settingsFieldBorderWidth,
      borderRadius: metrics.settingsRadius.field,
      borderColor: colors.light.border,
      backgroundColor: colors.light.surfaceSecondary,
      paddingHorizontal: metrics.settingsConnect.fieldPaddingH,
    });
    // The shared field carries no outer margin; the card block owns the inset
    // and the card column owns the .wd-form/.wd-p 10 rhythm.
    const fieldStyle = StyleSheet.flatten(field.props.style);
    expect(fieldStyle.marginHorizontal).toBeUndefined();
    expect(fieldStyle.marginVertical).toBeUndefined();
    expect(field.parent).toHaveStyle({ gap: metrics.settingsConnect.stackGap });
    expect(field.parent?.parent).toHaveStyle({
      paddingHorizontal: metrics.settingsConnect.fieldCardPaddingH,
    });
  });

  it('U4-design visual pass: the back row leads with the flipped chevron and carries no trailing one', async () => {
    await openS3Form();
    const back = screen.getByTestId('storage-pick-back');
    // The mockup's .wd-chev-l is the forward chevron flipped on X, at the row
    // start; the row carries exactly one chevron, so there is no trailing one.
    const backChevrons = within(back).queryAllByTestId('chevron');
    expect(backChevrons).toHaveLength(1);
    // The flip lives on a wrapping View: a transform styled directly on the
    // lucide icon reserves its slot but paints nothing on device (the by-eye
    // finding 2026-10-12), while a View transform paints reliably.
    const chevWrap = backChevrons[0]!.parent!;
    expect(StyleSheet.flatten(chevWrap.props.style)).toMatchObject({ transform: [{ scaleX: -1 }] });
    // The icon slot leads: the wrapper is the row's first host child, so the
    // chevron draws before the label and nothing trails it.
    const backHosts = back.children.filter((node) => typeof node !== 'string');
    expect(backHosts[0]).toBe(chevWrap);
    // Its own row card, and forward rows keep their trailing chevron after the label.
    const backCards = connectCards().filter((card) => within(card).queryByTestId('storage-pick-back') !== null);
    expect(backCards).toHaveLength(1);
    expect(within(backCards[0]!).queryAllByRole('button')).toHaveLength(1);
    const check = screen.getByTestId('byos-check');
    const checkChevrons = within(check).queryAllByTestId('chevron');
    expect(checkChevrons).toHaveLength(1);
    const checkHosts = check.children.filter((node) => typeof node !== 'string');
    expect(checkHosts[checkHosts.length - 1]).toBe(checkChevrons[0]);
    expect(checkHosts[0]).not.toBe(checkChevrons[0]);
  });

  it('U4-design (2026-10-12): the folder-prefix field is gone and a check carries no prefix', async () => {
    const connectFlow = flow();
    await openS3Form(connectFlow);
    expect(screen.queryByTestId('byos-field-prefix')).toBeNull();
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    const sent = (connectFlow.probeBucket as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
    // No prefix key at all: the default `waifu-deck/` now comes from the flow
    // (pinned in byos-connect-flow.test.ts), exactly as the empty field sent it.
    expect('prefix' in sent).toBe(false);
    expect(connectFlow.probeBucket).toHaveBeenCalledWith({
      endpoint: 'https://e.example.com', bucket: 'my-bucket', accessKey: 'key', secret: 'secret', region: undefined,
    });
  });

  it.each([
    ['en', "CF R2: region can be 'auto'", 'Check Bucket'],
    ['zh-Hans', 'CF R2 可填 region 为 auto', '检查 Bucket'],
    ['zh-Hant', 'CF R2 可填 region 為 auto', '檢查 Bucket'],
    ['ja', 'CF R2 は region に auto を入力できます', 'バケットを確認'],
  ] as const)('%s: the region field identifies itself, the CF R2 hint replaces the AWS/MinIO sentence, and check uses the Bucket token', async (lng, hint, checkLabel) => {
    await i18n.changeLanguage(lng);
    await openS3Form();
    expect(screen.getByTestId('byos-field-region').props.placeholder).toBe('region');
    expect(screen.getByTestId('byos-field-region').props.accessibilityLabel).toBe(own(lng, 'settings.byos.fields.region'));
    expect(screen.getByText(hint, { exact: true })).toBeTruthy();
    expect(screen.getByTestId('byos-check')).toHaveTextContent(checkLabel);
    // The old hint's AWS S3 / MinIO sentence is replaced entirely (owner ruling).
    expect(JSON.stringify(screen.getByTestId('byos-section').toJSON())).not.toMatch(/MinIO/);
    expect(own(lng, 'settings.byos.fields.regionHint')).toBe(hint);
    expect(own(lng, 'settings.byos.check')).toBe(checkLabel);
  });

  it('U4-design (2026-10-12): the in-page 云库 label is gone from the connect surfaces (the page head keeps the title)', async () => {
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
    );
    expect(screen.queryByText(own('en', 'settings.byos.heading'))).toBeNull();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-s3'));
    });
    expect(screen.queryByText(own('en', 'settings.byos.heading'))).toBeNull();
  });

  it('the in-page 云库 label is gone from the ready page too — the app-bar title is the page title', async () => {
    await render(
      <ByosSettingsSection byosStatus={readyStatus('aes-gcm')} connectFlow={flow()} onReload={jest.fn()} />,
    );
    expect(screen.queryByText(own('en', 'settings.byos.heading'))).toBeNull();
  });

  it('renders the status row and disconnect when ready, with no manual sync button', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={readyStatus('aes-gcm')}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('byos-status')).toHaveTextContent(/my-bucket/);
    expect(screen.queryByTestId('byos-sync-now')).toBeNull();
    expect(screen.getByTestId('byos-disconnect')).toBeTruthy();
  });

  it('renders stale stats from the injected snapshot and only the selected fresh footer', async () => {
    const status = readyStatus();
    const data = cloudSnapshot(status, { counts: cloudRead(cloudCounts),
      lastSyncedAt: cloudRead(100), quotaFullCount: cloudRead(3), mode: cloudRead('both', null) });
    const { rerender } = await render(<ByosSettingsSection byosStatus={status} connectFlow={flow()}
      onReload={jest.fn()} data={data} />);
    expect(screen.getByTestId('byos-quota-full')).toHaveTextContent('Drive full, 3 images waiting to upload');
    expect(screen.queryByTestId('byos-last-sync')).toBeNull();
    await rerender(<ByosSettingsSection byosStatus={status} connectFlow={flow()} onReload={jest.fn()}
      data={cloudSnapshot(status, { ...data, quotaFullCount: { ...cloudRead(3), fresh: false } })} />);
    expect(screen.queryByTestId('byos-quota-full')).toBeNull();
    expect(screen.queryByTestId('byos-last-sync')).toBeNull();
    expect(screen.getByTestId('cloud-stat-in-cloud')).toHaveTextContent('2 images');
  });

  it('a read zero is displayed; unread and failed counts have no numeric progress', async () => {
    const status = readyStatus();
    const { rerender } = await render(<ByosSettingsSection byosStatus={status} connectFlow={flow()}
      onReload={jest.fn()} data={cloudSnapshot(status, { counts: cloudRead({ ...cloudCounts,
        backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0 }) })} />);
    expect(screen.getByTestId('cloud-stat-in-cloud')).toHaveTextContent('0 images');
    for (const state of ['unread', 'error'] as const) {
      await rerender(<ByosSettingsSection byosStatus={status} connectFlow={flow()} onReload={jest.fn()}
        data={cloudSnapshot(status, { counts: { state, fresh: false, roundId: 1 } })} />);
      expect(screen.queryByTestId('byos-mirror-progress')).toBeNull();
      expect(screen.queryByTestId('byos-last-sync')).toBeNull();
    }
  });

  it.each(LOCALES)('selected relative synced footer and never-synced use real %s translations', async (language) => {
    await i18n.changeLanguage(language);
    const status = readyStatus();
    const data = cloudSnapshot(status, { counts: cloudRead(cloudCounts), lastSyncedAt: cloudRead(940_000),
      quotaFullCount: cloudRead(0), mode: cloudRead('both', null) });
    const { rerender } = await render(<ByosSettingsSection byosStatus={status} connectFlow={flow()} onReload={jest.fn()} data={data} />);
    expect(screen.getByTestId('byos-last-sync')).toHaveTextContent(i18n.t('settings.cloudLibrary.footer.synced', {
      age: i18n.t('settings.cloudLibrary.age.minutesAgo', { count: 1 }) }));
    await rerender(<ByosSettingsSection byosStatus={status} connectFlow={flow()} onReload={jest.fn()}
      data={cloudSnapshot(status, { ...data, lastSyncedAt: cloudRead(null) })} />);
    expect(screen.getByTestId('byos-last-sync')).toHaveTextContent(own(language, 'settings.byos.status.neverSynced'));
  });

  it.each([
    ['en', '7 images still waiting to upload', 'Downloading, 3 images remaining'],
    ['zh-Hans', '还有 7 张待上传', '正在下载，还差 3 张'],
    ['zh-Hant', '還有 7 張待上傳', '正在下載，還差 3 張'],
    ['ja', 'あと 7 枚がアップロード待ち', 'ダウンロード中、残り 3 枚'],
  ] as const)('%s renders distinct pending and downloading footers without a competing sync line', async (language, pendingText, downloadingText) => {
    await i18n.changeLanguage(language);
    const status = readyStatus();
    // Both waiting uploads and missing originals are present: pending must win.
    const counts = { ...cloudCounts, pending: 7, downloaded: 2, downloadedTotal: 5 };
    const data = cloudSnapshot(status, { counts: cloudRead(counts), lastSyncedAt: cloudRead(940_000),
      quotaFullCount: cloudRead(0), mode: cloudRead('both', null) });
    const props = { byosStatus: status, connectFlow: flow(), onReload: jest.fn() };
    const { rerender, unmount } = await render(<ByosSettingsSection {...props} data={data} />);
    expect(screen.getByTestId('byos-cloud-footer')).toHaveTextContent(pendingText, { exact: true });
    expect(screen.queryByText(downloadingText)).toBeNull();
    expect(screen.queryByTestId('byos-last-sync')).toBeNull();
    expect(screen.queryByTestId('byos-quota-full')).toBeNull();
    await rerender(<ByosSettingsSection {...props} data={cloudSnapshot(status, {
      ...data, counts: cloudRead({ ...counts, pending: 0 }),
    })} />);
    expect(screen.getByTestId('byos-cloud-footer')).toHaveTextContent(downloadingText, { exact: true });
    expect(screen.queryByText(pendingText)).toBeNull();
    expect(screen.queryByTestId('byos-last-sync')).toBeNull();
    expect(screen.queryByTestId('byos-quota-full')).toBeNull();
    await unmount();
  });

  it('renders the locked reason and unlock control when password is required', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'password_required' }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('byos-locked-reason')).toBeTruthy();
    expect(screen.getByTestId('byos-unlock-password')).toBeTruthy();
    expect(screen.getByTestId('byos-unlock')).toBeTruthy();
  });

  it('renders a reason for a non-password lock without an unlock field', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'network' }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('byos-locked-reason')).toBeTruthy();
    expect(screen.queryByTestId('byos-unlock')).toBeNull();
  });

  it('a vault_unreachable lock whose detail is not_webdav reads the WebDAV copy, never the bucket copy', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'not_webdav' }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    const reason = screen.getByTestId('byos-locked-reason');
    expect(reason).toHaveTextContent(own('en', 'settings.cloudLibrary.lockMessage.other'));
    expect(reason).not.toHaveTextContent(/usable bucket/);
  });

  it('a vault_unreachable/reauth_required lock reads the re-sign-in copy, offers 「Sign in with Microsoft again」 (no password field) and reloads on success', async () => {
    const onReload = jest.fn();
    const reauthOneDrive = jest.fn(async () => ({ ok: true }) as ReauthResult);
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'onedrive' }}
        connectFlow={flow({ reauthOneDrive })}
        onReload={onReload}
      />,
    );
    expect(screen.getByTestId('byos-locked-reason')).toHaveTextContent(/sign in again/i);
    expect(screen.queryByTestId('byos-unlock-password')).toBeNull();
    const reauthRow = screen.getByTestId('byos-reauth');
    expect(reauthRow).toHaveTextContent('Sign in with Microsoft again');
    await act(async () => {
      await userEvent.press(reauthRow);
    });
    expect(reauthOneDrive).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('byos-disconnect')).toBeTruthy();
  });

  it('a failed re-sign-in shows its error under the row, without reloading', async () => {
    const onReload = jest.fn();
    const reauthOneDrive = jest.fn(
      async () => ({ ok: false, category: 'network', detail: 'offline' }) as ReauthResult,
    );
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'onedrive' }}
        connectFlow={flow({ reauthOneDrive })}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-reauth'));
    });
    expect(await screen.findByTestId('byos-error')).toHaveTextContent(
      own('en', 'settings.cloudLibrary.lockMessage.networkAction'),
    );
    expect(onReload).not.toHaveBeenCalled();
  });

  it('a failed re-sign-in with a credential_rejected failure shows the shared rejected-keys copy, without reloading', async () => {
    const onReload = jest.fn();
    const reauthOneDrive = jest.fn(
      async () =>
        ({ ok: false, category: 'credential_rejected', detail: 'account_mismatch' }) as ReauthResult,
    );
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'onedrive' }}
        connectFlow={flow({ reauthOneDrive })}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-reauth'));
    });
    expect(await screen.findByTestId('byos-error')).toHaveTextContent(
      own('en', 'settings.cloudLibrary.lockMessage.credentialRejected'),
    );
    expect(onReload).not.toHaveBeenCalled();
  });

  it('P12-D: a Google Drive reauth_required lock offers 「Sign in with Google again」, runs reauthGdrive (never reauthOneDrive), asks for no password and reloads on success', async () => {
    const onReload = jest.fn();
    const reauthGdrive = jest.fn(async () => ({ ok: true }) as ReauthResult);
    const reauthOneDrive = jest.fn(async () => ({ ok: true }) as ReauthResult);
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' }}
        connectFlow={flow({ reauthGdrive, reauthOneDrive })}
        onReload={onReload}
      />,
    );
    expect(screen.getByTestId('byos-locked-reason')).toHaveTextContent(/sign in again/i);
    expect(screen.queryByTestId('byos-unlock-password')).toBeNull();
    expect(screen.queryByTestId('byos-field-password')).toBeNull();
    const reauthRow = screen.getByTestId('byos-reauth');
    expect(reauthRow).toHaveTextContent('Sign in with Google again');
    await act(async () => {
      await userEvent.press(reauthRow);
    });
    expect(reauthGdrive).toHaveBeenCalledTimes(1);
    expect(reauthOneDrive).not.toHaveBeenCalled();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('byos-disconnect')).toBeTruthy();
  });

  it('P12-D: a failed Google re-sign-in (network) reads the Google network copy, never Microsoft, without reloading', async () => {
    const onReload = jest.fn();
    const reauthGdrive = jest.fn(
      async () => ({ ok: false, category: 'network', detail: 'offline' }) as ReauthResult,
    );
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' }}
        connectFlow={flow({ reauthGdrive })}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-reauth'));
    });
    expect(await screen.findByTestId('byos-error')).toHaveTextContent(
      own('en', 'settings.cloudLibrary.lockMessage.networkAction'),
    );
    expect(onReload).not.toHaveBeenCalled();
  });

  // Task 8 drift review (Important): the reauth row names the provider that is
  // actually bound — its label, its network error and its action — and never
  // the other one, in every locale.
  describe.each(LOCALES)('%s: the reauth row names only the bound provider', (lng) => {
    beforeEach(async () => {
      await i18n.changeLanguage(lng);
    });

    it.each([
      ['gdrive', MICROSOFT, 'reauthGdrive'],
      ['onedrive', GOOGLE, 'reauthOneDrive'],
    ] as const)('%s binding: label + network failure name it; nothing names the other provider', async (provider, wrong, action) => {
      const failing = jest.fn(async () => ({ ok: false, category: 'network' }) as ReauthResult);
      await render(
        <ByosSettingsSection
          byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider }}
          connectFlow={flow({ [action]: failing })}
          onReload={jest.fn()}
        />,
      );
      expect(screen.getByTestId('byos-reauth')).toHaveTextContent(own(lng, `settings.byos.${provider}.reauth`));
      await act(async () => {
        await userEvent.press(screen.getByTestId('byos-reauth'));
      });
      expect(failing).toHaveBeenCalledTimes(1);
      expect(await screen.findByTestId('byos-error')).toHaveTextContent(own(lng, 'settings.cloudLibrary.lockMessage.networkAction'));
      expect(screen.getByTestId('byos-section')).not.toHaveTextContent(wrong);
    });
  });

  it('a stale re-sign-in error is cleared the moment the user starts the sign-in again (P12-C f3c24f2)', async () => {
    let finish: (value: ReauthResult) => void = () => {};
    const reauthGdrive = jest
      .fn<Promise<ReauthResult>, []>()
      .mockResolvedValueOnce({ ok: false, category: 'sign_in_cancelled' })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onReload = jest.fn();
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' }}
        connectFlow={flow({ reauthGdrive })}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-reauth'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent(own('en', 'settings.cloudLibrary.lockMessage.signInCancelled'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('byos-reauth'));
    });
    expect(screen.queryByTestId('byos-error')).toBeNull();
    await act(async () => {
      finish({ ok: true });
    });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('probes and branches to the empty-bucket create flow', async () => {
    const connectFlow = flow({
      probeBucket: jest.fn(async () => ({ kind: 'empty' }) as ProbeResult),
    });
    await openS3Form(connectFlow);
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    expect(await screen.findByTestId('byos-probe-empty')).toBeTruthy();
    expect(screen.getByTestId('byos-encryption-toggle')).toBeTruthy();
    expect(screen.getByTestId('byos-create')).toBeTruthy();
  });

  it('probes and branches to the encrypted-join flow with a password field', async () => {
    const connectFlow = flow({
      probeBucket: jest.fn(
        async () => ({ kind: 'existing-encrypted', meta: meta('aes-gcm') }) as ProbeResult,
      ),
    });
    await openS3Form(connectFlow);
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    expect(await screen.findByTestId('byos-probe-existing-encrypted')).toBeTruthy();
    expect(screen.getByTestId('byos-field-password')).toBeTruthy();
    expect(screen.getByTestId('byos-join')).toBeTruthy();
  });

  it('probes and branches to the plain-join flow without a password field', async () => {
    const connectFlow = flow({
      probeBucket: jest.fn(
        async () => ({ kind: 'existing-plain', meta: meta('none') }) as ProbeResult,
      ),
    });
    await openS3Form(connectFlow);
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    expect(await screen.findByTestId('byos-probe-existing-plain')).toBeTruthy();
    expect(screen.queryByTestId('byos-field-password')).toBeNull();
    expect(screen.getByTestId('byos-join')).toBeTruthy();
  });

  it('blocks create when the password confirmation does not match', async () => {
    const connectToBucket = jest.fn(
      async () => ({ ok: true, vaultId: 'v1', encryption: 'aes-gcm' }) as ConnectResult,
    );
    const connectFlow = flow({ connectToBucket });
    await openS3Form(connectFlow);
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    await screen.findByTestId('byos-create');
    await typeInto('byos-field-password', 'secret-one');
    await typeInto('byos-field-password-confirm', 'secret-two');
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-create'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent(/do not match/);
    expect(connectToBucket).not.toHaveBeenCalled();
    expect(screen.queryByText(/permanently loses access/)).toBeNull();
  });

  it('shows the unrecoverable-password warning before creating, then creates on confirm', async () => {
    let captured: ConnectInput | null = null;
    const connectToBucket = jest.fn(async (input: ConnectInput) => {
      captured = input;
      return { ok: true, vaultId: 'v1', encryption: 'aes-gcm' } as ConnectResult;
    });
    const onReload = jest.fn();
    const connectFlow = flow({ connectToBucket });
    await openS3Form(connectFlow, onReload);
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    await screen.findByTestId('byos-create');
    await typeInto('byos-field-password', 'match');
    await typeInto('byos-field-password-confirm', 'match');
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-create'));
    });
    // Warning modal is shown before any connect happens.
    expect(await screen.findByText(/permanently loses access/)).toBeTruthy();
    expect(connectToBucket).not.toHaveBeenCalled();

    const confirmButtons = screen.getAllByRole('button', { name: 'Create' });
    await act(async () => {
      await userEvent.press(confirmButtons[confirmButtons.length - 1]!);
    });
    expect(connectToBucket).toHaveBeenCalledTimes(1);
    expect(captured!.password).toBe('match');
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('creates an unencrypted vault directly, with no unrecoverable-password warning', async () => {
    let captured: ConnectInput | null = null;
    const connectToBucket = jest.fn(async (input: ConnectInput) => {
      captured = input;
      return { ok: true, vaultId: 'v1', encryption: 'none' } as ConnectResult;
    });
    const onReload = jest.fn();
    const connectFlow = flow({ connectToBucket });
    await openS3Form(connectFlow, onReload);
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    await screen.findByTestId('byos-create');
    // Turn encryption off: the password fields disappear, and there is no
    // password to forget — so the create must proceed without the warning.
    await act(async () => {
      fireEvent(screen.getByTestId('byos-encryption-toggle'), 'valueChange', false);
    });
    expect(screen.queryByTestId('byos-field-password')).toBeNull();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-create'));
    });
    // No unrecoverable-password warning modal; the create runs immediately.
    expect(screen.queryByText(/permanently loses access/)).toBeNull();
    expect(connectToBucket).toHaveBeenCalledTimes(1);
    expect(captured!.encryption).toBe('none');
    expect(captured!.password).toBeUndefined();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('confirms before disconnecting this device', async () => {
    const disconnectDevice = jest.fn(async () => undefined);
    const onReload = jest.fn();
    const connectFlow = flow({ disconnectDevice });
    await render(
      <ByosSettingsSection
        byosStatus={readyStatus()}
        connectFlow={connectFlow}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-disconnect'));
    });
    expect(await screen.findByText(/only; cloud data and other devices/)).toBeTruthy();
    await act(async () => {
      await userEvent.press(screen.getByRole('button', { name: 'Disconnect' }));
    });
    expect(disconnectDevice).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('unlocks a password-locked device and reloads', async () => {
    const unlock = jest.fn(
      async () => ({ ok: true, vaultId: 'v1', encryption: 'aes-gcm' }) as ConnectResult,
    );
    const onReload = jest.fn();
    const connectFlow = flow({ unlock });
    await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'password_required' }}
        connectFlow={connectFlow}
        onReload={onReload}
      />,
    );
    await typeInto('byos-unlock-password', 'my-password');
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-unlock'));
    });
    expect(unlock).toHaveBeenCalledWith('my-password');
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('renders the mapped error copy when a probe fails', async () => {
    const connectFlow = flow({
      probeBucket: jest.fn(
        async () => ({ kind: 'error', category: 'network', detail: 'offline' }) as ProbeResult,
      ),
    });
    await openS3Form(connectFlow);
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    expect(await screen.findByTestId('byos-error')).toHaveTextContent(
      /Could not reach that address/,
    );
    expect(screen.queryByTestId('byos-probe-empty')).toBeNull();
  });

  it('an insecure_url probe failure reads the https copy (T8 added the category; the form must map it)', async () => {
    const connectFlow = flow({
      probeBucket: jest.fn(
        async () => ({ kind: 'error', category: 'insecure_url' }) as ProbeResult,
      ),
    });
    await openS3Form(connectFlow);
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    expect(await screen.findByTestId('byos-error')).toHaveTextContent('Enter an https:// address.');
  });

  it('renders the background-upload row when the port is present', async () => {
    const { unmount } = await render(
      <ByosSettingsSection
        byosStatus={readyStatus()}
        connectFlow={flow()}
        onReload={jest.fn()}
        backgroundSync={{
          isBatteryOptimizationIgnored: () => true,
          requestIgnoreBatteryOptimizations: jest.fn(async () => undefined),
        }}
      />,
    );
    expect(within(screen.getByTestId('byos-background-sync')).getByText('Background uploads')).toBeTruthy();
    expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Allowed');
    await unmount();
  });

  it.each<[string, ByosStatus]>([
    ['password_required', { status: 'locked', reason: 'password_required' }],
    ['reauth_required (OneDrive)', { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'onedrive' }],
    ['reauth_required (Google Drive)', { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' }],
    ['vault_unreachable', { status: 'locked', reason: 'vault_unreachable', detail: 'network' }],
    ['meta_corrupt', { status: 'locked', reason: 'meta_corrupt', detail: 'malformed' }],
    ['meta_absent', { status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent' }],
  ])('renders the background-upload row when locked: %s', async (_variant, byosStatus) => {
    const { unmount } = await render(
      <ByosSettingsSection
        byosStatus={byosStatus}
        connectFlow={flow()}
        onReload={jest.fn()}
        backgroundSync={{
          isBatteryOptimizationIgnored: () => false,
          requestIgnoreBatteryOptimizations: jest.fn(async () => undefined),
        }}
      />,
    );
    expect(within(screen.getByTestId('byos-background-sync')).getByText('Background uploads')).toBeTruthy();
    expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Restricted');
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    await unmount();
  });

  it('omits the background-upload row when unconfigured even with the port', async () => {
    const { unmount } = await render(
      <ByosSettingsSection
        byosStatus={UNCONFIGURED}
        connectFlow={flow()}
        onReload={jest.fn()}
        backgroundSync={{
          isBatteryOptimizationIgnored: () => false,
          requestIgnoreBatteryOptimizations: jest.fn(async () => undefined),
        }}
      />,
    );
    expect(screen.queryByTestId('byos-background-sync')).toBeNull();
    await unmount();
  });

  it('omits the background-sync row where the native module is absent', async () => {
    const { unmount } = await render(
      <ByosSettingsSection
        byosStatus={readyStatus()}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('byos-background-sync')).toBeNull();
    await unmount();
  });
});

describe('board #12 — storage location picker', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('shows a headed storage location picker with all four backends pickable and none disabled (P12-D: nothing is coming soon any more)', async () => {
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
    );
    expect(screen.getByTestId('storage-pick-heading')).toHaveTextContent('S3-compatible storage');
    for (const kind of ['s3', 'webdav', 'onedrive', 'gdrive'] as const) {
      expect(screen.getByTestId(`storage-pick-${kind}`)).not.toBeDisabled();
    }
    expect(screen.queryAllByRole('button', { disabled: true })).toHaveLength(0);
    expect(screen.queryByText(/Coming in a later build/)).toBeNull();
    expect(screen.queryByTestId('byos-field-endpoint')).toBeNull();
  });

  it.each(LOCALES)('%s Google form retains its caveat after the picker drops it', async (locale) => {
    await i18n.changeLanguage(locale);
    await render(<ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />);
    const caveat = own(locale, 'settings.byos.gdrive.needsGoogle');
    expect(screen.queryByText(caveat)).toBeNull();
    await fireEvent.press(screen.getByTestId('storage-pick-gdrive'));
    expect(screen.getByTestId('gdrive-needs-google')).toHaveTextContent(caveat);
    await fireEvent.press(screen.getByTestId('storage-pick-back'));
    expect(screen.queryByText(caveat)).toBeNull();
    expect(screen.getByTestId('storage-pick-heading')).toBeOnTheScreen();
  });

  it('names every picker card by its label; Google access caveat belongs to the form', async () => {
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
    );
    expect(screen.getByLabelText('Quick setup with API key. Paste one key — Waifu Deck detects the provider and finds or creates waifu-deck.')).toBeTruthy();
    expect(screen.getByLabelText('Custom S3 credentials. Cloudflare R2, Wasabi, MinIO and more. Connect with your keys.')).toBeTruthy();
    expect(screen.getByLabelText('WebDAV. Nutstore, Nextcloud, NAS')).toBeTruthy();
    expect(screen.getByLabelText('OneDrive')).toBeTruthy();
    expect(screen.getByLabelText('Google Drive')).toBeTruthy();
  });

  it('opens the S3 connect form after picking S3 (heading gone), and returns to the picker via back', async () => {
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-s3'));
    });
    expect(screen.getByTestId('byos-field-endpoint')).toBeTruthy();
    expect(screen.queryByTestId('storage-pick-s3')).toBeNull();
    expect(screen.queryByTestId('storage-pick-heading')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-back'));
    });
    expect(screen.getByTestId('storage-pick-s3')).toBeTruthy();
    expect(screen.getByTestId('storage-pick-heading')).toBeTruthy();
    expect(screen.queryByTestId('byos-field-endpoint')).toBeNull();
    expect(screen.queryByTestId('byos-probe-empty')).toBeNull();
  });

  it('opens the WebDAV connect form after picking WebDAV (heading gone), and returns to the picker via back', async () => {
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-webdav'));
    });
    expect(screen.getByTestId('webdav-field-url')).toBeTruthy();
    expect(screen.queryByTestId('storage-pick-webdav')).toBeNull();
    expect(screen.queryByTestId('storage-pick-heading')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-back'));
    });
    expect(screen.getByTestId('storage-pick-webdav')).toBeTruthy();
    expect(screen.getByTestId('storage-pick-heading')).toBeTruthy();
    expect(screen.queryByTestId('webdav-field-url')).toBeNull();
  });

  it('opens the OneDrive form after picking OneDrive, and returns to the picker via back', async () => {
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-onedrive'));
    });
    expect(screen.getByTestId('onedrive-sign-in')).toBeTruthy();
    expect(screen.queryByTestId('storage-pick-onedrive')).toBeNull();
    expect(screen.queryByTestId('storage-pick-heading')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-back'));
    });
    expect(screen.getByTestId('storage-pick-onedrive')).toBeTruthy();
    expect(screen.getByTestId('storage-pick-heading')).toBeTruthy();
    expect(screen.queryByTestId('onedrive-sign-in')).toBeNull();
  });

  it('P12-D: opens the Google Drive form after picking Google Drive, and returns to the picker via back', async () => {
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-gdrive'));
    });
    expect(screen.getByTestId('gdrive-sign-in')).toHaveTextContent('Sign in with Google');
    expect(screen.queryByTestId('storage-pick-gdrive')).toBeNull();
    expect(screen.queryByTestId('storage-pick-heading')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-back'));
    });
    expect(screen.getByTestId('storage-pick-gdrive')).toBeTruthy();
    expect(screen.queryByTestId('gdrive-sign-in')).toBeNull();
  });

  it('P12-D: the Drive form drives the injected Google flow end to end — signInWithGoogle → probeGdrive → create → connectGdrive → reload', async () => {
    const onReload = jest.fn();
    const connectGdrive = jest.fn(
      async () => ({ ok: true, vaultId: 'v1', encryption: 'aes-gcm' }) as ConnectResult,
    );
    const probeGdrive = jest.fn(async () => ({ kind: 'empty' }) as ProbeResult);
    const connectFlow = flow({ connectGdrive, probeGdrive });
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={onReload} />,
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-gdrive'));
    });
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(connectFlow.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(connectFlow.signInWithMicrosoft).not.toHaveBeenCalled();
    expect(probeGdrive).toHaveBeenCalledWith(expect.objectContaining({ binding: GDRIVE_BINDING }));
    expect(await screen.findByTestId('gdrive-account')).toHaveTextContent(/owner@gmail\.com/);
    expect(screen.queryByTestId('byos-encryption-toggle')).toBeNull();
    await typeInto('byos-field-password', 'pw');
    await typeInto('byos-field-password-confirm', 'pw');
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-create'));
    });
    const buttons = screen.getAllByRole('button', { name: 'Create' });
    await act(async () => {
      await userEvent.press(buttons[buttons.length - 1]!);
    });
    expect(connectGdrive).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw', passwordConfirm: 'pw' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  // 补裁 12: the caveat belongs to Google Drive only. P12-C decided OneDrive
  // gets none (its mainland reachability was measured; Drive's was not), and a
  // WebDAV server's reachability is the user's own.
  it.each(LOCALES)('%s: the needs-Google caveat renders on the Drive form and never on the OneDrive or WebDAV forms', async (lng) => {
    await i18n.changeLanguage(lng);
    const caveat = own(lng, 'settings.byos.gdrive.needsGoogle');
    await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
    );
    for (const kind of ['onedrive', 'webdav', 'gdrive'] as const) {
      await act(async () => {
        await fireEvent.press(screen.getByTestId(`storage-pick-${kind}`));
      });
      if (kind === 'gdrive') {
        expect(screen.getByTestId('gdrive-connect-form')).toHaveTextContent(caveat, { exact: false });
      } else {
        expect(screen.getByTestId('byos-section')).not.toHaveTextContent(caveat, { exact: false });
      }
      await act(async () => {
        await fireEvent.press(screen.getByTestId('storage-pick-back'));
      });
    }
  });

  it('shows the back row on the probe step too, and back + re-pick lands on the form, not the stale probe', async () => {
    await openS3Form();
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    await screen.findByTestId('byos-probe-empty');
    expect(screen.getByTestId('storage-pick-back')).toBeTruthy();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-back'));
    });
    expect(screen.getByTestId('storage-pick-s3')).toBeTruthy();
    expect(screen.queryByTestId('byos-probe-empty')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-s3'));
    });
    expect(screen.getByTestId('byos-field-endpoint')).toBeTruthy();
    expect(screen.queryByTestId('byos-probe-empty')).toBeNull();
    expect(screen.getByTestId('byos-field-bucket')).toHaveProp('value', 'my-bucket');
  });

  it('disables the back row while a probe is in flight, re-enables it once settled, and leaves no stale probe after back + re-pick', async () => {
    let resolveProbe: (value: ProbeResult) => void = () => {};
    const probeBucket = jest.fn(() => new Promise<ProbeResult>((resolve) => { resolveProbe = resolve; }));
    await openS3Form(flow({ probeBucket }));
    await fillForm();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('byos-check'));
    });
    expect(screen.getByTestId('storage-pick-back')).toBeDisabled();

    await act(async () => {
      resolveProbe({ kind: 'empty' });
    });
    await screen.findByTestId('byos-probe-empty');
    expect(screen.getByTestId('storage-pick-back')).not.toBeDisabled();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-back'));
    });
    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-s3'));
    });
    expect(screen.queryByTestId('byos-probe-empty')).toBeNull();
  });

  it('returns to the picker, probe cleared, when the status leaves unconfigured and later comes back (tab screens stay mounted)', async () => {
    const connectFlow = flow();
    const { rerender } = await render(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={jest.fn()} />,
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-s3'));
    });
    await fillForm();
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-check'));
    });
    await screen.findByTestId('byos-probe-empty');

    await rerender(
      <ByosSettingsSection byosStatus={readyStatus()} connectFlow={connectFlow} onReload={jest.fn()} />,
    );
    expect(screen.getByTestId('byos-status')).toBeTruthy();

    // Disconnected in the same session: the user must land on the picker,
    // not straight in the S3 form (let alone on the old probe step).
    await rerender(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={jest.fn()} />,
    );
    expect(screen.getByTestId('storage-pick-s3')).toBeTruthy();
    expect(screen.queryByTestId('byos-field-endpoint')).toBeNull();
    expect(screen.queryByTestId('byos-probe-empty')).toBeNull();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-s3'));
    });
    expect(screen.getByTestId('byos-field-endpoint')).toBeTruthy();
    expect(screen.queryByTestId('byos-probe-empty')).toBeNull();
  });

  it('clears a stale unlock error when entering unconfigured from locked and S3 is picked again (M-d)', async () => {
    const unlock = jest.fn(async () => ({ ok: false, category: 'wrong_password' }) as ConnectResult);
    const connectFlow = flow({ unlock });
    const { rerender } = await render(
      <ByosSettingsSection
        byosStatus={{ status: 'locked', reason: 'password_required' }}
        connectFlow={connectFlow}
        onReload={jest.fn()}
      />,
    );
    await typeInto('byos-unlock-password', 'wrong-password');
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-unlock'));
    });
    expect(await screen.findByTestId('byos-error')).toBeTruthy();

    await rerender(
      <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={jest.fn()} />,
    );
    expect(screen.getByTestId('storage-pick-s3')).toBeTruthy();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('storage-pick-s3'));
    });
    expect(screen.queryByTestId('byos-error')).toBeNull();
  });

  it('shows the storage-kind badge for the bound S3 binding when ready', async () => {
    await render(
      <ByosSettingsSection byosStatus={readyStatus()} connectFlow={flow()} onReload={jest.fn()} />,
    );
    expect(screen.getByTestId('storage-kind-badge')).toHaveTextContent(/S3-compatible storage/);
    expect(screen.getByTestId('byos-status')).toHaveTextContent(/Cloudflare R2/);
  });

  it('board #12 P12-B: shows the WebDAV badge and host detail for a bound store context when ready, never "bucket"', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={{
          status: 'ready',
          context: {
            kind: 'store',
            binding: {
              kind: 'webdav',
              baseUrl: 'https://dav.example.com/dav',
              username: 'u',
              password: 'p',
              rootPath: '/',
            },
            store: createMemoryCloudObjectStore(),
            meta: meta('aes-gcm'),
            masterKey: new Uint8Array(32),
            deviceId: 'device-1',
          },
        }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('storage-kind-badge')).toHaveTextContent(/WebDAV/);
    expect(screen.getByTestId('byos-status')).toHaveTextContent(/dav\.example\.com/);
    expect(screen.getByTestId('byos-status')).not.toHaveTextContent(/bucket/i);
  });

  it('board #12 P12-C: shows the OneDrive badge and account e-mail for a bound store context when ready, never a URL', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={{
          status: 'ready',
          context: {
            kind: 'store',
            binding: ONEDRIVE_BINDING,
            store: createMemoryCloudObjectStore({ kind: 'onedrive' }),
            meta: meta('aes-gcm'),
            masterKey: new Uint8Array(32),
            deviceId: 'device-1',
          },
        }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('storage-kind-badge')).toHaveTextContent(/OneDrive/);
    expect(screen.getByTestId('byos-status')).toHaveTextContent(/owner@example\.com/);
    expect(screen.getByTestId('byos-status')).not.toHaveTextContent(/bucket|https?:\/\//i);
  });

  function gdriveReady(quota: () => Promise<{ usedBytes: number; totalBytes: number | null } | null>): ByosStatus {
    return {
      status: 'ready',
      context: {
        kind: 'store',
        binding: GDRIVE_BINDING,
        store: { ...createMemoryCloudObjectStore({ kind: 'gdrive' }), quota },
        meta: meta('aes-gcm'),
        masterKey: new Uint8Array(32),
        deviceId: 'device-1',
      },
    };
  }

  it('P12-D: a bound Google Drive shows the Google Drive badge, the account e-mail, the encrypted status and 「used x of y」', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={gdriveReady(async () => ({ usedBytes: 1048576, totalBytes: 16106127360 }))}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('storage-kind-badge')).toHaveTextContent(/Google Drive/);
    expect(screen.getByTestId('byos-status')).toHaveTextContent(/owner@gmail\.com/);
    expect(screen.getByTestId('byos-status')).toHaveTextContent(/Encrypted/);
    expect(screen.getByTestId('byos-status')).not.toHaveTextContent(MICROSOFT);
    expect(await screen.findByTestId('byos-quota')).toHaveTextContent('Drive used 0.0 / 16.1 GB');
  });

  it('P12-D: Drive on an unlimited plan omits storageQuota.limit (补裁 5) → 「used x」 only, no invented total', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={gdriveReady(async () => ({ usedBytes: 1048576, totalBytes: null }))}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    const quota = await screen.findByTestId('byos-quota');
    expect(quota).toHaveTextContent('Drive used 0.0 GB');
    expect(quota).not.toHaveTextContent(/\/|NaN|null/);
  });

  it.each([
    ['zh-Hant', 'Google 雲端硬碟'], ['ja', 'Google ドライブ'], ['zh-Hans', 'Google Drive'],
  ] as const)('P12-D %s: the bound badge names the service as the picker and the card do (%s)', async (lng, name) => {
    await i18n.changeLanguage(lng);
    await render(
      <ByosSettingsSection
        byosStatus={gdriveReady(async () => null)}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('storage-kind-badge')).toHaveTextContent(name, { exact: false });
  });

  it('board #12 P12-B: a stored WebDAV baseUrl that is not a parseable URL still renders (raw string), never crashes the settings screen', async () => {
    await render(
      <ByosSettingsSection
        byosStatus={{
          status: 'ready',
          context: {
            kind: 'store',
            binding: { kind: 'webdav', baseUrl: 'nas-without-scheme/dav', username: 'u', password: 'p', rootPath: '/' },
            store: createMemoryCloudObjectStore(),
            meta: meta('aes-gcm'),
            masterKey: new Uint8Array(32),
            deviceId: 'device-1',
          },
        }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(screen.getByTestId('byos-status')).toHaveTextContent(/nas-without-scheme\/dav/);
  });

  it('board #12 P12-B: shows a used-only quota row (no total) for a store context with no chaos.quotaBytes', async () => {
    const store = createMemoryCloudObjectStore();
    await store.put('waifu-deck/a', new Uint8Array(1048576), 'application/octet-stream');
    await render(
      <ByosSettingsSection
        byosStatus={{
          status: 'ready',
          context: {
            kind: 'store',
            binding: {
              kind: 'webdav',
              baseUrl: 'https://dav.example.com/dav',
              username: 'u',
              password: 'p',
              rootPath: '/',
            },
            store,
            meta: meta('aes-gcm'),
            masterKey: new Uint8Array(32),
            deviceId: 'device-1',
          },
        }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    const quota = await screen.findByTestId('byos-quota');
    expect(quota).toHaveTextContent('Drive used 0.0 GB');
    expect(quota).not.toHaveTextContent(/\//);
  });

  it('board #12 P12-B: shows a used-of-total quota row once the store reports chaos.quotaBytes', async () => {
    const store = createMemoryCloudObjectStore({ chaos: { quotaBytes: 10485760 } });
    await store.put('waifu-deck/a', new Uint8Array(1048576), 'application/octet-stream');
    await render(
      <ByosSettingsSection
        byosStatus={{
          status: 'ready',
          context: {
            kind: 'store',
            binding: {
              kind: 'webdav',
              baseUrl: 'https://dav.example.com/dav',
              username: 'u',
              password: 'p',
              rootPath: '/',
            },
            store,
            meta: meta('aes-gcm'),
            masterKey: new Uint8Array(32),
            deviceId: 'device-1',
          },
        }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    expect(await screen.findByTestId('byos-quota')).toHaveTextContent('Drive used 0.0 / 0.0 GB');
  });

  it('a cleared quota snapshot removes a previously visible quota row', async () => {
    const status = gdriveReady(async () => null);
    const props = { byosStatus: status, connectFlow: flow(), onReload: jest.fn() };
    const { rerender } = await render(<ByosSettingsSection {...props}
      data={cloudSnapshot(status, { quota: { usedBytes: 1048576, totalBytes: 10485760 } })} />);
    expect(screen.getByTestId('byos-quota')).toHaveTextContent('Drive used 0.0 / 0.0 GB');
    await rerender(<ByosSettingsSection {...props} data={cloudSnapshot(status)} />);
    expect(screen.queryByTestId('byos-quota')).toBeNull();
  });

  it('board #12 P12-B: a store that reports no quota at all (null) shows no row', async () => {
    const store = { ...createMemoryCloudObjectStore(), quota: async () => null };
    await render(
      <ByosSettingsSection
        byosStatus={{
          status: 'ready',
          context: {
            kind: 'store',
            binding: { kind: 'webdav', baseUrl: 'https://dav.example.com/dav', username: 'u', password: 'p', rootPath: '/' },
            store,
            meta: meta('aes-gcm'),
            masterKey: new Uint8Array(32),
            deviceId: 'device-1',
          },
        }}
        connectFlow={flow()}
        onReload={jest.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('byos-status')).toBeTruthy());
    expect(screen.queryByTestId('byos-quota')).toBeNull();
  });

  it('board #12 P12-B: shows no quota row for an S3-kind ready status (quota is store-kind-only)', async () => {
    await render(
      <ByosSettingsSection byosStatus={readyStatus()} connectFlow={flow()} onReload={jest.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('byos-status')).toBeTruthy());
    expect(screen.queryByTestId('byos-quota')).toBeNull();
  });
});

describe('board #27 S3b: 本机存储 (spec §5.14)', () => {
  const z = (key: string) => own('zh-Hans', key);
  const COUNTS: LibraryMirrorCounts = {
    backedUp: 5,
    backedUpTotal: 7,
    downloaded: 2,
    downloadedTotal: 5,
    inCloud: 3,
    inCloudBytes: 3250586,
    pending: 2,
    totalBytes: 5242880,
  };

  beforeEach(async () => {
    await i18n.changeLanguage('zh-Hans');
  });

  function control(initial: LibraryStorageMode) {
    let mode = initial;
    return {
      read: jest.fn(async () => mode),
      set: jest.fn(async (next: LibraryStorageMode) => {
        mode = next;
      }),
    };
  }

  async function renderReady(
    storageMode: LibraryStorageModeControl | undefined,
    extra: Partial<ComponentProps<typeof ByosSettingsSection>> = {},
  ) {
    await render(
      <ByosSettingsSection
        byosStatus={readyStatus()}
        connectFlow={flow()}
        onReload={jest.fn()}
        counts={COUNTS}
        {...(storageMode === undefined ? {} : { storageMode })}
        {...extra}
      />,
    );
    await act(async () => {});
  }

  async function press(node: Parameters<typeof fireEvent.press>[0]) {
    await act(async () => {
      await fireEvent.press(node);
    });
  }

  it("the row shows this phone's choice", async () => {
    await renderReady(control('both'));
    const row = await screen.findByTestId('byos-storage-mode');
    expect(within(row).getByText(z('settings.byos.storageMode.label'))).toBeTruthy();
    expect(within(row).getByText(z('settings.byos.storageMode.both'))).toBeTruthy();
    expect(within(row).getByText(z('settings.byos.storageMode.detail'))).toBeTruthy();
    expect(within(row).queryByText(z('settings.byos.storageMode.cloudOnly'))).toBeNull();
  });

  it("the row shows 仅云端 when that is this phone's choice", async () => {
    await renderReady(control('cloud-only'));
    const row = await screen.findByTestId('byos-storage-mode');
    expect(within(row).getByText(z('settings.byos.storageMode.label'))).toBeTruthy();
    expect(within(row).getByText(z('settings.byos.storageMode.cloudOnly'))).toBeTruthy();
    expect(within(row).queryByText(z('settings.byos.storageMode.both'))).toBeNull();
  });

  it.each([
    ['a locked library', 'locked'],
    ['no control', 'no-control'],
    ['a mode that cannot be read', 'read-rejects'],
    ['no mirror counts reader', 'no-counts'],
  ] as const)('no row without a ready library, a control, a readable mode or the counts: %s', async (_name, kind) => {
    const failing = {
      read: jest.fn(async (): Promise<LibraryStorageMode> => {
        throw new Error('kv unavailable');
      }),
      set: jest.fn(async () => undefined),
    };
    const storageMode = kind === 'no-control' ? undefined : kind === 'read-rejects' ? failing : control('both');
    const extra: Partial<ComponentProps<typeof ByosSettingsSection>> =
      kind === 'locked'
        ? { byosStatus: { status: 'locked', reason: 'password_required' } }
        : kind === 'no-counts'
          ? { counts: undefined }
          : {};
    await renderReady(storageMode, extra);
    await act(async () => {});
    await act(async () => {});
    expect(screen.queryByTestId('byos-storage-mode')).toBeNull();
  });

  it('the row leaves with the ready card when the same mounted section turns locked', async () => {
    const storageMode = control('both');
    const connectFlow = flow();
    const props = { connectFlow, onReload: jest.fn(), counts: COUNTS, storageMode };
    const { rerender } = await render(<ByosSettingsSection byosStatus={readyStatus()} {...props} />);
    await act(async () => {});
    expect(await screen.findByTestId('byos-storage-mode')).toBeTruthy();
    await act(async () => {
      await rerender(<ByosSettingsSection byosStatus={{ status: 'locked', reason: 'password_required' }} {...props} />);
    });
    expect(screen.queryByTestId('byos-storage-mode')).toBeNull();
  });

  it('turning 仅云端 on warns first, then sets it', async () => {
    const storageMode = control('both');
    await renderReady(storageMode);
    await press(await screen.findByTestId('byos-storage-mode'));
    // The sheet is titled with the row's label: the row and the sheet both show it.
    expect(screen.getAllByText(z('settings.byos.storageMode.label'))).toHaveLength(2);
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.cloudOnly') }));
    expect(screen.getByText(z('settings.byos.storageMode.warn.title'))).toBeTruthy();
    expect(screen.getByText(z('settings.byos.storageMode.warn.message'))).toBeTruthy();
    expect(storageMode.set).not.toHaveBeenCalled();
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.warn.confirm') }));
    expect(storageMode.set).toHaveBeenCalledTimes(1);
    expect(storageMode.set).toHaveBeenCalledWith('cloud-only');
    expect(storageMode.read).toHaveBeenCalledTimes(2);
    expect(within(screen.getByTestId('byos-storage-mode')).getByText(z('settings.byos.storageMode.cloudOnly'))).toBeTruthy();
  });

  it('the row shows the new choice only once the write has landed', async () => {
    let mode: LibraryStorageMode = 'both';
    let finishWrite!: () => void;
    const storageMode = {
      read: jest.fn(async () => mode),
      // A real write is asynchronous: the stored mode changes only when it lands.
      set: jest.fn(async (next: LibraryStorageMode) => {
        await new Promise<void>((resolve) => { finishWrite = resolve; });
        mode = next;
      }),
    };
    await renderReady(storageMode);
    await press(await screen.findByTestId('byos-storage-mode'));
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.cloudOnly') }));
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.warn.confirm') }));
    expect(storageMode.read).toHaveBeenCalledTimes(1);
    // While the write is in flight the row cannot be pressed again.
    expect(screen.getByTestId('byos-storage-mode')).toBeDisabled();

    await act(async () => {
      finishWrite();
    });

    expect(screen.getByTestId('byos-storage-mode')).not.toBeDisabled();
    expect(storageMode.read).toHaveBeenCalledTimes(2);
    expect(within(screen.getByTestId('byos-storage-mode')).getByText(z('settings.byos.storageMode.cloudOnly'))).toBeTruthy();
  });

  it('cancelling the warning changes nothing', async () => {
    const storageMode = control('both');
    await renderReady(storageMode);
    await press(await screen.findByTestId('byos-storage-mode'));
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.cloudOnly') }));
    await press(screen.getByRole('button', { name: '取消' }));
    expect(storageMode.set).not.toHaveBeenCalled();
    expect(screen.queryByText(z('settings.byos.storageMode.warn.title'))).toBeNull();
    expect(within(screen.getByTestId('byos-storage-mode')).getByText(z('settings.byos.storageMode.both'))).toBeTruthy();
  });

  it('cancelling the switch back changes nothing and closes the confirm', async () => {
    const storageMode = control('cloud-only');
    await renderReady(storageMode);
    await press(await screen.findByTestId('byos-storage-mode'));
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.both') }));
    await press(screen.getByRole('button', { name: '取消' }));
    expect(storageMode.set).not.toHaveBeenCalled();
    expect(screen.queryByText(z('settings.byos.storageMode.back.title'))).toBeNull();
    expect(within(screen.getByTestId('byos-storage-mode')).getByText(z('settings.byos.storageMode.cloudOnly'))).toBeTruthy();
  });

  it('switching back confirms the count and size first', async () => {
    const storageMode = control('cloud-only');
    await renderReady(storageMode);
    await press(await screen.findByTestId('byos-storage-mode'));
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.both') }));
    expect(screen.getByText('将把 3 张原图重新下载到这台手机（约 3.1 MB）。')).toBeTruthy();
    expect(screen.getByText(z('settings.byos.storageMode.back.title'))).toBeTruthy();
    expect(storageMode.set).not.toHaveBeenCalled();
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.back.confirm') }));
    expect(storageMode.set).toHaveBeenCalledTimes(1);
    expect(storageMode.set).toHaveBeenCalledWith('both');
    expect(within(screen.getByTestId('byos-storage-mode')).getByText(z('settings.byos.storageMode.both'))).toBeTruthy();
  });

  it('picking the current choice does nothing', async () => {
    const storageMode = control('both');
    await renderReady(storageMode);
    await press(await screen.findByTestId('byos-storage-mode'));
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.both') }));
    expect(screen.queryByText(z('settings.byos.storageMode.warn.title'))).toBeNull();
    expect(screen.queryByText(z('settings.byos.storageMode.back.title'))).toBeNull();
    expect(storageMode.set).not.toHaveBeenCalled();
    // The sheet closed: its options are gone.
    expect(screen.queryByRole('button', { name: z('settings.byos.storageMode.cloudOnly') })).toBeNull();
  });

  it('a re-read that fails after a successful write hides the row rather than guess', async () => {
    let reads = 0;
    const storageMode = {
      read: jest.fn(async (): Promise<LibraryStorageMode> => {
        reads += 1;
        if (reads > 1) throw new Error('kv read failed');
        return 'both';
      }),
      set: jest.fn(async (_mode: LibraryStorageMode) => undefined),
    };
    await renderReady(storageMode);
    await press(await screen.findByTestId('byos-storage-mode'));
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.cloudOnly') }));
    await press(screen.getByRole('button', { name: z('settings.byos.storageMode.warn.confirm') }));
    expect(storageMode.set).toHaveBeenCalledWith('cloud-only');
    expect(screen.queryByTestId('byos-storage-mode')).toBeNull();
  });

  it('a write that fails keeps the stored choice', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const storageMode = {
        read: jest.fn(async (): Promise<LibraryStorageMode> => 'both'),
        set: jest.fn(async (_mode: LibraryStorageMode) => {
          throw new Error('kv write failed');
        }),
      };
      await renderReady(storageMode);
      await press(await screen.findByTestId('byos-storage-mode'));
      await press(screen.getByRole('button', { name: z('settings.byos.storageMode.cloudOnly') }));
      await press(screen.getByRole('button', { name: z('settings.byos.storageMode.warn.confirm') }));
      await act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      });
      expect(storageMode.set).toHaveBeenCalledWith('cloud-only');
      // The row re-reads what is stored after the failed write.
      expect(storageMode.read).toHaveBeenCalledTimes(2);
      expect(within(screen.getByTestId('byos-storage-mode')).getByText(z('settings.byos.storageMode.both'))).toBeTruthy();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a disconnect that fails says so and does not reload', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const disconnectDevice = jest.fn()
        .mockRejectedValueOnce(new Error('disconnect failed'))
        .mockResolvedValueOnce(undefined);
      const onReload = jest.fn();
      await renderReady(undefined, { connectFlow: flow({ disconnectDevice }), onReload });
      await press(screen.getByTestId('byos-disconnect'));
      await press(screen.getByRole('button', { name: z('settings.byos.disconnectConfirm.confirm') }));

      await waitFor(() => {
        expect(screen.getByTestId('byos-disconnect-failed')).toHaveTextContent(
          z('settings.byos.disconnectFailed'),
        );
      });
      expect(onReload).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByTestId('byos-disconnect')).toBeEnabled());
      expect(unhandled).toEqual([]);

      await press(screen.getByTestId('byos-disconnect'));
      await press(screen.getByRole('button', { name: z('settings.byos.disconnectConfirm.confirm') }));
      await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('byos-disconnect-failed')).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a failed disconnect re-reads the stored mode', async () => {
    const storageMode = control('cloud-only');
    const disconnectDevice = jest.fn(async () => {
      await storageMode.set('both');
      throw new Error('disconnect failed');
    });
    await renderReady(storageMode, { connectFlow: flow({ disconnectDevice }) });
    await press(screen.getByTestId('byos-disconnect'));
    await press(screen.getByRole('button', { name: z('settings.byos.disconnectConfirm.confirm') }));

    await waitFor(() => {
      expect(within(screen.getByTestId('byos-storage-mode')).getByText(
        z('settings.byos.storageMode.both'),
      )).toBeTruthy();
    });
    expect(storageMode.read).toHaveBeenCalledTimes(2);
  });

  describe('progress line and disconnect extra (spec §5.15, §5.16)', () => {
    const STATS = '5 张在云端5.2 MB原图大小2 张待上传';
    const EXTRA = '这台手机上有 3 张图只在云端。断开后只能看缩略图；重新连接同一个云库即可恢复。';

    // The confirm's message is one Text child; read it verbatim (newline kept).
    function confirmMessage(): string {
      const node = screen.getByText(z('settings.byos.disconnectConfirm.message'), { exact: false });
      return [node.props.children].flat().join('');
    }

    it('in 仅云端 the line counts what is in the cloud and what waits', async () => {
      await renderReady(control('cloud-only'));
      expect(await screen.findByTestId('byos-mirror-progress')).toHaveTextContent(STATS, { exact: true });
    });

    it('in 本地+云端 the line is unchanged', async () => {
      await renderReady(control('both'));
      expect(await screen.findByTestId('byos-mirror-progress')).toHaveTextContent(STATS, { exact: true });
    });

    it('an unreadable mode keeps the 本地+云端 line', async () => {
      const failing = {
        read: jest.fn(async (): Promise<LibraryStorageMode> => {
          throw new Error('kv unavailable');
        }),
        set: jest.fn(async () => undefined),
      };
      await renderReady(failing);
      expect(await screen.findByTestId('byos-mirror-progress')).toHaveTextContent(STATS, { exact: true });
    });

    it('switching updates the mode while keeping collection totals', async () => {
      await renderReady(control('both'));
      expect(await screen.findByTestId('byos-mirror-progress')).toHaveTextContent(STATS, { exact: true });
      await press(screen.getByTestId('byos-storage-mode'));
      await press(screen.getByRole('button', { name: z('settings.byos.storageMode.cloudOnly') }));
      await press(screen.getByRole('button', { name: z('settings.byos.storageMode.warn.confirm') }));
      expect(screen.getByTestId('byos-mirror-progress')).toHaveTextContent(STATS, { exact: true });
      expect(screen.getByTestId('byos-storage-mode')).toHaveTextContent(/仅云端/);
    });

    it('the disconnect confirm adds the cloud-only count', async () => {
      await renderReady(control('cloud-only'));
      await screen.findByTestId('byos-storage-mode');
      await press(screen.getByTestId('byos-disconnect'));
      expect(confirmMessage()).toBe(`${z('settings.byos.disconnectConfirm.message')}\n${EXTRA}`);
    });

    it('one image only in the cloud is warned about too', async () => {
      await renderReady(control('cloud-only'), { counts: { ...COUNTS, inCloud: 1 } });
      await screen.findByTestId('byos-storage-mode');
      await press(screen.getByTestId('byos-disconnect'));
      expect(confirmMessage()).toBe(
        `${z('settings.byos.disconnectConfirm.message')}\n这台手机上有 1 张图只在云端。断开后只能看缩略图；重新连接同一个云库即可恢复。`,
      );
    });

    it('the extra line leaves when the same mounted section turns locked', async () => {
      const storageMode = control('cloud-only');
      const props = { connectFlow: flow(), onReload: jest.fn(), counts: COUNTS, storageMode };
      const { rerender } = await render(<ByosSettingsSection byosStatus={readyStatus()} {...props} />);
      await act(async () => {});
      await screen.findByTestId('byos-storage-mode');
      await act(async () => {
        await rerender(<ByosSettingsSection byosStatus={{ status: 'locked', reason: 'password_required' }} {...props} />);
      });
      await press(screen.getByTestId('byos-disconnect'));
      expect(confirmMessage()).toBe(z('settings.byos.disconnectConfirm.message'));
    });

    it.each([
      ['本地+云端', 'both'],
      ['nothing only in the cloud (inCloud 0)', 'zero'],
      ['an unreadable mode', 'unreadable'],
      ['a locked library', 'locked'],
    ] as const)('no extra line: %s', async (_name, kind) => {
      const unreadable = {
        read: jest.fn(async (): Promise<LibraryStorageMode> => {
          throw new Error('kv unavailable');
        }),
        set: jest.fn(async () => undefined),
      };
      const storageMode =
        kind === 'both' ? control('both') : kind === 'unreadable' ? unreadable : kind === 'locked' ? undefined : control('cloud-only');
      const extra: Partial<ComponentProps<typeof ByosSettingsSection>> =
        kind === 'zero'
          ? { counts: { ...COUNTS, inCloud: 0, inCloudBytes: 0 } }
          : kind === 'locked'
            ? { byosStatus: { status: 'locked', reason: 'password_required' } }
            : {};
      await renderReady(storageMode, extra);
      await act(async () => {});
      await press(screen.getByTestId('byos-disconnect'));
      expect(confirmMessage()).toBe(z('settings.byos.disconnectConfirm.message'));
    });
  });

  describe('Ledger N12: storage FAQ modal and S3 API key quick-setup flow', () => {
    it('opens and closes the StorageAdviceFaqModal from the unconfigured hero pill', async () => {
      await render(
        <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={flow()} onReload={jest.fn()} />,
      );
      expect(screen.queryByTestId('cloud-storage-faq-dialog')).toBeNull();
      await act(async () => {
        fireEvent.press(screen.getByTestId('cloud-storage-faq-button'));
      });
      expect(screen.getByTestId('cloud-storage-faq-dialog')).toBeTruthy();
      expect(screen.getByText('Cloudflare R2、Bunny.net 与 Backblaze B2')).toBeTruthy();
      expect(screen.getByText('Google Drive、OneDrive 与 WebDAV')).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByTestId('cloud-storage-faq-close'));
      });
      expect(screen.queryByTestId('cloud-storage-faq-dialog')).toBeNull();
    });

    it('opens S3ApiKeyQuickSetupModal via row or provider badge, auto-detects key format, and transitions into the probe step on success', async () => {
      const provisionedFields = {
        endpoint: 'https://s3.storage.bunnycdn.com',
        bucket: 'waifu-deck',
        accessKey: 'waifu-deck',
        secret: 'bunny-rw-pass',
        region: 'de',
      };
      const provisionS3FromApiKey = jest.fn(async () => ({
        ok: true as const,
        provider: 'bunny' as const,
        fields: provisionedFields,
        createdNewBucket: false,
      }));
      const probeBucket = jest.fn(async (): Promise<ProbeResult> => ({ kind: 'empty' }));
      const connectFlow = flow({ provisionS3FromApiKey, probeBucket });

      await render(
        <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={jest.fn()} />,
      );

      await act(async () => {
        fireEvent.press(screen.getByTestId('storage-badge-bunny'));
      });
      expect(screen.getByTestId('s3-apikey-dialog')).toBeTruthy();

      await typeInto('s3-apikey-input', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(screen.getByTestId('s3-apikey-detected-banner')).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByTestId('s3-apikey-connect'));
      });

      expect(provisionS3FromApiKey).toHaveBeenCalledWith(
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        'bunny',
      );
      expect(probeBucket).toHaveBeenCalledWith(provisionedFields);
      expect(await screen.findByTestId('byos-probe-empty')).toBeTruthy();
      expect(screen.queryByTestId('s3-apikey-dialog')).toBeNull();
    });

    it('surfaces an inline error inside S3ApiKeyQuickSetupModal when provisionS3FromApiKey fails', async () => {
      const provisionS3FromApiKey = jest.fn(async () => ({
        ok: false as const,
        errorCode: 'invalid_cf_token' as const,
      }));
      const connectFlow = flow({ provisionS3FromApiKey });

      await render(
        <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={jest.fn()} />,
      );

      await act(async () => {
        fireEvent.press(screen.getByTestId('storage-pick-s3-apikey'));
      });
      await typeInto('s3-apikey-input', '005abc123def:K005secretkey');
      await act(async () => {
        fireEvent.press(screen.getByTestId('s3-apikey-connect'));
      });

      expect(await screen.findByTestId('s3-apikey-error')).toHaveTextContent(
        'Cloudflare 拒绝了此 R2 API 令牌。请确认它具有 R2 管理员读写权限。',
      );
      expect(screen.getByTestId('s3-apikey-dialog')).toBeTruthy();
    });

    it('lets an explicit tab click override auto-detection so a 40-char key is routed to the chosen provider', async () => {
      const provisionS3FromApiKey = jest.fn(async () => ({
        ok: false as const,
        errorCode: 'invalid_bunny_key' as const,
      }));
      const connectFlow = flow({ provisionS3FromApiKey });

      await render(
        <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={jest.fn()} />,
      );

      await act(async () => {
        fireEvent.press(screen.getByTestId('storage-pick-s3-apikey'));
      });
      await typeInto('s3-apikey-input', 'A'.repeat(40));
      await act(async () => {
        fireEvent.press(screen.getByTestId('s3-apikey-tab-bunny'));
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('s3-apikey-connect'));
      });

      expect(provisionS3FromApiKey).toHaveBeenCalledWith('A'.repeat(40), 'bunny');
    });

    it('retries probeBucket when a newly created Bunny S3 zone has not yet propagated to the regional S3 gateway', async () => {
      jest.useFakeTimers();
      try {
        const provisionedFields = {
          endpoint: 'https://de-s3.storage.bunnycdn.com',
          bucket: 'waifu-deck',
          accessKey: 'waifu-deck',
          secret: 'bunny-rw-pass',
          region: 'de',
        };
        const provisionS3FromApiKey = jest.fn(async () => ({
          ok: true as const,
          provider: 'bunny' as const,
          fields: provisionedFields,
          createdNewBucket: true,
        }));
        const probeBucket = jest.fn<Promise<ProbeResult>, []>()
          .mockResolvedValueOnce({ kind: 'error', category: 'credential_rejected' })
          .mockResolvedValueOnce({ kind: 'empty' });
        const connectFlow = flow({ provisionS3FromApiKey, probeBucket });

        await render(
          <ByosSettingsSection byosStatus={UNCONFIGURED} connectFlow={connectFlow} onReload={jest.fn()} />,
        );

        await act(async () => {
          fireEvent.press(screen.getByTestId('storage-badge-bunny'));
        });
        await typeInto('s3-apikey-input', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

        let connectPromise!: Promise<void>;
        await act(async () => {
          connectPromise = Promise.resolve(fireEvent.press(screen.getByTestId('s3-apikey-connect')));
        });
        await act(async () => {
          jest.advanceTimersByTime(1_250);
          await connectPromise;
        });

        expect(probeBucket).toHaveBeenCalledTimes(2);
        expect(await screen.findByTestId('byos-probe-empty')).toBeTruthy();
        expect(screen.queryByTestId('s3-apikey-dialog')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
