import { createNativeDigest, type DigestPort } from '@/features/library/library-digest';

/**
 * Board #16: a first-frame still for a gif too large to animate
 * (`animation-limits.ts`), cut from a bounded prefix of the file **without
 * Glide**. Every Glide path — `<Image>`, `useImage`, `asBitmap`, the image
 * manipulator — routes a gif through penfeizhou's whole-file read first, which
 * is exactly the OOM this avoids (spec §2/§5.3). A still made of the header,
 * the colour tables and frame 0 plus a trailer is a well-formed 1-frame gif;
 * row 44's (50.3 MB) is 408 151 B and decodes on any path.
 *
 * The cut is then transcoded once to a PNG and only the PNG is kept (gate
 * amendment 2026-09-27): a 1-frame *gif* is still decoded by penfeizhou as a
 * `FrameAnimationDrawable` with its own decoder, which parked the main thread
 * in `FrameSeqDecoder.getBounds` next to two animated neighbours. A PNG loads
 * as a plain bitmap.
 */

/** Read size per native call. */
export const GIF_STILL_CHUNK_BYTES = 256 * 1024;
/** Never read past this: covers a ~2048×2048 frame 0 at any LZW ratio. */
export const GIF_STILL_MAX_PREFIX_BYTES = 4 * 1024 * 1024;

const GIF_TRAILER = 0x3b;
const STILL_DIRECTORY = 'gif-still';

type WalkResult = number | 'truncated' | 'malformed';

/**
 * Walks the blocks of a GIF prefix up to the end of frame 0 (port of
 * a local log). `truncated` means more bytes may
 * resolve it; `malformed` means they never will.
 */
function walkFirstFrame(d: Uint8Array): WalkResult {
  if (!isGifSignature(d)) return 'malformed';
  if (d.byteLength < 13) return 'truncated';
  const flags = d[10];
  let p = 13;
  if (flags & 0x80) p += 3 * (2 << (flags & 7));

  // Skips a chain of data sub-blocks starting at `q`; returns the offset after
  // its zero terminator.
  const skipSubBlocks = (q: number): number | null => {
    while (q < d.byteLength) {
      const n = d[q];
      q += 1;
      if (n === 0) return q;
      q += n;
    }
    return null;
  };

  while (p < d.byteLength) {
    const block = d[p];
    if (block === GIF_TRAILER) return 'malformed'; // no frame at all
    if (block === 0x21) {
      // Extension: introducer, label, then sub-blocks.
      const next = skipSubBlocks(p + 2);
      if (next === null) return 'truncated';
      p = next;
      continue;
    }
    if (block === 0x2c) {
      // Image descriptor (10 bytes), optional local colour table, LZW
      // minimum code size, then the image data sub-blocks.
      if (p + 10 > d.byteLength) return 'truncated';
      const frameFlags = d[p + 9];
      p += 10;
      if (frameFlags & 0x80) p += 3 * (2 << (frameFlags & 7));
      const end = skipSubBlocks(p + 1);
      return end === null ? 'truncated' : end;
    }
    return 'malformed';
  }
  return 'truncated';
}

/** A prefix shorter than 6 bytes matches while it is still a GIF signature start. */
function isGifSignature(d: Uint8Array): boolean {
  const signature = String.fromCharCode(...d.subarray(0, 6));
  return 'GIF87a'.startsWith(signature) || 'GIF89a'.startsWith(signature);
}

/**
 * The byte offset right after frame 0's LZW terminator, or `null` when the
 * prefix is truncated before it or is not a GIF.
 */
export function firstFrameEnd(bytes: Uint8Array): number | null {
  const result = walkFirstFrame(bytes);
  return typeof result === 'number' ? result : null;
}

/** The slice of expo-file-system the store needs; faked in tests. */
export type GifStillFilePort = {
  /** Directory uri the `gif-still/` folder lives under. */
  readonly cacheDir: string;
  exists(uri: string): Promise<boolean>;
  /** Throws when the file cannot be opened. */
  open(uri: string): {
    readonly size: number | null;
    readBytes(length: number): Uint8Array;
    close(): void;
  };
  /** Creates intermediate directories; a partial write must never be visible at `uri`. */
  write(uri: string, bytes: Uint8Array): Promise<void>;
  /** Decodes the gif at `gifUri` and saves it as a PNG at `pngUri`; a partial PNG must never be visible there. */
  transcodeToPng(gifUri: string, pngUri: string): Promise<void>;
  /** Deletes the file if it exists. */
  delete(uri: string): Promise<void>;
};

/**
 * `uri` is the still's `file://` uri, or `null` when none could be made (then
 * the caller shows the colour block). `missing` is true only when the source
 * file itself is gone, so the viewer can run its `onLocalFileMissing` repair.
 */
export type GifStillResult = { uri: string | null; missing: boolean };

export type GifStillStore = {
  stillFor(sourceUri: string, byteSize: number): Promise<GifStillResult>;
};

