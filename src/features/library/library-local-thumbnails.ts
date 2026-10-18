import type { LibraryFailureCategory, LibrarySessionPort } from '@/features/library/library-actions-types';
import type { LibraryCacheStore } from '@/features/library/library-cache-store';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import type { LibraryFilePort, LibraryFileStore } from '@/features/library/library-file-store';
import { detectLibraryImageFormat, LIBRARY_FORMAT_SNIFF_BYTES } from '@/features/library/library-format';
import type { LibraryRoleReader } from '@/features/library/library-render-source';
import type { LibraryRepository } from '@/features/library/library-repository';
import type { DeviceLibraryAsset } from '@/features/library/library-types';

export type LocalThumbnailSource =
  | 'existing' | 'local-original' | 'cloud-thumbnail' | 'cloud-preview' | 'cloud-original';
export type LocalThumbnailResult =
  | Readonly<{ status: 'ensured'; uri: string; source: LocalThumbnailSource }>
  | Readonly<{
    status: 'failed';
    reason: 'no-asset' | 'unchecked' | 'no-source' | 'write-failed' | 'error' | 'too-large';
  }>
  | Readonly<{ status: 'failed'; reason: 'cloud'; category: LibraryFailureCategory }>;
export type LibraryLocalThumbnails = Readonly<{
  /** Spec §5.9. Never rejects; single-flight per digest. S3 evicts only on `ensured`. */
  ensureLocalThumbnail(plaintextSha256: string): Promise<LocalThumbnailResult>;
}>;
export type LibraryLocalThumbnailsDependencies = Readonly<{
  repository: Pick<LibraryRepository, 'findLocalAsset' | 'setLocalThumbnail'>;
  files: Pick<LibraryFileStore, 'hasOwnOriginal' | 'promoteThumbnail' | 'deleteOriginal'>;
  port: Pick<LibraryFilePort, 'probe' | 'readBytes' | 'size' | 'readPrefix'>;
  derived: LibraryDerivedImages;
  /** The BYOS-ready composition's; absent: only a local original can make one. */
  cloud?: Readonly<{ session: LibrarySessionPort; roles: LibraryRoleReader; cache: Pick<LibraryCacheStore, 'forget'> }>;
  /** Board #31: never fetch a cloud original larger than this (plaintext bytes) just to resize it. Absent: no limit. */
  originalByteLimit?: number;
}>;

/**
 * Board #31: a cloud original is read whole into the Java heap; 50 MB OOMs at a
 * 192 MiB heap. The value is #16's animation cap, far under the heap.
 */
export const LIBRARY_THUMBNAIL_SOURCE_ORIGINAL_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Board #31 Task 4: a "thumbnail" over this is a hostile or broken bucket, not
 * a thumbnail (app-made ones are a few hundred KiB at most) — never read whole.
 */
export const LIBRARY_THUMBNAIL_SOURCE_MAX_BYTES = 2 * 1024 * 1024;

const EXTENSION = { webp: 'webp', jpeg: 'jpg', png: 'png' } as const;
/** A role the cloud cannot serve for good: try the next, larger one. */
const NEXT_ROLE: ReadonlySet<LibraryFailureCategory> = new Set(['object_missing', 'integrity', 'unsupported_image']);

