import type { TFunction } from 'i18next';

import { formatBytes } from './format-bytes';

// A minimal stand-in for the injected `t`: formatBytes' parameter keeps its
// production TFunction type, which only i18next's branded shape satisfies.
const t = ((key: string) => {
  switch (key) {
    case 'settings.storage.calculating': return '计算中…';
    case 'settings.storage.unavailable': return '不可用';
    default: throw new Error(`unexpected key ${key}`);
  }
}) as unknown as TFunction;

describe('formatBytes', () => {
  it('keeps the Settings byte ladder exactly as the home rows render it', () => {
    expect(formatBytes(0, t)).toBe('0 B');
    expect(formatBytes(999, t)).toBe('999 B');
    expect(formatBytes(1000, t)).toBe('1 KB');
    expect(formatBytes(1500, t)).toBe('1.5 KB');
    expect(formatBytes(1_000_000, t)).toBe('1 MB');
    expect(formatBytes(1_500_000, t)).toBe('1.5 MB');
    // E12: large libraries stay in MB with one stripped decimal — no GB step.
    expect(formatBytes(3_617_793_056, t)).toBe('3617.8 MB');
  });

  it('keeps the translated calculating/unavailable strings for the old callers', () => {
    expect(formatBytes(null, t)).toBe('计算中…');
    expect(formatBytes('unavailable', t)).toBe('不可用');
  });
});
