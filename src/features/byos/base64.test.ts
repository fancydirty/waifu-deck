import { encodeBase64, decodeBase64 } from './base64';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('byos base64 (standard alphabet, Hermes-safe)', () => {
  it('encodes known vectors matching RFC 4648 standard base64', () => {
    expect(encodeBase64(utf8('hello'))).toBe('aGVsbG8=');
    expect(encodeBase64(utf8('f'))).toBe('Zg==');
    expect(encodeBase64(utf8('fo'))).toBe('Zm8=');
    expect(encodeBase64(utf8('foo'))).toBe('Zm9v');
    expect(encodeBase64(utf8('foob'))).toBe('Zm9vYg==');
    expect(encodeBase64(utf8('fooba'))).toBe('Zm9vYmE=');
    expect(encodeBase64(utf8('foobar'))).toBe('Zm9vYmFy');
  });

  it('encodes empty input to an empty string and decodes it back', () => {
    expect(encodeBase64(new Uint8Array(0))).toBe('');
    expect(decodeBase64('')).toEqual(new Uint8Array(0));
  });

  it('round-trips every residual-byte padding case (1, 2, 3)', () => {
    for (const len of [1, 2, 3, 4, 5, 6, 7]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
      const encoded = encodeBase64(bytes);
      expect(decodeBase64(encoded)).toEqual(bytes);
    }
  });

  it('round-trips arbitrary bytes across the full 0..255 range', () => {
    const full = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeBase64(encodeBase64(full))).toEqual(full);
    const random = Uint8Array.from({ length: 512 }, () => Math.floor(Math.random() * 256));
    expect(decodeBase64(encodeBase64(random))).toEqual(random);
  });

  it('uses the standard alphabet (+ and /), not base64url (- and _)', () => {
    // 0xFB 0xFF 0xBF -> "+/+/" region exercises the +/ chars.
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0xff]);
    const encoded = encodeBase64(bytes);
    expect(encoded).toMatch(/[+/]/);
    expect(encoded).not.toMatch(/[-_]/);
    expect(decodeBase64(encoded)).toEqual(bytes);
  });

  it('rejects non-base64 input rather than silently accepting it', () => {
    expect(() => decodeBase64('****')).toThrow('Invalid base64 value.');
    expect(() => decodeBase64('aGVsbG8')).toThrow('Invalid base64 value.'); // wrong length
    expect(() => decodeBase64('aGVs-_==')).toThrow('Invalid base64 value.'); // url-safe chars
    expect(() => decodeBase64('=AAA')).toThrow('Invalid base64 value.'); // misplaced padding
  });

  // CRITICAL regression test: this is exactly what Jest (Node, which HAS
  // Buffer) missed. `Buffer` is undefined on the Hermes/RN device runtime, so
  // any base64 path built on it crashes on device. Pin the device contract by
  // proving encode+decode still work with the Node global removed.
  it('works with the Buffer global removed (device-runtime contract)', () => {
    const saved = (globalThis as any).Buffer;
    // eslint-disable-next-line no-param-reassign
    delete (globalThis as any).Buffer;
    try {
      expect((globalThis as any).Buffer).toBeUndefined();
      const bytes = utf8('hermes has no Buffer');
      const encoded = encodeBase64(bytes);
      expect(encoded).toBe('aGVybWVzIGhhcyBubyBCdWZmZXI=');
      expect(decodeBase64(encoded)).toEqual(bytes);
    } finally {
      (globalThis as any).Buffer = saved;
    }
  });

  it('decodes values produced by Node Buffer (no cross-device breakage)', () => {
    // Node's real Buffer is available in the Jest env; a value another device
    // already wrote with the old Buffer path must remain decodable.
    for (const s of ['', 'a', 'ab', 'abc', 'the quick brown fox', 'παλ𝟙']) {
      const bytes = utf8(s);
      const nodeB64 = Buffer.from(bytes).toString('base64');
      expect(decodeBase64(nodeB64)).toEqual(bytes);
      // ...and the reverse: our encoder matches Node's output.
      expect(encodeBase64(bytes)).toBe(nodeB64);
    }
  });
});
