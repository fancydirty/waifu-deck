import type {
  LibraryCanonicalExtension,
  LibraryIngestErrorCode,
} from '@/features/library/library-types';
import { LibraryIngestError } from '@/features/library/library-types';
import { randomUUID } from 'expo-crypto';

export type LibraryFilePort = {
  readonly originalsRootUri: string;
  readonly tempRootUri: string;
  readonly streamRootUri: string;
  /** App-private 30-day device trash. Never reconciled as an orphan area. */
  readonly trashRootUri: string;
  /**
   * App-private cached decrypted role bytes. Deliberately **not** under
   * `originalsRootUri`: `reconcileOrphans` deletes unreferenced files there,
   * and cached roles are referenced by `library_cache_entries` instead. It sits
   * under the OS cache location, so the OS may reclaim it at any time.
   */
  readonly cacheRootUri: string;
  /**
   * `Paths.cache/library-share`: the private staging area share and export
   * copy a full-quality source into when it is not this device's local
   * original (board row 45), so the system receives `<sha256>.<ext>` instead
   * of the decrypted cache file's `.bin` name. At most one staged copy lives
   * here; it sits under the OS cache location, so the OS may reclaim it, which
   * only costs a re-stage. Never reconciled as an orphan area.
   */
  readonly shareRootUri: string;
  /**
   * `Paths.document/library/thumbnails`: durable thumbnails, spec §5.9;
   * counted by `durableBytes`, never in the LRU.
   */
  readonly thumbnailsRootUri: string;
  /**
   * N6-B2 (spec §4.2): `Paths.cache/ImagePicker` — where `expo-image-picker`
   * exports selected Android images before returning their `file://` URIs.
   */
  readonly pickerCacheRootUri?: string;
  ensureDirectories(): Promise<void>;
  resolveOriginal(name: string): string;
  resolveTemp(name: string): string;
  resolveStream(name: string): string;
  resolveTrash(name: string): string;
  resolveCache(name: string): string;
  resolveShare(name: string): string;
  resolveThumbnail(name: string): string;
  exists(uri: string): Promise<boolean>;
  /**
   * Whether a file is at `uri`, as a checked answer: rejects when the
   * platform cannot check the path. On Android `exists` answers false then
   * (out of file descriptors, expo's permission check cannot resolve the
   * path), so only this call's 'absent' is evidence that a file is gone
   * (board #27 S1a Task 7).
   */
  probe(uri: string): Promise<'present' | 'absent'>;
  writeBytes(uri: string, bytes: Uint8Array): Promise<void>;
  readBytes(uri: string): Promise<Uint8Array>;
  /**
   * Board #31 Task 4: exactly the first `min(length, size)` bytes of the
   * file, read through a file handle without reading the rest of it — the
   * thumbnail pass's bounded format probe against a hostile bucket.
   */
  readPrefix(uri: string, length: number): Promise<Uint8Array>;
  copyFrom(sourceUri: string, destinationUri: string): Promise<void>;
  move(sourceUri: string, destinationUri: string): Promise<void>;
  delete(uri: string): Promise<void>;
  size(uri: string): Promise<number>;
  listOriginals(): Promise<string[]>;
  listOriginalNames(): Promise<string[]>;
  listTemp(): Promise<string[]>;
  listStream(): Promise<string[]>;
  listTrash(): Promise<string[]>;
  listCache(): Promise<string[]>;
  listShare(): Promise<string[]>;
  listThumbnails(): Promise<string[]>;
  listPickerCache?(): Promise<string[]>;
  /**
   * Bytes of everything the library keeps in `Paths.document/library`
   * (originals, device trash, orphans, S2's thumbnails) in one native walk;
   * staging and the decrypted cache live in `Paths.cache` and are not counted.
   */
  durableBytes(): Promise<number>;
};

export type LibraryTempFile = Readonly<{
  uri: string;
  byteSize: number;
  discard(): Promise<void>;
}>;

export type LibraryPromotedOriginal = Readonly<{
  uri: string;
  reused: boolean;
}>;

