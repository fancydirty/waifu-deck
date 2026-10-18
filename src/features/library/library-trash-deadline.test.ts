import {
  LIBRARY_TRASH_RETENTION_MS,
  purgeDeadlineAt,
} from '@/features/library/library-trash-deadline';

describe('purgeDeadlineAt', () => {
  it('is trashed_at + 30 days', () => {
    const trashedAt = Date.UTC(2026, 6, 1, 0, 0, 0);
    expect(LIBRARY_TRASH_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(purgeDeadlineAt(trashedAt)).toBe(trashedAt + LIBRARY_TRASH_RETENTION_MS);
  });
});
