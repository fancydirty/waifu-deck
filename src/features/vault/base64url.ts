const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64Url(bytes: Uint8Array): string {
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
  return output
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64url value.');
  }
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bytes: number[] = [];
  for (let index = 0; index < base64.length; index += 4) {
    const first = ALPHABET.indexOf(base64[index]);
    const second = ALPHABET.indexOf(base64[index + 1]);
    const third = base64[index + 2] === '='
      ? 0
      : ALPHABET.indexOf(base64[index + 2]);
    const fourth = base64[index + 3] === '='
      ? 0
      : ALPHABET.indexOf(base64[index + 3]);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      throw new Error('Invalid base64url value.');
    }
    const block = (first << 18) | (second << 12) | (third << 6) | fourth;
    bytes.push((block >> 16) & 255);
    if (base64[index + 2] !== '=') bytes.push((block >> 8) & 255);
    if (base64[index + 3] !== '=') bytes.push(block & 255);
  }
  return Uint8Array.from(bytes);
}
