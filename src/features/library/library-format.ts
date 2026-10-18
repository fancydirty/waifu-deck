import type {
  LibraryCanonicalExtension,
  LibraryImageFormat,
} from '@/features/library/library-types';

export const LIBRARY_FORMAT_SNIFF_BYTES = 16;

export type DetectedLibraryFormat = Readonly<{
  format: LibraryImageFormat;
  canonicalExtension: LibraryCanonicalExtension;
}>;

const CANONICAL_EXTENSIONS: Readonly<
  Record<LibraryImageFormat, LibraryCanonicalExtension>
> = Object.freeze({
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
});

const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.byteLength < offset + length) return '';
  let text = '';
  for (let index = offset; index < offset + length; index += 1) {
    text += String.fromCharCode(bytes[index]!);
  }
  return text;
}

export function canonicalExtensionFor(
  format: LibraryImageFormat,
): LibraryCanonicalExtension {
  return CANONICAL_EXTENSIONS[format];
}

export function detectLibraryImageFormat(
  bytes: Uint8Array,
): DetectedLibraryFormat | null {
  if (bytes.byteLength < 4) return null;

  if (startsWith(bytes, JPEG_MAGIC)) {
    return { format: 'jpeg', canonicalExtension: 'jpg' };
  }
  if (startsWith(bytes, PNG_MAGIC)) {
    return { format: 'png', canonicalExtension: 'png' };
  }

  const header = asciiAt(bytes, 0, 6);
  if (header === 'GIF87a' || header === 'GIF89a') {
    return { format: 'gif', canonicalExtension: 'gif' };
  }

  if (
    asciiAt(bytes, 0, 4) === 'RIFF'
    && asciiAt(bytes, 8, 4) === 'WEBP'
  ) {
    return { format: 'webp', canonicalExtension: 'webp' };
  }

  return null;
}

