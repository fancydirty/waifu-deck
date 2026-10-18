import type { S3TransferProgress } from '@/features/byos/s3-transport';
import {
  CloudStoreError,
  CloudStoreLocalWriteError,
  toLibraryCloudErrorFromStore,
  type CloudGetProgress,
  type CloudObjectStore,
} from '@/features/cloud-store/cloud-object-store';

import {
  attachAssetStateKey,
  encodeAssetState,
  type LibraryAssetStateRecord,
} from './library-asset-state-codec';
import { LibraryCloudError } from './library-cloud-errors';
import {
  buildNextRecord,
  groupConsecutiveByAsset,
  rebaseWithinGroup,
  toNarrowAsset,
  type DecideLibraryMutationFn,
  type S3LibraryBlobStagingPort,
  type LibraryCloudClient,
  type S3LibraryPendingMutation,
  type S3LibraryRemoteMutationResult,
} from './library-cloud-client-s3';
import { encodeNoteName, nextMutationId, writerTag } from './library-note-name';
import { NOTE_ETAG, type AppendLibraryReconciliationPort } from './library-reconciliation-append';
import type { LibraryTransferProgressStore } from './library-transfer-progress';

/**
 * Board #12 protocol v2 append-only cloud client (spec §3.3), implementing
 * the same `S3LibraryCloudClient` shape as `createS3LibraryCloudClient` so
 * the sync engine above it needs no changes to run on WebDAV/OneDrive/Drive.
 *
 * The cloud never overwrites: every accepted change to an asset becomes a
 * brand-new immutable note named `state/<assetId>.<mutationId>.<writer>.json`
 * (`library-note-name.ts`), and the greatest `mutationId` per asset wins
 * (pure lexicographic ULID ordering). There is therefore no conditional
 * write of any kind here, and consequently no `resync_required` outcome —
 * that rejection reason exists only for the S3 CAS path's precondition
 * failures, which this client has no equivalent of.
 *
 * `decide`/`buildNextRecord`/`groupConsecutiveByAsset`/`rebaseWithinGroup`/
 * `toNarrowAsset` are reused unmodified from the S3 client: the decision
 * table and per-group record-building are backend-agnostic, only how the
 * resulting record reaches the cloud differs.
 */
export type CreateAppendLibraryCloudClientOptions = Readonly<{
  store: Pick<CloudObjectStore, 'put' | 'putFromFile' | 'get' | 'getToFile' | 'delete'>;
  reconciliation: Pick<AppendLibraryReconciliationPort, 'getAssetHead' | 'remember'>;
  decide: DecideLibraryMutationFn;
  /** This device's id; reduced to its note-safe 8-char tag via `writerTag`. */
  writer: string;
  now?: () => string;
  /** Millisecond clock for minting mutationIds; defaults to `Date.now`. */
  clock?: () => number;
  /** ULID tail randomness; injectable for deterministic tests. */
  random?: () => Uint8Array;
  /** When present, blobs stream from a staged temp file via `putFromFile`. */
  blobStaging?: S3LibraryBlobStagingPort;
  transferProgress?: LibraryTransferProgressStore;
}>;

const CONTENT_JSON = 'application/json';
const CONTENT_BLOB = 'application/octet-stream';

/**
 * The note-name codec (`nextMutationId`/`encodeNoteName`) threw on a head this
 * device cannot mint a successor for — a clock past the ULID ceiling, or a
 * head note whose own id is already the maximal ULID. That is corrupt remote
 * state for ONE asset, not a transport failure, so `submitMutations` catches
 * it and rejects only that asset's group (`corrupt_remote_state`) instead of
 * letting the throw abort every group and make the engine replay the whole
 * batch forever. Internal to this module: it never escapes `submitMutations`.
 */
