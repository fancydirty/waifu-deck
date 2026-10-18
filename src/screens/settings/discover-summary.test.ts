import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';
import { discoverSummaryParts, formatDiscoverSummary } from './discover-summary';

// Deliberately independent of i18next: the runtime trap must cover the helper,
// without a translator's plural rules accessing the forbidden globals.
const copy: Record<string, string> = {
  'settings.filters.portrait': 'Portrait',
  'settings.filters.landscape': 'Landscape',
  'settings.filters.styleAny': 'Any style',
  'settings.filters.prefer3d': 'Prefer 3D',
  'settings.filters.prefer2d': 'Prefer 2D',
  'settings.quality.unlimited': 'No limit',
  'settings.discover.summary.anyOrientation': 'Any orientation',
  'settings.discover.summary.animation.exclude': 'Exclude animated',
  'settings.discover.summary.animation.include': 'Include animated',
  'settings.discover.summary.animation.only': 'Animated only',
  'settings.discover.prefetchSummary': 'Preload {{count}}',
  'settings.discover.summary.minWidth': 'Width ≥ {{value}}',
  'settings.discover.summary.maxBytes': 'File ≤ {{value}}',
};
const fixedTranslation = (key: string, values: Record<string, string | number> = {}): string => {
  const template = copy[key];
  if (template === undefined) throw new Error(`Unexpected summary key: ${key}`);
  return template.replace(/{{(\w+)}}/g, (_, name: string) => String(values[name]));
};
const allNonDefaults: AppSettings = {
  ...DEFAULT_SETTINGS, orientation: 'landscape', animationMode: 'only',
  prefetchDepth: 60, stylePreference: 'prefer-3d', minWidth: 1080, maxBytes: 5_000_000,
};

const fullSummary = 'Landscape · Animated only · Preload 60 · Prefer 3D · Width ≥ 1080 px · File ≤ 5 MB';

