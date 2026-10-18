import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function hashHex(payload: Uint8Array): string {
  return bytesToHex(sha256(payload));
}

export function hmacBytes(key: Uint8Array, data: string): Uint8Array {
  return hmac(sha256, key, utf8(data));
}

export type CanonicalInput = Readonly<{
  method: string;
  canonicalUri: string;
  canonicalQuery: string;
  headers: Readonly<Record<string, string>>;
  signedHeaders: readonly string[];
  payloadHashHex: string;
}>;

export function canonicalRequest(input: CanonicalInput): string {
  const canonicalHeaders = input.signedHeaders
    .map((h) => `${h}:${input.headers[h]}\n`)
    .join('');
  return [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    input.signedHeaders.join(';'),
    input.payloadHashHex,
  ].join('\n');
}

export function deriveSigningKey(input: Readonly<{
  secretAccessKey: string;
  dateStamp: string; // YYYYMMDD
  region: string;
  service: string;   // 's3'
}>): Uint8Array {
  const kDate = hmacBytes(utf8(`AWS4${input.secretAccessKey}`), input.dateStamp);
  const kRegion = hmacBytes(kDate, input.region);
  const kService = hmacBytes(kRegion, input.service);
  return hmacBytes(kService, 'aws4_request');
}

export function stringToSign(input: Readonly<{
  amzDate: string;    // YYYYMMDDTHHMMSSZ
  dateStamp: string;
  region: string;
  service: string;
  canonicalRequestHashHex: string;
}>): string {
  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  return [
    'AWS4-HMAC-SHA256',
    input.amzDate,
    scope,
    input.canonicalRequestHashHex,
  ].join('\n');
}

export function authorizationHeader(input: Readonly<{
  accessKeyId: string;
  dateStamp: string;
  region: string;
  service: string;
  signedHeaders: readonly string[];
  signatureHex: string;
}>): string {
  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  return (
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${input.signedHeaders.join(';')}, ` +
    `Signature=${input.signatureHex}`
  );
}

export type SignRequestInput = Readonly<{
  method: string;
  host: string;
  canonicalUri: string;   // already percent-encoded path
  canonicalQuery: string; // already sorted+encoded, may be ''
  extraHeaders: Readonly<Record<string, string>>;
  /**
   * Lowercase hex SHA-256 of the request body, computed by the caller.
   *
   * K6-1e: signing used to take the raw `payload` and hash it here with the
   * pure-JS @noble sha256. On Hermes (no JIT) that is ~1.3 s per 6 MB blob,
   * paid inside every single PUT — three times for one protected image. The
   * digest is now the transport's job (`s3-transport.ts` defaults it to
   * `expo-crypto`'s native `digest`), and signing stays pure and synchronous.
   * `hashHex` below is still the right tool for the small canonical-request
   * string this function hashes itself.
   */
  payloadHashHex: string;
  credentials: import('./s3-transport-types').S3Credentials;
  amzDate: string;        // YYYYMMDDTHHMMSSZ, injected
}>;

export function signRequest(
  input: SignRequestInput,
): Record<string, string> {
  const dateStamp = input.amzDate.slice(0, 8);
  const payloadHashHex = input.payloadHashHex;
  const baseHeaders: Record<string, string> = {
    host: input.host,
    'x-amz-content-sha256': payloadHashHex,
    'x-amz-date': input.amzDate,
  };
  for (const [k, v] of Object.entries(input.extraHeaders)) {
    baseHeaders[k.toLowerCase()] = v;
  }
  const signedHeaders = Object.keys(baseHeaders).sort();
  const cr = canonicalRequest({
    method: input.method,
    canonicalUri: input.canonicalUri,
    canonicalQuery: input.canonicalQuery,
    headers: baseHeaders,
    signedHeaders,
    payloadHashHex,
  });
  const sts = stringToSign({
    amzDate: input.amzDate,
    dateStamp,
    region: input.credentials.region,
    service: 's3',
    canonicalRequestHashHex: hashHex(utf8(cr)),
  });
  const signingKey = deriveSigningKey({
    secretAccessKey: input.credentials.secretAccessKey,
    dateStamp,
    region: input.credentials.region,
    service: 's3',
  });
  const signatureHex = bytesToHex(hmacBytes(signingKey, sts));
  return {
    ...baseHeaders,
    authorization: authorizationHeader({
      accessKeyId: input.credentials.accessKeyId,
      dateStamp,
      region: input.credentials.region,
      service: 's3',
      signedHeaders,
      signatureHex,
    }),
  };
}
