import {
  createGifStillStore,
  firstFrameEnd,
  GIF_STILL_CHUNK_BYTES,
  GIF_STILL_MAX_PREFIX_BYTES,
  type GifStillFilePort,
} from '@/features/images/gif-first-frame';
import { sha256PlaintextHex } from '@/features/library/library-identity';

/**
 * The store's default key hash is `expo-crypto`'s native digest. Under
 * `jest-expo` the unmocked module answers every digest with 32 ZERO bytes, so
 * every still would share one file name and the key assertions below would be
 * vacuous; map it onto the double's genuine SHA-256 (see library-digest.test).
 * babel-jest hoists this above the imports.
 */
jest.mock('expo-crypto', () => jest.requireActual('../../test/expo-crypto-double'));

// ---------------------------------------------------------------------------
// Byte fixtures, built block by block so each expected offset is exact.

type FrameSpec = {
  /** Local colour table size exponent (table = 3 * 2^(n+1) bytes), or none. */
  lct?: number;
  /** Total LZW payload bytes, split into ≤ 255-byte sub-blocks. */
  dataBytes: number;
};

type GifSpec = {
  version?: '87a' | '89a';
  gct?: number;
  /** Raw extension blocks placed before frame 0 (each already framed). */
  before?: number[][];
  frames: FrameSpec[];
  trailer?: boolean;
};

/** Appends without spreading: fixtures run to megabytes. */
function append(out: number[], bytes: readonly number[]): void {
  for (const byte of bytes) out.push(byte);
}

function subBlocks(total: number, fill = 0x5a): number[] {
  const out: number[] = [];
  let left = total;
  while (left > 0) {
    const n = Math.min(255, left);
    out.push(n);
    for (let i = 0; i < n; i += 1) out.push(fill);
    left -= n;
  }
  out.push(0);
  return out;
}

function colourTable(exponent: number, fill: number): number[] {
  return new Array<number>(3 * (2 << exponent)).fill(fill);
}

const graphicControl = [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00];
const netscapeLoop = [
  0x21, 0xff, 0x0b, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)),
  0x03, 0x01, 0x00, 0x00, 0x00,
];
const comment = [0x21, 0xfe, ...subBlocks(300, 0x41)];

/** Returns the gif bytes and the offset right after frame 0's terminator. */
function buildGif(spec: GifSpec): { bytes: Uint8Array; frame0End: number } {
  const out: number[] = [];
  out.push(...Array.from(`GIF${spec.version ?? '89a'}`, (c) => c.charCodeAt(0)));
  const gctFlags = spec.gct === undefined ? 0 : 0x80 | spec.gct;
  out.push(0x10, 0x00, 0x10, 0x00, gctFlags, 0x00, 0x00);
  if (spec.gct !== undefined) append(out, colourTable(spec.gct, 0xcc));
  for (const block of spec.before ?? []) append(out, block);
  let frame0End = -1;
  spec.frames.forEach((frame, index) => {
    append(out, graphicControl);
    const lctFlags = frame.lct === undefined ? 0 : 0x80 | frame.lct;
    out.push(0x2c, 0, 0, 0, 0, 0x10, 0x00, 0x10, 0x00, lctFlags);
    // A zero-filled local table: a walker that failed to skip it would read
    // the table's second byte as frame 0's terminator and stop far too early.
    // (A 0x07 fill resyncs by luck: 768 bytes parse as 96 seven-byte blocks.)
    if (frame.lct !== undefined) append(out, colourTable(frame.lct, 0x00));
    out.push(0x08);
    append(out, subBlocks(frame.dataBytes));
    if (index === 0) frame0End = out.length;
  });
  if (spec.trailer ?? true) out.push(0x3b);
  return { bytes: Uint8Array.from(out), frame0End };
}

// ---------------------------------------------------------------------------

