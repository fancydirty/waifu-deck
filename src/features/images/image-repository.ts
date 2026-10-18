import type { SqlBindValue, SqlDatabasePort } from '@/db/sql-port';
import {
  candidateContentRating,
  strongerContentRating,
} from '@/features/content/content-taxonomy';
import {
  isImageProviderKey,
  type ContentRating,
  type ImageCandidate,
  type ImageProviderKey,
  type WaifuImage,
} from '@/features/waifu/types';

export type ImageDecision = 'queued' | 'active' | 'dismissed' | 'saved';
export type DownloadState = 'none' | 'pending' | 'ready' | 'failed' | 'mirrored';
/**
 * Board #5: WHY a `failed` download failed. `transient` (network, timeout,
 * stall, 5xx, cancelled, unknown) is re-tried by the resume sweep (cold start
 * and pull-to-refresh — the two triggers the owner kept on 2026-09-18);
 * `source_gone` (404/410 from the source) is shown honestly as 「源站已删除」
 * with no repair affordance — and is never auto-deleted.
 */
export type DownloadErrorKind = 'transient' | 'source_gone';
export type AppliedDecision = 'dismissed' | 'saved';

/**
 * Board #24: the decision a rewind expects to find on its row. A row whose
 * decision or `decided_at` moved on since (a 收藏 delete, a Search re-save)
 * belongs to that later action, and the rewind leaves it alone.
 */
export type RewindExpectation = {
  decision: AppliedDecision;
  decidedAt: number;
};

export type StoredImage = WaifuImage & {
  contentRating: ContentRating;
  nativeRating: string | null;
  decision: ImageDecision;
  presentedAt: number | null;
  decidedAt: number | null;
  queueOrdinal: number;
  decisionOrdinal: number | null;
  localUri: string | null;
  downloadState: DownloadState;
  downloadError: string | null;
  /**
   * Board #5: the classification behind `downloadError`. `null` for a row that
   * never failed and for a `failed` row written before v20 — both the sweep and
   * the UI read `null` exactly like `transient` (never hide what might return).
   */
  downloadErrorKind: DownloadErrorKind | null;
  /**
   * K6-5 C: the {@link LibraryIngestErrorCode} the private-library ingest last
   * threw for this row, or `null`. Orthogonal to `downloadError`, which is
   * about the provider fetch: this row's fetch succeeded and its bytes are on
   * disk — they just never became a library asset. Without it the tile has
   * nothing to show and the save is silently lost.
   */
  libraryError: string | null;
};

export type RestoredDeck = {
  active: StoredImage | null;
  queued: StoredImage[];
};

export type ProviderImageIdentity = {
  providerKey: ImageProviderKey;
  providerItemId: string;
};

export type DownloadAttemptSnapshot = Pick<WaifuImage, 'remoteUrl' | 'extension'>;

type InsertableImage = ImageCandidate & { id?: number };

/**
 * Discovery insert result. The per-provider breakdown exists because the global
 * scalar made a source that contributes 0 forever literally invisible (G3 spec
 * §4 item 2); `inserted` remains the same total the scalar return used to be.
 */
export type InsertCandidatesResult = {
  readonly inserted: number;
  readonly byProvider: Partial<Record<ImageProviderKey, number>>;
};

export type InsertCandidatesOptions = {
  /**
   * Decides the persisted `queue_ordinal` order over the candidates that
   * actually **survived** the identity gate, rather than over the batch that
   * was offered (G3c Task 4 gate catch).
   *
   * Why this exists. Discovery used to order the whole batch first and insert
   * second, so any card the gate suppressed left a hole in an order that had
   * already been decided — and a suppressed card sitting *between* two runs of
   * the same source let those runs join. A deck ordered to a longest run of 2
   * therefore persisted a run of 4. The bound `interleaveWithRunCap`
   * guarantees (spec §2.6) is a property of the sequence it is handed, so the
   * only way for the *persisted* deck to inherit it — which is the form spec
   * §6.3-3 and §6.5 state — is to order the survivors.
   *
   * Contract: a pure, synchronous **permutation** of the list it is given, with
   * the same object identities. It is not a filter and not a factory — a
   * different length, a repeat, or an object that was not handed out means the
   * mapping back to rows cannot be trusted, and the input order (the behaviour
   * every caller had before this option existed) stands.
   *
   * Optional on purpose: every other call site keeps insertion order, so no
   * existing caller or test changes behaviour by a byte.
   */
  readonly orderSurvivors?: (
    survivors: readonly ImageCandidate[],
  ) => readonly ImageCandidate[];
};

