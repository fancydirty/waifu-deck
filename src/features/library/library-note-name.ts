import { getRandomValues } from 'expo-crypto';

/**
 * Note-name codec and monotonic ULID minter for the append-only library
 * protocol v2 (board #12, spec
 * `docs/superpowers/specs/2026-09-18-cloud-drive-library-backends-design.md`
 * §3.1).
 *
 * WHY — the name IS the ordering. Every change to an asset is a new immutable
 * file `state/<assetId>.<mutationId>.<writer>.json`; the note with the
 * greatest `mutationId` is that asset's current state. Because ULIDs sort
 * lexicographically in time order, two devices agree on "newest wins" from a
 * plain directory listing alone: no backend needs ETags, conditional writes,
 * or compare-and-swap for them to converge. That is what lets the same
 * protocol run on S3, WebDAV, and consumer cloud drives, whose APIs offer no
 * atomic primitives at all.
 *
 * `writer` is the device id's short prefix, so a device can garbage-collect
 * only the old notes it wrote itself. Note the deliberate asymmetry:
 * `encodeNoteName` takes the RAW device id and tags it, while `parseNoteName`
 * returns the 8-character tag that was actually on disk.
 *
 * Pure functions, no I/O. The only ambient dependency is the random source
 * for the ULID tail, injectable for tests.
 */

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * Crockford base32 minus I, L, O, U, as a regex character class. Built once
 * and interpolated into both `ULID_RE` and `NOTE_RE` (and used by `isUlid`)
 * so the three can never drift apart into three slightly different alphabets.
 */
const ULID_CLASS = '[0-9A-HJKMNP-TV-Z]';
const ULID_RE = new RegExp(`^${ULID_CLASS}{26}$`);
const NOTE_RE = new RegExp(`^([0-9a-f]{64})\\.(${ULID_CLASS}{26})\\.([A-Za-z0-9_-]{1,8})\\.json$`);

/** 10 chars x 5 bits = 50 bits of millisecond timestamp, big-endian. */
const TIME_CHARS = 10;
/** 16 chars x 5 bits = exactly the 80 random bits below. */
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;
const WRITER_CHARS = 8;
const ALPHABET_SIZE = 32;
/** 32^10 - 1: the largest millisecond a 10-char ULID time segment can hold. */
const MAX_TIME_MS = ALPHABET_SIZE ** TIME_CHARS - 1;
const WRITER_STRIP_RE = /[^A-Za-z0-9_-]/g;

export type NoteName = Readonly<{
  assetId: string;
  mutationId: string;
  writer: string;
}>;

/**
 * The `writer` segment: the device id reduced to characters that survive
 * every backend's naming rules, then cut to 8. Two devices colliding on a
 * tag is harmless — the tag only decides which old notes a device may
 * delete, and the `mutationId` still orders them.
 */
export function writerTag(deviceId: string): string {
  return deviceId.replace(WRITER_STRIP_RE, '').slice(0, WRITER_CHARS);
}

/**
 * Throws if `note.writer` has no name-safe characters at all (an empty tag
 * would produce `<assetId>..json`, which `parseNoteName` rejects — the codec
 * must never emit a name it cannot parse itself).
 */
export function encodeNoteName(note: NoteName): string {
  const writer = writerTag(note.writer);
  if (writer === '') {
    throw new Error(`device id has no name-safe characters: ${JSON.stringify(note.writer)}`);
  }
  return `${note.assetId}.${note.mutationId}.${writer}.json`;
}

/**
 * `null` for anything that is not exactly a note name. A listing of the
 * `state/` folder can contain foreign files (a backend's own placeholder, a
 * user's stray upload, a partial write); those are ignored, never fatal.
 */
export function parseNoteName(name: string): NoteName | null {
  const match = NOTE_RE.exec(name);
  if (match === null) return null;
  const [, assetId, mutationId, writer] = match;
  return { assetId, mutationId, writer };
}

/** Whether `value` has the exact shape of a ULID: 26 Crockford base32 chars. */
export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/**
 * The millisecond timestamp encoded in a ULID's first 10 characters. 50 bits
 * stays inside `Number.MAX_SAFE_INTEGER`, so plain arithmetic is exact here.
 * Throws on a malformed input rather than returning a plausible-looking
 * number that would silently corrupt the ordering; callers gate with
 * `isUlid`.
 */
export function ulidTimestamp(ulid: string): number {
  const time = ulid.slice(0, TIME_CHARS);
  if (time.length < TIME_CHARS) {
    throw new Error(`not a ULID timestamp: ${JSON.stringify(ulid)}`);
  }
  let milliseconds = 0;
  for (const character of time) {
    const value = ULID_ALPHABET.indexOf(character);
    if (value < 0) {
      throw new Error(`not a ULID timestamp: ${JSON.stringify(ulid)}`);
    }
    milliseconds = milliseconds * ALPHABET_SIZE + value;
  }
  return milliseconds;
}

/** Where the timestamp handed to `encodeTime` came from; only the error message differs. */
type TimeSource = 'clock' | 'greatestSeen';

