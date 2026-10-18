import {
  GIF_ANIMATE_MAX_BYTES,
  isAnimatedRow,
  isGifRow,
  isTooLargeToAnimate,
} from '@/features/images/animation-limits';

const row = (overrides: Partial<{ byteSize: number; isAnimated: boolean; extension: string }> = {}) => ({
  byteSize: 1_000_000,
  isAnimated: false,
  extension: '.gif',
  ...overrides,
});

describe('board #16 animation limits', () => {
  test('the cap is 16 MiB (spec §5.1)', () => {
    expect(GIF_ANIMATE_MAX_BYTES).toBe(16_777_216);
  });

  test('a gif of exactly 16 MiB still animates; one byte more does not', () => {
    expect(isTooLargeToAnimate(row({ byteSize: 16_777_216 }))).toBe(false);
    expect(isTooLargeToAnimate(row({ byteSize: 16_777_217 }))).toBe(true);
  });

  test('an unknown size (0) keeps today\'s behaviour', () => {
    expect(isTooLargeToAnimate(row({ byteSize: 0 }))).toBe(false);
  });

  test('a 50 MB static jpg is never "too large to animate"', () => {
    expect(isTooLargeToAnimate(row({ byteSize: 50_278_178, extension: '.jpg' }))).toBe(false);
  });

  test('an upper-case .GIF and an isAnimated .gif above the cap both count', () => {
    expect(isTooLargeToAnimate(row({ byteSize: 50_278_178, extension: '.GIF' }))).toBe(true);
    expect(
      isTooLargeToAnimate(row({ byteSize: 50_278_178, extension: '.gif', isAnimated: true })),
    ).toBe(true);
  });

  test('a non-gif animated row (animated WebP, mp4/webm flag) above the cap keeps today\'s path (spec §4)', () => {
    expect(
      isTooLargeToAnimate(row({ byteSize: 50_278_178, extension: '.webp', isAnimated: true })),
    ).toBe(false);
    expect(
      isTooLargeToAnimate(row({ byteSize: 50_278_178, extension: '.jpg', isAnimated: true })),
    ).toBe(false);
  });

  test('isGifRow reads the extension only, stored with or without its dot', () => {
    expect(isGifRow({ extension: '.gif' })).toBe(true);
    expect(isGifRow({ extension: ' GIF ' })).toBe(true);
    expect(isGifRow({ extension: '.jpg' })).toBe(false);
  });

  test('isAnimatedRow: the metadata flag or a gif extension (any case, stored with its dot)', () => {
    expect(isAnimatedRow(row({ isAnimated: true, extension: '.jpg' }))).toBe(true);
    expect(isAnimatedRow(row({ isAnimated: false, extension: '.gif' }))).toBe(true);
    expect(isAnimatedRow(row({ isAnimated: false, extension: '.GIF' }))).toBe(true);
    expect(isAnimatedRow(row({ isAnimated: false, extension: '.jpg' }))).toBe(false);
    expect(isAnimatedRow(row({ isAnimated: false, extension: 'GIF' }))).toBe(true);
    expect(isAnimatedRow(row({ isAnimated: false, extension: 'gif' }))).toBe(true);
    expect(isAnimatedRow(row({ isAnimated: false, extension: 'jpg' }))).toBe(false);
  });
});