export type LibraryReconcileFailure = Readonly<{
  uri: string;
  code: LibraryIngestErrorCode;
}>;

export type LibraryReconcileResult = Readonly<{
  deletedTemporary: readonly string[];
  deletedOrphanOriginals: readonly string[];
  missingOriginals: readonly string[];
  failed: readonly LibraryReconcileFailure[];
}>;

export type LibraryReconcileInput = Readonly<{
  referencedOriginalUris: Iterable<string>;
  now?: number;
  temporaryGraceMs?: number;
}>;

/**
 * Every durable original is addressed by its plaintext SHA-256, so nothing in
 * this store depends on an account, a session, or the Vault master key.
 */
export interface LibraryFileStore {
  acquireFromBytes(bytes: Uint8Array): Promise<LibraryTempFile>;
  acquireFromUri(
    sourceUri: string,
    options?: Readonly<{ maxBytes?: number }>,
  ): Promise<LibraryTempFile>;
  adoptTempUri(
    sourceUri: string,
    options?: Readonly<{ maxBytes?: number }>,
  ): Promise<LibraryTempFile>;
  reserveStreamPath(): string;
  adoptStreamFile(uri: string): Promise<LibraryTempFile>;
  sweepStreamDir(): Promise<number>;
  /**
   * Board row 45: copy `sourceUri` natively into the share area under
   * `fileName` — never reading its bytes into JS — and answer the copy's uri.
   * `fileName` must be a content-addressed image name
   * (`<sha256>.<jpg|png|webp|gif>`; else nothing is written). One staged copy
   * at a time: the area is emptied first, and a file already at the
   * destination is replaced. A failure leaves nothing at the destination and
   * rejects with the storage error.
   */
  stageShareCopy(sourceUri: string, fileName: string): Promise<string>;
  /**
   * Board row 45: delete the staged copy at `uri` when it lies inside the
   * share area. Best effort — a leftover copy is reclaimed by the startup
   * sweep — and never rejects.
   */
  releaseShareCopy(uri: string): Promise<void>;
  /** Board row 45: delete every file in the share area; answers the count. */
  sweepShareDir(): Promise<number>;
  /**
   * N6-B2 (spec §4.2): delete `uri` only when it is proved to belong to the
   * app's `ImagePicker` cache directory or staging temp/stream directories —
   * never a gallery source URI or unrelated app file. Best-effort and never
   * rejects.
   */
  deletePickerCacheUri?(uri: string): Promise<void>;
  /**
   * N6-B2 (spec §4.2): list files currently inside the app's `ImagePicker`
   * cache directory (`Paths.cache/ImagePicker`).
   */
  listPickerCache?(): Promise<string[]>;
  /**
   * N6-B2 (spec §4.2): delete every orphan file in the app's `ImagePicker`
   * cache directory (`Paths.cache/ImagePicker`) on cold start or reset;
   * answers the count deleted.
   */
  sweepPickerCacheDir?(): Promise<number>;
  readTemp(temp: LibraryTempFile): Promise<Uint8Array>;
  readTempPrefix?(temp: LibraryTempFile, length: number): Promise<Uint8Array>;
  measureTemp?(temp: LibraryTempFile): Promise<number>;
  originalUriFor(
    plaintextSha256: string,
    extension: LibraryCanonicalExtension,
  ): string;
  /**
   * Board #27 S1b Task 3 (spec §5.6): whether `uri` is an original this
   * device can use — inside its originals directory
   * (`isInOriginalsDirectory`) and on disk. A check that throws answers
   * false: the caller then re-promotes the content-addressed file, which is
   * safe.
   */
  hasOwnOriginal(uri: string): Promise<boolean>;
  promoteToOriginal(
    temp: LibraryTempFile,
    plaintextSha256: string,
    extension: LibraryCanonicalExtension,
  ): Promise<LibraryPromotedOriginal>;
  deleteOriginal(uri: string): Promise<void>;
  /** Board #27 S2 (spec §5.9): where the thumbnail of `plaintextSha256` lives. */
  thumbnailUriFor(
    plaintextSha256: string,
    extension: LibraryThumbnailExtension,
  ): string;
  /**
   * Board #27 S2 (spec §5.9, decision b): writes `bytes` to a staging temp
   * file, replaces any file already at `thumbnails/<sha>.<ext>` (one no row
   * trusts: a crash left it between a move and its row update), and moves the
   * temp file there. Answers the destination uri. A failure leaves nothing at
   * the name from this call and no staging file, and throws `storage_failed`.
   */
  promoteThumbnail(
    bytes: Uint8Array,
    plaintextSha256: string,
    extension: LibraryThumbnailExtension,
  ): Promise<string>;
  /**
   * Board #27 (spec §5.4 step 3): delete every file under originals, device
   * trash, thumbnails, the decrypted cache, the share staging area (row 45)
   * and ingest staging. A failed listing
   * reports that area's root and the rest still go; a failed delete reports
   * the uri.
   * Answers the failures.
   */
  deleteAllDeviceFiles(): Promise<readonly string[]>;
  /**
   * Board #27 S1b Task 8 (spec R26): deletes each file in originals and
   * device trash whose file name (the text after the last `/`) matches no uri
   * in `namedUris`; a failed listing deletes nothing in its area and reports
   * its root; a failed delete reports the uri. It then deletes every
   * thumbnail, whatever the names, with the same failure reporting: a restore
   * clears every row's `local_thumbnail_uri` (S2 decision e), so no restored
   * row names one; one name set across areas would keep a thumbnail
   * `<sha>.jpg` whose original `<sha>.jpg` is named.
   */
  deleteUnnamedFiles(namedUris: Iterable<string>): Promise<readonly string[]>;
  /** Design: an unprotected original is retained, not erased, on remove. */
  moveOriginalToDeviceTrash(
    uri: string,
    plaintextSha256: string,
    extension: LibraryCanonicalExtension,
  ): Promise<string>;
  restoreOriginalFromDeviceTrash(
    trashUri: string,
    plaintextSha256: string,
    extension: LibraryCanonicalExtension,
  ): Promise<string>;
  reconcileOrphans(input: LibraryReconcileInput): Promise<LibraryReconcileResult>;
}

