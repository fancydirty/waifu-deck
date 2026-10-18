import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibraryEncryptedMetadata,
  LibraryRestorableSource,
} from '@/features/library/library-actions-types';
import {
  isStoredContentRating,
  parseTags,
} from '@/features/images/image-repository';
import { LIBRARY_MAX_METADATA_PLAINTEXT_BYTES } from '@/features/library/library-object-crypto';
import {
  isLibraryImportClassification,
  type LibraryImportClassification,
} from '@/features/library/library-types';
import { isImageProviderKey } from '@/features/waifu/types';

const metadataEncoder = new TextEncoder();

/**
 * C3a (mirror spec §5.2 "恢复为一等收藏项"): the sealed metadata envelope must
 * carry enough to rebuild a first-class `StoredImage` on a device that never
 * saw the provider item. This module owns both directions of that projection so
 * the two seal sites — `library-protect-action.ts`'s `metadataFor` and
 * `library-sync-engine.ts`'s `sealCollectMetadata` — emit byte-identical
 * envelopes for the same asset. `JSON.stringify` preserves insertion order, so
 * key order is part of that contract: only `buildLibraryEncryptedMetadata`
 * constructs the object.
 */

type SourceRow = Readonly<{
  provider_key: unknown;
  provider_item_id: unknown;
  canonical_source_key: unknown;
  perceptual_hash: unknown;
  md5: unknown;
  remote_url: unknown;
  sample_url: unknown;
  source_url: unknown;
  artist_name: unknown;
  artist_url: unknown;
  extension: unknown;
  dominant_color: unknown;
  content_rating: unknown;
  native_rating: unknown;
  is_nsfw: unknown;
  is_animated: unknown;
  tags_json: unknown;
}>;

const SOURCE_COLUMNS = `
  provider_key, provider_item_id, canonical_source_key, perceptual_hash, md5,
  remote_url, sample_url, source_url, artist_name, artist_url, extension,
  dominant_color, content_rating, native_rating, is_nsfw, is_animated, tags_json
`;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The `images` row behind one collected asset, projected into the envelope's
 * `source` block. `null` when there is no provider row to read: an imported
 * asset (`sourceImageId === null`), or a discovery row the user has since
 * purged. A null return is a fact, never a reason to invent provider data.
 *
 * Deliberately preserves a NULL `sample_url` instead of falling back to
 * `remote_url` the way `mapImageRow` does: the fallback belongs to the row
 * mapper, and copying the original url into the sample slot would make the
 * restored row differ from the row on the device that collected it.
 */
export async function readSourceMetadata(
  database: SqlDatabasePort,
  sourceImageId: number | null,
): Promise<LibraryRestorableSource | null> {
  if (sourceImageId === null) return null;
  const row = await database.getFirst<SourceRow>(
    `SELECT ${SOURCE_COLUMNS} FROM images WHERE id = ?`,
    [sourceImageId],
  );
  if (row === null) return null;
  const providerKey = text(row.provider_key);
  const providerItemId = text(row.provider_item_id);
  const remoteUrl = text(row.remote_url);
  const extension = text(row.extension);
  const dominantColor = text(row.dominant_color);
  if (
    providerKey === null
    || !isImageProviderKey(providerKey)
    || providerItemId === null
    || remoteUrl === null
    || extension === null
    || dominantColor === null
  ) {
    // A row this build cannot read is the same situation as a missing row: the
    // envelope stays v1-shaped rather than carrying a half-built source.
    return null;
  }
  const isNsfw = row.is_nsfw === 1;
  const tags = parseTags(row.tags_json);
  return {
    providerKey,
    providerItemId,
    canonicalSourceKey: text(row.canonical_source_key),
    perceptualHash: text(row.perceptual_hash),
    md5: text(row.md5),
    remoteUrl,
    sampleUrl: text(row.sample_url),
    sourceUrl: text(row.source_url),
    artistName: text(row.artist_name),
    artistUrl: text(row.artist_url),
    extension,
    dominantColor,
    contentRating: isStoredContentRating(row.content_rating)
      ? row.content_rating
      : 'unknown',
    nativeRating: text(row.native_rating),
    isNsfw,
    isAnimated: row.is_animated === 1,
    tags,
  };
}

