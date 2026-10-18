import type {
  LibraryAssetOrigin,
  LibraryCanonicalExtension,
  LibraryImageFormat,
  LibraryImportClassification,
} from '@/features/library/library-types';
import type { ContentRating, ImageProviderKey } from '@/features/waifu/types';

export type LibraryLifecycle = 'active' | 'trash' | 'purged';

export type LibraryProtection =
  | 'unprotected'
  | 'pending'
  | 'protected'
  | 'failed';

export type LibraryObjectRole = 'thumbnail' | 'preview' | 'original';

/** Design § Error And Retry Policy: user-action categories, not HTTP codes. */
export type LibraryFailureCategory =
  | 'offline'
  | 'local_space'
  | 'auth_attention'
  | 'unsupported_image'
  | 'retryable_transfer'
  | 'integrity'
  | 'stale_client'
  /**
   * Board #12 (spec §4): the cloud drive is full. A product state the user must
   * act on (clear space, upgrade), so it halts exactly like `auth_attention` —
   * retrying costs a request and cannot succeed.
   */
  | 'quota_full'
  | 'object_missing';

export type LibraryActionKind =
  | 'protect'
  | 'download'
  | 'stop-protection'
  | 'remove';

export type LibraryActionResult =
  | Readonly<{ status: 'applied' }>
  | Readonly<{ status: 'noop'; reason: 'already-satisfied' | 'not-applicable' }>
  | Readonly<{ status: 'queued'; category: LibraryFailureCategory }>
  | Readonly<{ status: 'blocked'; category: LibraryFailureCategory }>;

export type LibraryBatchKind =
  | 'protect-all'
  | 'download-all'
  | 'empty-trash';
export type LibraryBatchState = 'running' | 'paused' | 'completed';
export type LibraryBatchItemState = 'pending' | 'running' | 'done' | 'failed';

export type LibraryBatchFailure = Readonly<{
  plaintextSha256: string;
  category: LibraryFailureCategory;
}>;

export type LibraryBatchProgress = Readonly<{
  batchId: string;
  kind: LibraryBatchKind;
  state: LibraryBatchState;
  total: number;
  done: number;
  failed: number;
  pending: number;
  pausedCategory: LibraryFailureCategory | null;
  failures: readonly LibraryBatchFailure[];
  /**
   * Set only when `start` / `startPaused` refuse because another unfinished
   * batch already exists for the **current session `accountScope`**
   * (`running` or `paused`, including auto quota/auth pauses). Absent on
   * ordinary progress reads. Unfinished batches for other account scopes
   * do not set this flag and do not block start.
   */
  startRefused?: 'busy';
}>;

/** Local projection of the account-layer `AccountAsset`. */
export type LibraryProtectionRecord = Readonly<{
  accountScope: string;
  assetId: string;
  plaintextSha256: string;
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
  generation: number;
  revision: number | null;
  originalGenerationId: string | null;
  originalCiphertextBytes: number | null;
  /** Authoritative derived references. Only this device's own protect commit or `GET /library/index` may set them; a feed row never can. */
  thumbnailGenerationId: string | null;
  previewGenerationId: string | null;
  /** Highest `revision` whose object references were read from the index. Bounds the sweep so a legitimately derived-less asset is not re-swept forever. */
  objectRefsRevision: number | null;
  /**
   * N6-A3 (spec §4.3): remote state authority identity (`state/<noteName>` on
   * append backends or `s3:<revision>` on S3 CAS) of the last applied remote
   * state.
   */
  appliedStateKey?: string | null;
  /** Set only after this device decrypted the committed original and matched its digest. */
  verifiedAt: number | null;
  failureCategory: LibraryFailureCategory | null;
  trashedAt: number | null;
  updatedAt: number;
}>;

/**
 * Why a render source is being resolved. `full` is the intent for a
 * full-quality view, export, explicit local download, protection changes, or
 * byte verification, and it never returns a thumbnail. `placeholder` is a
 * local-only stand-in for the detail page while its picture loads: this
 * device's thumbnail, never the network, never an original.
 */
