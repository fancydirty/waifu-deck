/**
 * Overhead of one SP7 library object envelope: 8-byte magic, the 60-byte
 * wrapped per-object data key (12-byte nonce + 32-byte key + 16-byte tag), and
 * the payload's own 12-byte nonce + 16-byte tag.
 */
export const LIBRARY_OBJECT_ENVELOPE_OVERHEAD_BYTES = 8 + 60 + 12 + 16;

/** Worker `MAX_V2_OBJECT_BYTES`: one stored object envelope may not exceed this. */
export const LIBRARY_MAX_OBJECT_ENVELOPE_BYTES = 64 * 1024 * 1024;

/**
 * Maximum plaintext size a library asset may have and still be eligible for
 * Cloud Vault protection. Larger images stay valid local originals and are
 * recorded with `protectEligible: false`; they can never be evicted locally.
 */
export const LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES =
  LIBRARY_MAX_OBJECT_ENVELOPE_BYTES - LIBRARY_OBJECT_ENVELOPE_OVERHEAD_BYTES;