export interface ImageRepository {
  insertCandidates(
    candidates: readonly InsertableImage[],
    options?: InsertCandidatesOptions,
  ): Promise<InsertCandidatesResult>;
  saveCandidate(candidate: ImageCandidate, savedAt: number): Promise<StoredImage>;
  /**
   * K2: save a row whose bytes the private library owns (restored from another
   * device). Identity/merge rules match `saveCandidate`; a row that already has
   * this device's own ready collection file keeps it. Writes
   * `download_state='mirrored'`, never `pending`, so the collection sweeper
   * does not fetch it from the provider.
   */
  saveMirroredCandidate(candidate: ImageCandidate, savedAt: number): Promise<StoredImage>;
  restoreDeck(): Promise<RestoredDeck>;
  activateNext(presentedAt: number): Promise<StoredImage | null>;
  /**
   * Make a queued decision target active while putting any stranded active
   * row at the end of the queue. Returns null without changing anything when
   * the target is neither queued nor already active.
   */
  promoteForDecision(imageId: number, presentedAt: number): Promise<StoredImage | null>;
  decide(
    imageId: number,
    decision: AppliedDecision,
    decidedAt: number,
  ): Promise<StoredImage | null>;
  /**
   * Board #24: put a decided row back on the deck as the active card. The row
   * must still hold `expected` (decision and `decided_at`); otherwise nothing
   * changes and the result is `null`. Any other active card is demoted to the
   * queue front. Returns the row as it was BEFORE the rewind.
   */
  rewindDecision(
    imageId: number,
    expected: RewindExpectation,
  ): Promise<StoredImage | null>;
  listCollection(): Promise<StoredImage[]>;
  getById(imageId: number): Promise<StoredImage | null>;
  markDownloadReady(
    imageId: number,
    localUri: string,
    attempt?: DownloadAttemptSnapshot,
    downloadedByteSize?: number,
  ): Promise<boolean>;
  markDownloadFailed(
    imageId: number,
    errorCode: string,
    attempt?: DownloadAttemptSnapshot,
    /** Board #5: defaults to `transient` — the safe reading of an unknown failure. */
    kind?: DownloadErrorKind,
  ): Promise<boolean>;
  markFileMissing(imageId: number, errorCode: string): Promise<boolean>;
  /**
   * K6-5 C: record that the private-library ingest of this row's downloaded
   * file failed, and count the try. `download_state` is untouched — the file
   * is there and the download did succeed. Returns false for an empty code or
   * a row that is not in the collection.
   */
  recordLibraryIngestFailure(imageId: number, errorCode: string): Promise<boolean>;
  /** K6-5 C: the row is in the library now; drop the code and the counter. */
  clearLibraryIngestError(imageId: number): Promise<boolean>;
  /**
   * K2b: explicit user repair for a `mirrored` row whose library bytes are no
   * longer available. Moves it back to `pending` so the ordinary provider
   * download runs. Returns false when the row is not saved+mirrored.
   */
  reclaimMirroredForDownload(imageId: number): Promise<boolean>;
  deleteFromCollection(imageId: number): Promise<StoredImage | null>;
  returnToDiscovery(imageId: number): Promise<StoredImage | null>;
  deleteQueuedCandidates(): Promise<number>;
  /**
   * R8.16-C: remove a single not-yet-presented card from the deck queue by id.
   * Used when its artwork URL failed to prefetch — a dead card is swapped out
   * before it surfaces instead of confronting the user with an error tile.
   */
  dropQueuedCandidate(imageId: number): Promise<StoredImage | null>;
  recentHandledIds(limit?: number): Promise<number[]>;
  recentHandledIdentities(limit?: number): Promise<ProviderImageIdentity[]>;
  resetDismissedHistory(): Promise<number>;
  resetDiscoveryHistory(): Promise<number>;
  deleteAll(): Promise<number>;
}

type ImageRow = {
  id: unknown;
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
  width: unknown;
  height: unknown;
  byte_size: unknown;
  extension: unknown;
  dominant_color: unknown;
  content_rating: unknown;
  native_rating: unknown;
  is_nsfw: unknown;
  is_animated: unknown;
  tags_json: unknown;
  taste_signal: unknown;
  taste_recorded_at: unknown;
  decision: unknown;
  presented_at: unknown;
  decided_at: unknown;
  queue_ordinal: unknown;
  decision_ordinal: unknown;
  local_uri: unknown;
  download_state: unknown;
  download_error: unknown;
  download_error_kind?: unknown;
  library_error: unknown;
};

const IMAGE_COLUMNS = `
  id, provider_key, provider_item_id, canonical_source_key, perceptual_hash,
  md5, remote_url, sample_url, source_url, artist_name, artist_url, width, height,
  byte_size, extension, dominant_color, content_rating, native_rating,
  is_nsfw, is_animated, tags_json, taste_signal, taste_recorded_at,
  decision, presented_at, decided_at, queue_ordinal, decision_ordinal,
  local_uri, download_state, download_error, download_error_kind, library_error
`;

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  )].sort();
}

export function parseTags(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    return normalizeTags(JSON.parse(value));
  } catch {
    return [];
  }
}

function requiredString(value: unknown, column: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid images.${column}`);
  return value;
}

function nullableString(value: unknown, column: string): string | null {
  if (value === null) return null;
  return requiredString(value, column);
}

function requiredNumber(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid images.${column}`);
  }
  return value;
}

function requiredInteger(value: unknown, column: string): number {
  const number = requiredNumber(value, column);
  if (!Number.isInteger(number)) throw new Error(`Invalid images.${column}`);
  return number;
}

function nullableTimestamp(value: unknown, column: string): number | null {
  if (value === null) return null;
  const timestamp = requiredInteger(value, column);
  if (timestamp < 0) throw new Error(`Invalid images.${column}`);
  return timestamp;
}

function nullableDecisionOrdinal(value: unknown): number | null {
  if (value === null) return null;
  const ordinal = requiredInteger(value, 'decision_ordinal');
  if (ordinal <= 0) throw new Error('Invalid images.decision_ordinal');
  return ordinal;
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }
}

export function isStoredContentRating(value: unknown): value is ContentRating {
  return [
    'safe',
    'suggestive',
    'nsfw_unspecified',
    'explicit',
    'unknown',
  ].includes(value as ContentRating);
}

function ratingIsNsfw(rating: ContentRating): boolean {
  return rating !== 'safe';
}