export function createGifStillStore(
  fs: GifStillFilePort = createExpoGifStillFilePort(),
  { digest = createNativeDigest() }: { digest?: DigestPort } = {},
): GifStillStore {
  const inFlight = new Map<string, Promise<GifStillResult>>();
  // A source whose bytes can't give a still (not a gif, or frame 0 past the
  // 4 MiB bound) gives the same answer every time; without this every tile
  // and viewer render would re-read up to 4 MiB on the JS thread. Only a
  // thrown I/O error stays retryable — a thrown transcode included, since a
  // decoder failure under memory pressure is not proof the cut is bad. Keyed
  // with the byte size, so a changed file is read again.
  const unreadable = new Set<string>();
  const directory = `${fs.cacheDir.replace(/\/+$/, '')}/${STILL_DIRECTORY}`;

  const readFirstFrame = (sourceUri: string): Uint8Array | null => {
    const handle = fs.open(sourceUri);
    try {
      const capacity = Math.min(GIF_STILL_MAX_PREFIX_BYTES, handle.size ?? GIF_STILL_MAX_PREFIX_BYTES);
      const prefix = new Uint8Array(capacity);
      let length = 0;
      while (length < capacity) {
        const chunk = handle.readBytes(Math.min(GIF_STILL_CHUNK_BYTES, capacity - length));
        if (chunk.byteLength === 0) return null;
        prefix.set(chunk, length);
        length += chunk.byteLength;
        const walked = walkFirstFrame(prefix.subarray(0, length));
        if (walked === 'malformed') return null;
        if (walked === 'truncated') continue;
        const still = new Uint8Array(walked + 1);
        still.set(prefix.subarray(0, walked));
        still[walked] = GIF_TRAILER;
        return still;
      }
      return null;
    } finally {
      handle.close();
    }
  };

  const make = async (sourceUri: string, byteSize: number): Promise<GifStillResult> => {
    try {
      if (!(await fs.exists(sourceUri))) return { uri: null, missing: true };
      const hash = await digest(new TextEncoder().encode(`${sourceUri}|${byteSize}`));
      const stillUri = `${directory}/${hash}.png`;
      if (await fs.exists(stillUri)) return { uri: stillUri, missing: false };
      const still = readFirstFrame(sourceUri);
      if (still === null) {
        unreadable.add(`${sourceUri}|${byteSize}`);
        return { uri: null, missing: false };
      }
      const cutUri = `${directory}/${hash}.gif`;
      try {
        await fs.write(cutUri, still);
        await fs.transcodeToPng(cutUri, stillUri);
      } finally {
        await fs.delete(cutUri).catch(() => undefined);
      }
      return { uri: stillUri, missing: false };
    } catch {
      return { uri: null, missing: false };
    }
  };

  return {
    stillFor(sourceUri, byteSize) {
      const key = `${sourceUri}|${byteSize}`;
      if (unreadable.has(key)) return Promise.resolve({ uri: null, missing: false });
      const pending = inFlight.get(key);
      if (pending) return pending;
      const promise = make(sourceUri, byteSize).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
  };
}

function createExpoGifStillFilePort(): GifStillFilePort {
  // Lazy native import keeps web and Store bundles independent of the module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { File, FileMode, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  const deleteIfExists = (uri: string) => {
    const file = new File(uri);
    if (file.exists) file.delete();
  };

  return {
    cacheDir: Paths.cache.uri,
    async exists(uri) {
      return new File(uri).exists;
    },
    open(uri) {
      const handle = new File(uri).open(FileMode.ReadOnly);
      return {
        size: handle.size,
        readBytes: (length) => handle.readBytes(length),
        close: () => handle.close(),
      };
    },
    async write(uri, bytes) {
      // Write beside the target and move into place, so an interrupted write
      // is never mistaken for a finished still on the next call.
      const partial = new File(`${uri}.part`);
      partial.create({ overwrite: true, intermediates: true });
      partial.write(bytes);
      partial.moveSync(new File(uri), { overwrite: true });
    },
    async transcodeToPng(gifUri, pngUri) {
      const { ImageManipulator, SaveFormat } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('expo-image-manipulator') as typeof import('expo-image-manipulator');
      const context = ImageManipulator.manipulate(gifUri);
      let savedUri: string | null = null;
      const partialUri = `${pngUri}.part`;
      try {
        const rendered = await context.renderAsync();
        try {
          savedUri = (await rendered.saveAsync({ format: SaveFormat.PNG })).uri;
        } finally {
          // Free the native bitmap as soon as it is encoded.
          rendered.release();
        }
        // The manipulator saves under its own cache folder. Move it beside the
        // target first (a cross-folder move may fall back to copy + delete),
        // then rename within gif-still/, so only a whole PNG ever sits at `pngUri`.
        new File(savedUri).moveSync(new File(partialUri), { overwrite: true });
        savedUri = null;
        new File(partialUri).moveSync(new File(pngUri), { overwrite: true });
      } finally {
        context.release();
        if (savedUri !== null) deleteIfExists(savedUri);
        deleteIfExists(partialUri);
      }
    },
    async delete(uri) {
      deleteIfExists(uri);
    },
  };
}

let defaultStore: GifStillStore | null = null;

/** The app-wide store, so the viewer and the tiles share one in-flight read. */
export function defaultGifStillStore(): GifStillStore {
  defaultStore ??= createGifStillStore();
  return defaultStore;
}
