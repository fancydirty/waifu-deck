import {
  createExpoFirstFrameDecoder,
  createExpoLibraryDecodeGate,
  createLibraryDecodeGate,
  LIBRARY_DECODE_MAX_DIMENSION,
  type ExpoFirstFrameDecoder,
  type ExpoImageLoader,
} from '@/features/library/library-decode-gate';
import { LibraryIngestError } from '@/features/library/library-types';

// Board #35 review finding 1: the gate's DEFAULT first-frame decoder must be the one that holds the
// manipulator context (production builds the gate with its defaults). Only the default path reaches this mock.
const mockManipulatorEvents: string[] = [];
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: {
    manipulate: (uri: string) => {
      mockManipulatorEvents.push(`manipulate ${uri}`);
      return {
        async renderAsync() {
          mockManipulatorEvents.push('render');
          return { width: 8, height: 6, release() { mockManipulatorEvents.push('image release'); } };
        },
        release() { mockManipulatorEvents.push('context release'); },
      };
    },
  },
  SaveFormat: {},
}));

describe('library decode gate', () => {
  test('accepts a decodable image and returns its dimensions', async () => {
    const gate = createLibraryDecodeGate({
      decode: async () => ({ width: 640, height: 480 }),
    });

    await expect(gate.validate({
      uri: 'file:///cache/a.tmp',
      format: 'jpeg',
      byteSize: 1024,
    })).resolves.toEqual({ width: 640, height: 480 });
  });

  test('rejects an empty staged file before decoding', async () => {
    let decoded = false;
    const gate = createLibraryDecodeGate({
      decode: async () => {
        decoded = true;
        return { width: 1, height: 1 };
      },
    });

    await expect(gate.validate({
      uri: 'file:///cache/empty.tmp',
      format: 'png',
      byteSize: 0,
    })).rejects.toMatchObject({ code: 'empty_file' });
    expect(decoded).toBe(false);
  });

  test('rejects a corrupt image the renderer cannot decode', async () => {
    const gate = createLibraryDecodeGate({
      decode: async () => {
        throw new Error('Unable to decode image');
      },
    });

    const failure = gate.validate({
      uri: 'file:///cache/corrupt.tmp',
      format: 'gif',
      byteSize: 12,
    });
    await expect(failure).rejects.toBeInstanceOf(LibraryIngestError);
    await expect(failure).rejects.toMatchObject({ code: 'decode_failed' });
  });

  test('rejects a decode that reports no pixels', async () => {
    const gate = createLibraryDecodeGate({
      decode: async () => ({ width: 0, height: 10 }),
    });

    await expect(gate.validate({
      uri: 'file:///cache/zero.tmp',
      format: 'webp',
      byteSize: 40,
    })).rejects.toMatchObject({ code: 'decode_failed' });
  });

  test('A2: a GIF is proven decodable by a FIRST-FRAME decode, never a full-animation decode at 4096', async () => {
    // Emulator repro 2026-09-16: `expo-image.loadAsync(gif, 4096x4096)` decodes
    // the whole GifDrawable — every frame — which was 63-100 s per 37-frame gif
    // and, on Glide's shared decode pool, starved the collection tile's own load
    // of the same file (the "solid tile until restart" the owner saw). The gif
    // branch instead renders one frame through expo-image-manipulator
    // (Glide.asBitmap), whose size IS the first frame = the gif's logical
    // screen. The full-size loadAsync is never called for a gif.
    const loadCalls: unknown[] = [];
    const firstFrameCalls: string[] = [];
    const loader: ExpoImageLoader = {
      async loadAsync(source, options) { loadCalls.push({ source, options }); return { width: 1, height: 1 }; },
    };
    const firstFrame: ExpoFirstFrameDecoder = {
      async firstFrame(uri) { firstFrameCalls.push(uri); return { width: 560, height: 315 }; },
    };
    const gate = createExpoLibraryDecodeGate(loader, firstFrame);

    await expect(gate.validate({
      uri: 'file:///cache/anim.tmp', format: 'gif', byteSize: 948_975,
    })).resolves.toEqual({ width: 560, height: 315 });
    expect(firstFrameCalls).toEqual(['file:///cache/anim.tmp']);
    expect(loadCalls).toEqual([]); // the full-animation loader is never asked for a gif
  });

  test('A2: a static image still decodes through loadAsync at the full bound', async () => {
    const loadCalls: unknown[] = [];
    const gate = createExpoLibraryDecodeGate(
      { async loadAsync(source, options) { loadCalls.push({ source, options }); return { width: 100, height: 50 }; } },
      { async firstFrame() { throw new Error('gif path must not run for a png'); } },
    );
    await expect(gate.validate({
      uri: 'file:///cache/b.tmp', format: 'png', byteSize: 99,
    })).resolves.toEqual({ width: 100, height: 50 });
    expect(loadCalls).toEqual([{ source: { uri: 'file:///cache/b.tmp' }, options: { maxWidth: LIBRARY_DECODE_MAX_DIMENSION, maxHeight: LIBRARY_DECODE_MAX_DIMENSION } }]);
  });

  test('A2: a corrupt GIF whose first frame cannot be decoded is refused', async () => {
    const gate = createExpoLibraryDecodeGate(
      { async loadAsync() { return { width: 1, height: 1 }; } },
      { async firstFrame() { throw new Error('Unable to decode image'); } },
    );
    await expect(gate.validate({
      uri: 'file:///cache/bad.tmp', format: 'gif', byteSize: 10,
    })).rejects.toMatchObject({ code: 'decode_failed' });
  });

  test('the Expo gate loads through the production renderer with bounded size', async () => {
    const calls: unknown[] = [];
    const loader: ExpoImageLoader = {
      async loadAsync(source, options) {
        calls.push({ source, options });
        return { width: 100, height: 50 };
      },
    };
    const gate = createExpoLibraryDecodeGate(loader);

    await expect(gate.validate({
      uri: 'file:///cache/b.tmp',
      format: 'png',
      byteSize: 99,
    })).resolves.toEqual({ width: 100, height: 50 });
    expect(calls).toEqual([{
      source: { uri: 'file:///cache/b.tmp' },
      options: { maxWidth: 4096, maxHeight: 4096 },
    }]);
  });
});