describe('Discover summary', () => {
  test('defaults show orientation, animation and live prefetch only', () => {
    expect(discoverSummaryParts(DEFAULT_SETTINGS, fixedTranslation))
      .toEqual(['Portrait', 'Exclude animated', 'Preload 40']);
    expect(formatDiscoverSummary(DEFAULT_SETTINGS, fixedTranslation))
      .toBe('Portrait · Exclude animated · Preload 40');
  });

  test('all non-defaults append style, width and bytes in the specified order', () => {
    expect(discoverSummaryParts(allNonDefaults, fixedTranslation)).toEqual([
      'Landscape', 'Animated only', 'Preload 60', 'Prefer 3D', 'Width ≥ 1080 px', 'File ≤ 5 MB',
    ]);
    expect(formatDiscoverSummary(allNonDefaults, fixedTranslation)).toBe(fullSummary);
  });

  test.each([
    ['portrait', 'Portrait'], ['landscape', 'Landscape'], ['any', 'Any orientation'],
  ] as const)('%s orientation always starts the summary', (orientation, label) => {
    for (const [animationMode, animation] of [
      ['exclude', 'Exclude animated'], ['include', 'Include animated'], ['only', 'Animated only'],
    ] as const) {
      expect(formatDiscoverSummary({ ...DEFAULT_SETTINGS, orientation, animationMode }, fixedTranslation))
        .toBe(`${label} · ${animation} · Preload 40`);
    }
  });

  test.each([30, 40, 60] as const)('prefetch uses the live count %i', (prefetchDepth) => {
    expect(formatDiscoverSummary({ ...DEFAULT_SETTINGS, prefetchDepth }, fixedTranslation))
      .toBe(`Portrait · Exclude animated · Preload ${prefetchDepth}`);
  });

  test.each([
    ['prefer-3d', 'Prefer 3D'], ['prefer-2d', 'Prefer 2D'],
  ] as const)('%s uses its own translated style label', (stylePreference, label) => {
    expect(formatDiscoverSummary({ ...DEFAULT_SETTINGS, stylePreference }, fixedTranslation))
      .toBe(`Portrait · Exclude animated · Preload 40 · ${label}`);
  });

  test.each([[720, '720 px'], [1080, '1080 px'], [1440, '1440 px']] as const)(
    'width %i uses the shared option label and width interpolation', (minWidth, label) => {
      expect(formatDiscoverSummary({ ...DEFAULT_SETTINGS, minWidth }, fixedTranslation))
        .toBe(`Portrait · Exclude animated · Preload 40 · Width ≥ ${label}`);
    },
  );
  test.each([[2_000_000, '2 MB'], [5_000_000, '5 MB'], [10_000_000, '10 MB']] as const)(
    'bytes %i uses the shared option label and file interpolation', (maxBytes, label) => {
      expect(formatDiscoverSummary({ ...DEFAULT_SETTINGS, maxBytes }, fixedTranslation))
        .toBe(`Portrait · Exclude animated · Preload 40 · File ≤ ${label}`);
    },
  );

  test.each([
    [{ stylePreference: DEFAULT_SETTINGS.stylePreference }, 'Landscape · Animated only · Preload 60 · Width ≥ 1080 px · File ≤ 5 MB'],
    [{ minWidth: DEFAULT_SETTINGS.minWidth }, 'Landscape · Animated only · Preload 60 · Prefer 3D · File ≤ 5 MB'],
    [{ maxBytes: DEFAULT_SETTINGS.maxBytes }, 'Landscape · Animated only · Preload 60 · Prefer 3D · Width ≥ 1080 px'],
  ] as const)('omits each conditional default independently: %j', (defaults, expected) => {
    expect(formatDiscoverSummary({ ...allNonDefaults, ...defaults }, fixedTranslation)).toBe(expected);
  });

  test('conditional defaults follow DEFAULT_SETTINGS when the defaults change', () => {
    jest.replaceProperty(DEFAULT_SETTINGS, 'stylePreference', 'prefer-3d');
    jest.replaceProperty(DEFAULT_SETTINGS, 'minWidth', 720);
    jest.replaceProperty(DEFAULT_SETTINGS, 'maxBytes', 2_000_000);
    expect(formatDiscoverSummary({ ...DEFAULT_SETTINGS }, fixedTranslation))
      .toBe('Portrait · Exclude animated · Preload 40');
  });

  test('formatting runs with clock and internationalization globals trapped', () => {
    const originalDate = global.Date;
    const originalIntl = global.Intl;
    class ForbiddenDate {
      constructor() { throw new Error('Forbidden clock constructor'); }
      static now() { throw new Error('Forbidden clock now'); }
    }
    let defaultSummary: string;
    let nonDefaultSummary: string;
    let anySummary: string;
    try {
      global.Date = ForbiddenDate as unknown as DateConstructor;
      global.Intl = new Proxy(originalIntl, {
        get() { throw new Error('Forbidden internationalization access'); },
      });
      defaultSummary = formatDiscoverSummary(DEFAULT_SETTINGS, fixedTranslation);
      nonDefaultSummary = formatDiscoverSummary(allNonDefaults, fixedTranslation);
      anySummary = formatDiscoverSummary({
        ...allNonDefaults, orientation: 'any', animationMode: 'include', stylePreference: 'prefer-2d',
      }, fixedTranslation);
    } finally {
      global.Date = originalDate;
      global.Intl = originalIntl;
    }
    expect(defaultSummary).toBe('Portrait · Exclude animated · Preload 40');
    expect(nonDefaultSummary).toBe(fullSummary);
    expect(anySummary).toBe('Any orientation · Include animated · Preload 60 · Prefer 2D · Width ≥ 1080 px · File ≤ 5 MB');
  });

  test('helper source has no clock, internationalization, locale formatting or UI dependency', () => {
    const source = readFileSync(join(__dirname, 'discover-summary.ts'), 'utf8');
    expect(source).not.toMatch(/Date|Intl|toLocale|react/);
  });
});
