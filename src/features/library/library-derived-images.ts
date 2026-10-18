import type { LibraryObjectRole } from '@/features/library/library-actions-types';
import {
  LIBRARY_PREVIEW_MAX_EDGE,
  LIBRARY_THUMBNAIL_MAX_EDGE,
} from '@/features/library/library-cache-limits';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import type { LibraryImageFormat } from '@/features/library/library-types';

/** What a derived encoder produced. `format` is what it actually wrote. */
export type LibraryDerivedImage = Readonly<{
  role: Extract<LibraryObjectRole, 'thumbnail' | 'preview'>;
  bytes: Uint8Array;
  width: number;
  height: number;
  format: 'webp' | 'jpeg' | 'png';
}>;

export type LibraryImageResizePort = Readonly<{
  resize(input: Readonly<{
    sourceUri: string;
    sourceWidth: number;
    sourceHeight: number;
    maxEdge: number;
  }>): Promise<Readonly<{
    bytes: Uint8Array;
    width: number;
    height: number;
    format: 'webp' | 'jpeg' | 'png';
  }>>;
}>;

export type LibraryDerivedResult = Readonly<{
  thumbnail: LibraryDerivedImage | null;
  preview: LibraryDerivedImage | null;
  /**
   * True when the source is an animated format. Its derived variants are a
   * single still frame, so a detail view with no local original must resolve the
   * `original` role rather than present a still image as the artwork.
   */
  animated: boolean;
  /** True when at least one role could not be produced. Never an error. */
  failed: boolean;
}>;

export type LibraryDerivedImages = Readonly<{
  derive(input: Readonly<{
    sourceUri: string;
    format: LibraryImageFormat;
    width: number;
    height: number;
    /** Absent: both roles. An unrequested role comes back `null`. */
    roles?: readonly Extract<LibraryObjectRole, 'thumbnail' | 'preview'>[];
  }>): Promise<LibraryDerivedResult>;
}>;

const ROLE_BOUNDS: readonly Readonly<{
  role: Extract<LibraryObjectRole, 'thumbnail' | 'preview'>;
  maxEdge: number;
}>[] = [
  { role: 'thumbnail', maxEdge: LIBRARY_THUMBNAIL_MAX_EDGE },
  { role: 'preview', maxEdge: LIBRARY_PREVIEW_MAX_EDGE },
];

export function createLibraryDerivedImages({
  resizer,
}: Readonly<{ resizer: LibraryImageResizePort }>): LibraryDerivedImages {
  return {
    async derive({ sourceUri, format, width, height, roles }) {
      const animated = format === 'gif';
      const produced: Partial<Record<'thumbnail' | 'preview', LibraryDerivedImage>> = {};
      let failed = false;

      for (const { role, maxEdge } of ROLE_BOUNDS) {
        if (roles !== undefined && !roles.includes(role)) continue;
        try {
          const output = await resizer.resize({
            sourceUri,
            sourceWidth: Math.max(1, width),
            sourceHeight: Math.max(1, height),
            maxEdge,
          });
          if (
            output.bytes.byteLength === 0
            || output.bytes.byteLength > LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES
            // A derived variant larger than the requested bound means the port
            // ignored `maxEdge`; refuse it rather than upload a wrong role.
            || Math.max(output.width, output.height) > maxEdge
          ) {
            failed = true;
            continue;
          }
          produced[role] = { role, ...output };
        } catch {
          // Derived objects are regenerable from an authenticated original, so a
          // failure here is reported and never propagated: protection must still
          // succeed on the original alone.
          failed = true;
        }
      }

      return {
        thumbnail: produced.thumbnail ?? null,
        preview: produced.preview ?? null,
        animated,
        failed,
      };
    },
  };
}
