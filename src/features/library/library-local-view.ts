import type { SqlDatabasePort } from '@/db/sql-port';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import type { LibraryFilePort } from '@/features/library/library-file-store';
import type { LibraryRepository } from '@/features/library/library-repository';
import type { LibraryRenderResolver } from '@/features/library/library-render-source';
import {
  readLibraryEntries,
  readLibraryEntry,
  type LibraryViewModel,
} from '@/features/library/library-view-model';

/**
 * Spec §5.2: a row the last cloud library holds, with no session: `offline`
 * for a network lock, else `auth_attention`.
 */
export function localUnavailableCategoryFor(
  status: ByosStatus | undefined,
): LibraryFailureCategory {
  return status?.status === 'locked'
    && status.reason === 'vault_unreachable'
    && status.detail === 'network'
    ? 'offline'
    : 'auth_attention';
}

// None: bind NULL, which matches nothing, so every entry reads unprotected.
export const LAST_ACCOUNT_SCOPE_SQL = `
  SELECT account_scope FROM library_asset_protection
   ORDER BY updated_at DESC, account_scope ASC
   LIMIT 1
`;

async function lastScope(database: SqlDatabasePort): Promise<string | null> {
  const row = await database.getFirst<{ account_scope: string }>(LAST_ACCOUNT_SCOPE_SQL);
  return row?.account_scope ?? null;
}

export function createLocalLibraryViewModel(
  deps: Readonly<{ database: SqlDatabasePort }>,
): LibraryViewModel {
  const { database } = deps;
  return {
    async listEntries() {
      return readLibraryEntries(database, await lastScope(database));
    },

    async findEntry(plaintextSha256) {
      return readLibraryEntry(
        database,
        await lastScope(database),
        plaintextSha256,
      );
    },

    // Account trash needs a session. This view has none.
    async listTrashEntries() {
      return [];
    },
  };
}

export function createLocalLibraryRenderResolver(
  deps: Readonly<{
    repository: Pick<LibraryRepository, 'findLocalAsset'>;
    model: Pick<LibraryViewModel, 'findEntry'>;
    files: Pick<LibraryFilePort, 'exists'>;
    unavailableCategory: LibraryFailureCategory;
  }>,
): LibraryRenderResolver {
  const { repository, model, files, unavailableCategory } = deps;
  return {
    async resolve(plaintextSha256, intent) {
      const asset = await repository.findLocalAsset(plaintextSha256);
      // `placeholder` is the detail page's stand-in: the local thumbnail only.
      const uri = intent === 'placeholder'
        ? null
        : asset !== null
          && asset.residency === 'local-original'
          && asset.localOriginalUri !== null
          && asset.missingOriginalSince === null
          ? asset.localOriginalUri
          : null;
      if (uri !== null && await files.exists(uri)) {
        return {
          kind: 'file',
          uri,
          tier: 'local-original',
          role: 'original',
        };
      }
      // Spec §5.9: the local view's second tier. Never for a share.
      const thumbnailUri = intent === 'full' ? null : asset?.localThumbnailUri ?? null;
      if (thumbnailUri !== null && await files.exists(thumbnailUri)) {
        return { kind: 'file', uri: thumbnailUri, tier: 'local-thumbnail', role: 'thumbnail' };
      }
      const entry = await model.findEntry(plaintextSha256);
      // Mirrors isOriginalUnrecoverable (spec §5.2): repair is offered exactly
      // when no original generation is known.
      const category = entry?.originalGenerationId == null
        ? 'object_missing'
        : unavailableCategory;
      return { kind: 'unavailable', category };
    },

    async repairDerived(_plaintextSha256) {
      return false;
    },
  };
}