function mapImageRow(row: ImageRow): StoredImage {
  const decisions: ImageDecision[] = ['queued', 'active', 'dismissed', 'saved'];
  const downloadStates: DownloadState[] = ['none', 'pending', 'ready', 'failed', 'mirrored'];
  if (!decisions.includes(row.decision as ImageDecision)) {
    throw new Error('Invalid images.decision');
  }
  if (!downloadStates.includes(row.download_state as DownloadState)) {
    throw new Error('Invalid images.download_state');
  }
  if (row.is_nsfw !== 0 && row.is_nsfw !== 1) {
    throw new Error('Invalid images.is_nsfw');
  }
  if (row.is_animated !== 0 && row.is_animated !== 1) {
    throw new Error('Invalid images.is_animated');
  }
  const tags = parseTags(row.tags_json);
  const contentRating = isStoredContentRating(row.content_rating)
    ? row.content_rating
    : candidateContentRating({
        isNsfw: row.is_nsfw === 1,
        tags,
      });
  const nativeRating = row.native_rating === undefined || row.native_rating === null
    ? null
    : requiredString(row.native_rating, 'native_rating');

  const decision = row.decision as ImageDecision;
  const presentedAt = nullableTimestamp(row.presented_at, 'presented_at');
  const decidedAt = nullableTimestamp(row.decided_at, 'decided_at');
  const queueOrdinal = requiredInteger(row.queue_ordinal, 'queue_ordinal');
  const decisionOrdinal = nullableDecisionOrdinal(row.decision_ordinal);
  const localUri = nullableString(row.local_uri, 'local_uri');
  const downloadState = row.download_state as DownloadState;
  const downloadError = nullableString(row.download_error, 'download_error');
  // Board #5. Tolerant like `library_error`: a hand-written pre-v20 test schema
  // has no such column, and a missing column reads as "unclassified".
  const downloadErrorKindRaw = row.download_error_kind === undefined || row.download_error_kind === null
    ? null
    : requiredString(row.download_error_kind, 'download_error_kind');
  if (
    downloadErrorKindRaw !== null
    && downloadErrorKindRaw !== 'transient'
    && downloadErrorKindRaw !== 'source_gone'
  ) {
    throw new Error('Invalid images.download_error_kind');
  }
  const downloadErrorKind = downloadErrorKindRaw as DownloadErrorKind | null;
  // Tolerant like `native_rating`: a hand-written pre-v19 test schema has no
  // such column, and a missing column is exactly "nothing has failed yet".
  const libraryError = row.library_error === undefined || row.library_error === null
    ? null
    : requiredString(row.library_error, 'library_error');
  const providerKey = requiredString(row.provider_key, 'provider_key');
  if (!isImageProviderKey(providerKey)) {
    throw new Error('Invalid images.provider_key');
  }
  const hasLocalUri = typeof localUri === 'string' && localUri.trim().length > 0;
  const hasDownloadError =
    typeof downloadError === 'string' && downloadError.trim().length > 0;

  const validDiscoveryState =
    decisionOrdinal === null &&
    ((decision === 'queued' && presentedAt === null && decidedAt === null) ||
      (decision === 'active' && presentedAt !== null && decidedAt === null));
  const validHandledState =
    decision === 'dismissed' &&
    presentedAt !== null &&
    decidedAt !== null &&
    decisionOrdinal !== null;
  const validSavedState =
    decision === 'saved' &&
    presentedAt !== null &&
    decidedAt !== null &&
    decisionOrdinal !== null &&
    ((downloadState === 'pending' && localUri === null && downloadError === null) ||
      (downloadState === 'failed' && localUri === null && hasDownloadError) ||
      (downloadState === 'ready' && hasLocalUri && downloadError === null) ||
      (downloadState === 'mirrored' && localUri === null && downloadError === null));
  if (
    (validDiscoveryState || validHandledState) &&
    (downloadState !== 'none' || localUri !== null || downloadError !== null)
  ) {
    throw new Error('Invalid images state');
  }
  if (!validDiscoveryState && !validHandledState && !validSavedState) {
    throw new Error('Invalid images state');
  }
  // Board #5: a classification only ever describes a `failed` row.
  if (downloadErrorKind !== null && downloadState !== 'failed') {
    throw new Error('Invalid images state');
  }

  return {
    id: requiredNumber(row.id, 'id'),
    providerKey,
    providerItemId: requiredString(row.provider_item_id, 'provider_item_id'),
    canonicalSourceKey: nullableString(
      row.canonical_source_key,
      'canonical_source_key',
    ),
    perceptualHash: nullableString(row.perceptual_hash, 'perceptual_hash'),
    md5: nullableString(row.md5, 'md5'),
    remoteUrl: requiredString(row.remote_url, 'remote_url'),
    // R8.18: resolve to a concrete display url — a real sample when the source
    // published one, otherwise the original. Old (pre-v16) rows and
    // sample-less sources both store NULL and fall back here, so every
    // restored card has a usable sampleUrl for the deck to render.
    sampleUrl: nullableString(row.sample_url, 'sample_url') ??
      requiredString(row.remote_url, 'remote_url'),
    sourceUrl: nullableString(row.source_url, 'source_url'),
    artistName: nullableString(row.artist_name, 'artist_name'),
    artistUrl: nullableString(row.artist_url, 'artist_url'),
    width: requiredNumber(row.width, 'width'),
    height: requiredNumber(row.height, 'height'),
    byteSize: requiredNumber(row.byte_size, 'byte_size'),
    extension: requiredString(row.extension, 'extension'),
    dominantColor: requiredString(row.dominant_color, 'dominant_color'),
    contentRating,
    nativeRating,
    isNsfw: row.is_nsfw === 1,
    isAnimated: row.is_animated === 1,
    tags,
    decision,
    presentedAt,
    decidedAt,
    queueOrdinal,
    decisionOrdinal,
    localUri,
    downloadState,
    downloadError,
    downloadErrorKind,
    libraryError,
  };
}

async function loadById(
  database: SqlDatabasePort,
  id: number,
): Promise<StoredImage | null> {
  const row = await database.getFirst<ImageRow>(
    `SELECT ${IMAGE_COLUMNS} FROM images WHERE id = ?`,
    [id],
  );
  return row ? mapImageRow(row) : null;
}

/** A row this call created, with the `queue_ordinal` slot it was allocated. */
type LandedCandidate = {
  readonly id: number;
  readonly candidate: ImageCandidate;
  readonly ordinal: number;
};

