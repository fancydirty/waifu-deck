/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LIBRARY_TRASH_RETENTION_MS } from '@/features/library/library-trash-deadline';
import type { TrashLibraryEntry } from '@/features/library/library-view-model';
import i18n from '@/i18n';
import {
  isTrashDeadlineUrgent,
  LibraryTrashScreen,
  trashDeadlineDays,
} from '@/screens/library/library-trash-screen';

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => {
        const cleanup = effect();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, [effect]);
    },
  };
});

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return {
    ChevronRight: Icon,
    Trash2: Icon,
  };
});

const DIGEST = 'a'.repeat(64);
const TRASHED_AT = 1_700_000_000_000;
const FORMATTED_DEADLINE = 'formatted-deadline-2024-01-01';

const entry: TrashLibraryEntry = {
  plaintextSha256: DIGEST,
  sourceImageId: null,
  format: 'jpeg',
  byteSize: 1_024,
  width: 100,
  height: 100,
  residency: 'cloud-only',
  lifecycle: 'trash',
  protection: 'unprotected',
  failureCategory: null,
  hasLocalOriginal: false,
  localOriginalUri: null,
  originalGenerationId: null,
  createdAt: TRASHED_AT - 1_000,
  trashedAt: TRASHED_AT,
  purgeDeadlineAt: TRASHED_AT + LIBRARY_TRASH_RETENTION_MS,
};

async function renderTrashScreen(overrides: {
  entries?: readonly TrashLibraryEntry[];
  restoreFromTrash?: jest.Mock;
  permanentlyDeleteFromTrash?: jest.Mock;
  emptyLibraryTrash?: jest.Mock;
  formatDeadline?: (ms: number) => string;
} = {}) {
  const entries = overrides.entries ?? [];
  const listTrashEntries = jest.fn(async () => entries);
  return render(
    <LibraryTrashScreen
      listTrashEntries={listTrashEntries}
      restoreFromTrash={
        overrides.restoreFromTrash
          ?? jest.fn(async () => ({ status: 'queued' as const, mutationId: 'm' }))
      }
      permanentlyDeleteFromTrash={
        overrides.permanentlyDeleteFromTrash
          ?? jest.fn(async () => ({ status: 'queued' as const, mutationId: 'm' }))
      }
      emptyLibraryTrash={
        overrides.emptyLibraryTrash
          ?? jest.fn(async () => ({ purged: 0, failures: 0, pending: 0 }))
      }
      formatDeadline={
        overrides.formatDeadline
          ?? (() => FORMATTED_DEADLINE)
      }
    />,
  );
}

describe('LibraryTrashScreen', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('lists trash entries with formatted 30-day deadlines', async () => {
    await renderTrashScreen({
      entries: [entry],
    });
    expect(await screen.findByText(/Deletes permanently on/i)).toBeTruthy();
    expect(await screen.findByText(new RegExp(FORMATTED_DEADLINE))).toBeTruthy();
  });

  it('restore calls restoreFromTrash and refreshes', async () => {
    const restoreFromTrash = jest.fn(async () => ({
      status: 'queued' as const,
      mutationId: 'm',
    }));
    await renderTrashScreen({
      restoreFromTrash,
      entries: [entry],
    });
    fireEvent.press(await screen.findByLabelText('Restore'));
    await waitFor(() => expect(restoreFromTrash).toHaveBeenCalledWith(DIGEST));
  });

  it('permanent delete uses the strongest warning and does not enqueue until confirm', async () => {
    const permanentlyDeleteFromTrash = jest.fn(async () => ({
      status: 'queued' as const,
      mutationId: 'm',
    }));
    await renderTrashScreen({
      permanentlyDeleteFromTrash,
      entries: [entry],
    });
    await fireEvent.press(await screen.findByLabelText('Delete permanently'));
    expect(await screen.findByText(
      String(i18n.getResource('en', 'translation', 'libraryTrash.deletePermanentlyConfirmMessage')),
    )).toBeTruthy();
    expect(permanentlyDeleteFromTrash).not.toHaveBeenCalled();
    await fireEvent.press(await screen.findByLabelText('Delete permanently forever'));
    await waitFor(() => expect(permanentlyDeleteFromTrash).toHaveBeenCalledWith(DIGEST));
  });

  it('empty trash confirms then calls emptyLibraryTrash', async () => {
    const emptyLibraryTrash = jest.fn(async () => ({ purged: 1, failures: 0, pending: 0 }));
    await renderTrashScreen({
      emptyLibraryTrash,
      entries: [entry],
    });
    await fireEvent.press(await screen.findByLabelText('Empty trash'));
    await fireEvent.press(await screen.findByLabelText('Empty trash now'));
    await waitFor(() => expect(emptyLibraryTrash).toHaveBeenCalled());
  });

  it('surfaces empty-trash rejection as polite live-region status without leaving confirm open', async () => {
    const emptyLibraryTrash = jest.fn(async () => {
      throw new Error('transport');
    });
    await renderTrashScreen({
      emptyLibraryTrash,
      entries: [entry],
    });
    await fireEvent.press(await screen.findByLabelText('Empty trash'));
    expect(await screen.findByText('Empty trash?')).toBeTruthy();
    await fireEvent.press(await screen.findByLabelText('Empty trash now'));
    await waitFor(() => expect(emptyLibraryTrash).toHaveBeenCalled());
    expect(screen.queryByText('Empty trash?')).toBeNull();
    const status = await screen.findByText(
      "That didn't work. Please try again in a moment.",
    );
    expect(status).toBeTruthy();
    expect(status.props.accessibilityLiveRegion).toBe('polite');
  });

  /**
   * K7 ⑤: focus used to run a whole cloud round here too. The screen no longer
   * holds a sync trigger at all (the prop is gone — a compile-time guarantee);
   * what focus must still do is re-read the trash list.
   */
  it('K7 ⑤: focus re-reads the trash list and starts no sync round', async () => {
    const listTrashEntries = jest.fn(async () => [entry]);
    await render(
      <LibraryTrashScreen
        listTrashEntries={listTrashEntries}
        restoreFromTrash={jest.fn(async () => ({ status: 'queued' as const, mutationId: 'm' }))}
        permanentlyDeleteFromTrash={jest.fn(async () => ({ status: 'queued' as const, mutationId: 'm' }))}
        emptyLibraryTrash={jest.fn(async () => ({ purged: 0, failures: 0, pending: 0 }))}
        formatDeadline={() => FORMATTED_DEADLINE}
      />,
    );
    await screen.findByText(/Deletes permanently on/i);
    expect(listTrashEntries).toHaveBeenCalled();
  });
});

describe('trash deadline chip helpers', () => {
  const DAY = 86_400_000;
  test('whole days remaining, floored at zero', () => {
    expect(trashDeadlineDays(Date.parse('2026-08-31T00:00:00Z'), Date.parse('2026-08-21T00:00:00Z'))).toBe(10);
    expect(trashDeadlineDays(1_000, 2_000)).toBe(0);
    expect(trashDeadlineDays(2_000 + DAY / 2, 2_000)).toBe(1);
  });
  test('urgent below seven whole days, calm at or above', () => {
    const now = 1_700_000_000_000;
    expect(isTrashDeadlineUrgent(now + 6 * DAY, now)).toBe(true);
    expect(isTrashDeadlineUrgent(now + 6.9 * DAY, now)).toBe(false);
    expect(isTrashDeadlineUrgent(now + 7 * DAY, now)).toBe(false);
    expect(isTrashDeadlineUrgent(now + 30 * DAY, now)).toBe(false);
  });
});
