import {
  createLibraryDerivedImages,
  type LibraryImageResizePort,
} from '@/features/library/library-derived-images';
import {
  LIBRARY_PREVIEW_MAX_EDGE,
  LIBRARY_THUMBNAIL_MAX_EDGE,
} from '@/features/library/library-cache-limits';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';

const SOURCE = 'file:///originals/a.jpg';

type ResizeOutput = Awaited<ReturnType<LibraryImageResizePort['resize']>>;

function fakeResizer(
  overrides: Partial<{
    fail: boolean;
    respond: (input: {
      maxEdge: number;
      sourceWidth: number;
      sourceHeight: number;
    }) => ResizeOutput | Promise<ResizeOutput>;
  }> = {},
): LibraryImageResizePort & { calls: { maxEdge: number }[] } {
  const calls: { maxEdge: number }[] = [];
  return {
    calls,
    async resize({ maxEdge, sourceWidth, sourceHeight }) {
      calls.push({ maxEdge });
      if (overrides.fail) throw new Error('resize unavailable');
      if (overrides.respond) {
        return overrides.respond({ maxEdge, sourceWidth, sourceHeight });
      }
      const longest = Math.max(sourceWidth, sourceHeight);
      const scale = longest <= maxEdge ? 1 : maxEdge / longest;
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      return {
        bytes: new Uint8Array(width * height),
        width,
        height,
        format: 'webp' as const,
      };
    },
  };
}

describe('library derived images', () => {
  it('produces a bounded thumbnail and preview from one verified original', async () => {
    const resizer = fakeResizer();
    const derived = createLibraryDerivedImages({ resizer });
    const result = await derived.derive({
      sourceUri: SOURCE,
      format: 'jpeg',
      width: 4000,
      height: 3000,
    });

    expect(result.thumbnail?.width).toBe(LIBRARY_THUMBNAIL_MAX_EDGE);
    expect(result.preview?.width).toBe(LIBRARY_PREVIEW_MAX_EDGE);
    // Aspect ratio preserved within rounding.
    expect(Math.abs(
      (result.preview!.width / result.preview!.height) - (4000 / 3000),
    )).toBeLessThan(0.01);
    expect(resizer.calls.map((call) => call.maxEdge)).toEqual([
      LIBRARY_THUMBNAIL_MAX_EDGE,
      LIBRARY_PREVIEW_MAX_EDGE,
    ]);
    expect(result.animated).toBe(false);
  });

  it("roles: ['thumbnail'] resizes once, at the thumbnail bound", async () => {
    const resizer = fakeResizer();
    const derived = createLibraryDerivedImages({ resizer });
    const input = { sourceUri: SOURCE, format: 'jpeg', width: 4000, height: 3000 } as const;

    const only = await derived.derive({ ...input, roles: ['thumbnail'] });
    expect(resizer.calls.map((call) => call.maxEdge)).toEqual([LIBRARY_THUMBNAIL_MAX_EDGE]);
    expect(only.thumbnail).not.toBeNull();
    expect(only.preview).toBeNull();
    expect(only.failed).toBe(false);

    resizer.calls.length = 0;
    await derived.derive(input);
    expect(resizer.calls.map((call) => call.maxEdge)).toEqual([
      LIBRARY_THUMBNAIL_MAX_EDGE,
      LIBRARY_PREVIEW_MAX_EDGE,
    ]);
  });

  it('never upscales a source that is already smaller than the bound', async () => {
    const derived = createLibraryDerivedImages({ resizer: fakeResizer() });
    const result = await derived.derive({
      sourceUri: SOURCE,
      format: 'png',
      width: 120,
      height: 90,
    });
    expect(result.thumbnail).toEqual(expect.objectContaining({ width: 120, height: 90 }));
    expect(result.preview).toEqual(expect.objectContaining({ width: 120, height: 90 }));
  });

  it('reports an animated source so detail can prefer the original', async () => {
    const derived = createLibraryDerivedImages({ resizer: fakeResizer() });
    const result = await derived.derive({
      sourceUri: SOURCE,
      format: 'gif',
      width: 400,
      height: 400,
    });
    expect(result.animated).toBe(true);
    // A still frame is still worth caching for the grid.
    expect(result.thumbnail).not.toBeNull();
  });

  it('returns null roles instead of throwing when the resizer is unavailable', async () => {
    const derived = createLibraryDerivedImages({ resizer: fakeResizer({ fail: true }) });
    const result = await derived.derive({
      sourceUri: SOURCE,
      format: 'jpeg',
      width: 800,
      height: 600,
    });
    expect(result.thumbnail).toBeNull();
    expect(result.preview).toBeNull();
    expect(result.failed).toBe(true);
  });

  it('drops a produced plaintext that would exceed the envelope limit', async () => {
    const derived = createLibraryDerivedImages({
      resizer: fakeResizer({
        respond: ({ maxEdge }) => ({
          bytes: new Uint8Array(LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES + 1),
          width: maxEdge,
          height: maxEdge,
          format: 'webp',
        }),
      }),
    });
    const result = await derived.derive({
      sourceUri: SOURCE,
      format: 'jpeg',
      width: 800,
      height: 600,
    });
    expect(result.thumbnail).toBeNull();
    expect(result.preview).toBeNull();
    expect(result.failed).toBe(true);
  });

  it('refuses empty bytes and marks the role failed', async () => {
    const derived = createLibraryDerivedImages({
      resizer: fakeResizer({
        respond: ({ maxEdge }) => ({
          bytes: new Uint8Array(0),
          width: maxEdge,
          height: maxEdge,
          format: 'webp',
        }),
      }),
    });
    const result = await derived.derive({
      sourceUri: SOURCE,
      format: 'jpeg',
      width: 800,
      height: 600,
    });
    expect(result.thumbnail).toBeNull();
    expect(result.preview).toBeNull();
    expect(result.failed).toBe(true);
  });

  it('refuses an output whose longest edge exceeds maxEdge and marks failed', async () => {
    const derived = createLibraryDerivedImages({
      resizer: fakeResizer({
        respond: ({ maxEdge }) => ({
          bytes: new Uint8Array(16),
          width: maxEdge + 1,
          height: maxEdge + 1,
          format: 'webp',
        }),
      }),
    });
    const result = await derived.derive({
      sourceUri: SOURCE,
      format: 'jpeg',
      width: 800,
      height: 600,
    });
    expect(result.thumbnail).toBeNull();
    expect(result.preview).toBeNull();
    expect(result.failed).toBe(true);
  });
});
