import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibraryLifecycle,
  LibraryProtection,
  LibrarySessionContext,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import {
  createLibraryActionOutbox,
  type LibraryActionOutbox,
} from '@/features/library/library-action-outbox';
import type {
  LibraryAssetStateGenerations,
  LibraryAssetStateRecord,
} from '@/features/library/library-asset-state-codec';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import type {
  LibraryGenerationRole,
  LibraryCloudClient,
  S3LibraryPendingMutation,
  S3LibraryRemoteMutationResult,
  S3LibraryRemoteRejectionReason,
} from '@/features/library/library-cloud-client-s3';
import {
  decideLibraryMutation,
  type LibraryMutationDecision,
  type LibraryRemoteAssetState as NarrowRemoteAssetState,
} from '@/features/library/library-mutation-decision';
import type { LibraryReconciliationPort } from '@/features/library/library-reconciliation-port';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import {
  createLibraryLocalActions,
  type LibraryLocalActionsDependencies,
} from '@/features/library/library-local-actions';
import {
  createJsFileDecryptor,
  type LibraryFileDecryptor,
} from '@/features/library/library-file-decryptor';
import type { LibraryProtectActionDependencies } from '@/features/library/library-protect-action';
import type { LibraryChangeKind } from '@/features/library/library-sync-types';
import {
  createLibraryFileStore,
  type LibraryFileStore,
} from '@/features/library/library-file-store';
import {
  createLibraryObjectCipher,
  type LibraryObjectCipher,
} from '@/features/library/library-object-crypto';
import {
  createLibraryProtectionRepository,
  type LibraryProtectionRepository,
} from '@/features/library/library-protection-repository';
import {
  createLibraryRepository,
  type LibraryRepository,
} from '@/features/library/library-repository';
import { readSourceMetadata } from '@/features/library/library-source-metadata';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import {
  createTransferCoalescer,
  type LibraryRoleFetch,
} from '@/features/library/library-transfer-coalescer';
import {
  createFakeLibraryFilePort,
  type FakeLibraryFilePort,
} from '@/features/library/library-test-support';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';
import { withNodeStreamRoot } from '@/test/node-file-transfer';

export const TEST_MASTER_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);
export const TEST_DEVICE_ID = 'device-A';
export const TEST_ACCOUNT_SCOPE = 'scope-A';
export const TEST_GENERATION_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_THUMBNAIL_GENERATION_ID = 'thumb-gen';
export const TEST_PREVIEW_GENERATION_ID = 'preview-gen';
export const TEST_MUTATION_ID_PREFIX = '00000000-0000-4000-8000-';

const ORIGINAL_BYTES = 128;

/** One accepted `state.json` write, in bucket write order. */
export type FakeStateWrite = Readonly<{
  revision: number;
  assetId: string;
  kind: LibraryChangeKind;
}>;

/**
 * The shared BYOS bucket. Two harnesses handed the same `FakeAccountState`
 * are two devices pointing at one S3-compatible bucket, which is the only
 * thing that makes them one library.
 *
 * This is a bucket, not a Worker account: it holds exactly the two object
 * families the BYOS protocol defines — `assets/<assetId>/state.json` (kept
 * decoded, as `LibraryAssetStateRecord`, since nothing here tests the codec)
 * and content-addressed `blobs/<generationId>`. There is no change feed, no
 * cursor, no quota, and no server-side decision table: every decision is made
 * client-side by the production `decideLibraryMutation`, exactly as
 * `library-cloud-client-s3.ts` does it against a real bucket.
 */
export type FakeAccountState = {
  masterKey: Uint8Array;
  cipher: LibraryObjectCipher;
  /** `blobs/<generationId>`: content-addressed, so no role and no assetId. */
  blobs: Map<string, Uint8Array>;
  /** `assets/<assetId>/state.json`, keyed by assetId, stored decoded. */
  remote: Map<string, LibraryAssetStateRecord>;
  /** Every accepted state.json write any device made, in order. */
  writes: FakeStateWrite[];
  /**
   * Every mutation any device submitted, in one chronological order — the
   * single submission log decision #17 asks for, replacing the wide fake's
   * parallel `submitted`/`mutations`/per-device logs.
   */
  submitted: S3LibraryPendingMutation[];
  /**
   * Every reconciliation read any device issued, in order. Mutation traffic
   * is recorded by `submitted`, not here: these two request families are what
   * the sync engine's read side is asserted on (one listing per cycle, one
   * targeted GET per committed asset), and folding CAS reads into the same
   * log would make that assertion meaningless.
   */
  requests: string[];
  /** Highest revision any asset in this bucket has reached. */
  latestRevision: number;
  /** State-changing writes per assetId — an idempotent replay must not raise it. */
  appliedCounts: Map<string, number>;
  /** Commit the next mutation, then lose the response exactly once. */
  dropNextResponse: boolean;
  assetIdFor(plaintextSha256: string): string;
  /** Assets the library still shows. */
  assetCount(): number;
  lifecycleOf(plaintextSha256: string): LibraryLifecycle | null;
  /** The accepted writes for one asset, oldest first. */
  revisionsFor(plaintextSha256: string): readonly FakeStateWrite[];
  purge(plaintextSha256: string): void;
  /** A deterministic ISO stamp for a revision, so `trashedAt` is stable. */
  isoAt(revision: number): string;
  /** Writes one record and records the write. Bumps nothing else. */
  writeRecord(next: LibraryAssetStateRecord, kind: LibraryChangeKind): void;
  seedRemoteAsset(input: {
    plaintextSha256: string;
    protection?: LibraryProtection;
    lifecycle?: LibraryLifecycle;
    /** When protected, also carry authoritative derived generation ids. */
    withDerived?: boolean;
  }): Promise<void>;
  removeRemoteAsset(plaintextSha256: string): void;
  trashRemoteAsset(plaintextSha256: string): void;
  originalGenerationIdFor(plaintextSha256: string): string | null;
  lifecycleFor(assetId: string): LibraryLifecycle | null;
  /** A concurrent device wrote the asset again, so its revision moved on. */
  bumpRevision(plaintextSha256: string): void;
  revisionFor(plaintextSha256: string): number;
  purgeRemoteAsset(plaintextSha256: string): void;
  /**
   * The first attempt really did land: the record carries this mutation's
   * `lastMutationId`, so the replay resolves from the record instead of
   * applying a second time.
   */
  applyStoredMutation(mutationId: string, assetId: string): void;
  appliedCountFor(assetId: string): number;
};

