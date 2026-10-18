import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ByosConnectFailure, ConnectResult, ReauthResult } from '@/features/byos/byos-connect-flow';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { LibraryActionsController } from '@/features/library/library-actions-service';
import i18n from '@/i18n';
import { cloudSnapshot } from '@/test/cloud-library-fixtures';
import { cloudMessageFactory } from '@/test/cloud-message-fixture';
import { ByosSettingsSection, type ByosConnectFlow } from './byos-settings-section';
import { CloudLibraryCard } from './cloud-library-card';
import { formatCloudLibraryMessage } from './cloud-library-model';
import { LibraryCloudSlot } from './library-cloud-slot-impl';

jest.mock('lucide-react-native', () => ({ Check: () => null, ChevronRight: () => null, Cloud: () => null, Lock: () => null, Server: () => null }));

const flow = (overrides: Partial<ByosConnectFlow> = {}): ByosConnectFlow => ({
  probeBucket: jest.fn(async () => ({ kind: 'empty' } as const)),
  connectToBucket: jest.fn(async () => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' } as const)),
  probeWebdav: jest.fn(async () => ({ kind: 'empty' } as const)),
  connectWebdav: jest.fn(async () => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' } as const)),
  signInWithMicrosoft: jest.fn(async () => ({ ok: false, category: 'sign_in_cancelled' } as const)),
  probeOneDrive: jest.fn(async () => ({ kind: 'empty' } as const)),
  connectOneDrive: jest.fn(async () => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' } as const)),
  reauthOneDrive: jest.fn(async () => ({ ok: true } as const)),
  signInWithGoogle: jest.fn(async () => ({ ok: false, category: 'sign_in_cancelled' } as const)),
  probeGdrive: jest.fn(async () => ({ kind: 'empty' } as const)),
  connectGdrive: jest.fn(async () => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' } as const)),
  reauthGdrive: jest.fn(async () => ({ ok: true } as const)),
  unlock: jest.fn(async () => ({ ok: false, category: 'wrong_password' } as const)),
  disconnectDevice: jest.fn(async () => undefined),
  ...overrides,
});
const locales = ['en', 'ja', 'zh-Hans', 'zh-Hant'] as const;
const own = (locale: string, suffix: string) => i18n.getResource(locale, 'translation', `settings.cloudLibrary.lockMessage.${suffix}`) as string;
const locked: ByosStatus = { status: 'locked', reason: 'password_required' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function controller(getAccountScope: () => Promise<string | null>) {
  return { getAccountScope, readMirrorCounts: jest.fn(), readQuotaFullCount: jest.fn() } as unknown as LibraryActionsController;
}

const statusCases: [ByosStatus, string][] = [
  [locked, 'unlock'],
  ...(['gdrive', 'onedrive'] as const).map((provider): [ByosStatus, string] => [{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider }, 'reauth']),
  [{ status: 'locked', reason: 'vault_unreachable', detail: 'network' }, 'network'],
  [{ status: 'locked', reason: 'vault_unreachable', detail: 'credential_rejected' }, 'credentialRejected'],
  ...(['not_s3', 'not_webdav', 'not_onedrive', 'not_gdrive'] as const).map((detail): [ByosStatus, string] => [{ status: 'locked', reason: 'vault_unreachable', detail }, 'other']),
  ...(['meta_absent', 'malformed', 'unsupported-version'] as const).map((detail): [ByosStatus, string] => [{ status: 'locked', reason: 'meta_corrupt', detail }, 'unreadable']),
];
for (const locale of locales) {
  test.each(statusCases)(`${locale}: one approved status sentence and three dashes per surface for %j`, async (status, suffix) => {
    await i18n.changeLanguage(locale);
    const data = cloudSnapshot(status);
    const actions = controller(jest.fn(async () => 'existing-scope'));
    await render(<>
      <CloudLibraryCard model={data.model} nowMs={data.viewNowMs} onPress={jest.fn()} />
      <ByosSettingsSection byosStatus={status} connectFlow={flow()} onReload={jest.fn()} data={data}
        renderCloudMessage={cloudMessageFactory(actions)} backgroundSync={{ isBatteryOptimizationIgnored: () => true, requestIgnoreBatteryOptimizations: async () => undefined }} />
    </>);
    expect(within(screen.getByTestId('byos-locked-reason')).getAllByText(own(locale, suffix))).toHaveLength(1);
    expect(within(screen.getByTestId('settings-cloud-card')).getAllByText(own(locale, suffix))).toHaveLength(1);
    expect(screen.getAllByText('—')).toHaveLength(6);
    expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
    expect(screen.getByTestId('byos-background-sync')).toBeOnTheScreen();
    expect(screen.queryByTestId('byos-mirror-progress')).toBeNull();
    expect(screen.queryByTestId('library-import')).toBeNull();
    expect(screen.queryByText(i18n.t('collection.import.entry'))).toBeNull();
    expect(actions.readMirrorCounts).not.toHaveBeenCalled();
    if (suffix !== 'unlock') expect(screen.queryByTestId('byos-unlock-password')).toBeNull();
    if (suffix !== 'reauth') expect(screen.queryByTestId('byos-reauth')).toBeNull();
  });
}
const failures: [ByosConnectFailure, string][] = [
  [{ category: 'wrong_password' }, 'wrongPassword'],
  [{ category: 'password_mismatch', detail: 'confirmation_mismatch' }, 'wrongPassword'],
  [{ category: 'password_mismatch', detail: 'password_required' }, 'passwordRequired'],
  [{ category: 'sign_in_cancelled' }, 'signInCancelled'],
  [{ category: 'network', detail: 'offline' }, 'networkAction'],
  [{ category: 'reauth_required' }, 'reauth'],
  [{ category: 'credential_rejected' }, 'credentialRejected'],
  [{ category: 'meta_corrupt', detail: 'meta_absent' }, 'unreadable'],
  ...(['not_s3', 'not_webdav', 'not_onedrive', 'not_gdrive', 'insecure_url'] as const).map((category): [ByosConnectFailure, string] => [{ category }, 'other']),
];
for (const locale of locales) {
  for (const action of ['unlock', 'gdrive', 'onedrive'] as const) {
    const cases = action === 'unlock' ? failures : failures.filter(([failure]) => ['sign_in_cancelled', 'network'].includes(failure.category));
    test.each(cases)(`${locale} ${action}: failure %j replaces status, retry clears immediately, success reloads`, async (failure, suffix) => {
      await i18n.changeLanguage(locale);
      const status: ByosStatus = action === 'unlock' ? locked : { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: action };
      const data = cloudSnapshot(status);
      const retry = deferred<ConnectResult | ReauthResult>();
      const perform = jest.fn().mockResolvedValueOnce({ ok: false, ...failure }).mockReturnValueOnce(retry.promise);
      const connect = flow(action === 'unlock' ? { unlock: perform } : action === 'gdrive' ? { reauthGdrive: perform } : { reauthOneDrive: perform });
      const onReload = jest.fn();
      await render(<>
        <CloudLibraryCard model={data.model} nowMs={data.viewNowMs} onPress={jest.fn()} />
        <ByosSettingsSection byosStatus={status} connectFlow={connect} onReload={onReload} data={data} renderCloudMessage={cloudMessageFactory(null)} />
      </>);
      const statusText = own(locale, action === 'unlock' ? 'unlock' : 'reauth');
      const failedText = own(locale, suffix);
      expect(screen.getByTestId('byos-locked-reason')).toHaveTextContent(statusText);
      if (action === 'unlock') await fireEvent.changeText(screen.getByTestId('byos-unlock-password'), 'bad');
      const button = action === 'unlock' ? 'byos-unlock' : 'byos-reauth';
      await fireEvent.press(screen.getByTestId(button));
      expect(screen.getByTestId('byos-error')).toHaveTextContent(failedText);
      expect(screen.getByTestId('byos-error').props.accessibilityLiveRegion).toBe('polite');
      expect(within(screen.getByTestId('byos-locked-reason')).getAllByText(failedText)).toHaveLength(1);
      if (failedText !== statusText) expect(within(screen.getByTestId('byos-locked-reason')).queryByText(statusText)).toBeNull();
      expect(within(screen.getByTestId('settings-cloud-card')).getByText(statusText)).toBeOnTheScreen();
      if (failedText !== statusText) expect(within(screen.getByTestId('settings-cloud-card')).queryByText(failedText)).toBeNull();
      expect(onReload).not.toHaveBeenCalled();
      await fireEvent.press(screen.getByTestId(button));
      expect(screen.queryByTestId('byos-error')).toBeNull();
      expect(screen.getByTestId('byos-locked-reason')).toHaveTextContent(statusText);
      expect(screen.getByTestId(button)).toBeDisabled();
      await act(async () => retry.resolve({ ok: true, vaultId: 'v', encryption: 'aes-gcm' }));
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(perform).toHaveBeenCalledTimes(2);
      if (action !== 'gdrive') expect(connect.reauthGdrive).not.toHaveBeenCalled();
      if (action !== 'onedrive') expect(connect.reauthOneDrive).not.toHaveBeenCalled();
    });
  }
}

test.each(['null', 'non-null', 'rejection'] as const)('CD8: rejected current scope and obsolete %s preserve one current sentence without marker', async (late) => {
  await i18n.changeLanguage('en');
  const message = own('en', 'network');
  const old = deferred<string | null>();
  const current = deferred<string | null>();
  const oldestActions = controller(jest.fn(async () => 'old-scope'));
  const oldActions = controller(jest.fn(() => old.promise));
  const currentActions = controller(jest.fn(() => current.promise));
  const view = await render(<LibraryCloudSlot actions={oldestActions} message={message} />);
  expect(screen.getAllByText(message)).toHaveLength(1);
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  await view.rerender(<LibraryCloudSlot actions={oldActions} message={message} />);
  expect(screen.getAllByText(message)).toHaveLength(1);
  await view.rerender(<LibraryCloudSlot actions={currentActions} message={message} />);
  await act(async () => current.reject(new Error('unreadable scope')));
  expect(screen.getAllByText(message)).toHaveLength(1);
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  await act(async () => late === 'rejection' ? old.reject(new Error('old rejection')) : old.resolve(late === 'null' ? null : 'obsolete'));
  expect(screen.getAllByText(message)).toHaveLength(1);
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  const fresh = controller(jest.fn(async () => null));
  await view.rerender(<LibraryCloudSlot actions={fresh} message={message} />);
  expect(screen.getByTestId('library-cloud-unavailable')).toHaveTextContent(message);
  expect(screen.getAllByText(message)).toHaveLength(1);
  await view.rerender(<LibraryCloudSlot actions={fresh} message={undefined} />);
  expect(screen.queryByText(message)).toBeNull();
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  expect(fresh.getAccountScope).toHaveBeenCalledTimes(1);
  await view.rerender(<LibraryCloudSlot actions={null} message={message} />);
  expect(screen.getAllByText(message)).toHaveLength(1);
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  await view.unmount();
});
test('CD8: replacement invalidates an already resolved null immediately and unmount cancels deferred result', async () => {
  const next = deferred<string | null>();
  const actions = controller(jest.fn(() => next.promise));
  const view = await render(<LibraryCloudSlot actions={controller(async () => null)} message="Current sentence" />);
  expect(screen.getByTestId('library-cloud-unavailable')).toBeOnTheScreen();
  await view.rerender(<LibraryCloudSlot actions={actions} message="New sentence" />);
  expect(screen.getByTestId('byos-message')).toHaveTextContent('New sentence');
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  await view.unmount();
  await act(async () => next.resolve(null));
});
test('CD8: an action error and retry do not remount the scope reader', async () => {
  await i18n.changeLanguage('en');
  const scope = jest.fn(async () => 'scope-A');
  const actions = controller(scope);
  const first = { ok: false, category: 'wrong_password' } as const;
  const retry = deferred<ConnectResult>();
  const unlock = jest.fn().mockResolvedValueOnce(first).mockReturnValueOnce(retry.promise);
  const view = await render(<ByosSettingsSection
    byosStatus={locked}
    connectFlow={flow({ unlock })}
    onReload={jest.fn()}
    data={cloudSnapshot(locked)}
    renderCloudMessage={cloudMessageFactory(actions)}
  />);
  await waitFor(() => expect(scope).toHaveBeenCalledTimes(1));
  await fireEvent.changeText(screen.getByTestId('byos-unlock-password'), 'bad');
  await fireEvent.press(screen.getByTestId('byos-unlock'));
  expect(screen.getByTestId('byos-error')).toBeOnTheScreen();
  expect(scope).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId('byos-unlock'));
  expect(screen.queryByTestId('byos-error')).toBeNull();
  expect(scope).toHaveBeenCalledTimes(1);
  await act(async () => retry.resolve({ ok: true, vaultId: 'v', encryption: 'aes-gcm' }));
  await view.unmount();
});

test('CD8: returning to the same controller starts a new scope generation', async () => {
  const second = deferred<string | null>();
  const getAccountScope = jest.fn().mockResolvedValueOnce(null).mockReturnValueOnce(second.promise);
  const actions = controller(getAccountScope);
  const view = await render(<LibraryCloudSlot actions={actions} message="Current sentence" />);
  expect(screen.getByTestId('library-cloud-unavailable')).toBeOnTheScreen();
  await view.rerender(<LibraryCloudSlot actions={null} message="Current sentence" />);
  await view.rerender(<LibraryCloudSlot actions={actions} message="Current sentence" />);
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  await act(async () => second.reject(new Error('new generation rejected')));
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  expect(screen.getAllByText('Current sentence')).toHaveLength(1);
  expect(getAccountScope).toHaveBeenCalledTimes(2);
});
test('A6: password editing and locked-reason transitions clear previous feedback', async () => {
  await i18n.changeLanguage('en');
  const connect = flow();
  const props = { connectFlow: connect, onReload: jest.fn(), renderCloudMessage: cloudMessageFactory(null) };
  const view = await render(<ByosSettingsSection {...props} byosStatus={locked} data={cloudSnapshot(locked)} />);
  await fireEvent.press(screen.getByTestId('byos-unlock'));
  expect(screen.getByTestId('byos-error')).toHaveTextContent(own('en', 'wrongPassword'));
  await fireEvent.changeText(screen.getByTestId('byos-unlock-password'), 'new password');
  expect(screen.queryByTestId('byos-error')).toBeNull();
  await fireEvent.press(screen.getByTestId('byos-unlock'));
  expect(screen.getByTestId('byos-error')).toBeOnTheScreen();
  const network: ByosStatus = { status: 'locked', reason: 'vault_unreachable', detail: 'network' };
  await view.rerender(<ByosSettingsSection {...props} byosStatus={network} data={cloudSnapshot(network)} />);
  expect(screen.queryByTestId('byos-error')).toBeNull();
  expect(screen.getByTestId('byos-locked-reason')).toHaveTextContent(own('en', 'network'));
});
test('ready/loading formatter removes explanation even for scope null', async () => {
  const model = { ...cloudSnapshot(locked).model, state: 'ready' as const, messageKey: null };
  expect(formatCloudLibraryMessage(model, i18n.t.bind(i18n))).toBeUndefined();
  expect(formatCloudLibraryMessage({ ...model, state: 'loading' }, i18n.t.bind(i18n))).toBeUndefined();
  await render(<LibraryCloudSlot actions={controller(async () => null)} message={formatCloudLibraryMessage(model, i18n.t.bind(i18n))} />);
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  expect(screen.queryByTestId('byos-message')).toBeNull();
});
