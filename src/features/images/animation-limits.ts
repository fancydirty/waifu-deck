/**
 * Board #16: the largest gif the app will animate. Above it a row shows its
 * first frame as a still (`gif-first-frame.ts`) and the viewer says why.
 *
 * The number is measured, not guessed (spec §5.1, sweep on emulator-5560 at
 * `heapgrowthlimit=192m`, a local log): every
 * gif up to 17.4 MB animated with 0 OOM, 32.9 MB OOMed once in two opens and
 * 50.3 MB OOMs on every open. The penfeizhou decoder reads the whole file into
 * a doubling `ByteArrayOutputStream` and then copies it, so a file of at most
 * 16 MiB peaks at ≤ 32 MiB transient; from 16 MiB up the next grow step makes
 * that 48 MiB, which the 32.9 MB probe already shows can fail. 32 MiB leaves
 * ≥ 2× margin for one decode and still fits a pager neighbour gif beside it.
 * The pre-declared fallback, if the under-cap neighbour gate records an OOM,
 * is 8 MiB.
 */
export const GIF_ANIMATE_MAX_BYTES = 16 * 1024 * 1024;

type AnimationFacts = { isAnimated: boolean; extension: string };

/** The repository stores the extension with its dot (`.gif`); accept either. */
export function isGifRow(image: { extension: string }): boolean {
  return image.extension.trim().toLowerCase().replace(/^\.+/, '') === 'gif';
}

/**
 * Board #6: rows the viewer shows through a Glide-owned `<Image>` instead of a
 * `useImage` ref. Metadata is the first signal; `StaticGalleryContent` hands
 * off at runtime when a ref turns out animated anyway.
 */
export function isAnimatedRow(image: AnimationFacts): boolean {
  return image.isAnimated || isGifRow(image);
}

/**
 * True when the row must never start an animated or whole-file decode. A
 * `byteSize` of 0 is "unknown" (Gelbooru defaults a missing `file_size` to 0)
 * and keeps today's behaviour. Gif only: an animated WebP (nekos) or an
 * mp4/webm-flagged row (Gelbooru, Danbooru `duration`) is out of scope (spec
 * §4) and the first-frame cut cannot read it, so it keeps today's path.
 */
export function isTooLargeToAnimate(image: { extension: string; byteSize: number }): boolean {
  return isGifRow(image) && image.byteSize > GIF_ANIMATE_MAX_BYTES;
}