/**
 * One device's face onto the shared bucket: the S3 client surface the
 * migrated action/sync consumers call, plus the per-device transport knobs a
 * test uses to cut this device off without touching the bucket.
 *
 * Decision #17's end state. Its `submitMutations` is not a translator over a
 * Worker-shaped fake any more — it is an S3-shaped store that runs the
 * PRODUCTION `decideLibraryMutation` against the bucket's own
 * `LibraryAssetStateRecord`s and mirrors `library-cloud-client-s3.ts`'s CAS
 * write semantics (per-asset monotonic revision, carried-field preservation,
 * `lastMutationId` idempotency, purge tombstones that strip `generations` and
 * `meta`). There is no second decision table to drift from the first.
 */
export type FakeS3Library = {
  /** The bucket this device reads and writes. */
  account: FakeAccountState;
  /** `blobs/<generationId>`, shared: uploads by either device are visible to both. */
  blobs: Map<string, Uint8Array>;
  /** `assets/<assetId>/state.json`, shared, keyed by assetId. */
  remote: Map<string, LibraryAssetStateRecord>;
  /** The bucket's one chronological submission log. */
  submitted: S3LibraryPendingMutation[];
  /** SP8's name for the same submission log `submitted` records. */
  submittedMutations: S3LibraryPendingMutation[];
  /** Every `submitMutations` batch this device dispatched, in order. */
  mutations: { mutations: S3LibraryPendingMutation[] }[];
  /** Every content-addressed `putBlob` this device issued, in order. */
  blobPuts: { generationId: string; bytes: Uint8Array }[];
  requests: string[];
  latestRevision: number;
  /** Cuts this device off entirely: every read and write throws offline. */
  offline: boolean;
  /** Fail the next blob `getObject` once as offline, then clear. */
  offlineOnGetOnce: boolean;
  /** Fail the next `putBlob` call once, as a lost/offline write. */
  failNextBlobPut: boolean;
  /** Flip a byte on every blob read, so the caller's integrity check fires. */
  corruptOnRead: boolean;
  /** Fail the next mutations request once: lost request, or a known refusal. */
  failMutationsOnce: 'offline' | 'refused' | null;
  /** Throw this on every mutations request until cleared. */
  submitError: LibraryCloudError | null;
  /** Refuse every mutation with this reason. */
  rejectWith: S3LibraryRemoteRejectionReason | null;
  /** Refuse the next mutation with this reason once, then clear. */
  rejectNext: S3LibraryRemoteRejectionReason | null;
  /** Commit this mutation kind, then lose the response exactly once. */
  loseResponseAfterCommit: S3LibraryPendingMutation['kind'] | null;
  seedRemoteAsset(input: {
    plaintextSha256: string;
    protection?: LibraryProtection;
    lifecycle?: LibraryLifecycle;
    withDerived?: boolean;
  }): Promise<void>;
  removeRemoteAsset(plaintextSha256: string): void;
  trashRemoteAsset(plaintextSha256: string): void;
  originalGenerationIdFor(plaintextSha256: string): string | null;
  lifecycleFor(assetId: string): LibraryLifecycle | null;
  bumpRevision(plaintextSha256: string): void;
  revisionFor(plaintextSha256: string): number;
  purgeRemoteAsset(plaintextSha256: string): void;
  applyStoredMutation(mutationId: string, assetId: string): void;
  appliedCountFor(assetId: string): number;
  /** The S3 client surface every migrated consumer in this harness calls. */
  client: Pick<LibraryCloudClient, 'getObject' | 'getObjectToFile' | 'submitMutations' | 'putBlob'>;
  /** The BYOS change-discovery face the sync engine reconciles against. */
  reconciliation: LibraryReconciliationPort;
};

/** Projects a stored record down to the 5 fields the decision table reads. */
function narrowAsset(
  record: LibraryAssetStateRecord | null,
): NarrowRemoteAssetState | null {
  if (record === null) return null;
  const { assetId, revision, generation, lifecycle, protection } = record;
  return { assetId, revision, generation, lifecycle, protection };
}

/**
 * Drops explicitly-`undefined` roles from a `generationsPatch`, so a patch
 * that omits a role preserves it instead of erasing it. Mirrors
 * `library-cloud-client-s3.ts`'s `compactGenerations` and exists for the same
 * reason: this tsconfig does not set `exactOptionalPropertyTypes`.
 */
function compactFakeGenerations(
  patch: LibraryAssetStateGenerations,
): LibraryAssetStateGenerations {
  const compact: {
    thumbnail?: string;
    preview?: string;
    original?: string;
  } = {};
  if (patch.thumbnail !== undefined) compact.thumbnail = patch.thumbnail;
  if (patch.preview !== undefined) compact.preview = patch.preview;
  if (patch.original !== undefined) compact.original = patch.original;
  return compact;
}

/**
 * Builds the next persisted record for an `applied` decision, mirroring
 * `library-cloud-client-s3.ts`'s `buildNextRecord` branch for branch:
 * per-asset monotonic revision, `newBlob` then `generationsPatch` merged over
 * the existing `generations`, `trashedAt` stamped on trash and cleared on
 * restore, `meta` preserved unless this mutation supplies one, and a purge
 * tombstone that strips both `generations` and `meta` whatever the mutation
 * carried.
 */
