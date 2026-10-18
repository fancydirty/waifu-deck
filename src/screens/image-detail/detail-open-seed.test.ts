import { readDetailOpenSeed, setDetailOpenSeed } from './detail-open-seed';

const thumb = 'file:///library/thumbnails/7.webp';

describe('detail open seed', () => {
  test('set then read returns the uri for that id and does not consume it', () => {
    setDetailOpenSeed(71, thumb);
    expect(readDetailOpenSeed(71)).toBe(thumb);
    expect(readDetailOpenSeed(71)).toBe(thumb);
  });

  test('another id reads null', () => {
    setDetailOpenSeed(72, thumb);
    expect(readDetailOpenSeed(73)).toBeNull();
  });

  test('null clears the id', () => {
    setDetailOpenSeed(74, thumb);
    setDetailOpenSeed(74, null);
    expect(readDetailOpenSeed(74)).toBeNull();
  });

  test('a second set replaces the uri', () => {
    setDetailOpenSeed(75, 'file:///library/thumbnails/first.webp');
    setDetailOpenSeed(75, 'file:///library/thumbnails/second.webp');
    expect(readDetailOpenSeed(75)).toBe('file:///library/thumbnails/second.webp');
  });

  test('setting or clearing one id keeps the other ids', () => {
    setDetailOpenSeed(81, 'file:///library/thumbnails/a.webp');
    setDetailOpenSeed(82, 'file:///library/thumbnails/b.webp');
    setDetailOpenSeed(83, 'file:///library/thumbnails/c.webp');
    setDetailOpenSeed(82, 'file:///library/thumbnails/b2.webp');
    expect(readDetailOpenSeed(81)).toBe('file:///library/thumbnails/a.webp');
    expect(readDetailOpenSeed(82)).toBe('file:///library/thumbnails/b2.webp');
    expect(readDetailOpenSeed(83)).toBe('file:///library/thumbnails/c.webp');
    setDetailOpenSeed(82, null);
    expect(readDetailOpenSeed(81)).toBe('file:///library/thumbnails/a.webp');
    expect(readDetailOpenSeed(82)).toBeNull();
    expect(readDetailOpenSeed(83)).toBe('file:///library/thumbnails/c.webp');
  });

  test('supports string digest keys alongside numeric image ids without collision', () => {
    const digest = 'a'.repeat(64);
    setDetailOpenSeed(digest, 'file:///library/thumbnails/import-a.webp');
    setDetailOpenSeed(91, 'file:///library/thumbnails/91.webp');
    expect(readDetailOpenSeed(digest)).toBe('file:///library/thumbnails/import-a.webp');
    expect(readDetailOpenSeed(91)).toBe('file:///library/thumbnails/91.webp');
    setDetailOpenSeed(digest, null);
    expect(readDetailOpenSeed(digest)).toBeNull();
    expect(readDetailOpenSeed(91)).toBe('file:///library/thumbnails/91.webp');
  });
});
