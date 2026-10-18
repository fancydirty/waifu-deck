// The main jest config (package.json "jest") has no `moduleNameMapper`, so
// `expo-crypto` resolves to the real module over jest-expo's native automock.
// Every suite in this repo that touches expo-crypto opts into the double
// per-file; the last test below needs that so `getRandomValues` actually
// produces bytes instead of a silent all-zero array.
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import { encodeNoteName, isUlid, nextMutationId, parseNoteName, ulidTimestamp, writerTag } from './library-note-name';

const ASSET = 'a'.repeat(64);
const ZERO = () => new Uint8Array(10);

describe('note names (spec §3.1)', () => {
  test('encode/parse round trip: <assetId>.<mutationId>.<writer8>.json', () => {
    const name = encodeNoteName({ assetId: ASSET, mutationId: '01J8Z3M9A5N6P7Q8R9S0T1V2W3', writer: 'device-1234-uuid' });
    expect(name).toBe(`${ASSET}.01J8Z3M9A5N6P7Q8R9S0T1V2W3.device-1.json`);
    expect(parseNoteName(name)).toEqual({ assetId: ASSET, mutationId: '01J8Z3M9A5N6P7Q8R9S0T1V2W3', writer: 'device-1' });
  });
  test('writerTag keeps only [A-Za-z0-9_-] and the first 8 characters', () => {
    expect(writerTag('device-1234-uuid')).toBe('device-1');
    expect(writerTag('ab cd/ef!ghijk')).toBe('abcdefgh');
  });
  test('encodeNoteName throws when the writer tag is empty (no name-safe characters survive stripping)', () => {
    expect(() =>
      encodeNoteName({ assetId: ASSET, mutationId: '01J8Z3M9A5N6P7Q8R9S0T1V2W3', writer: '设备一号' }),
    ).toThrow(/no name-safe characters/);
  });
  test('parse rejects anything that is not exactly the shape (foreign files in the folder are ignored, not fatal)', () => {
    expect(parseNoteName('README.md')).toBeNull();
    expect(parseNoteName(`${ASSET}.notaulid.dev.json`)).toBeNull();
    expect(parseNoteName(`${'z'.repeat(64)}.01J8Z3M9A5N6P7Q8R9S0T1V2W3.dev.json`)).toBeNull();
    expect(parseNoteName(`${ASSET}.01J8Z3M9A5N6P7Q8R9S0T1V2W3.toolongwriter.json`)).toBeNull();
  });
  test('mutation ids sort by time as plain strings (ULID property)', () => {
    const a = nextMutationId(null, { now: () => 1_000_000, random: ZERO });
    const b = nextMutationId(null, { now: () => 1_000_001, random: ZERO });
    expect(a < b).toBe(true);
    expect(a).toHaveLength(26);
    expect(ulidTimestamp(a)).toBe(1_000_000);
  });
  test('the random tail is 16 Crockford base32 chars derived from the 10 random bytes', () => {
    const id = nextMutationId(null, { now: () => 0, random: () => new Uint8Array(10).fill(255) });
    expect(id.slice(0, 10)).toBe('0000000000');
    expect(id.slice(10)).toBe('ZZZZZZZZZZZZZZZZ');
  });
  test('random tail pin (Nit A): all-zero bytes encode to all-zero chars', () => {
    // Pinned ahead of the BigInt -> accumulator swap so the swap is provably
    // byte-for-byte equivalent, not just "still passes the existing tests."
    const id = nextMutationId(null, { now: () => 0, random: () => new Uint8Array(10) });
    expect(id.slice(10)).toBe('0'.repeat(16));
  });
  test('random tail pin (Nit A): a mixed byte vector encodes to a specific, pre-computed tail', () => {
    // Vector and expected output independently verified against the current
    // BigInt implementation (including a decode round trip) before pinning:
    // Uint8Array.of(0x00,0x44,0x32,0x14,0xC7,0x42,0x54,0xB6,0x35,0xCF) -> '0123456789ABCDEF'.
    const bytes = Uint8Array.of(0x00, 0x44, 0x32, 0x14, 0xc7, 0x42, 0x54, 0xb6, 0x35, 0xcf);
    const id = nextMutationId(null, { now: () => 0, random: () => bytes });
    expect(id.slice(10)).toBe('0123456789ABCDEF');
  });
  test('monotonic rule: a new id is always greater than the greatest id already seen for the asset', () => {
    const seen = nextMutationId(null, { now: () => 5_000_000, random: ZERO });
    const next = nextMutationId(seen, { now: () => 4_998_000, random: ZERO });   // my clock is 2 s behind
    expect(next > seen).toBe(true);
    expect(ulidTimestamp(next)).toBe(5_000_001);
  });
  test('monotonic rule also fires on an EQUAL timestamp (same millisecond as the seen id)', () => {
    const seen = nextMutationId(null, { now: () => 5_000_000, random: ZERO });
    const next = nextMutationId(seen, { now: () => 5_000_000, random: ZERO });
    expect(ulidTimestamp(next)).toBe(5_000_001);
  });
  test('monotonic rule leaves a genuinely later clock alone', () => {
    const seen = nextMutationId(null, { now: () => 5_000_000, random: ZERO });
    const next = nextMutationId(seen, { now: () => 5_000_500, random: ZERO });
    expect(ulidTimestamp(next)).toBe(5_000_500);
  });
  test('a malformed greatestSeen is ignored rather than crashing the minter', () => {
    expect(nextMutationId('garbage', { now: () => 7, random: ZERO })).toHaveLength(26);
  });
  test('encodeTime throws instead of silently wrapping at the ULID ceiling, and names greatestSeen (not the clock) as the source', () => {
    // 'Z'.repeat(26) decodes to MAX_TIME_MS (2^50 - 1); minting the next id
    // for it must overflow to MAX_TIME_MS + 1, which no longer fits 10 chars.
    // The head came from a listing (third-party data), so the message must not
    // blame this device's clock, which returned a perfectly usable 0 here.
    expect(() => nextMutationId('Z'.repeat(26), { now: () => 0, random: ZERO })).toThrow(
      /greatestSeen \+ 1 ms is an unusable timestamp/,
    );
  });
  test('a clock past the ULID ceiling throws and names the clock as the source', () => {
    expect(() => nextMutationId(null, { now: () => 2 ** 50, random: ZERO })).toThrow(
      /clock produced an unusable timestamp/,
    );
  });
  test('isUlid checks shape: 26 Crockford base32 chars, uppercase only', () => {
    expect(isUlid('Z'.repeat(26))).toBe(true);
    expect(isUlid('z'.repeat(26))).toBe(false);
    expect(isUlid('0'.repeat(25))).toBe(false);
  });
  test('isUlid rejects the letters Crockford base32 excludes: I, L, O, U', () => {
    for (const letter of ['I', 'L', 'O', 'U']) expect(isUlid(letter.repeat(26))).toBe(false);
    // A single excluded letter anywhere is enough to reject the whole id.
    expect(isUlid(`${'0'.repeat(25)}I`)).toBe(false);
  });
  test('default deps produce a valid ULID with a genuinely random tail (exercises the expo-crypto random path)', () => {
    const a = nextMutationId(null);
    const b = nextMutationId(null);
    expect(isUlid(a)).toBe(true);
    expect(a.slice(10)).not.toBe('0'.repeat(16));
    expect(a.slice(10)).not.toBe(b.slice(10));
  });
});
