import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  TEST_GENERATION_ID,
  TEST_MASTER_KEY,
  TEST_PREVIEW_GENERATION_ID,
  TEST_THUMBNAIL_GENERATION_ID,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import type { LibraryObjectRole } from '@/features/library/library-actions-types';
import {
  createLibraryCacheStore,
  type LibraryCacheStore,
} from '@/features/library/library-cache-store';
import { createJsFileDecryptor } from '@/features/library/library-file-decryptor';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import type { LibraryReachabilityPort } from '@/features/library/library-reachability';
import {
  createLibraryRenderReaders,
  type LibraryRenderResolverDependencies,
  type LibraryRenderResolver,
  type LibraryRoleReader,
} from '@/features/library/library-render-source';
import {
  createTransferCoalescer,
  type LibraryRoleFetch,
} from '@/features/library/library-transfer-coalescer';

export const ORIGINAL = Uint8Array.from([3, 1, 4, 1, 5, 9, 2, 6]);
// The actual hash: a test file's counting mock of library-identity is not yet
// initialised when this module loads.
export const DIGEST: string = (
  jest.requireActual('@/features/library/library-identity') as
    typeof import('@/features/library/library-identity')
).sha256PlaintextHex(ORIGINAL);
export const THUMB_BYTES = Uint8Array.from([10, 11, 12]);
export const PREVIEW_BYTES = Uint8Array.from([20, 21, 22, 23]);
export const WRONG_ORIGINAL = Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]);

type GetObjectCall = Readonly<{
  generationId: string;
}>;

type DeriveCall = Readonly<{
  sourceUri: string;
  format: string;
  width: number;
  height: number;
  /** Present only when the caller asked for specific roles. */
  roles?: readonly string[];
}>;

export type RenderHarness = {
  actions: ActionsHarness;
  cache: LibraryCacheStore;
  resolver: LibraryRenderResolver;
  roles: LibraryRoleReader;
  derived: LibraryDerivedImages;
  getObjectCalls: GetObjectCall[];
  deriveCalls: DeriveCall[];
  reachability: { value: boolean } & LibraryReachabilityPort;
  /** Make the next cloud `getObjectToFile` throw this exact error once, then clear. */
  failNextGetObject(error: Error): void;
  close(): void;
};

export async function createRenderHarness(
  options: Readonly<{
    derived?: LibraryDerivedImages;
    digest?: (bytes: Uint8Array) => Promise<string>;
    nodeStreamRoot?: boolean;
    coalescer?: LibraryRenderResolverDependencies['coalescer'];
  }> = {},
): Promise<RenderHarness> {
  const actions = await createActionsHarness({ nodeStreamRoot: options.nodeStreamRoot });
  const getObjectCalls: GetObjectCall[] = [];
  const deriveCalls: DeriveCall[] = [];
  const cache = createLibraryCacheStore({
    database: actions.database,
    files: actions.files,
    port: actions.port,
    budgetBytes: 1_000_000,
    clock: () => actions.now,
  });
  const reachability = {
    value: true,
    async isReachable() {
      return reachability.value;
    },
  };
  const derived: LibraryDerivedImages = options.derived ?? {
    async derive(input) {
      deriveCalls.push({
        sourceUri: input.sourceUri,
        format: input.format,
        width: input.width,
        height: input.height,
        ...(input.roles === undefined ? {} : { roles: input.roles }),
      });
      return {
        thumbnail: {
          role: 'thumbnail',
          bytes: THUMB_BYTES,
          width: 8,
          height: 8,
          format: 'webp',
        },
        preview: {
          role: 'preview',
          bytes: PREVIEW_BYTES,
          width: 16,
          height: 16,
          format: 'webp',
        },
        animated: false,
        failed: false,
      };
    },
  };
  const nextGetObjectFailure = { error: null as Error | null };
  const cloud = {
    async getObjectToFile(generationId: string, fileUri: string) {
      // Narrow S3-shaped adapter: track calls, delegate to shared harness.s3.
      getObjectCalls.push({ generationId });
      if (nextGetObjectFailure.error !== null) {
        const error = nextGetObjectFailure.error;
        nextGetObjectFailure.error = null;
        throw error;
      }
      return actions.s3.getObjectToFile(generationId, fileUri);
    },
  };
  const decryptor = options.digest === undefined
    ? actions.decryptor
    : createJsFileDecryptor(actions.cipher, actions.port, options.digest);
  const dependencies = {
    repository: actions.repository,
    protection: actions.protection,
    cache,
    cloud,
    derived,
    files: actions.port,
    streams: actions.files,
    decryptor,
    coalescer: options.coalescer ?? createTransferCoalescer<LibraryRoleFetch>(),
    reachability,
    session: actions.session,
  };
  const readers = createLibraryRenderReaders(dependencies);
  const { resolver, roles } = readers;
  return {
    actions,
    cache,
    resolver,
    roles,
    derived,
    getObjectCalls,
    deriveCalls,
    reachability,
    failNextGetObject: (error) => {
      nextGetObjectFailure.error = error;
    },
    close: () => actions.close(),
  };
}

export async function sealAndStore(
  harness: RenderHarness,
  role: LibraryObjectRole,
  plaintext: Uint8Array,
  generationId: string,
): Promise<void> {
  const assetId = harness.actions.assetIdFor(DIGEST);
  const envelope = await harness.actions.cipher.seal({
    masterKey: TEST_MASTER_KEY,
    assetId,
    scope: role,
    plaintext,
  });
  // Blobs are content-addressed under BYOS: one key per generationId, no
  // role and no assetId in it.
  harness.actions.cloud.blobs.set(generationId, envelope);
}

export async function upsertProtected(
  harness: RenderHarness,
  input: Readonly<{
    thumbnailGenerationId?: string | null;
    previewGenerationId?: string | null;
    originalGenerationId?: string | null;
    lifecycle?: 'active' | 'trash' | 'purged';
  }> = {},
): Promise<void> {
  const assetId = harness.actions.assetIdFor(DIGEST);
  await harness.actions.protection.upsertProtection({
    accountScope: TEST_ACCOUNT_SCOPE,
    assetId,
    plaintextSha256: DIGEST,
    lifecycle: input.lifecycle ?? 'active',
    protection: 'protected',
    generation: 1,
    revision: 1,
    originalGenerationId: input.originalGenerationId === undefined
      ? TEST_GENERATION_ID
      : input.originalGenerationId,
    originalCiphertextBytes: 128,
    thumbnailGenerationId: input.thumbnailGenerationId === undefined
      ? TEST_THUMBNAIL_GENERATION_ID
      : input.thumbnailGenerationId,
    previewGenerationId: input.previewGenerationId === undefined
      ? TEST_PREVIEW_GENERATION_ID
      : input.previewGenerationId,
    verifiedAt: 1,
    failureCategory: null,
    trashedAt: input.lifecycle === 'trash' || input.lifecycle === 'purged'
      ? harness.actions.clock()
      : null,
  });
}

export async function seedCloudOnly(harness: RenderHarness): Promise<void> {
  await harness.actions.seedProjectedAsset({
    plaintextSha256: DIGEST,
    protection: 'protected',
    originalGenerationId: TEST_GENERATION_ID,
  });
  await upsertProtected(harness);
}

export async function cacheRowCount(harness: RenderHarness): Promise<number> {
  const row = await harness.actions.database.getFirst<{ n: number }>(
    `SELECT COUNT(*) AS n FROM library_cache_entries
      WHERE account_scope = ? AND plaintext_sha256 = ?`,
    [TEST_ACCOUNT_SCOPE, DIGEST],
  );
  return row?.n ?? 0;
}
