import type { LibraryRemoteAssetState } from './library-mutation-decision';

/**
 * Shared plaintext-structural wire codec for `assets/<id>/state.json`.
 *
 * Both the BYOS reconciliation reader (`library-reconciliation-port.ts`) and
 * the BYOS S3 CAS writer (`library-cloud-client-s3.ts`) independently grew
 * their own encode/decode pair for this exact wire format and drifted: the
 * reader validated the 5 narrow `LibraryRemoteAssetState` fields and
 * fail-fast on corruption, the writer's decode was a raw `JSON.parse` cast
 * with no validation at all. This module is the single source of truth for
 * that wire format so both sides agree on what a well-formed `state.json`
 * body looks like.
 *
 * Scope: plaintext-structural only — a flat JSON object with the full
 * persisted `LibraryAssetStateRecord` shape (protocol spec
 * `docs/superpowers/specs/2026-08-28-byos-s3-sync-protocol-design.md`,
 * "每资产状态对象" section): the 5 narrow `LibraryRemoteAssetState` decision
 * fields (`assetId`, `revision`, `generation`, `lifecycle`, `protection`),
 * required and validated, plus 4 carried fields the decision table itself
 * never reads but the wire format must never drop — `lastMutationId`
 * (idempotent replay), `trashedAt`, `generations` (the blob-ULID map
 * recording where each rendition's encrypted bytes live), and `meta` (see
 * below). The 3 non-`meta` carried fields are validated when present and
 * default (`null`/`null`/`{}`) when absent, so a legacy 5-field body
 * (written before this fix) still decodes.
 *
 * `meta` is the sealed asset-metadata envelope (size, source, tag digest —
 * `LibraryEncryptedMetadata`, `library-actions-types.ts`) produced by
 * `LibraryObjectCipher.sealMetadata` (`library-object-crypto.ts`): a
 * self-describing base64url string (magic + wrapped data key + AES-GCM
 * payload, already base64url-encoded by `sealMetadata` itself), NOT the
 * structured plaintext object the protocol spec's illustrative example
 * shows — this module treats it as an opaque string end to end (P3C-2
 * decision, spec S1 amendment: safer than a plaintext structural field —
 * whole-body state.json sealing is designed but lands only with P3C-3's
 * composition layer, and `meta` stays sealed by `sealMetadata` either
 * way). It is the ONLY way a second device can
 * materialize an asset it has never seen locally (`library-sync-apply.ts`
 * needs `encryptedMetadata` to build a projectable row), so it is `undefined`-
 * optional (a legacy or not-yet-collected body has none) but, once present,
 * carried like `generations`: preserved verbatim across mutations that don't
 * supply a new one (never null-erased — a trash→restore round trip must not
 * lose it), and stripped only by the purge tombstone (see
 * `library-cloud-client-s3.ts`'s `buildNextRecord`, which owns that merge
 * rule; this module only encodes/decodes whatever `meta` value it's given).
 * This module never decodes or re-encrypts the envelope — decode/AAD
 * verification stays with `sealMetadata`/`openMetadata`.
 *
 * Encryption (the `{protocolVersion, sealed}` envelope used when the vault
 * has client-side encryption enabled) is intentionally NOT handled here —
 * that requires the masterKey, which is only available to the sync engine
 * (a later subplan). A future encrypted codec wraps this one (encrypt the
 * bytes this module produces; decrypt before handing bytes to this module's
 * decode), so this module's signatures are deliberately `Uint8Array in,
 * Uint8Array out` / `Uint8Array in, LibraryAssetStateRecord out` rather than
 * anything string-shaped, to make that wrapping trivial to add later.
 */

export const REQUIRED_FIELDS = [
  'assetId',
  'revision',
  'generation',
  'lifecycle',
  'protection',
] as const;

const GENERATION_ROLES = ['thumbnail', 'preview', 'original'] as const;

