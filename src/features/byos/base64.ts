// Standard base64 (alphabet `A-Za-z0-9+/` with `=` padding), NOT base64url.
// The BYOS wire/session values (`masterKeyB64`, `saltB64`, `keyCheckB64`) are
// all standard base64; using the url-safe alphabet would break cross-device
// data already written by other devices.
//
// Pure TypeScript with zero Node/Hermes-absent globals: `Buffer` is a Node
// global that does not exist on the Hermes/React Native runtime, so any
// `Buffer.from(...)` base64 path crashes on device even though Jest (Node)
// stays green. This helper is the device-safe replacement.

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const block = (first << 16) | (second << 8) | third;
    output += ALPHABET[(block >> 18) & 63];
    output += ALPHABET[(block >> 12) & 63];
    output += index + 1 < bytes.length ? ALPHABET[(block >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? ALPHABET[block & 63] : '=';
  }
  return output;
}

export function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error('Invalid base64 value.');
  }
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const first = ALPHABET.indexOf(value[index]);
    const second = ALPHABET.indexOf(value[index + 1]);
    const third = value[index + 2] === '='
      ? 0
      : ALPHABET.indexOf(value[index + 2]);
    const fourth = value[index + 3] === '='
      ? 0
      : ALPHABET.indexOf(value[index + 3]);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      throw new Error('Invalid base64 value.');
    }
    const block = (first << 18) | (second << 12) | (third << 6) | fourth;
    bytes.push((block >> 16) & 255);
    if (value[index + 2] !== '=') bytes.push((block >> 8) & 255);
    if (value[index + 3] !== '=') bytes.push(block & 255);
  }
  // `Uint8Array.from(number[])` allocates a standalone buffer (not a view into
  // a shared/pooled ArrayBuffer), which the resolver relies on before handing
  // the key to crypto code.
  return Uint8Array.from(bytes);
}
