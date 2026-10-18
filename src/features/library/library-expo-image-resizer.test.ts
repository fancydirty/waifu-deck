import { createExpoLibraryImageResizer } from '@/features/library/library-expo-image-resizer';
import type { LibraryFilePort } from '@/features/library/library-file-store';

type ManipulatorModule = typeof import('expo-image-manipulator');

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A fake expo-image-manipulator that records every call in order. */
function fakeManipulator(events: string[], options: Readonly<{
  render?: () => Promise<void>;
  save?: (format: string) => Promise<{ uri: string; width: number; height: number }>;
}> = {}): () => ManipulatorModule {
  const SaveFormat = { WEBP: 'webp', JPEG: 'jpeg', PNG: 'png' };
  const ImageManipulator = {
    manipulate(uri: string) {
      events.push(`manipulate ${uri}`);
      const context = {
        resize(size: { width: number; height: number }) {
          events.push(`resize ${size.width}x${size.height}`);
          return context;
        },
        async renderAsync() {
          events.push('render start');
          await (options.render ? options.render() : Promise.resolve());
          events.push('render end');
          return {
            width: 0,
            height: 0,
            async saveAsync({ format }: { format: string }) {
              events.push(`save ${format}`);
              return options.save
                ? options.save(format)
                : { uri: `file:///cache/out.${format}`, width: 288, height: 512 };
            },
            release() { events.push('image release'); },
          };
        },
        release() { events.push('context release'); },
      };
      return context;
    },
  };
  return () => ({ ImageManipulator, SaveFormat }) as unknown as ManipulatorModule;
}

function fakePort(events: string[]): LibraryFilePort {
  return {
    async readBytes(uri: string) { events.push(`read ${uri}`); return new Uint8Array([1, 2, 3]); },
    async delete(uri: string) { events.push(`delete ${uri}`); },
  } as unknown as LibraryFilePort;
}

describe('expo library image resizer', () => {
  test('board #35: the context is held until the render settles, then the image and the context are released', async () => {
    const events: string[] = [];
    let finishRender!: () => void;
    const rendering = new Promise<void>((resolve) => { finishRender = resolve; });
    const resizer = createExpoLibraryImageResizer(
      fakePort(events),
      fakeManipulator(events, { render: () => rendering }),
    );

    const result = resizer.resize({ sourceUri: 'file:///o.png', sourceWidth: 2160, sourceHeight: 3840, maxEdge: 512 });
    await flush();
    // Mid-render nothing is released: releasing the context is what cancels the render (expo/expo#50217).
    expect(events).toEqual(['manipulate file:///o.png', 'resize 288x512', 'render start']);

    finishRender();
    await expect(result).resolves.toMatchObject({ width: 288, height: 512, format: 'webp' });
    expect(events).toEqual([
      'manipulate file:///o.png', 'resize 288x512', 'render start', 'render end',
      'save webp', 'read file:///cache/out.webp', 'delete file:///cache/out.webp',
      'image release', 'context release',
    ]);
  });

  test('board #35: a failed render still releases the context and rejects with its error', async () => {
    const events: string[] = [];
    const resizer = createExpoLibraryImageResizer(
      fakePort(events),
      fakeManipulator(events, { render: () => Promise.reject(new Error('DeferredCoroutine was cancelled')) }),
    );

    await expect(resizer.resize({ sourceUri: 'file:///o.png', sourceWidth: 100, sourceHeight: 100, maxEdge: 512 }))
      .rejects.toThrow('DeferredCoroutine was cancelled');
    expect(events).toEqual(['manipulate file:///o.png', 'resize 100x100', 'render start', 'context release']);
  });

  test('board #35: when both encoders fail, the image and the context are released and the last error is thrown', async () => {
    const events: string[] = [];
    const resizer = createExpoLibraryImageResizer(
      fakePort(events),
      fakeManipulator(events, { save: (format) => Promise.reject(new Error(`no ${format}`)) }),
    );

    await expect(resizer.resize({ sourceUri: 'file:///o.png', sourceWidth: 100, sourceHeight: 100, maxEdge: 512 }))
      .rejects.toThrow('no jpeg');
    expect(events.slice(-4)).toEqual(['save webp', 'save jpeg', 'image release', 'context release']);
  });

  test('scales the longer edge to maxEdge and keeps a smaller image at its size', async () => {
    const events: string[] = [];
    const resizer = createExpoLibraryImageResizer(fakePort(events), fakeManipulator(events));

    await resizer.resize({ sourceUri: 'file:///a.png', sourceWidth: 2847, sourceHeight: 4096, maxEdge: 2048 });
    await resizer.resize({ sourceUri: 'file:///b.png', sourceWidth: 300, sourceHeight: 200, maxEdge: 512 });
    expect(events.filter((event) => event.startsWith('resize '))).toEqual(['resize 1424x2048', 'resize 300x200']);
  });
});
