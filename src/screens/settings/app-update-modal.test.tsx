import { render, screen, userEvent } from '@testing-library/react-native';

import type { AppRelease } from '@/features/update/update-model';
import i18n from '@/i18n';
import { AppUpdateModal } from './app-update-modal';

const SAMPLE_RELEASE: AppRelease = {
  versionCode: 1_002_001,
  versionName: '1.2.1',
  publishedAt: '2026-10-16T08:00:00.000Z',
  sizeBytes: 86_620_693,
  sha256: '3c3d38370211f11dc52fa489f7760560bf179342addcd7075f2a6d8e4697beeb',
  notes: '支持应用内自动检查更新与直接覆盖安装。',
  downloadUrl: 'https://waifudeck.app/api/app/download',
};

describe('AppUpdateModal (Ledger N11-C)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-Hans');
  });

  it('renders release title, size, notes, and triggers Later / Update / Browser actions', async () => {
    const onLater = jest.fn();
    const onConfirmUpdate = jest.fn();
    const onOpenBrowser = jest.fn();

    await render(
      <AppUpdateModal
        visible
        release={SAMPLE_RELEASE}
        phase={{ kind: 'ready', alreadyDownloaded: false }}
        onLater={onLater}
        onConfirmUpdate={onConfirmUpdate}
        onCancelDownload={jest.fn()}
        onOpenUnknownSources={jest.fn()}
        onOpenBrowser={onOpenBrowser}
      />,
    );

    expect(screen.getByTestId('app-update-modal-title')).toHaveTextContent('发现新版本 v1.2.1');
    expect(screen.getByTestId('app-update-modal-notes')).toHaveTextContent(
      '支持应用内自动检查更新与直接覆盖安装。',
    );
    expect(screen.getByTestId('update-modal-confirm')).toHaveTextContent('立即更新');

    await userEvent.press(screen.getByTestId('update-modal-later'));
    expect(onLater).toHaveBeenCalledTimes(1);

    await userEvent.press(screen.getByTestId('update-modal-confirm'));
    expect(onConfirmUpdate).toHaveBeenCalledTimes(1);

    await userEvent.press(screen.getByTestId('update-modal-browser'));
    expect(onOpenBrowser).toHaveBeenCalledTimes(1);
  });

  it('shows Install now when APK is already downloaded, and progress bar while downloading', async () => {
    const onCancelDownload = jest.fn();
    const { rerender } = await render(
      <AppUpdateModal
        visible
        release={SAMPLE_RELEASE}
        phase={{ kind: 'ready', alreadyDownloaded: true }}
        onLater={jest.fn()}
        onConfirmUpdate={jest.fn()}
        onCancelDownload={onCancelDownload}
        onOpenUnknownSources={jest.fn()}
        onOpenBrowser={jest.fn()}
      />,
    );

    expect(screen.getByTestId('update-modal-confirm')).toHaveTextContent('立即安装');

    await rerender(
      <AppUpdateModal
        visible
        release={SAMPLE_RELEASE}
        phase={{
          kind: 'downloading',
          bytesReceived: 43_310_346,
          totalBytes: 86_620_693,
        }}
        onLater={jest.fn()}
        onConfirmUpdate={jest.fn()}
        onCancelDownload={onCancelDownload}
        onOpenUnknownSources={jest.fn()}
        onOpenBrowser={jest.fn()}
      />,
    );

    expect(screen.getByTestId('app-update-modal-progress-label')).toHaveTextContent(
      '正在下载 50%（43.3 MB / 86.6 MB）',
    );
    await userEvent.press(screen.getByTestId('update-modal-cancel'));
    expect(onCancelDownload).toHaveBeenCalledTimes(1);
  });

  it('shows permission prompt and Open Settings button when unknown-sources permission is required', async () => {
    const onOpenUnknownSources = jest.fn();
    await render(
      <AppUpdateModal
        visible
        release={SAMPLE_RELEASE}
        phase={{
          kind: 'permission-required',
          apkUri: 'file:///cache/app-updates/waifudeck-1002001.apk',
        }}
        onLater={jest.fn()}
        onConfirmUpdate={jest.fn()}
        onCancelDownload={jest.fn()}
        onOpenUnknownSources={onOpenUnknownSources}
        onOpenBrowser={jest.fn()}
      />,
    );

    expect(screen.getByTestId('app-update-modal-permission')).toBeOnTheScreen();
    expect(screen.getByTestId('update-modal-confirm')).toHaveTextContent('去开启');
    await userEvent.press(screen.getByTestId('update-modal-confirm'));
    expect(onOpenUnknownSources).toHaveBeenCalledTimes(1);
  });
});
