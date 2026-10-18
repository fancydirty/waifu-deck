import type { LibraryImageResizePort } from '@/features/library/library-derived-images';
import type { LibraryFilePort } from '@/features/library/library-file-store';

type ManipulatorModule = typeof import('expo-image-manipulator');

export function createExpoLibraryImageResizer(
  port: LibraryFilePort,
  load: () => ManipulatorModule = () =>
    // Lazy native require keeps Store bundles independent of the module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-image-manipulator') as ManipulatorModule,
): LibraryImageResizePort {
  return {
    async resize({ sourceUri, sourceWidth, sourceHeight, maxEdge }) {
      const { ImageManipulator, SaveFormat } = load();
      const longest = Math.max(sourceWidth, sourceHeight);
      const scale = longest <= maxEdge ? 1 : maxEdge / longest;
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));

      // Board #35 (expo/expo#50217): on Android, releasing a manipulator context
      // cancels a render still in flight, and Hermes releases a context no
      // variable holds when it collects it — so a one-liner render can reject
      // mid-way and a derived role silently goes missing. Hold the context until
      // the render settles and release it (and the rendered bitmap) ourselves.
      const context = ImageManipulator.manipulate(sourceUri);
      try {
        context.resize({ width, height });
        const rendered = await context.renderAsync();
        try {
          const attempts: readonly Readonly<{
            format: 'webp' | 'jpeg';
            saveFormat: unknown;
            compress: number;
          }>[] = [
            { format: 'webp', saveFormat: SaveFormat.WEBP, compress: 0.82 },
            { format: 'jpeg', saveFormat: SaveFormat.JPEG, compress: 0.82 },
          ];

          let lastError: unknown = new Error('No derived encoder succeeded.');
          for (const attempt of attempts) {
            let savedUri: string | null = null;
            try {
              const saved = await rendered.saveAsync({
                format: attempt.saveFormat as never,
                compress: attempt.compress,
              });
              savedUri = saved.uri;
              const bytes = await port.readBytes(saved.uri);
              return {
                bytes,
                width: saved.width,
                height: saved.height,
                format: attempt.format,
              };
            } catch (error) {
              lastError = error;
            } finally {
              if (savedUri !== null) {
                // Never leave a derived plaintext on disk after it is in memory.
                await port.delete(savedUri).catch(() => undefined);
              }
            }
          }
          throw lastError;
        } finally {
          // Free the scaled bitmap now rather than at the next collection.
          rendered.release();
        }
      } finally {
        context.release();
      }
    },
  };
}