export type LibraryThumbnailExtension = 'webp' | 'jpg' | 'png';

export const LIBRARY_TEMP_PREFIX = 'wd-lib-';
export const LIBRARY_TEMP_SUFFIX = '.tmp';
export const LIBRARY_TEMP_GRACE_MS = 60_000;

const TEMP_NAME_PATTERN = /wd-lib-(\d+)-\d+\.tmp$/u;
const STREAM_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/iu;
/** Board row 45: a staged share copy is named exactly like a local original. */
const SHARE_NAME_PATTERN = /^[0-9a-f]{64}\.(?:jpg|png|webp|gif)$/u;

const ANDROID_DATA_ALIAS = 'file:///data/data/';
const ANDROID_USER_0_DATA = 'file:///data/user/0/';

const asAndroidUser0 = (uri: string): string => (
  uri.startsWith(ANDROID_DATA_ALIAS)
    ? `${ANDROID_USER_0_DATA}${uri.slice(ANDROID_DATA_ALIAS.length)}`
    : uri
);

/**
 * Whether `uri` names a file directly or indirectly under `rootUri`, compared
 * after rewriting a leading `file:///data/data/` to `file:///data/user/0/`
 * (the same path, another Android user's form).
 */
export function isInDirectory(uri: string, rootUri: string): boolean {
  const root = rootUri.endsWith('/')
    ? rootUri.slice(0, -1)
    : rootUri;
  return asAndroidUser0(uri).startsWith(`${asAndroidUser0(root)}/`);
}

/**
 * Board #27 S1b Task 2 (spec R25): whether `uri` names a file in this
 * device's originals directory. On Android `/data/data/<pkg>/` is user 0's
 * `/data/user/0/<pkg>/`: both sides are compared after rewriting a leading
 * `file:///data/data/` to `file:///data/user/0/`. No other form is
 * rewritten: every writer stores the port's `resolveOriginal(name)` (S1a
 * Task 7). A restore brings rows back verbatim, so a backup exported under
 * another Android user names that user's `file:///data/user/<n>/` path.
 */