/**
 * Re-seat the rows this call created into the order
 * {@link InsertCandidatesOptions.orderSurvivors} asks for.
 *
 * Only the *assignment* moves. The set of ordinal slots is exactly the set the
 * insert loop already allocated — including the slots duplicates consumed — so
 * gap behaviour, the relationship to neighbouring batches, and every other
 * caller's ordering are untouched. What changes is which surviving row sits in
 * which slot, which is the whole of the fix.
 *
 * Deliberately *not* a classify-then-insert restructure. Classifying the whole
 * batch before inserting any of it would break in-batch identity suppression:
 * `images_provider_identity` is the only UNIQUE index, so two candidates in one
 * batch sharing a `canonical_source_key`, `md5`, or `perceptual_hash` under
 * different provider identities would both read as fresh against the database
 * and both be written — silently weakening the G2b gate at the DB layer. Here
 * the loop stays sequential, so the second one still matches the first's
 * just-written row and takes the duplicate branch exactly as before.
 */
async function applySurvivorOrder(
  transaction: SqlDatabasePort,
  landed: readonly LandedCandidate[],
  orderSurvivors: InsertCandidatesOptions['orderSurvivors'],
): Promise<void> {
  // Runs inside the caller's transaction: a THROWING callback would roll back
  // the whole insert, not just the re-seat. The contract below covers bad
  // returns; callers must not pass a throwing callback (discovery's
  // orderBatchForDeck has no throw path).
  if (orderSurvivors === undefined || landed.length < 2) return;

  const slotFor = new Map<ImageCandidate, LandedCandidate>();
  for (const row of landed) slotFor.set(row.candidate, row);
  const ordered = orderSurvivors(landed.map((row) => row.candidate));
  if (ordered.length !== landed.length) return;

  const reseated: LandedCandidate[] = [];
  const seen = new Set<ImageCandidate>();
  for (const candidate of ordered) {
    const row = slotFor.get(candidate);
    // Not a permutation of what we handed out: keep insertion order.
    if (row === undefined || seen.has(candidate)) return;
    seen.add(candidate);
    reseated.push(row);
  }

  for (let index = 0; index < reseated.length; index += 1) {
    const row = reseated[index] as LandedCandidate;
    const ordinal = (landed[index] as LandedCandidate).ordinal;
    if (row.ordinal === ordinal) continue;
    await transaction.run(
      'UPDATE images SET queue_ordinal = ? WHERE id = ?',
      [ordinal, row.id],
    );
  }
}

