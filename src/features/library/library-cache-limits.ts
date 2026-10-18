/**
 * Total decrypted role bytes one account scope may keep in the app-private OS
 * cache directory. `PROJECT-STATUS.md` records cache sizing as an
 * implementer-owned parameter. 192 MiB comfortably holds thousands of bounded
 * thumbnails plus a working set of screen previews on a midrange Android
 * device, while staying small enough that the OS rarely reclaims the directory
 * mid-session. Eviction is oldest-first and never touches a durable original.
 */
export const LIBRARY_CACHE_MAX_BYTES = 192 * 1024 * 1024;

/** Longest edge of a grid thumbnail plaintext. Never upscales a smaller image. */
export const LIBRARY_THUMBNAIL_MAX_EDGE = 512;

/** Longest edge of a screen-sized detail preview plaintext. */
export const LIBRARY_PREVIEW_MAX_EDGE = 2048;

/**
 * Extra entries past the last visible grid item whose render source may be
 * resolved. Design § Viewing And Cache Behavior: prefetch a bounded next
 * window, never the whole library while scrolling.
 */
export const LIBRARY_RENDER_WINDOW_AHEAD = 12;