/** Which content-addressed blob (by generationId ULID) backs each rendition role. */
export type LibraryAssetStateGenerations = Readonly<{
  thumbnail?: string;
  preview?: string;
  original?: string;
}>;

/**
 * Full persisted shape of one `assets/<id>/state.json` payload: the 5
 * narrow decision fields (`LibraryRemoteAssetState`, unchanged) plus the 4
 * carried fields described in the module header. This is the type both
 * `library-reconciliation-port.ts` and `library-cloud-client-s3.ts` read
 * and write — the CAS writer must round-trip every field here on every
 * applied mutation, or an overwrite silently erases whatever the narrow
 * decision fields don't carry (the bug this module fixes).
 */
export type LibraryAssetStateRecord = LibraryRemoteAssetState &
  Readonly<{
    lastMutationId: string | null;
    trashedAt: string | null;
    generations: LibraryAssetStateGenerations;
    /**
     * Opaque base64url sealed metadata envelope (see module header). Absent
     * (`undefined`) for a not-yet-collected legacy body or a purge
     * tombstone; present otherwise. Unlike `lastMutationId`/`trashedAt`
     * there is no meaningful `null` state for `meta` — it is either a sealed
     * envelope or nothing — so it is a plain optional property, not a
     * `string | null` union.
     */
    meta?: string;
    /**
     * N6-A3 (spec §4.3): optional in-memory authority identity (`state/<name>`
     * for append-only protocol v2 notes, or `s3:<revision>` for S3 CAS).
     * Never serialized into wire JSON (`encodeAssetState` destructures only
     * the 9 wire fields).
     */
    stateKey?: string;
  }>;

const STATE_KEYS = new WeakMap<object, string>();

