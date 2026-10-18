import type {
  LibraryFailureCategory,
  LibraryObjectRole,
  LibraryRenderIntent,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import type { LibraryCacheStore } from '@/features/library/library-cache-store';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import type { LibraryCloudClient } from '@/features/library/library-cloud-client-s3';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import {
  LibraryLocalStorageError,
  type LibraryFileDecryptor,
} from '@/features/library/library-file-decryptor';
import type {
  LibraryFilePort,
  LibraryFileStore,
} from '@/features/library/library-file-store';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import type { LibraryProtectionRepository } from '@/features/library/library-protection-repository';
import type { LibraryReachabilityPort } from '@/features/library/library-reachability';
import {
  transferFaultFor,
  viewFailureFor,
} from '@/features/library/library-transfer-fault';
import {
  runWithOwnership,
  type LibraryRoleFetch,
  type LibraryTransferCoalescer,
} from '@/features/library/library-transfer-coalescer';
import {
  tiersFor,
  tiersForRole,
  type LibraryRenderState,
  type LibraryRenderTier,
} from '@/features/library/library-render-tiers';
import type { LibraryRepository } from '@/features/library/library-repository';

export type LibraryRenderSource =
  | Readonly<{
      kind: 'file';
      /** A `file://` URI expo-image can render directly. */
      uri: string;
      tier: LibraryRenderTier;
      role: LibraryObjectRole;
    }>
  | Readonly<{
      kind: 'unavailable';
      category: LibraryFailureCategory;
      /**
       * The object role whose failure produced this result, when the category
       * is one that pins blame to a specific tier (`integrity`/`unsupported_image`
       * decrypt/verify failures). Absent for pre-tier failures (`auth_attention`)
       * and for soft categories that only reflect "no tier served" (`offline`,
       * `object_missing`, `retryable_transfer`). Lets a caller tell an original-
       * tier failure from a derived (thumbnail/preview) one without re-deriving
       * `tiersFor`.
       */
      role?: LibraryObjectRole;
    }>;

export type LibraryRenderResolver = Readonly<{
  resolve(
    plaintextSha256: string,
    intent: LibraryRenderIntent,
  ): Promise<LibraryRenderSource>;
  /** Cache repair: rebuild derived variants from a verified local original. */
  repairDerived(plaintextSha256: string): Promise<boolean>;
}>;

/** Board #27 S2: one role's bytes, from the decrypted cache or the cloud, as a cache file. */
export type LibraryRoleReader = Readonly<{
  read(plaintextSha256: string, role: LibraryObjectRole): Promise<LibraryRenderSource>;
}>;

export type LibraryRenderResolverDependencies = Readonly<{
  repository: LibraryRepository;
  protection: LibraryProtectionRepository;
  cache: LibraryCacheStore;
  cloud: Pick<LibraryCloudClient, 'getObjectToFile'>;
  derived: LibraryDerivedImages;
  files: Pick<LibraryFilePort, 'exists'>;
  streams: Pick<LibraryFileStore, 'reserveStreamPath' | 'adoptStreamFile'>;
  decryptor: LibraryFileDecryptor;
  coalescer: LibraryTransferCoalescer<LibraryRoleFetch>;
  reachability: LibraryReachabilityPort;
  session: LibrarySessionPort;
}>;

const TIER_ROLE: Readonly<Record<LibraryRenderTier, LibraryObjectRole>> = {
  'local-original': 'original',
  'local-thumbnail': 'thumbnail',
  'cached-thumbnail': 'thumbnail',
  'cloud-thumbnail': 'thumbnail',
  'cached-preview': 'preview',
  'cloud-preview': 'preview',
  'cached-original': 'original',
  'cloud-original': 'original',
};

function createTierRunner({
  repository,
  protection,
  cache,
  cloud,
  files,
  streams,
  decryptor,
  coalescer,
  reachability,
  session,
}: LibraryRenderResolverDependencies): (
  plaintextSha256: string,
  choose: (state: LibraryRenderState) => readonly LibraryRenderTier[],
) => Promise<LibraryRenderSource> {
  const unavailable = (
    category: LibraryFailureCategory,
    role?: LibraryObjectRole,
  ): LibraryRenderSource =>
    role === undefined
      ? { kind: 'unavailable', category }
      : { kind: 'unavailable', category, role };

  const discardStreamPath = async (uri: string): Promise<void> => {
    try {
      const temp = await streams.adoptStreamFile(uri);
      await temp.discard();
    } catch {
      // A startup stream sweep is the crash backstop if cleanup itself fails.
    }
  };

  return async function run(plaintextSha256, choose) {
    const context = await session.current();
    if (context === null) return unavailable('auth_attention');
    const asset = await repository.findLocalAsset(plaintextSha256);
    const assetId = deriveLibraryAssetId(context.masterKey, plaintextSha256);
    const record = await protection.findByAssetId(context.accountScope, assetId);
    const deviceState = await protection.readDeviceState(plaintextSha256);
    // Trash and purged follow trash semantics, not normal rendering. SP9B
    // owns the trash surface; nothing here may render or resurrect them.
    if (
      (record !== null && record.lifecycle !== 'active')
      || deviceState?.deviceTrashedAt != null
    ) {
      return unavailable('object_missing');
    }

    const hasLocalOriginal = asset !== null
      && asset.localOriginalUri !== null
      && asset.missingOriginalSince === null
      && asset.residency === 'local-original'
      && await files.exists(asset.localOriginalUri);

    const tiers = choose({
      hasLocalOriginal,
      hasLocalThumbnail: asset?.localThumbnailUri != null,
      thumbnail: record?.thumbnailGenerationId ?? null,
      preview: record?.previewGenerationId ?? null,
      original: record?.originalGenerationId ?? null,
      animated: asset?.format === 'gif',
    });
    if (tiers.length === 0) return unavailable('object_missing');

    let lastCategory: LibraryFailureCategory = 'object_missing';
    for (const tier of tiers) {
      const role = TIER_ROLE[tier];

      if (tier === 'local-original') {
        return { kind: 'file', uri: asset!.localOriginalUri!, tier, role };
      }

      if (tier === 'local-thumbnail') {
        const uri = asset!.localThumbnailUri!;
        if (await files.exists(uri)) return { kind: 'file', uri, tier, role };
        continue;
      }

      if (tier.startsWith('cached-')) {
        const entry = await cache.find(context.accountScope, plaintextSha256, role);
        if (entry !== null) return { kind: 'file', uri: entry.uri, tier, role };
        continue;
      }

      const generationId = role === 'thumbnail'
        ? record?.thumbnailGenerationId
        : role === 'preview'
          ? record?.previewGenerationId
          : record?.originalGenerationId;
      if (generationId == null) continue;

      // Do not spend a request when the device is known to be offline; the
      // design wants a clear offline state, never a provider-URL fallback.
      if (!(await reachability.isReachable())) {
        lastCategory = 'offline';
        continue;
      }

      const fetchCloud = async (): Promise<LibraryRoleFetch> => {
        let cipherPath: string | undefined;
        let plainPath: string | undefined;
        try {
          try {
            cipherPath = streams.reserveStreamPath();
            plainPath = streams.reserveStreamPath();
          } catch (error) {
            return { kind: 'failed', stage: 'transfer', fault: transferFaultFor(error) };
          }

          let downloaded: Awaited<ReturnType<LibraryCloudClient['getObjectToFile']>>;
          try {
            downloaded = await cloud.getObjectToFile(generationId, cipherPath);
          } catch (caught) {
            return { kind: 'failed', stage: 'transfer', fault: transferFaultFor(caught) };
          }
          if (downloaded === null) {
            return { kind: 'failed', stage: 'transfer', fault: { kind: 'missing' } };
          }

          let opened: Awaited<ReturnType<LibraryFileDecryptor['openToFile']>>;
          try {
            opened = await decryptor.openToFile({
              masterKey: context.masterKey,
              assetId,
              scope: role,
              envelopeUri: cipherPath,
              plaintextUri: plainPath,
            });
          } catch (error) {
            if (error instanceof LibraryCloudError) {
              return {
                kind: 'failed',
                stage: 'transfer',
                fault: { kind: 'cloud', category: error.category },
              };
            }
            if (error instanceof LibraryLocalStorageError) {
              return { kind: 'failed', stage: 'transfer', fault: { kind: 'local-storage' } };
            }
            return { kind: 'failed', stage: 'transfer', fault: { kind: 'integrity', role } };
          } finally {
            // The envelope is no longer needed once decryption settles.
            await discardStreamPath(cipherPath);
          }

          if (role === 'original' && opened.plaintextSha256 !== plaintextSha256) {
            return {
              kind: 'failed',
              stage: 'transfer',
              fault: { kind: 'integrity', role },
            };
          }

          let stored;
          try {
            stored = await cache.putFromFile({
              accountScope: context.accountScope,
              plaintextSha256,
              role,
              generationId,
              sourceUri: plainPath,
              byteSize: opened.plaintextBytes,
            });
          } catch {
            return { kind: 'failed', stage: 'consume', fault: { kind: 'local-storage' } };
          }
          if (stored === null) {
            return { kind: 'failed', stage: 'consume', fault: { kind: 'local-storage' } };
          }
          return { kind: 'cached', entry: stored };
        } finally {
          if (cipherPath !== undefined) await discardStreamPath(cipherPath);
          if (plainPath !== undefined) await discardStreamPath(plainPath);
        }
      };

      const renderFetch = (outcome: LibraryRoleFetch): LibraryRenderSource => {
        if (outcome.kind === 'promoted') {
          return { kind: 'file', uri: outcome.uri, tier: 'local-original', role: 'original' };
        }
        if (outcome.kind === 'cached') {
          return { kind: 'file', uri: outcome.entry.uri, tier, role };
        }
        const failure = viewFailureFor(outcome.fault);
        if (failure.category === 'integrity') {
          return failure.role === undefined
            ? unavailable('integrity')
            : unavailable('integrity', failure.role);
        }
        return unavailable(failure.category);
      };

      const joinCloud = async (): Promise<LibraryRenderSource> => {
        const claim = runWithOwnership(coalescer, `${assetId}:${role}`, fetchCloud);
        try {
          const outcome = await claim.promise;
          if (!claim.owner && outcome.kind === 'failed' && outcome.stage === 'consume') {
            return joinCloud();
          }
          return renderFetch(outcome);
        } catch (error) {
          if (claim.owner) throw error;
          return unavailable('retryable_transfer');
        }
      };

      const result = await joinCloud();
      if (result.kind === 'file') return result;
      if (result.category === 'integrity') return result;
      lastCategory = result.category;
    }
    return unavailable(lastCategory);
  };
}

function createResolverWithRun(
  deps: LibraryRenderResolverDependencies,
  run: ReturnType<typeof createTierRunner>,
): LibraryRenderResolver {
  const { repository, cache, derived, session } = deps;
  return {
    resolve: (plaintextSha256, intent) =>
      run(plaintextSha256, (state) => tiersFor(intent, state)),

    async repairDerived(plaintextSha256) {
      const context = await session.current();
      if (context === null) return false;
      const asset = await repository.findLocalAsset(plaintextSha256);
      if (
        asset === null
        || asset.localOriginalUri === null
        || asset.missingOriginalSince !== null
        || asset.residency !== 'local-original'
      ) {
        return false;
      }
      // Design § Viewing And Cache Behavior: cache repair can regenerate
      // derived variants from a verified original. Local only — no account
      // mutation, no upload, no residency change.
      const produced = await derived.derive({
        sourceUri: asset.localOriginalUri,
        format: asset.format,
        width: asset.width,
        height: asset.height,
      });
      let repaired = false;
      for (const image of [produced.thumbnail, produced.preview]) {
        if (image === null) continue;
        const stored = await cache.put({
          accountScope: context.accountScope,
          plaintextSha256,
          role: image.role,
          generationId: null,
          bytes: image.bytes,
        });
        if (stored !== null) repaired = true;
      }
      return repaired;
    },
  };
}

function createRoleReaderWithRun(
  run: ReturnType<typeof createTierRunner>,
): LibraryRoleReader {
  return {
    read: (plaintextSha256, role) =>
      run(plaintextSha256, (state) => tiersForRole(role, state)),
  };
}

export function createLibraryRenderResolver(
  deps: LibraryRenderResolverDependencies,
): LibraryRenderResolver {
  return createResolverWithRun(deps, createTierRunner(deps));
}

export function createLibraryRoleReader(
  deps: LibraryRenderResolverDependencies,
): LibraryRoleReader {
  return createRoleReaderWithRun(createTierRunner(deps));
}

export type LibraryRenderReaders = Readonly<{
  resolver: LibraryRenderResolver;
  roles: LibraryRoleReader;
}>;

/** Builds the resolver and role reader over one tier runner and coalescer. */
export function createLibraryRenderReaders(
  deps: LibraryRenderResolverDependencies,
): LibraryRenderReaders {
  const run = createTierRunner(deps);
  return {
    resolver: createResolverWithRun(deps, run),
    roles: createRoleReaderWithRun(run),
  };
}