/**
 * The one constructor of an envelope payload. Both seal sites call this, so a
 * field added here reaches both at once and the JSON key order — and therefore
 * the sealed bytes — cannot drift between them.
 */
export function buildLibraryEncryptedMetadata(
  input: Omit<
    LibraryEncryptedMetadata,
    'version' | 'tags' | 'source' | 'importClassification'
  > & {
    importClassification?: LibraryImportClassification;
  },
  source: LibraryRestorableSource | null,
): LibraryEncryptedMetadata {
  const importClassification: LibraryImportClassification =
    input.importClassification ?? 'unknown';
  const build = (
    tags: readonly string[],
    withSource: LibraryRestorableSource | null,
  ): LibraryEncryptedMetadata => {
    const base = {
      version: 3 as const,
      plaintextSha256: input.plaintextSha256,
      format: input.format,
      canonicalExtension: input.canonicalExtension,
      byteSize: input.byteSize,
      width: input.width,
      height: input.height,
      origin: input.origin,
      sourceImageId: input.sourceImageId,
      collectedAt: input.collectedAt,
      importClassification,
      tags,
    };
    return withSource === null ? base : { ...base, source: { ...withSource, tags } };
  };
  if (source === null) return build([], null);

  const fits = (payload: LibraryEncryptedMetadata): boolean =>
    metadataEncoder.encode(JSON.stringify(payload)).byteLength
      <= LIBRARY_MAX_METADATA_PLAINTEXT_BYTES;

  const whole = build(source.tags, source);
  if (fits(whole)) return whole;
  // Fewer tags is always fewer bytes, so the longest fitting prefix is a binary
  // search; an empty list that still overflows means the source itself is too
  // large, and the envelope falls back to the v1 shape.
  if (!fits(build([], source))) return build([], null);
  let kept = 0;
  let over = source.tags.length;
  while (over - kept > 1) {
    const middle = (kept + over) >> 1;
    if (fits(build(source.tags.slice(0, middle), source))) kept = middle;
    else over = middle;
  }
  return build(source.tags.slice(0, kept), source);
}

/**
 * A `source` block is only usable when it still carries the identity and
 * presentation fields a `StoredImage` cannot be built without. The opened
 * envelope is an attacker-reachable input after decryption (see
 * `library-sync-apply.ts`) and C3b inserts an `images` row from it, so anything
 * short of a whole source is "no source" rather than a half-built row. Mirrors
 * the same required-field set `readSourceMetadata` enforces when projecting.
 */
function isUsableSource(value: unknown): value is LibraryRestorableSource {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Partial<LibraryRestorableSource>;
  return (
    typeof source.providerKey === 'string'
    && isImageProviderKey(source.providerKey)
    && text(source.providerItemId) !== null
    && text(source.remoteUrl) !== null
    && text(source.extension) !== null
    && text(source.dominantColor) !== null
    && isStoredContentRating(source.contentRating)
    && typeof source.isNsfw === 'boolean'
    && typeof source.isAnimated === 'boolean'
    && Array.isArray(source.tags)
  );
}

/**
 * N6-A1 (spec §4.3): resolves the closed three-state import classification from
 * an opened metadata envelope.
 *
 * - v1/v2 envelopes (or a v3 envelope missing the field) decode as `'unknown'`
 *   per D9's missing-field rule.
 * - A present valid value (`'safe' | 'adult' | 'unknown'`) returns as-is.
 * - Any present invalid value returns `null` (an integrity error — never
 *   coerced to `'safe'`).
 */
export function resolveEnvelopeImportClassification(
  metadata: Readonly<{ version?: unknown; importClassification?: unknown }>,
): LibraryImportClassification | null {
  const raw = metadata.importClassification;
  if (raw === undefined) return 'unknown';
  return isLibraryImportClassification(raw) ? raw : null;
}

/**
 * The `images` fields a restored asset needs, or `null` for a v1 envelope (and
 * for a v2/v3 envelope whose source block did not survive intact).
 */
export function restorableImageFrom(
  metadata: LibraryEncryptedMetadata,
): (LibraryRestorableSource & Readonly<{
  width: number;
  height: number;
  byteSize: number;
}>) | null {
  const { source } = metadata;
  if (!isUsableSource(source)) return null;
  return {
    ...source,
    width: metadata.width,
    height: metadata.height,
    byteSize: metadata.byteSize,
  };
}