export function attachAssetStateKey(
  record: LibraryAssetStateRecord,
  stateKey: string,
): LibraryAssetStateRecord {
  STATE_KEYS.set(record, stateKey);
  if (Object.getOwnPropertyDescriptor(record, 'stateKey') === undefined) {
    Object.defineProperty(record, 'stateKey', {
      value: stateKey,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } else {
    (record as { stateKey?: string }).stateKey = stateKey;
  }
  return record;
}

export function readAssetStateKey(
  record: LibraryAssetStateRecord,
): string | null {
  const mapped = STATE_KEYS.get(record);
  if (typeof mapped === 'string' && mapped.length > 0) {
    return mapped;
  }
  if (typeof record.stateKey === 'string' && record.stateKey.length > 0) {
    return record.stateKey;
  }
  return null;
}

/**
 * Thrown by `decodeAssetState` when a `state.json` body is not valid JSON,
 * does not parse to a plain object, is missing one of `REQUIRED_FIELDS`, has
 * a required field of the wrong type, or has a carried field
 * (`lastMutationId`/`trashedAt`/`generations`/`meta`) present with the wrong
 * type.
 *
 * Callers that need a domain-specific error type (e.g.
 * `library-reconciliation-port.ts`'s `LibraryReconciliationCorruptionError`,
 * which also carries the object key) should catch this error and re-throw
 * their own, passing this error as `cause`.
 */
export class AssetStateCorruptionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AssetStateCorruptionError';
    Object.setPrototypeOf(this, AssetStateCorruptionError.prototype);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encodes every field of `record` (destructured — no leakage of unknown
 * extras) as UTF-8 JSON bytes. `meta` is included as-is when present;
 * `JSON.stringify` drops an `undefined`-valued `meta` key entirely (not even
 * a `null` placeholder), matching the "absent, not nulled" carried-field
 * contract described in the module header.
 */
export function encodeAssetState(record: LibraryAssetStateRecord): Uint8Array {
  const {
    assetId,
    revision,
    generation,
    lifecycle,
    protection,
    lastMutationId,
    trashedAt,
    generations,
    meta,
  } = record;
  return encoder.encode(
    JSON.stringify({
      assetId,
      revision,
      generation,
      lifecycle,
      protection,
      lastMutationId,
      trashedAt,
      generations,
      meta,
    }),
  );
}

/**
 * Decodes and validates a `state.json` body into the full
 * `LibraryAssetStateRecord`. The 5 `REQUIRED_FIELDS` must be present and
 * correctly typed. The 3 `null`-defaulted carried fields
 * (`lastMutationId`/`trashedAt`/`generations`) are validated only when
 * present (type-checked; `generations`' present role values must be
 * strings) and default to `null` / `null` / `{}` when absent — so an old
 * 5-field body still decodes (backward compatible), and round-tripping it
 * forward fills in the defaults a writer can then merge updates into. `meta`
 * is validated only when present (must be a string) and left `undefined`
 * when absent — it has no default placeholder, unlike the other three.
 * Extra fields beyond the persisted record shape (e.g. a still-present
 * `protocolVersion` from an older write) are ignored, not rejected.
 */
export function decodeAssetState(body: Uint8Array): LibraryAssetStateRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch (cause) {
    throw new AssetStateCorruptionError(
      'state.json body is not valid JSON',
      cause,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AssetStateCorruptionError(
      'state.json body did not parse to a JSON object',
    );
  }

  const record = parsed as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (record[field] === undefined) {
      throw new AssetStateCorruptionError(`missing required field "${field}"`);
    }
  }

  if (typeof record.assetId !== 'string') {
    throw new AssetStateCorruptionError('field "assetId" must be a string');
  }
  if (typeof record.revision !== 'number') {
    throw new AssetStateCorruptionError('field "revision" must be a number');
  }
  if (typeof record.generation !== 'number') {
    throw new AssetStateCorruptionError('field "generation" must be a number');
  }
  if (typeof record.lifecycle !== 'string') {
    throw new AssetStateCorruptionError('field "lifecycle" must be a string');
  }
  if (typeof record.protection !== 'string') {
    throw new AssetStateCorruptionError('field "protection" must be a string');
  }

  let lastMutationId: string | null = null;
  if (record.lastMutationId !== undefined) {
    if (
      record.lastMutationId !== null &&
      typeof record.lastMutationId !== 'string'
    ) {
      throw new AssetStateCorruptionError(
        'field "lastMutationId" must be a string or null',
      );
    }
    lastMutationId = record.lastMutationId as string | null;
  }

  let trashedAt: string | null = null;
  if (record.trashedAt !== undefined) {
    if (record.trashedAt !== null && typeof record.trashedAt !== 'string') {
      throw new AssetStateCorruptionError(
        'field "trashedAt" must be a string or null',
      );
    }
    trashedAt = record.trashedAt as string | null;
  }

  let generations: LibraryAssetStateGenerations = {};
  if (record.generations !== undefined) {
    if (
      typeof record.generations !== 'object' ||
      record.generations === null ||
      Array.isArray(record.generations)
    ) {
      throw new AssetStateCorruptionError(
        'field "generations" must be an object',
      );
    }
    const rawGenerations = record.generations as Record<string, unknown>;
    const validated: {
      thumbnail?: string;
      preview?: string;
      original?: string;
    } = {};
    for (const role of GENERATION_ROLES) {
      const value = rawGenerations[role];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        throw new AssetStateCorruptionError(
          `field "generations.${role}" must be a string`,
        );
      }
      validated[role] = value;
    }
    generations = validated;
  }

  let meta: string | undefined;
  if (record.meta !== undefined) {
    if (typeof record.meta !== 'string') {
      throw new AssetStateCorruptionError('field "meta" must be a string');
    }
    meta = record.meta;
  }

  return {
    assetId: record.assetId,
    revision: record.revision,
    generation: record.generation,
    lifecycle: record.lifecycle as LibraryRemoteAssetState['lifecycle'],
    protection: record.protection as LibraryRemoteAssetState['protection'],
    lastMutationId,
    trashedAt,
    generations,
    ...(meta !== undefined ? { meta } : {}),
  };
}