export function createImageRepository(database: SqlDatabasePort): ImageRepository {
  type SaveInitialState = 'pending' | 'mirrored';

  async function saveCandidateAs(
    candidate: ImageCandidate,
    savedAt: number,
    initialState: SaveInitialState,
  ): Promise<StoredImage> {
    assertTimestamp(savedAt, 'savedAt');
    return database.transaction(async (transaction) => {
      const matches = await transaction.getAll<{
        id: number;
        decision: ImageDecision;
        download_state: DownloadState;
        local_uri: string | null;
        content_rating: ContentRating | null;
        native_rating: string | null;
        is_nsfw: number;
      }>(
        `SELECT id, decision, download_state, local_uri, content_rating,
                native_rating, is_nsfw
         FROM images
         WHERE (provider_key = ? AND provider_item_id = ?)
            OR (? IS NOT NULL AND canonical_source_key = ?)
            OR (? IS NOT NULL AND perceptual_hash = ?)
            OR (? IS NOT NULL AND md5 = ?)
         ORDER BY CASE
           WHEN provider_key = ? AND provider_item_id = ? THEN 0
           WHEN ? IS NOT NULL AND canonical_source_key = ? THEN 1
           WHEN ? IS NOT NULL AND md5 = ? THEN 2
           ELSE 3
         END, id`,
        [
          candidate.providerKey,
          candidate.providerItemId,
          candidate.canonicalSourceKey,
          candidate.canonicalSourceKey,
          candidate.perceptualHash,
          candidate.perceptualHash,
          candidate.md5,
          candidate.md5,
          candidate.providerKey,
          candidate.providerItemId,
          candidate.canonicalSourceKey,
          candidate.canonicalSourceKey,
          candidate.md5,
          candidate.md5,
        ],
      );
      if (matches.length > 1) {
        throw new Error('Candidate identity matches multiple image rows');
      }
      const existing = matches[0];
      const candidateRating = candidateContentRating(candidate);
      const existingRating = existing && isStoredContentRating(
        existing.content_rating,
      )
        ? existing.content_rating
        : existing?.is_nsfw === 1
          ? 'nsfw_unspecified'
          : 'safe';
      const persistedRating = existing
        ? strongerContentRating(existingRating, candidateRating)
        : candidateRating;
      const persistedNativeRating = existing?.native_rating ??
        candidate.nativeRating ?? null;
      const metadataParams: SqlBindValue[] = [
        candidate.canonicalSourceKey,
        candidate.perceptualHash,
        candidate.md5,
        candidate.remoteUrl,
        candidate.sampleUrl ?? null,
        candidate.sourceUrl,
        candidate.artistName,
        candidate.artistUrl,
        candidate.width,
        candidate.height,
        candidate.byteSize,
        candidate.extension,
        candidate.dominantColor,
        persistedRating,
        persistedNativeRating,
        ratingIsNsfw(persistedRating) ? 1 : 0,
        candidate.isAnimated ? 1 : 0,
        JSON.stringify(normalizeTags(candidate.tags)),
      ];

      if (existing?.decision === 'saved') {
        const hasReadyLocalFile =
          existing.download_state === 'ready' &&
          typeof existing.local_uri === 'string' &&
          existing.local_uri.trim().length > 0;
        // K2b: a mirrored row's bytes are the library's; a re-collect of the
        // same identity merges metadata but must not hand it back to the
        // provider download path.
        const keepsBytes = hasReadyLocalFile || existing.download_state === 'mirrored';
        if (keepsBytes) {
          await transaction.run(
            `UPDATE images
             SET canonical_source_key = COALESCE(canonical_source_key, ?),
                 perceptual_hash = COALESCE(perceptual_hash, ?),
                 md5 = COALESCE(md5, ?),
                 source_url = COALESCE(source_url, ?),
                 artist_name = COALESCE(artist_name, ?),
                 artist_url = COALESCE(artist_url, ?),
                 content_rating = ?,
                 native_rating = COALESCE(native_rating, ?),
                 is_nsfw = CASE
                   WHEN is_nsfw = 1 OR ? = 1 THEN 1 ELSE 0
                 END
             WHERE id = ?`,
            [
              candidate.canonicalSourceKey,
              candidate.perceptualHash,
              candidate.md5,
              candidate.sourceUrl,
              candidate.artistName,
              candidate.artistUrl,
              persistedRating,
              persistedNativeRating,
              ratingIsNsfw(persistedRating) ? 1 : 0,
              existing.id,
            ],
          );
        } else {
          await transaction.run(
            `UPDATE images
             SET canonical_source_key = COALESCE(canonical_source_key, ?),
                 perceptual_hash = COALESCE(perceptual_hash, ?),
                 md5 = COALESCE(md5, ?),
                 remote_url = ?, sample_url = COALESCE(?, sample_url),
                 source_url = COALESCE(?, source_url),
                 artist_name = COALESCE(?, artist_name),
                 artist_url = COALESCE(?, artist_url),
                 width = ?, height = ?, byte_size = ?, extension = ?,
                 dominant_color = ?, content_rating = ?, native_rating = ?,
                 is_nsfw = CASE
                   WHEN is_nsfw = 1 OR ? = 1 THEN 1 ELSE 0
                 END,
                 is_animated = ?, tags_json = ?, download_state = ?,
                 local_uri = NULL, download_error = NULL, download_error_kind = NULL
             WHERE id = ?`,
            [...metadataParams, initialState, existing.id],
          );
        }
        const saved = await loadById(transaction, existing.id);
        if (!saved) throw new Error('Saved image disappeared during transaction');
        return saved;
      }

      const ordinalRow = await transaction.getFirst<{
        next_queue_ordinal: number;
        next_decision_ordinal: number;
      }>(
        `SELECT COALESCE(MAX(queue_ordinal), 0) + 1 AS next_queue_ordinal,
                COALESCE(MAX(decision_ordinal), 0) + 1 AS next_decision_ordinal
         FROM images`,
      );
      const nextQueueOrdinal = ordinalRow?.next_queue_ordinal ?? 1;
      const nextDecisionOrdinal = ordinalRow?.next_decision_ordinal ?? 1;

      if (existing) {
        await transaction.run(
          `UPDATE images
           SET canonical_source_key = COALESCE(canonical_source_key, ?),
               perceptual_hash = COALESCE(perceptual_hash, ?),
               md5 = COALESCE(md5, ?),
               remote_url = ?, sample_url = COALESCE(?, sample_url),
               source_url = COALESCE(?, source_url),
               artist_name = COALESCE(?, artist_name),
               artist_url = COALESCE(?, artist_url),
               width = ?, height = ?, byte_size = ?, extension = ?,
               dominant_color = ?, content_rating = ?, native_rating = ?,
               is_nsfw = CASE
                 WHEN is_nsfw = 1 OR ? = 1 THEN 1 ELSE 0
               END,
               is_animated = ?, tags_json = ?,
               decision = 'saved', presented_at = COALESCE(presented_at, ?),
               decided_at = ?, decision_ordinal = ?, download_state = ?,
               taste_signal = 'saved', taste_recorded_at = ?,
               local_uri = NULL, download_error = NULL, download_error_kind = NULL
           WHERE id = ?`,
          [
            ...metadataParams,
            savedAt,
            savedAt,
            nextDecisionOrdinal,
            initialState,
            savedAt,
            existing.id,
          ],
        );
        const saved = await loadById(transaction, existing.id);
        if (!saved) throw new Error('Saved image disappeared during transaction');
        return saved;
      }

      const result = await transaction.run(
        `INSERT INTO images (
           provider_key, provider_item_id, canonical_source_key, perceptual_hash,
           md5, remote_url, sample_url, source_url, artist_name, artist_url, width, height,
           byte_size, extension, dominant_color, content_rating,
           native_rating, is_nsfw, is_animated, tags_json,
           decision, presented_at, decided_at, queue_ordinal, decision_ordinal,
           taste_signal, taste_recorded_at, local_uri, download_state,
           download_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   'saved', ?, ?, ?, ?, 'saved', ?, NULL, ?, NULL)`,
        [
          candidate.providerKey,
          candidate.providerItemId,
          ...metadataParams,
          savedAt,
          savedAt,
          nextQueueOrdinal,
          nextDecisionOrdinal,
          savedAt,
          initialState,
        ],
      );
      const saved = await loadById(transaction, result.lastInsertRowId);
      if (!saved) throw new Error('Saved image was not created');
      return saved;
    });
  }

  return {
    async insertCandidates(candidates, options) {
      // R8.16-B: the batch is committed in bounded-size transactions instead
      // of one giant one. Every SQL statement funnels through a single FIFO
      // scheduler (see createFifoSqlScheduler) so that an
      // exclusive-transaction ordinal read-modify-write can never interleave —
      // chunking keeps that single-writer guarantee while shrinking the
      // longest uninterrupted hold on the queue. A user decision (two short
      // statements) that lands while a ~100-post refill insert is running now
      // waits for at most one small chunk, not the whole batch. The FIFO's
      // `tail.then(operation)` chain makes each returned chunk transaction
      // hand the queue to whichever operation queued next.
      const CHUNK_SIZE = 32;
      const chunks: InsertableImage[][] = [];
      for (let index = 0; index < candidates.length; index += CHUNK_SIZE) {
        chunks.push(candidates.slice(index, index + CHUNK_SIZE));
      }
      if (chunks.length === 0) chunks.push([]);

      let inserted = 0;
      const byProvider: Partial<Record<ImageProviderKey, number>> = {};
      // Rows this call created, in input order, each with its ordinal slot.
      // Collected so `applySurvivorOrder` can re-seat them once the batch is
      // written and the survivor set is finally known.
      const landed: LandedCandidate[] = [];

      // The ordinal cursor starts from the persisted MAX once and then flows
      // across chunks: a suppressed duplicate intentionally consumes a slot
      // (the survivor re-seat below depends on that), so re-reading MAX per
      // chunk would drop those slots and tear holes in the re-seat math.
      let nextOrdinal: number | null = null;
      for (const chunk of chunks) {
        await database.transaction(async (transaction) => {
        if (nextOrdinal === null) {
          const ordinalRow = await transaction.getFirst<{ next_ordinal: number }>(
            'SELECT COALESCE(MAX(queue_ordinal), 0) + 1 AS next_ordinal FROM images',
          );
          nextOrdinal = ordinalRow?.next_ordinal ?? 1;
        }
        for (const candidate of chunk) {
          const duplicate = await transaction.getFirst<{
            id: number;
            content_rating: ContentRating | null;
            native_rating: string | null;
            is_nsfw: number;
          }>(
            `SELECT id, content_rating, native_rating, is_nsfw FROM images
             WHERE (provider_key = ? AND provider_item_id = ?)
                OR (? IS NOT NULL AND canonical_source_key = ?)
                OR (? IS NOT NULL AND perceptual_hash = ?)
                OR (? IS NOT NULL AND md5 = ?)
             LIMIT 1`,
            [
              candidate.providerKey,
              candidate.providerItemId,
              candidate.canonicalSourceKey,
              candidate.canonicalSourceKey,
              candidate.perceptualHash,
              candidate.perceptualHash,
              candidate.md5,
              candidate.md5,
            ],
          );
          if (duplicate) {
            const candidateRating = candidateContentRating(candidate);
            const existingRating = isStoredContentRating(duplicate.content_rating)
              ? duplicate.content_rating
              : duplicate.is_nsfw === 1
                ? 'nsfw_unspecified'
                : 'safe';
            const persistedRating = strongerContentRating(
              existingRating,
              candidateRating,
            );
            await transaction.run(
              `UPDATE images
               SET canonical_source_key = COALESCE(canonical_source_key, ?),
                   perceptual_hash = COALESCE(perceptual_hash, ?),
                   md5 = COALESCE(md5, ?),
                   content_rating = ?,
                   native_rating = COALESCE(native_rating, ?),
                   is_nsfw = ?
               WHERE id = ?`,
              [
                candidate.canonicalSourceKey,
                candidate.perceptualHash,
                candidate.md5,
                persistedRating,
                candidate.nativeRating ?? null,
                ratingIsNsfw(persistedRating) ? 1 : 0,
                duplicate.id,
              ],
            );
            nextOrdinal += 1;
            continue;
          }
          const contentRating = candidateContentRating(candidate);
          const params: SqlBindValue[] = [
            candidate.providerKey,
            candidate.providerItemId,
            candidate.canonicalSourceKey,
            candidate.perceptualHash,
            candidate.md5,
            candidate.remoteUrl,
            candidate.sampleUrl ?? null,
            candidate.sourceUrl,
            candidate.artistName,
            candidate.artistUrl,
            candidate.width,
            candidate.height,
            candidate.byteSize,
            candidate.extension,
            candidate.dominantColor,
            contentRating,
            candidate.nativeRating ?? null,
            ratingIsNsfw(contentRating) ? 1 : 0,
            candidate.isAnimated ? 1 : 0,
            JSON.stringify(normalizeTags(candidate.tags)),
            nextOrdinal,
          ];
          const hasLocalId = Number.isInteger(candidate.id) && candidate.id! > 0;
          if (hasLocalId) params.unshift(candidate.id!);
          const metadataPlaceholders = params
            .slice(0, -1)
            .map(() => '?')
            .join(', ');
          const result = await transaction.run(
            `INSERT OR IGNORE INTO images (
              ${hasLocalId ? 'id, ' : ''}provider_key, provider_item_id,
              canonical_source_key, perceptual_hash, md5,
              remote_url, sample_url, source_url, artist_name, artist_url, width, height,
              byte_size, extension, dominant_color, content_rating,
              native_rating, is_nsfw, is_animated, tags_json,
              decision, download_state, queue_ordinal
            ) VALUES (${metadataPlaceholders}, 'queued', 'none', ?)`,
            params,
          );
          inserted += result.changes;
          if (result.changes > 0) {
            byProvider[candidate.providerKey] =
              (byProvider[candidate.providerKey] ?? 0) + result.changes;
            landed.push({
              id: result.lastInsertRowId,
              candidate,
              ordinal: nextOrdinal,
            });
          }
          nextOrdinal += 1;
        }
        });
      }

      // The survivor re-seat spans the whole batch (holes left by the identity
      // gate anywhere in the offered order), so it runs once, after the last
      // chunk, in its own small transaction.
      if (options?.orderSurvivors !== undefined && landed.length >= 2) {
        await database.transaction(async (transaction) => {
          await applySurvivorOrder(transaction, landed, options.orderSurvivors);
        });
      }
      return { inserted, byProvider };
    },
    saveCandidate(candidate, savedAt) {
      return saveCandidateAs(candidate, savedAt, 'pending');
    },
    saveMirroredCandidate(candidate, savedAt) {
      return saveCandidateAs(candidate, savedAt, 'mirrored');
    },
    async restoreDeck() {
      return database.transaction(async (transaction) => {
        const activeRow = await transaction.getFirst<ImageRow>(
          `SELECT ${IMAGE_COLUMNS} FROM images WHERE decision = 'active' ORDER BY presented_at DESC, id LIMIT 1`,
        );
        const queuedRows = await transaction.getAll<ImageRow>(
          `SELECT ${IMAGE_COLUMNS}
           FROM images
           WHERE decision = 'queued'
           ORDER BY queue_ordinal, id`,
        );
        return {
          active: activeRow ? mapImageRow(activeRow) : null,
          queued: queuedRows.map(mapImageRow),
        };
      });
    },
    async activateNext(presentedAt) {
      assertTimestamp(presentedAt, 'presentedAt');
      return database.transaction(async (transaction) => {
        const existing = await transaction.getFirst<ImageRow>(
          `SELECT ${IMAGE_COLUMNS} FROM images WHERE decision = 'active' ORDER BY presented_at DESC, id LIMIT 1`,
        );
        if (existing) return mapImageRow(existing);

        const queued = await transaction.getFirst<{ id: number }>(
          "SELECT id FROM images WHERE decision = 'queued' ORDER BY queue_ordinal, id LIMIT 1",
        );
        if (!queued) return null;

        await transaction.run(
          "UPDATE images SET decision = 'active', presented_at = ? WHERE id = ? AND decision = 'queued'",
          [presentedAt, queued.id],
        );
        return loadById(transaction, queued.id);
      });
    },
    async promoteForDecision(imageId, presentedAt) {
      assertTimestamp(presentedAt, 'presentedAt');
      return database.transaction(async (transaction) => {
        const target = await loadById(transaction, imageId);
        if (!target) return null;
        if (target.decision === 'active') return target;
        if (target.decision !== 'queued') return null;

        const ordinalRow = await transaction.getFirst<{ next_ordinal: number }>(
          `SELECT COALESCE(MAX(queue_ordinal), 0) + 1 AS next_ordinal
           FROM images
           WHERE decision = 'queued'`,
        );
        const nextOrdinal = ordinalRow?.next_ordinal ?? 1;
        await transaction.run(
          `UPDATE images
           SET decision = 'queued', presented_at = NULL, queue_ordinal = ?
           WHERE decision = 'active'`,
          [nextOrdinal],
        );
        await transaction.run(
          `UPDATE images
           SET decision = 'active', presented_at = ?
           WHERE id = ? AND decision = 'queued'`,
          [presentedAt, imageId],
        );
        return loadById(transaction, imageId);
      });
    },
    async decide(imageId, decision, decidedAt) {
      assertTimestamp(decidedAt, 'decidedAt');
      return database.transaction(async (transaction) => {
        const ordinalRow = await transaction.getFirst<{ next_ordinal: number }>(
          `SELECT COALESCE(MAX(decision_ordinal), 0) + 1 AS next_ordinal
           FROM images`,
        );
        const nextOrdinal = ordinalRow?.next_ordinal ?? 1;
        const result =
          decision === 'saved'
            ? await transaction.run(
                `UPDATE images
                 SET decision = 'saved',
                     decided_at = CASE WHEN decision = 'active' THEN ? ELSE decided_at END,
                     decision_ordinal = CASE
                       WHEN decision = 'active' THEN ? ELSE decision_ordinal
                     END,
                     taste_signal = CASE
                       WHEN decision = 'active' THEN 'saved' ELSE taste_signal
                     END,
                     taste_recorded_at = CASE
                       WHEN decision = 'active' THEN ? ELSE taste_recorded_at
                     END,
                     download_state = 'pending',
                     local_uri = NULL, download_error = NULL, download_error_kind = NULL
                 WHERE id = ?
                   AND (decision = 'active' OR (decision = 'saved' AND download_state = 'failed'))`,
                [decidedAt, nextOrdinal, decidedAt, imageId],
              )
            : await transaction.run(
                `UPDATE images
                 SET decision = 'dismissed', decided_at = ?, decision_ordinal = ?,
                     download_state = 'none',
                     local_uri = NULL, download_error = NULL, download_error_kind = NULL
                 WHERE id = ? AND decision = 'active'`,
                [decidedAt, nextOrdinal, imageId],
              );
        if (result.changes === 0) {
          // The WHERE clause only matches undecided rows, so zero changes means
          // either the image is unknown or it already reached this decision.
          // Reporting null for the second case would tell the caller its
          // durable write failed and strand the deck, so confirm the row state.
          const settled = await loadById(transaction, imageId);
          return settled !== null && settled.decision === decision ? settled : null;
        }
        return loadById(transaction, imageId);
      });
    },
    async rewindDecision(imageId, expected) {
      return database.transaction(async (transaction) => {
        // No global-latest check: the LIFO order belongs to the discovery
        // service's history, and a Search save, a mirror restore or a settings
        // auto-dismiss that took a newer ordinal must not block a rewind.
        const target = await loadById(transaction, imageId);
        if (
          !target ||
          target.decision !== expected.decision ||
          target.decidedAt !== expected.decidedAt
        ) {
          return null;
        }

        const ordinalRow = await transaction.getFirst<{ front_ordinal: number }>(
          `SELECT COALESCE(MIN(queue_ordinal), 0) - 1 AS front_ordinal
           FROM images
           WHERE decision = 'queued'`,
        );
        await transaction.run(
          `UPDATE images
           SET decision = 'queued', presented_at = NULL, queue_ordinal = ?
           WHERE decision = 'active' AND id <> ?`,
          [ordinalRow?.front_ordinal ?? -1, imageId],
        );
        const result = await transaction.run(
          `UPDATE images
           SET decision = 'active', decided_at = NULL, decision_ordinal = NULL,
               taste_signal = NULL, taste_recorded_at = NULL,
               download_state = 'none', local_uri = NULL, download_error = NULL,
               download_error_kind = NULL,
               library_error = NULL, library_error_attempts = 0
           WHERE id = ? AND decision = ? AND decided_at = ?`,
          [imageId, expected.decision, expected.decidedAt],
        );
        if (result.changes === 0) return null;
        return target;
      });
    },
    async listCollection() {
      const rows = await database.getAll<ImageRow>(
        `SELECT ${IMAGE_COLUMNS}
         FROM images
         WHERE decision = 'saved'
         ORDER BY decided_at DESC, decision_ordinal DESC`,
      );
      return rows.map(mapImageRow);
    },
    getById(imageId) {
      return loadById(database, imageId);
    },
    async markDownloadReady(imageId, localUri, attempt, downloadedByteSize) {
      if (localUri.trim().length === 0) return false;
      const byteSize: number | null = typeof downloadedByteSize === 'number' &&
        Number.isSafeInteger(downloadedByteSize) && downloadedByteSize > 0
        ? downloadedByteSize
        : null;
      const result = await database.run(
        `UPDATE images
         SET download_state = 'ready', local_uri = ?,
             byte_size = CASE WHEN byte_size = 0 AND ? IS NOT NULL THEN ? ELSE byte_size END,
             download_error = NULL,
             download_error_kind = NULL,
             -- K6-5 C: fresh bytes, so any earlier ingest verdict (and the
             -- attempt count behind its terminal rule) is about a file that no
             -- longer exists. Every other path back into saved ends here.
             library_error = NULL, library_error_attempts = 0
         WHERE id = ? AND decision = 'saved' AND download_state = 'pending'
           AND (? IS NULL OR (remote_url = ? AND extension = ?))`,
        [
          localUri,
          byteSize,
          byteSize,
          imageId,
          attempt ? 1 : null,
          attempt?.remoteUrl ?? '',
          attempt?.extension ?? '',
        ],
      );
      return result.changes === 1;
    },
    async markDownloadFailed(imageId, errorCode, attempt, kind = 'transient') {
      if (errorCode.trim().length === 0) return false;
      const result = await database.run(
        `UPDATE images
         SET download_state = 'failed', local_uri = NULL, download_error = ?,
             download_error_kind = ?
         WHERE id = ? AND decision = 'saved' AND download_state = 'pending'
           AND (? IS NULL OR (remote_url = ? AND extension = ?))`,
        [
          errorCode,
          kind,
          imageId,
          attempt ? 1 : null,
          attempt?.remoteUrl ?? '',
          attempt?.extension ?? '',
        ],
      );
      return result.changes === 1;
    },
    async recordLibraryIngestFailure(imageId, errorCode) {
      if (errorCode.trim().length === 0) return false;
      const result = await database.run(
        `UPDATE images
            SET library_error = ?,
                library_error_attempts = library_error_attempts + 1
          WHERE id = ? AND decision = 'saved'`,
        [errorCode, imageId],
      );
      return result.changes === 1;
    },
    async clearLibraryIngestError(imageId) {
      const result = await database.run(
        `UPDATE images
            SET library_error = NULL, library_error_attempts = 0
          WHERE id = ?`,
        [imageId],
      );
      return result.changes === 1;
    },
    async markFileMissing(imageId, errorCode) {
      if (errorCode.trim().length === 0) return false;
      // Board #5: a file that vanished locally says nothing about the source;
      // the sweep should simply fetch it again.
      const result = await database.run(
        `UPDATE images
         SET download_state = 'failed', local_uri = NULL, download_error = ?,
             download_error_kind = 'transient'
         WHERE id = ? AND decision = 'saved' AND download_state IN ('ready', 'failed')`,
        [errorCode, imageId],
      );
      return result.changes === 1;
    },
    async reclaimMirroredForDownload(imageId) {
      const result = await database.run(
        `UPDATE images
            SET download_state = 'pending', local_uri = NULL, download_error = NULL, download_error_kind = NULL
          WHERE id = ? AND decision = 'saved' AND download_state = 'mirrored'`,
        [imageId],
      );
      return result.changes > 0;
    },
    async deleteFromCollection(imageId) {
      return database.transaction(async (transaction) => {
        const result = await transaction.run(
          `UPDATE images
           SET decision = 'dismissed', download_state = 'none',
               local_uri = NULL, download_error = NULL, download_error_kind = NULL,
               library_error = NULL, library_error_attempts = 0
           WHERE id = ? AND decision = 'saved'`,
          [imageId],
        );
        if (result.changes === 0) return null;
        return loadById(transaction, imageId);
      });
    },
    async returnToDiscovery(imageId) {
      return database.transaction(async (transaction) => {
        const existing = await loadById(transaction, imageId);
        if (!existing || existing.decision !== 'saved') return null;
        const result = await transaction.run(
          "DELETE FROM images WHERE id = ? AND decision = 'saved'",
          [imageId],
        );
        return result.changes === 1 ? existing : null;
      });
    },
    async deleteQueuedCandidates() {
      const result = await database.run("DELETE FROM images WHERE decision = 'queued'");
      return result.changes;
    },
    async dropQueuedCandidate(imageId) {
      return database.transaction(async (transaction) => {
        const existing = await loadById(transaction, imageId);
        if (!existing || existing.decision !== 'queued') return null;
        const result = await transaction.run(
          "DELETE FROM images WHERE id = ? AND decision = 'queued'",
          [imageId],
        );
        return result.changes === 1 ? existing : null;
      });
    },
    async recentHandledIds(limit = 100) {
      const cappedLimit = Math.min(100, Math.max(0, Math.trunc(limit)));
      if (cappedLimit === 0) return [];
      const rows = await database.getAll<{ id: number }>(
        `SELECT id
         FROM images
         WHERE decision IN ('dismissed', 'saved')
         ORDER BY decided_at DESC, decision_ordinal DESC
         LIMIT ?`,
        [cappedLimit],
      );
      return rows.map(({ id }) => id);
    },
    async recentHandledIdentities(limit = 100) {
      const cappedLimit = Math.min(100, Math.max(0, Math.trunc(limit)));
      if (cappedLimit === 0) return [];
      const rows = await database.getAll<{
        provider_key: ImageProviderKey;
        provider_item_id: string;
      }>(
        `SELECT provider_key, provider_item_id
         FROM images
         WHERE decision IN ('dismissed', 'saved')
         ORDER BY decided_at DESC, decision_ordinal DESC
         LIMIT ?`,
        [cappedLimit],
      );
      return rows.map((row) => ({
        providerKey: row.provider_key,
        providerItemId: row.provider_item_id,
      }));
    },
    async resetDismissedHistory() {
      const result = await database.run("DELETE FROM images WHERE decision = 'dismissed'");
      return result.changes;
    },
    async resetDiscoveryHistory() {
      const result = await database.run("DELETE FROM images WHERE decision <> 'saved'");
      return result.changes;
    },
    async deleteAll() {
      const result = await database.run('DELETE FROM images');
      return result.changes;
    },
  };
}
