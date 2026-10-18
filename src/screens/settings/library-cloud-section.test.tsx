import { render, screen } from '@testing-library/react-native';
import type { LibraryActionsController } from '@/features/library/library-actions-service';
import i18n from '@/i18n';
import { colors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';
import { LibraryCloudSection } from './library-cloud-section';

const forbiddenIds = ['library-mirror-status', 'library-save-policy-future-only',
  'library-save-policy-this-device-only', 'library-save-policy-this-device-and-cloud', 'library-save-policy-cloud-only',
  'library-batch-protect-all', 'library-batch-download-all', 'library-batch-free-all',
  'library-batch-progress', 'library-batch-pause', 'library-batch-resume', 'library-batch-retry-failed'];

test.each([null, undefined, 'scope'])('message presence comes only from the supplied model, scope=%s', async (accountScope) => {
  const startBatch = jest.fn();
  const recoverBatches = jest.fn();
  const actions = { startBatch, recoverBatches } as unknown as LibraryActionsController;
  const view = await render(<LibraryCloudSection actions={actions} accountScope={accountScope} message="Current model sentence" />);
  expect(screen.getAllByText('Current model sentence')).toHaveLength(1);
  if (accountScope === null) expect(screen.getByTestId('library-cloud-unavailable')).toBeOnTheScreen();
  else expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  expect(screen.getByTestId(accountScope === null ? 'library-cloud-unavailable' : 'byos-message').props.style).toEqual(
    expect.objectContaining({ ...settingsTypography.cloudMessage, color: colors.light.text }));
  for (const id of forbiddenIds) expect(screen.queryByTestId(id)).toBeNull();
  expect(startBatch).not.toHaveBeenCalled();
  expect(recoverBatches).not.toHaveBeenCalled();
  await view.rerender(<LibraryCloudSection actions={actions} accountScope={accountScope} />);
  expect(screen.queryByText('Current model sentence')).toBeNull();
  expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
});

test.each(['en', 'ja', 'zh-Hans', 'zh-Hant'])('%s retains direct legacy equivalents with no above pointer', (locale) => {
  const reasons = i18n.getResource(locale, 'translation', 'settings.libraryCloud.lockedReason');
  for (const [key, suffix] of [['password_required', 'unlock'], ['vault_unreachable', 'network'], ['meta_corrupt', 'unreadable']]) {
    // Existing resource names are kept for callers outside the page composition.
    const value = reasons[key];
    expect(value).toBe(i18n.getResource(locale, 'translation', `settings.cloudLibrary.lockMessage.${suffix}`));
  }
  expect(JSON.stringify(reasons)).not.toMatch(/above|上方|上の|上記/i);
});