export function createLibraryLocalThumbnails(deps: LibraryLocalThumbnailsDependencies): LibraryLocalThumbnails {
  const inFlight = new Map<string, Promise<LocalThumbnailResult>>();

  // Board #31: one cloud original read and resized at a time across every
  // ensure (the pass runs 8 lanes). Released in `finally`; the chain itself
  // never rejects, so one failure cannot stall the next original.
  let originalSlot: Promise<void> = Promise.resolve();
  const oneOriginalAtATime = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = originalSlot;
    let release!: () => void;
    originalSlot = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  // Spec §5.9 / S2 (b): the file is in place before the row names it; a row
  // that vanished meanwhile gets no file left behind.
  const keep = async (sha: string, bytes: Uint8Array, format: keyof typeof EXTENSION,
    source: LocalThumbnailSource): Promise<LocalThumbnailResult> => {
    let uri: string;
    try {
      uri = await deps.files.promoteThumbnail(bytes, sha, EXTENSION[format]);
    } catch {
      return { status: 'failed', reason: 'write-failed' };
    }
    const named = await deps.repository.setLocalThumbnail(sha, uri).catch(() => false);
    if (named) return { status: 'ensured', uri, source };
    await deps.files.deleteOriginal(uri).catch(() => undefined);
    return { status: 'failed', reason: 'no-asset' };
  };

  /** One resize to the thumbnail bound; null when it produced nothing. */
  const resized = async (sha: string, asset: DeviceLibraryAsset, sourceUri: string,
    source: LocalThumbnailSource): Promise<LocalThumbnailResult | null> => {
    const produced = await deps.derived.derive({
      sourceUri, format: asset.format, width: asset.width, height: asset.height, roles: ['thumbnail'],
    });
    return produced.thumbnail === null
      ? null
      : keep(sha, produced.thumbnail.bytes, produced.thumbnail.format, source);
  };

  const fromCloud = async (sha: string, asset: DeviceLibraryAsset): Promise<LocalThumbnailResult> => {
    const cloud = deps.cloud;
    if (cloud === undefined) return { status: 'failed', reason: 'no-source' };
    const context = await cloud.session.current();
    if (context === null) return { status: 'failed', reason: 'cloud', category: 'auth_attention' };
    let last: LibraryFailureCategory = 'object_missing';
    for (const role of ['thumbnail', 'preview', 'original'] as const) {
      if (role === 'original' && deps.originalByteLimit !== undefined
        && asset.byteSize > deps.originalByteLimit) {
        return { status: 'failed', reason: 'too-large' };
      }
      const step = async (): Promise<LocalThumbnailResult | 'next'> => {
        const read = await cloud.roles.read(sha, role);
        if (read.kind === 'unavailable') {
          if (!NEXT_ROLE.has(read.category)) return { status: 'failed', reason: 'cloud', category: read.category };
          last = read.category;
          return 'next';
        }
        if (role === 'thumbnail') {
          // Board #31 Task 4: bound what a bucket can make this pass read —
          // the size first, then a 16-byte prefix for the format; only a
          // small, detected image is read whole (still bounded by the size).
          const byteSize = await deps.port.size(read.uri).catch(() => null);
          const prefix = byteSize === null
            || byteSize > LIBRARY_THUMBNAIL_SOURCE_MAX_BYTES
            ? null
            : await deps.port.readPrefix(read.uri, LIBRARY_FORMAT_SNIFF_BYTES)
              .catch(() => null);
          const detected = prefix === null ? null : detectLibraryImageFormat(prefix);
          if (prefix !== null && detected !== null && detected.format !== 'gif') {
            const bytes = await deps.port.readBytes(read.uri).catch(() => null);
            if (bytes !== null) {
              return keep(sha, bytes, detected.format, 'cloud-thumbnail');
            }
          }
          last = 'unsupported_image';
          return 'next';
        }
        try {
          const made = await resized(sha, asset, read.uri, role === 'preview' ? 'cloud-preview' : 'cloud-original');
          if (made !== null) return made;
          last = 'unsupported_image';
        } finally {
          // Spec §5.9: an original fetched only for this is discarded after the
          // resize; one already cached stays for whoever cached it.
          if (read.tier === 'cloud-original') {
            await cloud.cache.forget(context.accountScope, sha, 'original').catch(() => undefined);
          }
        }
        return 'next';
      };
      const outcome = role === 'original' ? await oneOriginalAtATime(step) : await step();
      if (outcome !== 'next') return outcome;
    }
    return { status: 'failed', reason: 'cloud', category: last };
  };

  const ensureOnce = async (sha: string): Promise<LocalThumbnailResult> => {
    const asset = await deps.repository.findLocalAsset(sha);
    if (asset === null) return { status: 'failed', reason: 'no-asset' };
    if (asset.localThumbnailUri !== null) {
      let state: 'present' | 'absent';
      try {
        state = await deps.port.probe(asset.localThumbnailUri);
      } catch {
        // Not checkable (out of descriptors): never a guess (S1a Task 7).
        return { status: 'failed', reason: 'unchecked' };
      }
      if (state === 'present') return { status: 'ensured', uri: asset.localThumbnailUri, source: 'existing' };
    }
    if (
      asset.residency === 'local-original' && asset.missingOriginalSince === null
      && asset.localOriginalUri !== null && await deps.files.hasOwnOriginal(asset.localOriginalUri)
    ) {
      const made = await resized(sha, asset, asset.localOriginalUri, 'local-original');
      if (made !== null) return made;
    }
    return fromCloud(sha, asset);
  };

  return {
    ensureLocalThumbnail(sha) {
      const running = inFlight.get(sha);
      if (running !== undefined) return running;
      const run = ensureOnce(sha)
        .catch((): LocalThumbnailResult => ({ status: 'failed', reason: 'error' }))
        .finally(() => { inFlight.delete(sha); });
      inFlight.set(sha, run);
      return run;
    },
  };
}
