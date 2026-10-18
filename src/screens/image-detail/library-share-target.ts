import type { StoredImage } from '@/features/images/image-repository';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import { canonicalExtensionFor } from '@/features/library/library-format';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import type { LibraryEntry } from '@/features/library/library-view-model';

export type ShareTarget =
  | Readonly<{ kind: 'collection'; imageId: number }>
  | Readonly<{ kind: 'file'; uri: string; staged?: boolean }>
  | Readonly<{ kind: 'unavailable'; category: LibraryFailureCategory }>;

/**
 * K2: pick where share/export bytes come from. A row with its own ready
 * collection file keeps the accepted collection path. A row the library owns
 * (mirrored, or a freed original) resolves the full-size library source. With
 * no library entry the collection path is kept so its existing `not_ready`
 * error surfaces unchanged.
 *
 * Board row 45: a resolved file that is this device's local original is handed
 * over unchanged; a `cached-original` / `cloud-original` source is the
 * decrypted cache file `<scope>-<sha>-original.bin`, so a native copy is
 * staged through `stage` as `<sha256>.<canonical extension>` first and the
 * staged copy's uri (marked `staged`) goes to the system instead. A stage
 * rejection propagates and fails the action.
 */
export async function resolveEntryShareTarget(
  entry: Pick<LibraryEntry, 'plaintextSha256' | 'format'>,
  resolveFull: (plaintextSha256: string) => Promise<LibraryRenderSource>,
  stage: (sourceUri: string, fileName: string) => Promise<string>,
): Promise<Exclude<ShareTarget, { kind: 'collection' }>> {
  const source = await resolveFull(entry.plaintextSha256);
  if (source.kind === 'file') {
    if (source.tier === 'local-original') return { kind: 'file', uri: source.uri };
    const uri = await stage(
      source.uri,
      `${entry.plaintextSha256}.${canonicalExtensionFor(entry.format)}`,
    );
    return { kind: 'file', uri, staged: true };
  }
  return { kind: 'unavailable', category: source.category };
}

export async function resolveShareTarget(
  image: Pick<StoredImage, 'id' | 'downloadState' | 'localUri'>,
  entry: Pick<LibraryEntry, 'plaintextSha256' | 'format'> | null,
  resolveFull: (plaintextSha256: string) => Promise<LibraryRenderSource>,
  stage: (sourceUri: string, fileName: string) => Promise<string>,
): Promise<ShareTarget> {
  if (image.downloadState === 'ready' && image.localUri) {
    return { kind: 'collection', imageId: image.id };
  }
  if (entry === null) return { kind: 'collection', imageId: image.id };
  return resolveEntryShareTarget(entry, resolveFull, stage);
}