class PoisonedHeadError extends Error {
  constructor(readonly cause: unknown) {
    super(
      `append client: head mutationId cannot be minted above: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PoisonedHeadError';
    Object.setPrototypeOf(this, PoisonedHeadError.prototype);
  }
}

export function createAppendLibraryCloudClient(
  options: CreateAppendLibraryCloudClientOptions,
): LibraryCloudClient {
  const { store, reconciliation, decide } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const clock = options.clock ?? Date.now;
  const mine = writerTag(options.writer);
  if (mine === '') {
    // A writer with no name-safe characters would make `encodeNoteName` throw
    // on every write (it refuses to emit a name it cannot parse back). Fail
    // once here, at construction, rather than on the first mutation deep inside
    // a batch.
    throw new Error(
      `createAppendLibraryCloudClient: writer id has no name-safe characters: ${JSON.stringify(options.writer)}`,
    );
  }
  /** This device's own most-recently-written note name per asset, so the next write knows what to delete. */
  const lastMine = new Map<string, string>();
  /** Greatest mutationId observed per asset this session, seeding `nextMutationId`'s monotonic rule. */
  const greatestSeen = new Map<string, string>();

  /** Bridge a store error to the engine's category-bearing `LibraryCloudError`; anything else passes through. Callers `throw` the result explicitly. */
  const toCloudError = (error: unknown): unknown => {
    if (error instanceof CloudStoreError) return toLibraryCloudErrorFromStore(error);
    if (error instanceof CloudStoreLocalWriteError) {
      return new LibraryCloudError(0, 'store_local_write', 'local_space', error.message, true);
    }
    return error;
  };

  async function writeBlob(
    generationId: string,
    bytes: Uint8Array,
    onProgress?: (progress: S3TransferProgress) => void,
  ): Promise<void> {
    const path = `blobs/${generationId}`;
    try {
      if (options.blobStaging === undefined) {
        await store.put(path, bytes, CONTENT_BLOB);
        return;
      }
      const fileUri = options.blobStaging.resolveTemp(`blob-${generationId}`);
      await options.blobStaging.writeBytes(fileUri, bytes);
      try {
        await store.putFromFile(
          path,
          fileUri,
          CONTENT_BLOB,
          onProgress === undefined ? undefined : (sent) => onProgress({ sent, total: bytes.byteLength }),
        );
      } finally {
        // Best-effort: a leftover temp file is a local cleanup miss, not a
        // correctness problem — the blob itself is already durable.
        await options.blobStaging.delete(fileUri).catch(() => {});
      }
    } catch (error) {
      throw toCloudError(error);
    }
  }

  function noteSeen(assetId: string, mutationId: string): void {
    const current = greatestSeen.get(assetId);
    if (current === undefined || current < mutationId) greatestSeen.set(assetId, mutationId);
  }

  async function processGroup(
    group: readonly S3LibraryPendingMutation[],
  ): Promise<S3LibraryRemoteMutationResult[]> {
    // Step 1: blobs durable before the note that names them (mirrors the S3
    // client's own ordering), for every mutation in the group.
    for (const mutation of group) {
      if (mutation.newBlob !== null) await writeBlob(mutation.newBlob.generationId, mutation.newBlob.bytes);
    }

    // `groupConsecutiveByAsset` never yields an empty group.
    const assetId = group[0]!.assetId;
    const head = await reconciliation.getAssetHead(assetId);
    let record: LibraryAssetStateRecord | null = head?.record ?? null;
    // Seed the monotonic rule from the head note's NAME (spec §3.1: the name is
    // the ordering), never the record body's lastMutationId — a foreign writer
    // may leave that null or behind the name, which would let this device mint
    // a note that sorts UNDER the head it just read and silently lose the write.
    if (head !== null) noteSeen(assetId, head.mutationId);

    let anyApplied = false;
    const results: S3LibraryRemoteMutationResult[] = [];
    for (const [index, mutation] of group.entries()) {
      const decided = index === 0 ? mutation : rebaseWithinGroup(mutation, record);
      const decision = decide(toNarrowAsset(record), decided, 0);
      if (decision.outcome !== 'applied') {
        results.push({
          mutationId: mutation.mutationId,
          assetId,
          kind: mutation.kind,
          outcome: decision.outcome,
          reason: decision.outcome === 'rejected' ? decision.reason : null,
          revision: record?.revision ?? null,
          asset: record,
        });
        continue;
      }
      record = buildNextRecord(record, decided, decision, now);
      anyApplied = true;
      results.push({
        mutationId: mutation.mutationId,
        assetId,
        kind: mutation.kind,
        outcome: 'applied',
        reason: null,
        revision: record.revision,
        asset: record,
      });
    }
    if (!anyApplied || record === null) return results;

    // One note pays for the whole group, however many mutations it applied.
    // A codec throw here (a head this device cannot mint above) is corrupt
    // remote state for THIS asset, not a transport failure: wrap ONLY the two
    // codec calls so submitMutations can isolate this group's mutations as
    // `corrupt_remote_state` and let the rest of the batch proceed.
    let mutationId: string;
    let name: string;
    try {
      mutationId = nextMutationId(greatestSeen.get(assetId) ?? null, { now: clock, random: options.random });
      name = encodeNoteName({ assetId, mutationId, writer: mine });
    } catch (error) {
      throw new PoisonedHeadError(error);
    }
    // `buildNextRecord` stamped the CALLER's mutation id; overwrite with this
    // note's own freshly-minted ULID so a relaunch can seed the monotonic
    // rule straight from the head it reads back.
    const written: LibraryAssetStateRecord = attachAssetStateKey(
      { ...record, lastMutationId: mutationId },
      `state/${name}`,
    );
    try {
      await store.put(`state/${name}`, encodeAssetState(written), CONTENT_JSON);
    } catch (error) {
      throw toCloudError(error);
    }
    noteSeen(assetId, mutationId);
    try {
      // The ETag argument is inert here (the port stores its own
      // `note:unlisted` marker instead); it only satisfies the shared
      // `LibraryReconciliationPort` signature v1's CAS writer needs.
      await reconciliation.remember(`state/${name}`, NOTE_ETAG, written);
    } catch {
      // Local bookkeeping only: the note is already durable in the bucket, so
      // the mutation is applied regardless. If the durable index write is what
      // failed, remember() has still cached the note (its `finally`), so
      // heads() stays truthful — and for that same reason the missing index
      // row does NOT heal in this process: discoverChanges() only GETs names
      // it has not cached. It heals at the next process start instead (prewarm
      // loads an index without the row, the listing reports a miss, one GET
      // re-indexes it), unless this device's next write on the asset has
      // deleted the note by then, in which case there is nothing to heal.
    }

    const previous = lastMine.get(assetId);
    lastMine.set(assetId, name);
    if (previous !== undefined && previous !== name) {
      // Best-effort: append-only means a leftover old note is harmless, never
      // a correctness bug, so a failed delete here is swallowed rather than
      // surfaced.
      try {
        await store.delete(`state/${previous}`);
      } catch {
        // Leftover is harmless; the reconciliation port's own sweep retries.
      }
    }

    // Only the LAST applied member is rewritten to the note's final record
    // (carrying the note's own ULID as lastMutationId and its `state/<name>`
    // authority key). Earlier applied members in the same group keep the
    // intermediate record `buildNextRecord` produced for them (with no note
    // `stateKey`), so `projectMutationResult` in `library-sync-engine.ts` can
    // distinguish the one authoritative note from intermediate group steps
    // (N6-A3 spec §4.3: "Intermediate results from a grouped append write are
    // not independently authoritative notes").
    for (let i = results.length - 1; i >= 0; i -= 1) {
      if (results[i]!.outcome === 'applied') {
        results[i] = { ...results[i]!, asset: written };
        break;
      }
    }
    return results;
  }

  return {
    async submitMutations({ mutations }) {
      const results: S3LibraryRemoteMutationResult[] = [];
      for (const group of groupConsecutiveByAsset(mutations)) {
        try {
          results.push(...(await processGroup(group)));
        } catch (error) {
          if (!(error instanceof PoisonedHeadError)) throw error;
          // A head this device cannot mint above is corrupt remote state for
          // THIS asset only; reject its whole group and let the rest of the
          // batch proceed, instead of letting the throw abort every group and
          // make the engine treat the batch as offline and replay it forever.
          const assetId = group[0]!.assetId;
          for (const mutation of group) {
            results.push({
              mutationId: mutation.mutationId,
              assetId,
              kind: mutation.kind,
              outcome: 'rejected',
              reason: 'corrupt_remote_state',
              revision: null,
              asset: null,
            });
          }
        }
      }
      return { cursor: 0, minBaseCursor: 0, results };
    },

    async getObject(generationId) {
      const path = `blobs/${generationId}`;
      // P12-B (spec §4 补裁): the ring is "in flight" from the first request —
      // indeterminate until the adapter reports a length, and left
      // indeterminate by an adapter that never reports one. Either way the
      // tile shows movement without a number it cannot back up.
      options.transferProgress?.set(generationId, { sent: 0, total: null });
      try {
        return await store.get(path, (progress) => {
          options.transferProgress?.set(generationId, progress);
        });
      } catch (error) {
        throw toCloudError(error);
      } finally {
        // Arrived, missing, or failed — nothing is in flight any more.
        options.transferProgress?.clear(generationId);
      }
    },
    async getObjectToFile(generationId, fileUri) {
      const path = `blobs/${generationId}`;
      options.transferProgress?.set(generationId, { sent: 0, total: null });
      try {
        const onProgress = options.transferProgress === undefined
          ? undefined
          : (progress: CloudGetProgress) => options.transferProgress!.set(generationId, progress);
        if (store.getToFile !== undefined) {
          const result = await store.getToFile(path, fileUri, onProgress);
          return result === null ? null : { etag: '' };
        }
        const result = await store.get(path, onProgress);
        if (result === null) return null;
        if (options.blobStaging === undefined) {
          throw new Error('append getObjectToFile fallback requires a file port');
        }
        try {
          await options.blobStaging.writeBytes(fileUri, result);
        } catch (error) {
          throw new LibraryCloudError(
            0,
            's3_local_write',
            'local_space',
            error instanceof Error ? error.message : String(error),
            true,
          );
        }
        return { etag: '' };
      } catch (error) {
        if (error instanceof LibraryCloudError) throw error;
        throw toCloudError(error);
      } finally {
        options.transferProgress?.clear(generationId);
      }
    },

    putBlob: writeBlob,
    async putBlobFromFile(
      generationId,
      fileUri,
      fileOptions,
    ) {
      const path = `blobs/${generationId}`;
      try {
        await store.putFromFile(
          path,
          fileUri,
          CONTENT_BLOB,
          fileOptions.onProgress === undefined
            ? undefined
            : (sent) => fileOptions.onProgress!({ sent, total: fileOptions.byteLength }),
        );
      } catch (error) {
        throw toCloudError(error);
      }
    },
  };
}
