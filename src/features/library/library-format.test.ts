import {
  canonicalExtensionFor,
  detectLibraryImageFormat,
  LIBRARY_FORMAT_SNIFF_BYTES,
} from '@/features/library/library-format';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
const gif87 = bytes(...ascii('GIF87a'), 0x01, 0x00, 0x01, 0x00);
const gif89 = bytes(...ascii('GIF89a'), 0x01, 0x00, 0x01, 0x00);
const webp = bytes(
  ...ascii('RIFF'), 0x1a, 0x00, 0x00, 0x00, ...ascii('WEBPVP8 '),
);

describe('library image format detection', () => {
  test('detects every supported format from magic bytes', () => {
    expect(detectLibraryImageFormat(jpeg)).toEqual({
      format: 'jpeg',
      canonicalExtension: 'jpg',
    });
    expect(detectLibraryImageFormat(png)).toEqual({
      format: 'png',
      canonicalExtension: 'png',
    });
    expect(detectLibraryImageFormat(gif87)).toEqual({
      format: 'gif',
      canonicalExtension: 'gif',
    });
    expect(detectLibraryImageFormat(gif89)).toEqual({
      format: 'gif',
      canonicalExtension: 'gif',
    });
    expect(detectLibraryImageFormat(webp)).toEqual({
      format: 'webp',
      canonicalExtension: 'webp',
    });
  });

  test('ignores a lying filename and reports the real bytes', () => {
    // A picker item named "vacation.jpg" whose bytes are really PNG.
    expect(detectLibraryImageFormat(png)).toEqual({
      format: 'png',
      canonicalExtension: 'png',
    });
    // A picker item named "art.png" whose bytes are really JPEG.
    expect(detectLibraryImageFormat(jpeg)).toEqual({
      format: 'jpeg',
      canonicalExtension: 'jpg',
    });
  });

  test('rejects unsupported, truncated, and RIFF-but-not-WebP input', () => {
    expect(detectLibraryImageFormat(bytes())).toBeNull();
    expect(detectLibraryImageFormat(bytes(0xff, 0xd8))).toBeNull();
    expect(detectLibraryImageFormat(bytes(0x42, 0x4d, 0x00, 0x00))).toBeNull();
    expect(detectLibraryImageFormat(
      bytes(...ascii('RIFF'), 0x1a, 0x00, 0x00, 0x00, ...ascii('WAVEfmt ')),
    )).toBeNull();
    expect(detectLibraryImageFormat(
      bytes(...ascii('GIF88a'), 0x01, 0x00, 0x01, 0x00),
    )).toBeNull();
  });

  test('maps each format to its canonical extension', () => {
    expect(canonicalExtensionFor('jpeg')).toBe('jpg');
    expect(canonicalExtensionFor('png')).toBe('png');
    expect(canonicalExtensionFor('webp')).toBe('webp');
    expect(canonicalExtensionFor('gif')).toBe('gif');
    expect(LIBRARY_FORMAT_SNIFF_BYTES).toBe(16);
  });
});