export type LibraryRenderIntent = 'grid' | 'detail' | 'full' | 'placeholder';

/** Per-device sidecar for the design `DeviceAsset` fields v9 does not hold. */
export type LibraryDeviceAssetState = Readonly<{
  plaintextSha256: string;
  cachedRoles: readonly LibraryObjectRole[];
  lastVerifiedAt: number | null;
  deviceTrashUri: string | null;
  deviceTrashedAt: number | null;
  /** Non-null after an explicit Photos export for remove-device-data. */
  exportedAt: number | null;
  updatedAt: number;
}>;

/** Payload stored on a non-`collect` `library_outbox` row. */
export type LibraryActionIntent = Readonly<{
  assetId: string;
  plaintextSha256: string;
  /** `restore` / `permanent-delete` are SP9 trash-screen hooks; others are SP7's. */
  kind: 'protect' | 'trash' | 'stop-protection' | 'restore' | 'permanent-delete';
  reservationId: string | null;
  originalGenerationId: string | null;
  originalCiphertextBytes: number | null;
  /**
   * The derived-role generation ids `library-protect-action.ts` uploaded
   * alongside the original, carried so a crash-restart drain can replay the
   * WHOLE `generations` triad instead of only the original. Enqueued after all
   * three blobs are durable, so this never violates blob-durable-before-state.
   * Optional (not `| null` required) so rows written before this field existed
   * still parse: a legacy row has them `undefined` and replays `{ original }`.
   */
  thumbnailGenerationId?: string | null;
  previewGenerationId?: string | null;
  queuedAt: number;
}>;

/**
 * The provider identity and presentation fields a restored asset needs to
 * become an ordinary `StoredImage` on a device that never saw the original
 * discovery item. Mirrors the `images` columns one-for-one, so C3b can insert
 * a row from an envelope without inventing anything.
 */
export type LibraryRestorableSource = Readonly<{
  providerKey: ImageProviderKey;
  providerItemId: string;
  canonicalSourceKey: string | null;
  perceptualHash: string | null;
  md5: string | null;
  remoteUrl: string;
  sampleUrl: string | null;
  sourceUrl: string | null;
  artistName: string | null;
  artistUrl: string | null;
  extension: string;
  dominantColor: string;
  contentRating: ContentRating;
  nativeRating: string | null;
  isNsfw: boolean;
  isAnimated: boolean;
  tags: readonly string[];
}>;

/**
 * Plaintext of the account-layer encrypted metadata envelope.
 *
 * C3a mirror (owner ruling 2026-09-09): a restored asset must become an
 * ordinary collection item on the receiving device, so the envelope carries the
 * provider identity and presentation fields a `StoredImage` needs. `version: 2`
 * adds `source`; `version: 3` (N6-A1, spec §4.3) adds `importClassification`
 * (`'safe' | 'adult' | 'unknown'`) at the top level, independent of optional
 * provider `source`. The wire `protocolVersion` is unchanged — this is the
 * payload version inside the sealed envelope. v1/v2 envelopes (or a v3 envelope
 * missing the field) decode with `'unknown'`.
 */
export type LibraryEncryptedMetadata = Readonly<{
  version: 1 | 2 | 3;
  plaintextSha256: string;
  format: LibraryImageFormat;
  canonicalExtension: LibraryCanonicalExtension;
  byteSize: number;
  width: number;
  height: number;
  origin: LibraryAssetOrigin;
  sourceImageId: number | null;
  collectedAt: number;
  /** N6-A1 (spec §4.3): present on `version: 3` envelopes; absent on v1/v2 decodes as `'unknown'`. */
  importClassification?: LibraryImportClassification;
  tags: readonly string[];
  /** Present on `version: 2 | 3` envelopes sealed for a provider asset. */
  source?: LibraryRestorableSource;
}>;

export type LibrarySessionContext = Readonly<{
  deviceId: string;
  masterKey: Uint8Array;
  accountScope: string;
}>;

/** Null means "no usable account on this device"; actions then stay local. */
export type LibrarySessionPort = Readonly<{
  current(): Promise<LibrarySessionContext | null>;
}>;