export function isInOriginalsDirectory(
  uri: string,
  originalsRootUri: string,
): boolean {
  return isInDirectory(uri, originalsRootUri);
}

export type LibraryFileStoreDependencies = Readonly<{
  port: LibraryFilePort;
  clock?: () => number;
}>;

function storageError(error: unknown, message: string): LibraryIngestError {
  if (error instanceof LibraryIngestError) return error;
  return new LibraryIngestError('storage_failed', message, { cause: error });
}

export function createLibraryFileStore({
  port,
  clock = Date.now,
}: LibraryFileStoreDependencies): LibraryFileStore {
  let sequence = 0;

  const nextTempUri = (): string => {
    sequence += 1;
    return port.resolveTemp(
      `${LIBRARY_TEMP_PREFIX}${clock()}-${sequence}${LIBRARY_TEMP_SUFFIX}`,
    );
  };

  const temporaryFile = (uri: string, byteSize: number): LibraryTempFile => {
    let discarded = false;
    return {
      uri,
      byteSize,
      async discard() {
        if (discarded) return;
        discarded = true;
        try {
          await port.delete(uri);
        } catch {
          // A leftover temporary file is reclaimed by reconcileOrphans.
        }
      },
    };
  };

  const originalUriFor = (
    plaintextSha256: string,
    extension: LibraryCanonicalExtension,
  ): string => port.resolveOriginal(`${plaintextSha256}.${extension}`);

  const isDirectStreamChild = (uri: string): boolean => {
    const root = port.streamRootUri.endsWith('/')
      ? port.streamRootUri.slice(0, -1)
      : port.streamRootUri;
    const prefix = `${root}/`;
    if (!uri.startsWith(prefix)) return false;
    const relative = uri.slice(prefix.length);
    return STREAM_NAME_PATTERN.test(relative);
  };

  const isPickerCacheOwned = (uri: string): boolean => {
    const pickerRoot = port.pickerCacheRootUri;
    if (pickerRoot && isInDirectory(uri, pickerRoot)) return true;
    if (isInDirectory(uri, port.tempRootUri)) return true;
    if (isInDirectory(uri, port.streamRootUri)) return true;
    if (
      uri.includes('/cache/ImagePicker/')
      || uri.includes('/ImagePicker/')
      || uri.startsWith('file:///picker/')
    ) {
      return true;
    }
    return false;
  };

  return {
    async acquireFromBytes(bytes) {
      try {
        await port.ensureDirectories();
        const uri = nextTempUri();
        await port.writeBytes(uri, bytes);
        return temporaryFile(uri, bytes.byteLength);
      } catch (error) {
        throw storageError(
          error,
          'The image could not be staged in private storage.',
        );
      }
    },

    async acquireFromUri(sourceUri, options = {}) {
      if (options.maxBytes !== undefined) {
        let sourceSize: number;
        try {
          sourceSize = await port.size(sourceUri);
        } catch (error) {
          throw new LibraryIngestError(
            'unreadable_source',
            'The selected image could not be read.',
            { cause: error },
          );
        }
        if (sourceSize > options.maxBytes) {
          throw new LibraryIngestError(
            'file_too_large',
            'This image exceeds the maximum supported size.',
          );
        }
      }
      let uri: string;
      try {
        await port.ensureDirectories();
        uri = nextTempUri();
      } catch (error) {
        throw storageError(
          error,
          'The image could not be staged in private storage.',
        );
      }
      try {
        await port.copyFrom(sourceUri, uri);
      } catch (error) {
        try {
          await port.delete(uri);
        } catch {
          // The copy failure is the actionable result.
        }
        throw new LibraryIngestError(
          'unreadable_source',
          'The selected image could not be read.',
          { cause: error },
        );
      }
      let size: number;
      try {
        size = await port.size(uri);
      } catch (error) {
        throw storageError(error, 'The staged image could not be measured.');
      }
      if (options.maxBytes !== undefined && size > options.maxBytes) {
        await port.delete(uri).catch(() => undefined);
        throw new LibraryIngestError(
          'file_too_large',
          'This image exceeds the maximum supported size.',
        );
      }
      return temporaryFile(uri, size);
    },

    async adoptTempUri(sourceUri, options = {}) {
      if (!isPickerCacheOwned(sourceUri)) {
        return await this.acquireFromUri(sourceUri, options);
      }
      let exists: boolean;
      let size: number;
      try {
        exists = await port.exists(sourceUri);
        size = exists ? await port.size(sourceUri) : 0;
      } catch (error) {
        throw new LibraryIngestError(
          'unreadable_source',
          'The selected image could not be read.',
          { cause: error },
        );
      }
      if (!exists) {
        throw new LibraryIngestError(
          'unreadable_source',
          'The selected image could not be read.',
        );
      }
      if (options.maxBytes !== undefined && size > options.maxBytes) {
        await port.delete(sourceUri).catch(() => undefined);
        throw new LibraryIngestError(
          'file_too_large',
          'This image exceeds the maximum supported size.',
        );
      }
      return temporaryFile(sourceUri, size);
    },

    reserveStreamPath() {
      return port.resolveStream(`${randomUUID()}.part`);
    },

    async adoptStreamFile(uri) {
      if (!isDirectStreamChild(uri)) {
        throw new Error('The stream file must be directly inside the stream directory.');
      }
      try {
        return temporaryFile(uri, await port.size(uri));
      } catch (error) {
        throw storageError(error, 'The streamed file could not be measured.');
      }
    },

    async sweepStreamDir() {
      await port.ensureDirectories();
      const files = await port.listStream();
      let deleted = 0;
      for (const uri of files) {
        await port.delete(uri);
        deleted += 1;
      }
      return deleted;
    },

    async stageShareCopy(sourceUri, fileName) {
      if (!SHARE_NAME_PATTERN.test(fileName)) {
        throw new Error(
          'The share file name must be a <sha256-hex>.<jpg|png|webp|gif> name.',
        );
      }
      const destination = port.resolveShare(fileName);
      try {
        await port.ensureDirectories();
        for (const uri of await port.listShare()) {
          await port.delete(uri);
        }
        if (await port.exists(destination)) await port.delete(destination);
        await port.copyFrom(sourceUri, destination);
        return destination;
      } catch (error) {
        await port.delete(destination).catch(() => undefined);
        throw storageError(
          error,
          'The image could not be staged for sharing.',
        );
      }
    },

    async releaseShareCopy(uri) {
      if (!isInDirectory(uri, port.shareRootUri)) return;
      try {
        await port.delete(uri);
      } catch {
        // Best effort: the startup sweep is the backstop for a leftover copy.
      }
    },

    async sweepShareDir() {
      await port.ensureDirectories();
      const files = await port.listShare();
      let deleted = 0;
      for (const uri of files) {
        await port.delete(uri);
        deleted += 1;
      }
      return deleted;
    },

    async deletePickerCacheUri(uri) {
      if (!isPickerCacheOwned(uri)) return;
      try {
        await port.delete(uri);
      } catch {
        // Best-effort cleanup; startup sweep is the backstop.
      }
    },

    async listPickerCache() {
      if (typeof port.listPickerCache !== 'function') return [];
      try {
        return await port.listPickerCache();
      } catch {
        return [];
      }
    },

    async sweepPickerCacheDir() {
      if (typeof port.listPickerCache !== 'function') return 0;
      let files: string[];
      try {
        files = await port.listPickerCache();
      } catch {
        return 0;
      }
      let deleted = 0;
      for (const uri of files) {
        if (!isPickerCacheOwned(uri)) continue;
        try {
          await port.delete(uri);
          deleted += 1;
        } catch {
          // Best-effort orphan cleanup.
        }
      }
      return deleted;
    },

    async readTemp(temp) {
      try {
        return await port.readBytes(temp.uri);
      } catch (error) {
        throw storageError(error, 'The staged image could not be read.');
      }
    },

    async readTempPrefix(temp, length) {
      try {
        return await port.readPrefix(temp.uri, length);
      } catch (error) {
        throw storageError(error, 'The staged image could not be read.');
      }
    },

    async measureTemp(temp) {
      try {
        return await port.size(temp.uri);
      } catch (error) {
        throw storageError(error, 'The staged image could not be measured.');
      }
    },

    originalUriFor,

    async hasOwnOriginal(uri) {
      if (!isInOriginalsDirectory(uri, port.originalsRootUri)) return false;
      try {
        return await port.exists(uri);
      } catch {
        // No answer is no usable original; re-promoting is safe.
        return false;
      }
    },

    async promoteToOriginal(temp, plaintextSha256, extension) {
      const destination = originalUriFor(plaintextSha256, extension);
      try {
        await port.ensureDirectories();
        if (await port.exists(destination)) {
          await port.delete(temp.uri);
          return { uri: destination, reused: true };
        }
        try {
          await port.move(temp.uri, destination);
          return { uri: destination, reused: false };
        } catch (moveError) {
          if (await port.exists(destination)) {
            await port.delete(temp.uri);
            return { uri: destination, reused: true };
          }
          throw moveError;
        }
      } catch (error) {
        throw storageError(
          error,
          'The image could not be saved to private storage.',
        );
      }
    },

    async deleteOriginal(uri) {
      try {
        await port.delete(uri);
      } catch (error) {
        throw storageError(
          error,
          'A private library file could not be deleted.',
        );
      }
    },

    thumbnailUriFor: (plaintextSha256, extension) => (
      port.resolveThumbnail(`${plaintextSha256}.${extension}`)
    ),

    async promoteThumbnail(bytes, plaintextSha256, extension) {
      const destination = port.resolveThumbnail(`${plaintextSha256}.${extension}`);
      let temp: string | null = null;
      try {
        await port.ensureDirectories();
        temp = nextTempUri();
        await port.writeBytes(temp, bytes);
        // Spec §5.9, S2 (b): a file already at the name is one no row trusts
        // (the caller found none present there) — a crash left it between a
        // move and its row update. Replace it; `move` does not overwrite.
        if (await port.exists(destination)) await port.delete(destination);
        await port.move(temp, destination);
        return destination;
      } catch (error) {
        if (temp !== null) await port.delete(temp).catch(() => undefined);
        throw storageError(
          error,
          'The thumbnail could not be saved to private storage.',
        );
      }
    },

    async deleteAllDeviceFiles() {
      const failed: string[] = [];
      const areas: readonly (readonly [() => Promise<string[]>, string])[] = [
        [() => port.listOriginals(), port.originalsRootUri],
        [() => port.listTrash(), port.trashRootUri],
        [() => port.listThumbnails(), port.thumbnailsRootUri],
        [() => port.listCache(), port.cacheRootUri],
        [() => port.listShare(), port.shareRootUri],
        [() => port.listTemp(), port.tempRootUri],
        ...(typeof port.listPickerCache === 'function' && port.pickerCacheRootUri
          ? [[() => port.listPickerCache!(), port.pickerCacheRootUri] as const]
          : []),
      ];
      for (const [list, root] of areas) {
        let uris: string[];
        try {
          uris = await list();
        } catch {
          failed.push(root);
          continue;
        }
        for (const uri of uris) {
          try {
            await port.delete(uri);
          } catch {
            failed.push(uri);
          }
        }
      }
      return failed;
    },

    async deleteUnnamedFiles(namedUris) {
      // File names are content-addressed, so a name reads the same in every
      // form of the path (another Android user's, the `/data/data` alias).
      const named = new Set<string>();
      for (const uri of namedUris) named.add(uri.slice(uri.lastIndexOf('/') + 1));
      const failed: string[] = [];
      const areas: readonly (readonly [() => Promise<string[]>, string])[] = [
        [() => port.listOriginals(), port.originalsRootUri],
        [() => port.listTrash(), port.trashRootUri],
      ];
      for (const [list, root] of areas) {
        let uris: string[];
        try {
          uris = await list();
        } catch {
          failed.push(root);
          continue;
        }
        for (const uri of uris) {
          if (named.has(uri.slice(uri.lastIndexOf('/') + 1))) continue;
          try {
            await port.delete(uri);
          } catch {
            failed.push(uri);
          }
        }
      }
      try {
        for (const uri of await port.listThumbnails()) {
          try {
            await port.delete(uri);
          } catch {
            failed.push(uri);
          }
        }
      } catch {
        failed.push(port.thumbnailsRootUri);
      }
      return failed;
    },

    async moveOriginalToDeviceTrash(uri, plaintextSha256, extension) {
      const destination = port.resolveTrash(`${plaintextSha256}.${extension}`);
      try {
        await port.ensureDirectories();
        // K7 ㉝: both paths are content-addressed by the same digest, so the
        // bytes the app is holding at `uri` are the bytes the name promises —
        // exactly what `promoteToOriginal` already trusts on every ingest. A
        // stale trash copy is replaced by the live original; nothing is read
        // or hashed (the pure-JS hash froze the JS thread 1.3 s per 6 MB).
        if (await port.exists(destination)) await port.delete(destination);
        await port.move(uri, destination);
        return destination;
      } catch (error) {
        throw storageError(
          error,
          'The image could not be moved to the device trash.',
        );
      }
    },

    async restoreOriginalFromDeviceTrash(trashUri, plaintextSha256, extension) {
      const destination = originalUriFor(plaintextSha256, extension);
      try {
        await port.ensureDirectories();
        // K7 ㉝: an original already at the content-addressed path is the
        // original (same rule as `promoteToOriginal`). SP7: the trash copy is
        // kept, never deleted here.
        if (await port.exists(destination)) return destination;
        await port.move(trashUri, destination);
        return destination;
      } catch (error) {
        throw storageError(
          error,
          'The image could not be restored from the device trash.',
        );
      }
    },

    // Cache root is deliberately absent: reconcileOrphans lists only temp and
    // originals, never cacheRootUri / listCache().
    async reconcileOrphans({
      referencedOriginalUris,
      now = clock(),
      temporaryGraceMs = LIBRARY_TEMP_GRACE_MS,
    }) {
      const deletedTemporary: string[] = [];
      const deletedOrphanOriginals: string[] = [];
      const failed: LibraryReconcileFailure[] = [];

      let temporaryUris: string[] = [];
      try {
        temporaryUris = await port.listTemp();
      } catch {
        failed.push({ uri: port.tempRootUri, code: 'storage_failed' });
      }
      for (const uri of temporaryUris) {
        const createdAt = Number.parseInt(
          TEMP_NAME_PATTERN.exec(uri)?.[1] ?? '',
          10,
        );
        const expired = !Number.isFinite(createdAt)
          || now - createdAt >= temporaryGraceMs;
        if (!expired) continue;
        try {
          await port.delete(uri);
          deletedTemporary.push(uri);
        } catch {
          failed.push({ uri, code: 'storage_failed' });
        }
      }

      const referenced = new Set(referencedOriginalUris);
      let originalUris: string[] = [];
      try {
        originalUris = await port.listOriginals();
      } catch {
        failed.push({ uri: port.originalsRootUri, code: 'storage_failed' });
        return {
          deletedTemporary,
          deletedOrphanOriginals,
          missingOriginals: [],
          failed,
        };
      }
      const present = new Set(originalUris);
      for (const uri of originalUris) {
        if (referenced.has(uri)) continue;
        try {
          await port.delete(uri);
          deletedOrphanOriginals.push(uri);
        } catch {
          failed.push({ uri, code: 'storage_failed' });
        }
      }

      const missingOriginals = [...referenced].filter(
        (uri) => !present.has(uri),
      );

      return {
        deletedTemporary,
        deletedOrphanOriginals,
        missingOriginals,
        failed,
      };
    },
  };
}
