import type { LibraryImageFormat } from '@/features/library/library-types';
import { LibraryIngestError } from '@/features/library/library-types';

export const LIBRARY_DECODE_MAX_DIMENSION = 4096;

export type LibraryDecodeInput = Readonly<{
  uri: string;
  format: LibraryImageFormat;
  byteSize: number;
}>;

export type LibraryDecodeInfo = Readonly<{
  width: number;
  height: number;
}>;

export interface LibraryDecodeGate {
  validate(input: LibraryDecodeInput): Promise<LibraryDecodeInfo>;
}

export type LibraryDecodePort = Readonly<{
  decode(input: LibraryDecodeInput): Promise<LibraryDecodeInfo>;
}>;

export type ExpoImageLoader = {
  loadAsync(
    source: { uri: string },
    options: { maxWidth: number; maxHeight: number },
  ): Promise<{ width: number; height: number }>;
};

type ManipulatorModule = typeof import('expo-image-manipulator');

/**
 * A2 (2026-09-16): a first-frame decode of an animated source. `expo-image`'s
 * `loadAsync` decodes to a `GifDrawable` — the WHOLE animation — which cost
 * 80–100 s per 37-frame gif on the emulator and, because it runs on Glide's
 * shared decode pool, starved the collection tile's own load of the same file
 * (the "solid tile until restart" the owner saw). `expo-image-manipulator`
 * renders through `expo-image-loader`'s `Glide.asBitmap()`, which decodes ONLY
 * the first frame — one frame, not 37 — and still fails on a corrupt gif, so it
 * is a real production-renderer proof at a real (small) cost. Its reported size
 * is the first frame, i.e. the gif's logical screen — the intrinsic size.
 */
export type ExpoFirstFrameDecoder = {
  firstFrame(uri: string): Promise<{ width: number; height: number }>;
};

export function createLibraryDecodeGate(
  port: LibraryDecodePort,
): LibraryDecodeGate {
  return {
    async validate(input) {
      if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
        throw new LibraryIngestError(
          'empty_file',
          'This image file is empty or incomplete.',
        );
      }

      let info: LibraryDecodeInfo;
      try {
        info = await port.decode(input);
      } catch (error) {
        throw new LibraryIngestError(
          'decode_failed',
          'This image could not be decoded and was not saved.',
          { cause: error },
        );
      }

      if (
        !Number.isFinite(info.width)
        || !Number.isFinite(info.height)
        || info.width <= 0
        || info.height <= 0
      ) {
        throw new LibraryIngestError(
          'decode_failed',
          'This image could not be decoded and was not saved.',
        );
      }
      return { width: info.width, height: info.height };
    },
  };
}

function loadExpoImage(): ExpoImageLoader {
  // Lazy native import keeps Store and web bundles free of the decode path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Image } = require('expo-image') as typeof import('expo-image');
  return Image as unknown as ExpoImageLoader;
}

export function createExpoFirstFrameDecoder(
  load: () => ManipulatorModule = () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-image-manipulator') as ManipulatorModule,
): ExpoFirstFrameDecoder {
  return {
    async firstFrame(uri) {
      const { ImageManipulator } = load();
      // Board #35 (expo/expo#50217): hold the context until the render settles;
      // a context released mid-render cancels it (see library-expo-image-resizer).
      const context = ImageManipulator.manipulate(uri);
      try {
        const rendered = await context.renderAsync();
        try {
          return { width: rendered.width, height: rendered.height };
        } finally {
          // Free the native bitmap the moment its dimensions are read.
          rendered.release();
        }
      } finally {
        context.release();
      }
    },
  };
}

export function createExpoLibraryDecodeGate(
  loader: ExpoImageLoader = loadExpoImage(),
  firstFrameDecoder: ExpoFirstFrameDecoder = createExpoFirstFrameDecoder(),
): LibraryDecodeGate {
  return createLibraryDecodeGate({
    async decode({ uri, format }) {
      if (format === 'gif') {
        // First frame only (see ExpoFirstFrameDecoder) — a real decode that
        // rejects a corrupt gif, at the cost of one frame, so the tile's own
        // load of the same file is never starved behind a 37-frame decode.
        return firstFrameDecoder.firstFrame(uri);
      }
      const reference = await loader.loadAsync({ uri }, {
        maxWidth: LIBRARY_DECODE_MAX_DIMENSION,
        maxHeight: LIBRARY_DECODE_MAX_DIMENSION,
      });
      return { width: reference.width, height: reference.height };
    },
  });
}