function nextFakeRecord(
  existing: LibraryAssetStateRecord | null,
  mutation: S3LibraryPendingMutation,
  decision: Extract<LibraryMutationDecision, { outcome: 'applied' }>,
  now: (revision: number) => string,
): LibraryAssetStateRecord {
  const revision = (existing?.revision ?? 0) + 1;
  const role: LibraryGenerationRole = mutation.newBlob?.role ?? 'original';
  const withNewBlob: LibraryAssetStateGenerations =
    mutation.newBlob === null
      ? (existing?.generations ?? {})
      : { ...(existing?.generations ?? {}), [role]: mutation.newBlob.generationId };
  const generations: LibraryAssetStateGenerations =
    decision.lifecycle === 'purged'
      ? {}
      : mutation.generationsPatch === undefined
        ? withNewBlob
        : { ...withNewBlob, ...compactFakeGenerations(mutation.generationsPatch) };
  const trashedAt: string | null =
    mutation.kind === 'trash'
      ? now(revision)
      : mutation.kind === 'restore'
        ? null
        : (existing?.trashedAt ?? null);
  const meta: string | undefined =
    decision.lifecycle === 'purged'
      ? undefined
      : (mutation.meta ?? existing?.meta);

  return {
    assetId: mutation.assetId,
    revision,
    generation: decision.generation,
    lifecycle: decision.lifecycle,
    protection: decision.protection,
    lastMutationId: mutation.mutationId,
    trashedAt,
    generations,
    ...(meta !== undefined ? { meta } : {}),
  };
}

/**
 * Mirrors `library-cloud-client-s3.ts`'s `rebaseWithinGroup` (K6-1b): a
 * mutation that follows another mutation for the SAME asset in one batch has
 * no independent base to state, because the record it must base on is only
 * produced while the batch is being applied. A `null` `baseRevision` on such a
 * follower therefore inherits the record the batch has rolled to; a stated
 * base is always kept, so a genuine stale-base conflict is still refused.
 * Duplicated rather than imported on purpose: this fake is the independent
 * oracle the real client is checked against, so it must not re-export the
 * behaviour under test.
 */
function rebaseFakeFollower(
  mutation: S3LibraryPendingMutation,
  record: LibraryAssetStateRecord | null,
): S3LibraryPendingMutation {
  if (record === null || mutation.baseRevision !== null) return mutation;
  return { ...mutation, baseRevision: record.revision };
}

export function createFakeAccountState(options: Readonly<{
  masterKey?: Uint8Array;
  cipher?: LibraryObjectCipher;
}> = {}): FakeAccountState {
  const masterKey = options.masterKey ?? TEST_MASTER_KEY;
  const cipher = options.cipher ?? createLibraryObjectCipher();

  const state: FakeAccountState = {
    masterKey,
    cipher,
    blobs: new Map(),
    remote: new Map(),
    writes: [],
    submitted: [],
    requests: [],
    latestRevision: 0,
    appliedCounts: new Map(),
    dropNextResponse: false,
    assetIdFor: (plaintextSha256) =>
      deriveLibraryAssetId(masterKey, plaintextSha256),
    assetCount: () => [...state.remote.values()].filter(
      (record) => record.lifecycle !== 'purged',
    ).length,
    lifecycleOf: (plaintextSha256) =>
      state.remote.get(state.assetIdFor(plaintextSha256))?.lifecycle ?? null,
    revisionsFor: (plaintextSha256) => {
      const assetId = state.assetIdFor(plaintextSha256);
      return state.writes.filter((write) => write.assetId === assetId);
    },
    purge: (plaintextSha256) => state.purgeRemoteAsset(plaintextSha256),
    isoAt: (revision) =>
      new Date(Date.UTC(2026, 6, 28) + revision * 1_000).toISOString(),
    writeRecord: (next, kind) => {
      state.remote.set(next.assetId, next);
      state.latestRevision = Math.max(state.latestRevision, next.revision);
      state.writes.push({
        revision: next.revision,
        assetId: next.assetId,
        kind,
      });
    },
    async seedRemoteAsset() {},
    removeRemoteAsset() {},
    trashRemoteAsset() {},
    originalGenerationIdFor() { return null; },
    lifecycleFor() { return null; },
    bumpRevision() {},
    revisionFor() { return 0; },
    purgeRemoteAsset() {},
    applyStoredMutation() {},
    appliedCountFor() { return 0; },
  };

  /**
   * What another device already wrote to the bucket. A protected seed carries
   * the generation-id triad on the asset's own record, because under BYOS
   * that record is the only place object locations live.
   */
  state.seedRemoteAsset = async (input) => {
    const assetId = state.assetIdFor(input.plaintextSha256);
    const protection = input.protection ?? 'unprotected';
    const lifecycle = input.lifecycle ?? 'active';
    const withDerived = input.withDerived === true && protection === 'protected';
    const meta = await cipher.sealMetadata({
      masterKey,
      assetId,
      metadata: {
        version: 1,
        plaintextSha256: input.plaintextSha256,
        format: 'jpeg',
        canonicalExtension: 'jpg',
        byteSize: 4,
        width: 10,
        height: 10,
        origin: 'import',
        sourceImageId: null,
        collectedAt: 1,
        tags: [],
      },
    });
    const previous = state.remote.get(assetId) ?? null;
    state.writeRecord(
      {
        assetId,
        revision: (previous?.revision ?? 0) + 1,
        generation: previous?.generation ?? 1,
        lifecycle,
        protection,
        lastMutationId: null,
        trashedAt: lifecycle === 'trash'
          ? state.isoAt((previous?.revision ?? 0) + 1)
          : null,
        generations: protection === 'protected'
          ? {
              original: TEST_GENERATION_ID,
              ...(withDerived
                ? {
                    thumbnail: TEST_THUMBNAIL_GENERATION_ID,
                    preview: TEST_PREVIEW_GENERATION_ID,
                  }
                : {}),
            }
          : {},
        meta,
      },
      protection === 'protected' ? 'protect' : 'collect',
    );
  };

  /** An out-of-band deletion: the `state.json` object is simply gone. */
  state.removeRemoteAsset = (plaintextSha256) => {
    state.remote.delete(state.assetIdFor(plaintextSha256));
  };

  const mutateRecord = (
    assetId: string,
    kind: LibraryChangeKind,
    change: (
      previous: LibraryAssetStateRecord | null,
      revision: number,
    ) => LibraryAssetStateRecord,
  ): void => {
    const previous = state.remote.get(assetId) ?? null;
    state.writeRecord(change(previous, (previous?.revision ?? 0) + 1), kind);
  };

  const blankRecord = (
    assetId: string,
    revision: number,
  ): LibraryAssetStateRecord => ({
    assetId,
    revision,
    generation: 1,
    lifecycle: 'active',
    protection: 'unprotected',
    lastMutationId: null,
    trashedAt: null,
    generations: {},
  });

  state.trashRemoteAsset = (plaintextSha256) => {
    const assetId = state.assetIdFor(plaintextSha256);
    mutateRecord(assetId, 'trash', (previous, revision) => ({
      ...(previous ?? blankRecord(assetId, revision)),
      revision,
      lifecycle: 'trash',
      trashedAt: state.isoAt(revision),
    }));
  };

  state.originalGenerationIdFor = (plaintextSha256) =>
    state.remote.get(state.assetIdFor(plaintextSha256))
      ?.generations.original ?? null;

  state.lifecycleFor = (assetId) => state.remote.get(assetId)?.lifecycle ?? null;

  const requireRemote = (assetId: string): LibraryAssetStateRecord => {
    const record = state.remote.get(assetId);
    if (record === undefined) {
      throw new Error(`No remote asset for ${assetId}.`);
    }
    return record;
  };

  state.bumpRevision = (plaintextSha256) => {
    const assetId = state.assetIdFor(plaintextSha256);
    const previous = requireRemote(assetId);
    state.writeRecord({ ...previous, revision: previous.revision + 1 }, 'collect');
  };

  state.revisionFor = (plaintextSha256) =>
    requireRemote(state.assetIdFor(plaintextSha256)).revision;

  /** The tombstone a permanent delete leaves: no `generations`, no `meta`. */
  state.purgeRemoteAsset = (plaintextSha256) => {
    const assetId = state.assetIdFor(plaintextSha256);
    mutateRecord(assetId, 'purge', (previous, revision) => {
      const base = previous ?? blankRecord(assetId, revision);
      return {
        assetId: base.assetId,
        revision,
        generation: base.generation,
        lifecycle: 'purged',
        protection: 'unprotected',
        lastMutationId: base.lastMutationId,
        trashedAt: base.trashedAt,
        generations: {},
      };
    });
  };

  state.applyStoredMutation = (mutationId, assetId) => {
    mutateRecord(assetId, 'trash', (previous, revision) => ({
      ...(previous ?? blankRecord(assetId, revision)),
      revision,
      lifecycle: 'trash',
      trashedAt: state.isoAt(revision),
      lastMutationId: mutationId,
    }));
    state.appliedCounts.set(assetId, 1);
  };

  state.appliedCountFor = (assetId) => state.appliedCounts.get(assetId) ?? 0;

  return state;
}