describe('board #16 firstFrameEnd (GIF block walker, port of gifcut.py)', () => {
  test('a 1-frame gif without colour tables ends after its LZW terminator', () => {
    const { bytes, frame0End } = buildGif({ frames: [{ dataBytes: 40 }] });
    expect(firstFrameEnd(bytes)).toBe(frame0End);
    expect(bytes[frame0End]).toBe(0x3b);
  });

  test('a 3-frame gif with a global colour table ends after frame 0, not the last frame', () => {
    const { bytes, frame0End } = buildGif({
      gct: 7,
      frames: [{ dataBytes: 700 }, { dataBytes: 900 }, { dataBytes: 50 }],
    });
    expect(firstFrameEnd(bytes)).toBe(frame0End);
    expect(bytes[frame0End]).toBe(0x21); // frame 1's graphic control extension
  });

  test('a frame with a local colour table skips the table', () => {
    const { bytes, frame0End } = buildGif({
      gct: 1,
      frames: [{ lct: 7, dataBytes: 600 }, { lct: 3, dataBytes: 10 }],
    });
    expect(firstFrameEnd(bytes)).toBe(frame0End);
  });

  test('a NETSCAPE2.0 loop extension before frame 0 is skipped', () => {
    const { bytes, frame0End } = buildGif({
      gct: 7,
      before: [netscapeLoop],
      frames: [{ dataBytes: 300 }, { dataBytes: 300 }],
    });
    expect(firstFrameEnd(bytes)).toBe(frame0End);
  });

  test('a comment extension before frame 0 is skipped (GIF87a header too)', () => {
    const { bytes, frame0End } = buildGif({
      version: '87a',
      before: [comment, netscapeLoop],
      frames: [{ dataBytes: 256 }],
    });
    expect(firstFrameEnd(bytes)).toBe(frame0End);
  });

  test('a prefix truncated anywhere inside frame 0 is null', () => {
    const { bytes, frame0End } = buildGif({
      gct: 7,
      before: [netscapeLoop],
      frames: [{ lct: 2, dataBytes: 1000 }, { dataBytes: 10 }],
    });
    for (const cut of [0, 5, 12, 13, 100, 800, frame0End - 300, frame0End - 1]) {
      expect(firstFrameEnd(bytes.subarray(0, cut))).toBeNull();
    }
    expect(firstFrameEnd(bytes.subarray(0, frame0End))).toBe(frame0End);
  });

  test('non-GIF bytes are null', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]);
    expect(firstFrameEnd(png)).toBeNull();
    const badBlock = buildGif({ frames: [{ dataBytes: 10 }] }).bytes.slice();
    badBlock[13] = 0x99; // the first block after the screen is neither 0x21 nor 0x2C
    expect(firstFrameEnd(badBlock)).toBeNull();
    const noFrame = buildGif({ frames: [] }).bytes; // header + trailer only
    expect(firstFrameEnd(noFrame)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

type FakeFs = GifStillFilePort & {
  files: Map<string, Uint8Array>;
  reads: number[];
  opens: string[];
  writes: string[];
  closes: number;
  /** `[gifUri, pngUri, gif bytes at the time of the call]` per transcode. */
  transcodes: [string, string, Uint8Array][];
  deletes: string[];
};

const CACHE_DIR = 'file:///data/cache/';

function fakeFs(
  initial: Record<string, Uint8Array>,
  { unknownSize = false }: { unknownSize?: boolean } = {},
): FakeFs {
  const files = new Map(Object.entries(initial));
  const reads: number[] = [];
  const opens: string[] = [];
  const writes: string[] = [];
  const transcodes: [string, string, Uint8Array][] = [];
  const deletes: string[] = [];
  const fake: FakeFs = {
    files,
    reads,
    opens,
    writes,
    closes: 0,
    transcodes,
    deletes,
    cacheDir: CACHE_DIR,
    async exists(uri) {
      return files.has(uri);
    },
    open(uri) {
      const bytes = files.get(uri);
      if (!bytes) throw new Error(`ENOENT ${uri}`);
      opens.push(uri);
      let position = 0;
      return {
        // Native `FileHandle.size` is null when `fileChannel.size()` throws.
        size: unknownSize ? null : bytes.byteLength,
        readBytes(length) {
          // A read budget so a loop that ignores EOF fails the test instead of hanging it.
          if (reads.length >= 64) throw new Error('fake fs: read budget exceeded');
          reads.push(length);
          const chunk = bytes.slice(position, position + length);
          position += chunk.byteLength;
          return chunk;
        },
        close() {
          fake.closes += 1;
        },
      };
    },
    async write(uri, bytes) {
      writes.push(uri);
      files.set(uri, bytes.slice());
    },
    async transcodeToPng(gifUri, pngUri) {
      const gif = files.get(gifUri);
      if (!gif) throw new Error(`ENOENT ${gifUri}`);
      transcodes.push([gifUri, pngUri, gif.slice()]);
      files.set(pngUri, PNG_BYTES);
    },
    async delete(uri) {
      deletes.push(uri);
      files.delete(uri);
    },
  };
  return fake;
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SOURCE = 'file:///collection/44.gif';
const BYTE_SIZE = 50_278_178;

function stillHash(sourceUri: string, byteSize: number): string {
  return sha256PlaintextHex(new TextEncoder().encode(`${sourceUri}|${byteSize}`));
}

/** The still the store returns: a PNG, so Glide never builds a gif decoder for it. */
function stillUriFor(sourceUri: string, byteSize: number): string {
  return `file:///data/cache/gif-still/${stillHash(sourceUri, byteSize)}.png`;
}

/** The intermediate 1-frame gif cut, deleted once the PNG exists. */
function cutUriFor(sourceUri: string, byteSize: number): string {
  return `file:///data/cache/gif-still/${stillHash(sourceUri, byteSize)}.gif`;
}

describe('board #16 createGifStillStore', () => {
  test('the bounds are 256 KiB reads and a 4 MiB prefix (spec §5.3)', () => {
    expect(GIF_STILL_CHUNK_BYTES).toBe(256 * 1024);
    expect(GIF_STILL_MAX_PREFIX_BYTES).toBe(4 * 1024 * 1024);
  });

  test('reads 256 KiB chunks until frame 0 ends, cuts prefix + trailer to <sha256>.gif, transcodes it to <sha256>.png and deletes the cut', async () => {
    // Frame 0 ends past the second chunk; the file goes on well beyond it.
    const { bytes, frame0End } = buildGif({
      gct: 7,
      before: [netscapeLoop],
      frames: [{ dataBytes: 600_000 }, { dataBytes: 900_000 }, { dataBytes: 900_000 }],
    });
    expect(frame0End).toBeGreaterThan(2 * GIF_STILL_CHUNK_BYTES);
    expect(frame0End).toBeLessThan(3 * GIF_STILL_CHUNK_BYTES);
    const fs = fakeFs({ [SOURCE]: bytes });
    const store = createGifStillStore(fs);

    const result = await store.stillFor(SOURCE, BYTE_SIZE);

    const expectedUri = stillUriFor(SOURCE, BYTE_SIZE);
    const cutUri = cutUriFor(SOURCE, BYTE_SIZE);
    expect(result).toEqual({ uri: expectedUri, missing: false });
    expect(fs.reads).toEqual([GIF_STILL_CHUNK_BYTES, GIF_STILL_CHUNK_BYTES, GIF_STILL_CHUNK_BYTES]);
    expect(fs.writes).toEqual([cutUri]);
    expect(fs.transcodes.map(([gif, png]) => [gif, png])).toEqual([[cutUri, expectedUri]]);
    const written = fs.transcodes[0][2];
    expect(written.byteLength).toBe(frame0End + 1);
    expect(Array.from(written.subarray(0, frame0End))).toEqual(Array.from(bytes.subarray(0, frame0End)));
    expect(written[frame0End]).toBe(0x3b);
    // The cut is itself a well-formed 1-frame gif.
    expect(firstFrameEnd(written)).toBe(frame0End);
    // Only the PNG is left: the cut gif is gone (spec gate amendment §5.3).
    expect(fs.deletes).toEqual([cutUri]);
    expect(fs.files.has(cutUri)).toBe(false);
    expect(fs.files.get(expectedUri)).toBe(PNG_BYTES);
    expect([...fs.files.keys()].filter((uri) => uri.includes('/gif-still/'))).toEqual([expectedUri]);
  });

  test('never requests past 4 MiB and returns null when frame 0 does not end within it', async () => {
    const { bytes, frame0End } = buildGif({ frames: [{ dataBytes: 4_600_000 }, { dataBytes: 10 }] });
    expect(frame0End).toBeGreaterThan(GIF_STILL_MAX_PREFIX_BYTES);
    const fs = fakeFs({ [SOURCE]: bytes });

    const result = await createGifStillStore(fs).stillFor(SOURCE, BYTE_SIZE);

    expect(result).toEqual({ uri: null, missing: false });
    expect(fs.reads.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(GIF_STILL_MAX_PREFIX_BYTES);
    expect(fs.writes).toEqual([]);
  });

  test('a file that ends inside frame 0 returns null without writing', async () => {
    const { bytes, frame0End } = buildGif({ frames: [{ dataBytes: 400_000 }] });
    const fs = fakeFs({ [SOURCE]: bytes.subarray(0, frame0End - 10) });

    await expect(createGifStillStore(fs).stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: null,
      missing: false,
    });
    expect(fs.writes).toEqual([]);
  });

  test('non-GIF bytes stop after the first chunk', async () => {
    const fs = fakeFs({ [SOURCE]: new Uint8Array(3_000_000).fill(0xff) });

    await expect(createGifStillStore(fs).stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: null,
      missing: false,
    });
    expect(fs.reads).toEqual([GIF_STILL_CHUNK_BYTES]);
  });

  test('a second call hits the existing still with no read', async () => {
    const { bytes } = buildGif({ gct: 7, frames: [{ dataBytes: 1000 }, { dataBytes: 1000 }] });
    const fs = fakeFs({ [SOURCE]: bytes });
    const store = createGifStillStore(fs);

    const first = await store.stillFor(SOURCE, BYTE_SIZE);
    const opensAfterFirst = fs.opens.length;
    const second = await store.stillFor(SOURCE, BYTE_SIZE);
    // A fresh store (a new app process) finds the file on disk too.
    const third = await createGifStillStore(fs).stillFor(SOURCE, BYTE_SIZE);

    expect(opensAfterFirst).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fs.opens).toHaveLength(1);
    expect(fs.writes).toHaveLength(1);
    expect(fs.transcodes).toHaveLength(1);
  });

  test('a PNG already on disk is a hit with no read; a leftover cut .gif is not', async () => {
    const { bytes } = buildGif({ frames: [{ dataBytes: 100 }] });
    const hit = fakeFs({ [SOURCE]: bytes, [stillUriFor(SOURCE, BYTE_SIZE)]: PNG_BYTES });

    await expect(createGifStillStore(hit).stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: stillUriFor(SOURCE, BYTE_SIZE),
      missing: false,
    });
    expect(hit.opens).toEqual([]);
    expect(hit.transcodes).toEqual([]);

    // A cut gif left behind by a killed process (or an older build's still)
    // is never served: Glide would build a gif decoder for it.
    const stale = fakeFs({ [SOURCE]: bytes, [cutUriFor(SOURCE, BYTE_SIZE)]: bytes });
    await expect(createGifStillStore(stale).stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: stillUriFor(SOURCE, BYTE_SIZE),
      missing: false,
    });
    expect(stale.opens).toEqual([SOURCE]);
    expect(stale.transcodes).toHaveLength(1);
    expect(stale.files.has(cutUriFor(SOURCE, BYTE_SIZE))).toBe(false);
  });

  test('a transcode failure returns null (not missing), deletes the cut, and a later call retries', async () => {
    const { bytes } = buildGif({ frames: [{ dataBytes: 100 }] });
    const fs = fakeFs({ [SOURCE]: bytes });
    const transcode = fs.transcodeToPng.bind(fs);
    let failNext = true;
    fs.transcodeToPng = async (gifUri, pngUri) => {
      if (failNext) {
        failNext = false;
        throw new Error('decode failed');
      }
      return transcode(gifUri, pngUri);
    };
    const store = createGifStillStore(fs);

    await expect(store.stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({ uri: null, missing: false });
    expect(fs.files.has(cutUriFor(SOURCE, BYTE_SIZE))).toBe(false);
    expect(fs.files.has(stillUriFor(SOURCE, BYTE_SIZE))).toBe(false);

    await expect(store.stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: stillUriFor(SOURCE, BYTE_SIZE),
      missing: false,
    });
    expect(fs.opens).toHaveLength(2);
    expect(fs.closes).toBe(2);
    expect(fs.files.has(cutUriFor(SOURCE, BYTE_SIZE))).toBe(false);
  });

  test('a failed delete of the cut does not lose the finished PNG', async () => {
    const { bytes } = buildGif({ frames: [{ dataBytes: 100 }] });
    const fs = fakeFs({ [SOURCE]: bytes });
    fs.delete = async () => {
      throw new Error('EBUSY');
    };

    await expect(createGifStillStore(fs).stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: stillUriFor(SOURCE, BYTE_SIZE),
      missing: false,
    });
  });

  test('the key covers the byte size: a changed file gets a new still', async () => {
    const { bytes } = buildGif({ frames: [{ dataBytes: 100 }] });
    const fs = fakeFs({ [SOURCE]: bytes });
    const store = createGifStillStore(fs);

    const a = await store.stillFor(SOURCE, BYTE_SIZE);
    const b = await store.stillFor(SOURCE, BYTE_SIZE + 1);

    expect(a.uri).toBe(stillUriFor(SOURCE, BYTE_SIZE));
    expect(b.uri).toBe(stillUriFor(SOURCE, BYTE_SIZE + 1));
    expect(fs.opens).toHaveLength(2);
  });

  test('two concurrent calls for the same source share one read', async () => {
    const { bytes } = buildGif({ gct: 7, frames: [{ dataBytes: 300_000 }, { dataBytes: 10 }] });
    const fs = fakeFs({ [SOURCE]: bytes });
    const store = createGifStillStore(fs);

    const [a, b] = await Promise.all([
      store.stillFor(SOURCE, BYTE_SIZE),
      store.stillFor(SOURCE, BYTE_SIZE),
    ]);

    expect(a).toEqual(b);
    expect(a.uri).toBe(stillUriFor(SOURCE, BYTE_SIZE));
    expect(fs.opens).toHaveLength(1);
    expect(fs.writes).toHaveLength(1);
    expect(fs.transcodes).toHaveLength(1);
  });

  test('a missing source returns null and reports missing, so the viewer can repair', async () => {
    const fs = fakeFs({});

    await expect(createGifStillStore(fs).stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: null,
      missing: true,
    });
    expect(fs.opens).toEqual([]);
  });

  test('a read failure returns null (not missing) and a later call retries', async () => {
    const { bytes } = buildGif({ frames: [{ dataBytes: 100 }] });
    const fs = fakeFs({ [SOURCE]: bytes });
    const open = fs.open.bind(fs);
    let failNext = true;
    fs.open = (uri) => {
      if (failNext) {
        failNext = false;
        throw new Error('EIO');
      }
      return open(uri);
    };
    const store = createGifStillStore(fs);

    await expect(store.stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({ uri: null, missing: false });
    await expect(store.stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: stillUriFor(SOURCE, BYTE_SIZE),
      missing: false,
    });
  });

  test('an unknown size on a file that ends inside frame 0 stops at EOF instead of spinning', async () => {
    const { bytes, frame0End } = buildGif({ frames: [{ dataBytes: 400_000 }] });
    const fs = fakeFs({ [SOURCE]: bytes.subarray(0, frame0End - 10) }, { unknownSize: true });

    await expect(createGifStillStore(fs).stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({
      uri: null,
      missing: false,
    });
    // Two chunks of data, then the empty read at EOF ends it.
    expect(fs.reads).toHaveLength(3);
    expect(fs.writes).toEqual([]);
  });

  test('every opened handle is closed: success, truncated, not-a-gif, a throwing read and a throwing transcode', async () => {
    const { bytes, frame0End } = buildGif({ gct: 7, frames: [{ dataBytes: 300_000 }, { dataBytes: 10 }] });
    const fs = fakeFs({
      [SOURCE]: bytes,
      'file:///collection/cut.gif': bytes.subarray(0, frame0End - 10),
      'file:///collection/junk.gif': new Uint8Array(1000).fill(0xff),
      'file:///collection/eio.gif': bytes,
      'file:///collection/nopng.gif': bytes,
    });
    const transcode = fs.transcodeToPng.bind(fs);
    fs.transcodeToPng = async (gifUri, pngUri) => {
      if (gifUri === cutUriFor('file:///collection/nopng.gif', BYTE_SIZE)) throw new Error('decode failed');
      return transcode(gifUri, pngUri);
    };
    const open = fs.open.bind(fs);
    fs.open = (uri) => {
      const handle = open(uri);
      if (uri !== 'file:///collection/eio.gif') return handle;
      return { ...handle, readBytes: () => { throw new Error('EIO'); } };
    };
    const store = createGifStillStore(fs);

    await store.stillFor(SOURCE, BYTE_SIZE);
    await store.stillFor('file:///collection/cut.gif', BYTE_SIZE);
    await store.stillFor('file:///collection/junk.gif', BYTE_SIZE);
    await store.stillFor('file:///collection/eio.gif', BYTE_SIZE);
    await store.stillFor('file:///collection/nopng.gif', BYTE_SIZE);

    expect(fs.opens).toHaveLength(5);
    expect(fs.closes).toBe(5);
  });

  test('a source that cannot give a still is not re-read on the next call (same size)', async () => {
    const fs = fakeFs({ [SOURCE]: new Uint8Array(1000).fill(0xff) });
    const store = createGifStillStore(fs);

    await store.stillFor(SOURCE, BYTE_SIZE);
    await expect(store.stillFor(SOURCE, BYTE_SIZE)).resolves.toEqual({ uri: null, missing: false });
    expect(fs.opens).toHaveLength(1);

    // A changed file (new byte size) is read again.
    await store.stillFor(SOURCE, BYTE_SIZE + 1);
    expect(fs.opens).toHaveLength(2);
  });
});