/**
 * Throws on a negative, non-finite, or too-large timestamp instead of
 * silently wrapping: encoding `MAX_TIME_MS + 1` would overflow the 10-char
 * field and emit `'0000000000'`, an id that sorts BEFORE every earlier
 * ULID — a mis-ordering a caller could never detect from the string alone.
 * The message names the source, because the two mean different things: a
 * bad `clock` is this device's own bug, while a `greatestSeen` at the ceiling
 * is third-party listing data (see `nextMutationId`).
 */
function encodeTime(milliseconds: number, source: TimeSource): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIME_MS) {
    throw new Error(
      source === 'clock'
        ? `clock produced an unusable timestamp: ${milliseconds}`
        : `greatestSeen + 1 ms is an unusable timestamp (head ULID at the ceiling): ${milliseconds}`,
    );
  }
  let rest = Math.floor(milliseconds);
  let encoded = '';
  for (let index = 0; index < TIME_CHARS; index += 1) {
    encoded = ULID_ALPHABET.charAt(rest % ALPHABET_SIZE) + encoded;
    rest = Math.floor(rest / ALPHABET_SIZE);
  }
  return encoded;
}

/**
 * The 10 random bytes read as one big-endian 80-bit stream and re-cut into
 * 5-bit groups through a small rolling accumulator, instead of `BigInt`:
 * this was the only use of `BigInt` in `src/`, and the project has a
 * documented history of code that passes Jest but crashes on Hermes because
 * of a JS-runtime gap. Plain `Number` bitwise ops on the *whole* 80-bit value
 * would have the same class of problem for a different reason — `>>` and `|`
 * coerce their operands to 32 bits, and 80 bits also exceeds `Number`'s
 * 53-bit exact-integer range — but the accumulator here never needs to hold
 * more than one leftover partial byte (at most 12 bits) at a time, which
 * comfortably fits inside either limit. Concretely: `accumulator << 8` is an
 * int32 operation, so anything above bit 31 is silently truncated — harmless,
 * because only the low `bits + 8 <= 12` bits are ever live (at most 4
 * leftover bits plus one fresh byte), the read `(accumulator >> bits) & 0x1f`
 * runs with `bits <= 7` and so only ever touches bits 0–11, and the `& 0x1f`
 * mask discards everything else, including any sign extension `>>` brings
 * in. Throws when `random()` did not hand back exactly `RANDOM_BYTES` bytes.
 */
function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length !== RANDOM_BYTES) {
    throw new Error(`ULID tail needs ${RANDOM_BYTES} random bytes, got ${bytes.length}`);
  }
  let encoded = '';
  let accumulator = 0;
  let bits = 0;
  let byteIndex = 0;
  for (let index = 0; index < RANDOM_CHARS; index += 1) {
    while (bits < 5) {
      accumulator = (accumulator << 8) | bytes[byteIndex];
      byteIndex += 1;
      bits += 8;
    }
    bits -= 5;
    encoded += ULID_ALPHABET.charAt((accumulator >> bits) & 0x1f);
  }
  return encoded;
}

export type MutationIdDeps = Readonly<{
  now?: () => number;
  random?: () => Uint8Array;
}>;

/**
 * Spec §3.1's monotonic rule: mint from this device's clock, and if the
 * result is not strictly greater than the greatest `mutationId` already seen
 * for this asset, mint from "greatest seen + 1 ms" instead (fresh random
 * tail). A device whose clock runs behind another device's therefore still
 * writes a note that wins, instead of writing an invisible one.
 *
 * A `greatestSeen` that is not a ULID is ignored rather than fatal: the
 * listing it came from is third-party data. `now()` and `random()` are not
 * — a clock past the ULID ceiling or a malformed random source still throws
 * (through `encodeTime` / `encodeRandom`), because that is a programming
 * error in this device's own dependencies.
 *
 * One throw IS reachable from third-party data: a well-formed `greatestSeen`
 * at the ULID ceiling (`'Z'.repeat(26)`, e.g. a hostile or corrupt foreign
 * note) makes "greatest seen + 1 ms" overflow the 10-char time field, and
 * `encodeTime` throws (naming `greatestSeen`, not the clock). It is not
 * absorbed here because no winning id can be minted at all — a wrapped id
 * would sort UNDER the head and silently lose the write. The append client
 * catches it and isolates that one asset as `corrupt_remote_state`.
 */
export function nextMutationId(
  greatestSeen: string | null,
  deps: MutationIdDeps = {},
): string {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? (() => getRandomValues(new Uint8Array(RANDOM_BYTES)));
  let timestamp = now();
  let source: TimeSource = 'clock';
  if (greatestSeen !== null && isUlid(greatestSeen)) {
    const seenAt = ulidTimestamp(greatestSeen);
    if (timestamp <= seenAt) {
      timestamp = seenAt + 1;
      source = 'greatestSeen';
    }
  }
  return encodeTime(timestamp, source) + encodeRandom(random());
}