export function createFakeS3Library(options: Readonly<{
  masterKey?: Uint8Array;
  cipher?: LibraryObjectCipher;
  /** Share one bucket between two devices to get one library. */
  account?: FakeAccountState;
  filePort?: Pick<FakeLibraryFilePort, 'writeBytes'>;
}> = {}): FakeS3Library {
  const account = options.account ?? createFakeAccountState({
    masterKey: options.masterKey,
    cipher: options.cipher,
  });

  const offlineError = (message = 'offline'): never => {
    throw new LibraryCloudError(0, 'network_unavailable', 'offline', message, false);
  };

  const refuse = (
    mutation: S3LibraryPendingMutation,
    reason: S3LibraryRemoteRejectionReason,
  ): S3LibraryRemoteMutationResult => ({
    mutationId: mutation.mutationId,
    assetId: mutation.assetId,
    kind: mutation.kind,
    outcome: 'rejected',
    reason,
    revision: null,
    asset: null,
  });

  /**
   * One mutation against the bucket, mirroring
   * `library-cloud-client-s3.ts`'s `processMutation`: blob first, then read
   * the record, decide with the production table, then write. The CAS retry
   * loop has no analogue here — this fake is single-threaded, so no writer
   * can slip between the read and the write, and a stale base is already
   * refused by the decision table itself.
   */
  const apply = (
    mutation: S3LibraryPendingMutation,
  ): S3LibraryRemoteMutationResult => {
    const existing = account.remote.get(mutation.assetId) ?? null;

    // `lastMutationId` idempotency: this exact mutation's write is already
    // durable, so a replay whose first response was lost answers from the
    // record instead of deciding a second time.
    if (existing !== null && existing.lastMutationId === mutation.mutationId) {
      return {
        mutationId: mutation.mutationId,
        assetId: mutation.assetId,
        kind: mutation.kind,
        outcome: 'applied',
        reason: null,
        revision: existing.revision,
        asset: existing,
      };
    }

    const decision = decideLibraryMutation(narrowAsset(existing), mutation, 0);
    if (decision.outcome !== 'applied') {
      return {
        mutationId: mutation.mutationId,
        assetId: mutation.assetId,
        kind: mutation.kind,
        outcome: decision.outcome,
        reason: decision.outcome === 'rejected' ? decision.reason : null,
        revision: existing?.revision ?? null,
        asset: existing,
      };
    }

    const next = nextFakeRecord(existing, mutation, decision, account.isoAt);
    account.writeRecord(next, decision.changeKind);
    account.appliedCounts.set(
      mutation.assetId,
      (account.appliedCounts.get(mutation.assetId) ?? 0) + 1,
    );
    return {
      mutationId: mutation.mutationId,
      assetId: mutation.assetId,
      kind: mutation.kind,
      outcome: 'applied',
      reason: null,
      revision: next.revision,
      asset: next,
    };
  };

  const state: FakeS3Library = {
    account,
    // Per-device transport knobs. Cutting one device off never touches the
    // bucket, which is what makes an offline-device scenario meaningful.
    offline: false,
    offlineOnGetOnce: false,
    failNextBlobPut: false,
    corruptOnRead: false,
    failMutationsOnce: null,
    submitError: null,
    rejectWith: null,
    rejectNext: null,
    loseResponseAfterCommit: null,
    mutations: [],
    blobPuts: [],
    // Bucket-owned state, shared by every device pointed at this account.
    get blobs() { return account.blobs; },
    get remote() { return account.remote; },
    get submitted() { return account.submitted; },
    get submittedMutations() { return account.submitted; },
    get requests() { return account.requests; },
    get latestRevision() { return account.latestRevision; },
    set latestRevision(value: number) { account.latestRevision = value; },
    seedRemoteAsset: (input) => account.seedRemoteAsset(input),
    removeRemoteAsset: (digest) => account.removeRemoteAsset(digest),
    trashRemoteAsset: (digest) => account.trashRemoteAsset(digest),
    originalGenerationIdFor: (digest) => account.originalGenerationIdFor(digest),
    lifecycleFor: (assetId) => account.lifecycleFor(assetId),
    bumpRevision: (digest) => account.bumpRevision(digest),
    revisionFor: (digest) => account.revisionFor(digest),
    purgeRemoteAsset: (digest) => account.purgeRemoteAsset(digest),
    applyStoredMutation: (mutationId, assetId) =>
      account.applyStoredMutation(mutationId, assetId),
    appliedCountFor: (assetId) => account.appliedCountFor(assetId),
    client: null as unknown as FakeS3Library['client'],
    reconciliation: null as unknown as LibraryReconciliationPort,
  };

  state.client = {
    /** Content-addressed blob read: `blobs/<generationId>`, no role, no assetId. */
    async getObject(generationId) {
      if (state.offlineOnGetOnce) {
        state.offlineOnGetOnce = false;
        offlineError();
      }
      if (state.offline) offlineError();
      const bytes = account.blobs.get(generationId);
      if (bytes === undefined) return null;
      if (state.corruptOnRead) {
        const corrupted = Uint8Array.from(bytes);
        corrupted[corrupted.byteLength - 5] ^= 0xff;
        return corrupted;
      }
      return Uint8Array.from(bytes);
    },
    async getObjectToFile(generationId, fileUri) {
      if (state.offlineOnGetOnce) {
        state.offlineOnGetOnce = false;
        offlineError();
      }
      if (state.offline) offlineError();
      const bytes = account.blobs.get(generationId);
      if (bytes === undefined) return null;
      const output = Uint8Array.from(bytes);
      if (state.corruptOnRead) output[output.byteLength - 5] ^= 0xff;
      if (options.filePort === undefined) {
        throw new Error('fake getObjectToFile requires a file port');
      }
      try {
        await options.filePort.writeBytes(fileUri, output);
      } catch (error) {
        throw new LibraryCloudError(
          0,
          's3_local_write',
          'local_space',
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
      return { etag: '', bytesWritten: output.byteLength };
    },
    /**
     * The protect flow's content-addressed upload. "Blob durable before
     * state" is the caller's obligation under `generationsPatch`, so this
     * lands in the bucket before the mutation that references it.
     */
    async putBlob(generationId, bytes) {
      if (state.failNextBlobPut) {
        state.failNextBlobPut = false;
        offlineError('blob put failed');
      }
      if (state.offline) offlineError();
      const copy = Uint8Array.from(bytes);
      state.blobPuts.push({ generationId, bytes: copy });
      account.blobs.set(generationId, copy);
    },
    async submitMutations({ mutations }) {
      if (state.offline) offlineError();
      // The dispatch is observable before any failure, so a lost response is
      // still a request that reached the bucket.
      state.mutations.push({ mutations: [...mutations] });
      for (const mutation of mutations) account.submitted.push(mutation);

      const failure = state.failMutationsOnce;
      if (failure !== null) {
        state.failMutationsOnce = null;
        if (failure === 'offline') offlineError('lost request');
        // A known refusal the remote answered and rejected (nothing applied):
        // outcomeKnown is true, so the drain path marks the row failed.
        throw new LibraryCloudError(403, 's3_credential', 'auth_attention', 'refused', true);
      }
      if (state.submitError !== null) throw state.submitError;

      const results: S3LibraryRemoteMutationResult[] = [];
      let previousAssetId: string | null = null;
      for (const mutation of mutations) {
        // Same-asset grouping (K6-1b): a follower for the same asset decides
        // against the record this batch has already rolled forward.
        const decided = mutation.assetId === previousAssetId
          ? rebaseFakeFollower(
              mutation,
              account.remote.get(mutation.assetId) ?? null,
            )
          : mutation;
        previousAssetId = mutation.assetId;
        if (state.rejectWith !== null) {
          results.push(refuse(mutation, state.rejectWith));
          continue;
        }
        if (state.rejectNext !== null) {
          results.push(refuse(mutation, state.rejectNext));
          state.rejectNext = null;
          continue;
        }
        // Step 1, exactly as the real client orders it: the blob is durable
        // before any state.json write can reference it.
        if (mutation.newBlob !== null) {
          account.blobs.set(
            mutation.newBlob.generationId,
            Uint8Array.from(mutation.newBlob.bytes),
          );
        }
        const result = apply(decided);
        if (state.loseResponseAfterCommit === mutation.kind) {
          // The write landed and the client never learns the outcome. The
          // record's `lastMutationId` is what lets the replay resolve.
          state.loseResponseAfterCommit = null;
          offlineError('lost response');
        }
        if (account.dropNextResponse) {
          account.dropNextResponse = false;
          offlineError('lost response');
        }
        results.push(result);
      }
      // BYOS is per-asset: there is no account-wide cursor to report.
      return { cursor: 0, minBaseCursor: 0, results };
    },
  };

  state.reconciliation = {
    /**
     * The fake bucket keeps no ETags, so every listed record counts as
     * changed. That is the honest stand-in for "this device has never read
     * any of these bytes", which is what the suites built on this harness are
     * about; the real ETag diff (and the empty batch it produces for an
     * unchanged library) is proven against the real port in
     * `library-reconciliation-port.test.ts`, `library-sync-engine.test.ts`,
     * and the MinIO gate.
     */
    async discoverChanges() {
      account.requests.push('/byos/assets/');
      if (state.offline) offlineError();
      const changed = [...account.remote.values()];
      return { changed, removedKeys: [], total: changed.length };
    },
    async getAssetState(assetId) {
      account.requests.push(`/byos/assets/${assetId}/state.json`);
      // Note: `offlineOnGetOnce` is intentionally NOT consumed here (only by
      // the blob `getObject` above), so the verify-goes-offline tests still
      // fail at the post-commit blob read, not this state read.
      if (state.offline) offlineError();
      return account.remote.get(assetId) ?? null;
    },
    async remember() {},
  };

  return state;
}

/** Failing derived double for harnesses that are not about derivation. */
export function createFailingLibraryDerivedImages(): LibraryDerivedImages {
  return {
    async derive() {
      throw new Error('derived images unavailable in this harness');
    },
  };
}

export type ActionsHarness = {
  native: DatabaseSync;
  database: SqlDatabasePort;
  port: FakeLibraryFilePort;
  files: LibraryFileStore;
  repository: LibraryRepository;
  protection: LibraryProtectionRepository;
  outbox: LibraryActionOutbox;
  cipher: LibraryObjectCipher;
  /** This device's face onto the shared bucket, plus its transport knobs. */
  cloud: FakeS3Library;
  /** The S3 client surface every consumer in this harness calls (decision #17). */
  s3: Pick<LibraryCloudClient, 'getObject' | 'getObjectToFile' | 'submitMutations' | 'putBlob'>;
  decryptor: LibraryFileDecryptor;
  /**
   * The BYOS change-discovery face the sync engine reconciles against, served
   * from the same bucket `cloud` writes — a listed record and a single-asset
   * GET are literally the same object, so the two can never disagree.
   */
  reconciliation: LibraryReconciliationPort;
  session: LibrarySessionPort & {
    value: LibrarySessionContext | null;
    signOut(): void;
  };
  now: number;
  clock: () => number;
  /** The registered device every seeded intent stores. */
  deviceId: string;
  /**
   * Mints this device's content-addressed blob generationIds. Prefixed per
   * device so two devices sharing one account can never mint the same id.
   */
  newGenerationId: () => string;
  /** One account, so two devices sharing a master key share this scope. */
  accountScope: string;
  /** Exactly what `createLibraryProtectAction` needs, nothing more. */
  protectDependencies: LibraryProtectActionDependencies;
  /** Exactly what `createLibraryLocalActions` needs, nothing more. */
  localDependencies: LibraryLocalActionsDependencies;
  assetIdFor(plaintextSha256: string): string;
  originalUriFor(plaintextSha256: string): string;
  /** Durable read-throughs, so a test asserts stored state, not a literal. */
  canonicalExtensionFor(plaintextSha256: string): Promise<string | null>;
  byteSizeFor(plaintextSha256: string): Promise<number | null>;
  seedProjectedAsset(input: Readonly<{
    plaintextSha256: string;
    protection: LibraryProtection;
    originalGenerationId: string | null;
  }>): Promise<void>;
  /**
   * A saved discovery `images` row plus the `source_image_id` link from the
   * already-seeded local asset to it — what SP6 leaves behind for a
   * provider-collected image, as opposed to a local import. Returns the row id.
   */
  seedSourceImage(input: Readonly<{
    plaintextSha256: string;
    overrides?: Readonly<Record<string, string | number | null>>;
  }>): Promise<number>;
  seedLocalAsset(input: Readonly<{
    plaintextSha256: string;
    bytes?: Uint8Array;
    protectEligible?: boolean;
    withCollectIntent?: boolean;
    importClassification?: 'safe' | 'adult' | 'unknown';
  }>): Promise<void>;
  /**
   * What SP6 leaves behind for one collected image: the durable local original
   * plus one durable `collect` intent, timestamped now. Safe to call again for
   * a deliberate re-import of the same bytes.
   */
  ingest(plaintextSha256: string, bytes: Uint8Array): Promise<void>;
  /** SP7's device-local eviction, reached through the real action. */
  freeLocalSpace(plaintextSha256: string): Promise<unknown>;
  readOriginalBytes(plaintextSha256: string): Promise<Uint8Array | null>;
  originalByteLength(plaintextSha256: string): Promise<number>;
  close(): void;
};

export async function createActionsHarness(
  options: Readonly<{
    /** Pass the same account to two harnesses to get two devices, one library. */
    account?: FakeAccountState;
    deviceId?: string;
    /** Keeps two devices' mutation ids unique inside one shared account. */
    mutationIdPrefix?: string;
    /** Use a real temporary stream directory for file-to-file transfer tests. */
    nodeStreamRoot?: boolean;
  }> = {},
): Promise<ActionsHarness> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);

  const cipher = createLibraryObjectCipher();
  const account = options.account
    ?? createFakeAccountState({ masterKey: TEST_MASTER_KEY, cipher });
  const deviceId = options.deviceId ?? TEST_DEVICE_ID;
  const mutationIdPrefix = options.mutationIdPrefix ?? TEST_MUTATION_ID_PREFIX;
  let sequence = 0;
  const newMutationId = () => {
    sequence += 1;
    return `${mutationIdPrefix}${sequence.toString().padStart(12, '0')}`;
  };
  // Distinct per device (the prefix differs), so two devices sharing one
  // account never mint colliding content-addressed blob ids.
  let generationSequence = 0;
  const newGenerationId = () => {
    generationSequence += 1;
    return `${mutationIdPrefix}gen-${generationSequence.toString().padStart(6, '0')}`;
  };

  const basePort = createFakeLibraryFilePort();
  const port = options.nodeStreamRoot ? withNodeStreamRoot(basePort) : basePort;

  const cloud = createFakeS3Library({ account, filePort: port });
  const decryptor = createJsFileDecryptor(cipher, port);
  const transferCoalescer = createTransferCoalescer<LibraryRoleFetch>();

  const harness: ActionsHarness = {
    native,
    database,
    port,
    files: null as unknown as LibraryFileStore,
    repository: createLibraryRepository(database),
    protection: null as unknown as LibraryProtectionRepository,
    outbox: null as unknown as LibraryActionOutbox,
    cipher,
    decryptor,
    cloud,
    s3: cloud.client,
    reconciliation: cloud.reconciliation,
    session: {
      value: {
        deviceId,
        masterKey: TEST_MASTER_KEY,
        accountScope: TEST_ACCOUNT_SCOPE,
      },
      async current() {
        return harness.session.value;
      },
      signOut() {
        harness.session.value = null;
      },
    },
    now: 10_000,
    clock: () => {
      harness.now += 1;
      return harness.now;
    },
    deviceId,
    newGenerationId,
    accountScope: TEST_ACCOUNT_SCOPE,
    // Accessors, because the collaborators below are wired after this literal.
    get protectDependencies() {
      return {
        repository: harness.repository,
        protection: harness.protection,
        outbox: harness.outbox,
        files: harness.files,
        cipher: harness.cipher,
        cloud: harness.s3,
        reconciliation: harness.reconciliation,
        session: harness.session,
        derived: createFailingLibraryDerivedImages(),
        // C3a: the same projection the sync engine reads, so both seal sites
        // are exercised against one source of provider metadata.
        readSource: (sourceImageId: number | null) =>
          readSourceMetadata(database, sourceImageId),
        clock: () => harness.now,
        newGenerationId: harness.newGenerationId,
      };
    },
    get localDependencies() {
      return {
        repository: harness.repository,
        protection: harness.protection,
        outbox: harness.outbox,
        files: harness.files,
        cipher: harness.cipher,
        decryptor: harness.decryptor,
        cloud: harness.s3,
        session: harness.session,
        transferCoalescer,
        clock: () => harness.now,
      };
    },
    assetIdFor(plaintextSha256) {
      return deriveLibraryAssetId(TEST_MASTER_KEY, plaintextSha256);
    },
    originalUriFor(plaintextSha256) {
      return `file:///data/library/originals/${plaintextSha256}.jpg`;
    },
    async canonicalExtensionFor(plaintextSha256) {
      const asset = await harness.repository.findLocalAsset(plaintextSha256);
      return asset?.canonicalExtension ?? null;
    },
    async byteSizeFor(plaintextSha256) {
      const asset = await harness.repository.findLocalAsset(plaintextSha256);
      return asset?.byteSize ?? null;
    },
    async seedSourceImage({ plaintextSha256, overrides = {} }) {
      const row: Record<string, string | number | null> = {
        provider_key: 'danbooru',
        provider_item_id: `item-${plaintextSha256.slice(0, 8)}`,
        canonical_source_key: `danbooru:item-${plaintextSha256.slice(0, 8)}`,
        perceptual_hash: null,
        md5: null,
        remote_url: `https://example.test/${plaintextSha256.slice(0, 8)}.jpg`,
        sample_url: `https://example.test/${plaintextSha256.slice(0, 8)}-s.jpg`,
        source_url: 'https://example.test/post/1',
        artist_name: 'seeded artist',
        artist_url: 'https://example.test/artist/1',
        width: 10,
        height: 10,
        byte_size: 4,
        extension: 'jpg',
        dominant_color: '#AABBCC',
        content_rating: 'explicit',
        native_rating: 'e',
        is_nsfw: 1,
        is_animated: 0,
        tags_json: JSON.stringify(['maid', 'solo']),
        decision: 'saved',
        presented_at: 1,
        decided_at: 2,
        queue_ordinal: 1,
        decision_ordinal: 1,
        local_uri: 'file:///seeded.jpg',
        download_state: 'ready',
        download_error: null,
        ...overrides,
      };
      const columns = Object.keys(row);
      const { lastInsertRowId } = await database.run(
        `INSERT INTO images (${columns.join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((column) => row[column] ?? null),
      );
      await database.run(
        `UPDATE device_library_assets
           SET source_image_id = ?, origin = 'provider'
           WHERE plaintext_sha256 = ?`,
        [lastInsertRowId, plaintextSha256],
      );
      // The durable `collect` intent carries its own copy of the link, and the
      // sync engine reads that copy rather than the asset row.
      await database.run(
        `UPDATE library_outbox
           SET local_metadata_json = json_set(
                 json_set(local_metadata_json, '$.sourceImageId', ?),
                 '$.origin', 'provider')
           WHERE kind = 'collect' AND asset_id = ?`,
        [lastInsertRowId, deriveLibraryAssetId(TEST_MASTER_KEY, plaintextSha256)],
      );
      return lastInsertRowId;
    },
    async seedProjectedAsset(input) {
      const assetId = harness.assetIdFor(input.plaintextSha256);
      const at = harness.clock();
      // Device must look synced so the next cycle pulls the feed (and then
      // refreshes object refs) rather than rebasing over the missing ids.
      await database.run(
        `INSERT INTO library_sync_state (
           account_scope, change_cursor, min_base_cursor, latest_revision,
           resync_pending, last_synced_at, updated_at
         ) VALUES (?, ?, 0, ?, 0, ?, ?)
         ON CONFLICT(account_scope) DO UPDATE SET
           change_cursor = excluded.change_cursor,
           latest_revision = excluded.latest_revision,
           resync_pending = 0,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
        [
          TEST_ACCOUNT_SCOPE,
          Math.max(0, harness.cloud.latestRevision - 1),
          harness.cloud.latestRevision,
          at,
          at,
        ],
      );
      await database.run(
        `INSERT INTO library_account_assets (
           account_scope, asset_id, plaintext_sha256, device_id, enrolled_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_scope, asset_id) DO NOTHING`,
        [
          TEST_ACCOUNT_SCOPE,
          assetId,
          input.plaintextSha256,
          deviceId,
          at,
          at,
        ],
      );
      await database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width, height,
           origin, source_image_id, local_original_uri, residency, protect_eligible,
           missing_original_since, created_at, updated_at
         ) VALUES (?, 'jpeg', 'jpg', 4, 10, 10, 'import', NULL, NULL,
           'cloud-only', 1, NULL, ?, ?)
         ON CONFLICT(plaintext_sha256) DO NOTHING`,
        [input.plaintextSha256, at, at],
      );
      await harness.protection.upsertProtection({
        accountScope: TEST_ACCOUNT_SCOPE,
        assetId,
        plaintextSha256: input.plaintextSha256,
        protection: input.protection,
        lifecycle: 'active',
        generation: 1,
        revision: Math.max(1, harness.cloud.latestRevision - 1),
        originalGenerationId: input.originalGenerationId,
        originalCiphertextBytes: input.originalGenerationId === null
          ? null
          : ORIGINAL_BYTES,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        failureCategory: null,
        trashedAt: null,
      });
    },
    async seedLocalAsset({
      plaintextSha256,
      bytes = Uint8Array.from([1, 2, 3, 4]),
      protectEligible = true,
      withCollectIntent = true,
      importClassification = 'unknown',
    }) {
      const uri = harness.originalUriFor(plaintextSha256);
      port.files.set(uri, Uint8Array.from(bytes));
      // `createdAt` is reused as the seeded intent's `collectedAt` below,
      // because that is what the real ingest does: `library-ingest.ts` writes
      // the asset row's `createdAt` into the durable collect intent's
      // `collectedAt`. Seeding them independently would make the two seal
      // sites disagree on `collectedAt` for reasons no device can reproduce.
      const createdAt = harness.clock();
      await database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width, height,
           origin, source_image_id, local_original_uri, residency, protect_eligible,
           missing_original_since, import_classification, created_at, updated_at
         ) VALUES (?, 'jpeg', 'jpg', ?, 10, 10, 'import', NULL, ?,
           'local-original', ?, NULL, ?, ?, ?)`,
        [
          plaintextSha256,
          bytes.byteLength,
          uri,
          protectEligible ? 1 : 0,
          importClassification,
          createdAt,
          harness.clock(),
        ],
      );
      const assetId = deriveLibraryAssetId(TEST_MASTER_KEY, plaintextSha256);
      await database.run(
        `INSERT INTO library_account_assets (
           account_scope, asset_id, plaintext_sha256, device_id, enrolled_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [TEST_ACCOUNT_SCOPE, assetId, plaintextSha256, deviceId, 1, 1],
      );
      if (!withCollectIntent) return;
      await database.run(
        `INSERT INTO library_outbox (
           mutation_id, account_scope, device_id, asset_id, kind, base_revision,
           observed_generation, state, attempt_count, next_attempt_at,
           last_error_code, local_metadata_json, encrypted_payload,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'collect', NULL, NULL, 'pending', 0, NULL, NULL,
           ?, NULL, ?, ?)`,
        [
          newMutationId(),
          TEST_ACCOUNT_SCOPE,
          deviceId,
          assetId,
          JSON.stringify({
            assetId,
            plaintextSha256,
            format: 'jpeg',
            byteSize: bytes.byteLength,
            width: 10,
            height: 10,
            origin: 'import',
            sourceImageId: null,
            collectedAt: createdAt,
            importClassification,
          }),
          1,
          1,
        ],
      );
    },
    async ingest(plaintextSha256, bytes) {
      const uri = harness.originalUriFor(plaintextSha256);
      port.files.set(uri, Uint8Array.from(bytes));
      const at = harness.clock();
      await database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width, height,
           origin, source_image_id, local_original_uri, residency, protect_eligible,
           missing_original_since, created_at, updated_at
         ) VALUES (?, 'jpeg', 'jpg', ?, 10, 10, 'import', NULL, ?,
           'local-original', 1, NULL, ?, ?)
         ON CONFLICT(plaintext_sha256) DO UPDATE SET
           local_original_uri = excluded.local_original_uri,
           residency = 'local-original',
           missing_original_since = NULL,
           updated_at = excluded.updated_at`,
        [plaintextSha256, bytes.byteLength, uri, at, at],
      );
      const assetId = harness.assetIdFor(plaintextSha256);
      await database.run(
        `INSERT INTO library_account_assets (
           account_scope, asset_id, plaintext_sha256, device_id, enrolled_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [TEST_ACCOUNT_SCOPE, assetId, plaintextSha256, deviceId, at, at],
      );
      // `created_at` is now, which is what makes a re-import after a learned
      // purge distinguishable from a stale intent queued before it.
      await database.run(
        `INSERT INTO library_outbox (
           mutation_id, account_scope, device_id, asset_id, kind, base_revision,
           observed_generation, state, attempt_count, next_attempt_at,
           last_error_code, local_metadata_json, encrypted_payload,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'collect', NULL, NULL, 'pending', 0, NULL, NULL,
           ?, NULL, ?, ?)
         ON CONFLICT(account_scope, kind, asset_id) DO NOTHING`,
        [
          newMutationId(),
          TEST_ACCOUNT_SCOPE,
          deviceId,
          assetId,
          JSON.stringify({
            assetId,
            plaintextSha256,
            format: 'jpeg',
            byteSize: bytes.byteLength,
            width: 10,
            height: 10,
            origin: 'import',
            sourceImageId: null,
            collectedAt: at,
          }),
          at,
          at,
        ],
      );
    },
    async freeLocalSpace(plaintextSha256) {
      return await createLibraryLocalActions(harness.localDependencies)
        .freeDeviceSpace(plaintextSha256);
    },
    async readOriginalBytes(plaintextSha256) {
      const row = await database.getFirst<{ local_original_uri: string | null }>(
        `SELECT local_original_uri FROM device_library_assets
          WHERE plaintext_sha256 = ?`,
        [plaintextSha256],
      );
      const uri = row?.local_original_uri ?? null;
      return uri === null ? null : await port.readBytes(uri);
    },
    async originalByteLength(plaintextSha256) {
      const bytes = await harness.readOriginalBytes(plaintextSha256);
      if (bytes === null) {
        throw new Error(`No local original for ${plaintextSha256}.`);
      }
      return bytes.byteLength;
    },
    close() {
      native.close();
    },
  };

  harness.files = createLibraryFileStore({
    port,
    clock: () => harness.now,
  });
  harness.protection = createLibraryProtectionRepository({
    database,
    clock: () => harness.now,
  });
  harness.outbox = createLibraryActionOutbox({
    database,
    newMutationId,
    clock: () => harness.now,
  });
  return harness;
}