describe('board #35: the expo first-frame decoder', () => {
  test('the Expo gate decodes a gif with the context-holding decoder by default', async () => {
    mockManipulatorEvents.length = 0;
    const gate = createExpoLibraryDecodeGate({ async loadAsync() { throw new Error('not for a gif'); } });

    await expect(gate.validate({ uri: 'file:///cache/anim.tmp', format: 'gif', byteSize: 10 }))
      .resolves.toEqual({ width: 8, height: 6 });
    expect(mockManipulatorEvents).toEqual([
      'manipulate file:///cache/anim.tmp', 'render', 'image release', 'context release',
    ]);
  });

  type ManipulatorModule = typeof import('expo-image-manipulator');

  function fakeFirstFrameModule(events: string[], render: () => Promise<void>): () => ManipulatorModule {
    const ImageManipulator = {
      manipulate(uri: string) {
        events.push(`manipulate ${uri}`);
        return {
          async renderAsync() {
            events.push('render start');
            await render();
            events.push('render end');
            // Like the native ref, a released image can no longer be read (drift finding 1).
            let released = false;
            const readable = (value: number) => {
              if (released) throw new Error('Cannot use shared object that was already released');
              return value;
            };
            return {
              get width() { return readable(560); },
              get height() { return readable(315); },
              release() { released = true; events.push('image release'); },
            };
          },
          release() { events.push('context release'); },
        };
      },
    };
    return () => ({ ImageManipulator }) as unknown as ManipulatorModule;
  }

  test('holds the context until the render settles, then releases the image and the context', async () => {
    const events: string[] = [];
    let finishRender!: () => void;
    const rendering = new Promise<void>((resolve) => { finishRender = resolve; });
    const decoder = createExpoFirstFrameDecoder(fakeFirstFrameModule(events, () => rendering));

    const size = decoder.firstFrame('file:///cache/anim.tmp');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['manipulate file:///cache/anim.tmp', 'render start']);

    finishRender();
    await expect(size).resolves.toEqual({ width: 560, height: 315 });
    expect(events).toEqual([
      'manipulate file:///cache/anim.tmp', 'render start', 'render end', 'image release', 'context release',
    ]);
  });

  test('a failed render releases the context and rejects', async () => {
    const events: string[] = [];
    const decoder = createExpoFirstFrameDecoder(
      fakeFirstFrameModule(events, () => Promise.reject(new Error('Unable to decode image'))),
    );

    await expect(decoder.firstFrame('file:///cache/bad.tmp')).rejects.toThrow('Unable to decode image');
    expect(events).toEqual(['manipulate file:///cache/bad.tmp', 'render start', 'context release']);
  });
});
