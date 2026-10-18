import { formatSyncAge } from './cloud-library-format';

/**
 * CD 13's exact four-locale age strings, injected so the pure formatter never
 * touches the real locale files (Task 2 ships those keys) nor `Intl`.
 * `plurals` mimics i18next's `_one`/`_other` suffix resolution for en.
 */
function makeT(table: Readonly<Record<string, string>>, plurals: boolean) {
  return (key: string, options?: { count?: number }): string => {
    const count = options?.count;
    const resolved = plurals && count !== undefined
      ? table[`${key}_${count === 1 ? 'one' : 'other'}`]
      : table[key];
    if (resolved === undefined) throw new Error(`unexpected key ${key}`);
    return count === undefined ? resolved : resolved.replace('{{count}}', String(count));
  };
}

const EN = makeT({
  'settings.cloudLibrary.age.justNow': 'Just now',
  'settings.cloudLibrary.age.minutesAgo_one': '1 minute ago',
  'settings.cloudLibrary.age.minutesAgo_other': '{{count}} minutes ago',
  'settings.cloudLibrary.age.hoursAgo_one': '1 hour ago',
  'settings.cloudLibrary.age.hoursAgo_other': '{{count}} hours ago',
  'settings.cloudLibrary.age.daysAgo_one': '1 day ago',
  'settings.cloudLibrary.age.daysAgo_other': '{{count}} days ago',
}, true);

const ZH_HANS = makeT({
  'settings.cloudLibrary.age.justNow': '刚刚',
  'settings.cloudLibrary.age.minutesAgo': '{{count}} 分钟前',
  'settings.cloudLibrary.age.hoursAgo': '{{count}} 小时前',
  'settings.cloudLibrary.age.daysAgo': '{{count}} 天前',
}, false);

const ZH_HANT = makeT({
  'settings.cloudLibrary.age.justNow': '剛剛',
  'settings.cloudLibrary.age.minutesAgo': '{{count}} 分鐘前',
  'settings.cloudLibrary.age.hoursAgo': '{{count}} 小時前',
  'settings.cloudLibrary.age.daysAgo': '{{count}} 天前',
}, false);

const JA = makeT({
  'settings.cloudLibrary.age.justNow': 'たった今',
  'settings.cloudLibrary.age.minutesAgo': '{{count}} 分前',
  'settings.cloudLibrary.age.hoursAgo': '{{count}} 時間前',
  'settings.cloudLibrary.age.daysAgo': '{{count}} 日前',
}, false);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatSyncAge', () => {
  it('floors each unit at its boundary', () => {
    const at = 1_000;
    expect(formatSyncAge(at, at, EN)).toBe('Just now');
    expect(formatSyncAge(at, at + 59_000, EN)).toBe('Just now');
    expect(formatSyncAge(at, at + MINUTE, EN)).toBe('1 minute ago');
    expect(formatSyncAge(at, at + 59 * MINUTE, EN)).toBe('59 minutes ago');
    expect(formatSyncAge(at, at + HOUR, EN)).toBe('1 hour ago');
    expect(formatSyncAge(at, at + 23 * HOUR, EN)).toBe('23 hours ago');
    expect(formatSyncAge(at, at + DAY, EN)).toBe('1 day ago');
  });

  it('keeps sub-unit remainders from rounding up to the next unit', () => {
    const at = 1_000;
    // 89 s is one completed minute and change; only flooring keeps it there.
    expect(formatSyncAge(at, at + 89_000, EN)).toBe('1 minute ago');
    expect(formatSyncAge(at, at + 90_000, EN)).toBe('1 minute ago');
    expect(formatSyncAge(at, at + 119_000, EN)).toBe('1 minute ago');
    expect(formatSyncAge(at, at + 89 * MINUTE + 59_000, EN)).toBe('1 hour ago');
    expect(formatSyncAge(at, at + 90 * MINUTE, EN)).toBe('1 hour ago');
    expect(formatSyncAge(at, at + 36 * HOUR, EN)).toBe('1 day ago');
  });

  it('clamps timestamps more than a minute in the future to just now', () => {
    expect(formatSyncAge(1_000 + 5 * MINUTE, 1_000, EN)).toBe('Just now');
    expect(formatSyncAge(1_000 + 5 * MINUTE, 1_000, ZH_HANS)).toBe('刚刚');
  });

  it('pluralizes only past one unit in en', () => {
    const at = 1_000;
    expect(formatSyncAge(at, at + 2 * MINUTE, EN)).toBe('2 minutes ago');
    expect(formatSyncAge(at, at + 2 * HOUR, EN)).toBe('2 hours ago');
    expect(formatSyncAge(at, at + 2 * DAY, EN)).toBe('2 days ago');
  });

  it('clamps a future timestamp to just now instead of counting up', () => {
    expect(formatSyncAge(5_000, 1_000, EN)).toBe('Just now');
    expect(formatSyncAge(5_000, 1_000, ZH_HANS)).toBe('刚刚');
  });

  it('renders the exact CD 13 age strings in all four locales', () => {
    const at = 1_000;
    expect(formatSyncAge(at, at, ZH_HANS)).toBe('刚刚');
    expect(formatSyncAge(at, at + 3 * MINUTE, ZH_HANS)).toBe('3 分钟前');
    expect(formatSyncAge(at, at + 3 * HOUR, ZH_HANS)).toBe('3 小时前');
    expect(formatSyncAge(at, at + 3 * DAY, ZH_HANS)).toBe('3 天前');
    expect(formatSyncAge(at, at + 3 * MINUTE, ZH_HANT)).toBe('3 分鐘前');
    expect(formatSyncAge(at, at + 3 * HOUR, ZH_HANT)).toBe('3 小時前');
    expect(formatSyncAge(at, at + 3 * DAY, ZH_HANT)).toBe('3 天前');
    expect(formatSyncAge(at, at + 3 * MINUTE, JA)).toBe('3 分前');
    expect(formatSyncAge(at, at + 3 * HOUR, JA)).toBe('3 時間前');
    expect(formatSyncAge(at, at + 3 * DAY, JA)).toBe('3 日前');
  });

  it('derives elapsed time only from the explicit nowMs argument', () => {
    const now = jest.spyOn(Date, 'now');
    formatSyncAge(1_000, 61_000, EN);
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });
});
