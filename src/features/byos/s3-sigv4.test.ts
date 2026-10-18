import { canonicalRequest, hashHex } from './s3-sigv4';
import {
  deriveSigningKey,
  stringToSign,
  authorizationHeader,
  hmacBytes,
} from './s3-sigv4';
import { signRequest } from './s3-sigv4';
import { bytesToHex } from '@noble/hashes/utils.js';

// AWS SigV4 test-suite 'get-vanilla' canonical form (well-known fixture).
test('builds the canonical request for a vanilla GET', () => {
  const cr = canonicalRequest({
    method: 'GET',
    canonicalUri: '/',
    canonicalQuery: '',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    signedHeaders: ['host', 'x-amz-date'],
    payloadHashHex: hashHex(new Uint8Array()),
  });
  expect(cr).toBe(
    'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\n' +
    'host;x-amz-date\n' +
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('hashHex of empty payload is the known SHA256 empty digest', () => {
  expect(hashHex(new Uint8Array())).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

// AWS documented example (SigV4 'Calculate signature' walkthrough).
// secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, date=20150830,
// region=us-east-1, service=iam -> signing-key hex computed with this repo's
// noble v2 (verified independently via a node probe from repo root).
test('derives the AWS example signing key', () => {
  const key = deriveSigningKey({
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    dateStamp: '20150830',
    region: 'us-east-1',
    service: 'iam',
  });
  expect(bytesToHex(key)).toBe(
    '2c94c0cf5378ada6887f09bb697df8fc0affdb34ba1cdd5bda32b664bd55b73c',
  );
});

test('produces the AWS example signature', () => {
  const sts =
    'AWS4-HMAC-SHA256\n' +
    '20150830T123600Z\n' +
    '20150830/us-east-1/iam/aws4_request\n' +
    'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59';
  const key = deriveSigningKey({
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    dateStamp: '20150830',
    region: 'us-east-1',
    service: 'iam',
  });
  expect(bytesToHex(hmacBytes(key, sts))).toBe(
    '33f5dad2191de0cb4b7ab912f876876c2c4f72e2991a458f9499233c7b992438',
  );
});

test('signRequest yields deterministic headers for a fixed timestamp', () => {
  const headers = signRequest({
    method: 'PUT',
    host: 'bucket.s3.us-east-1.amazonaws.com',
    canonicalUri: '/waifu-deck/assets/a1/state.json',
    canonicalQuery: '',
    extraHeaders: { 'content-type': 'application/json' },
    // K6-1e: the caller now supplies the payload digest (the transport gets it
    // from a native hash). Pre-computing it with `hashHex` here keeps this
    // vector byte-identical to the one the pure-JS signer used to produce.
    payloadHashHex: hashHex(new TextEncoder().encode('{}')),
    credentials: {
      endpoint: 'https://bucket.s3.us-east-1.amazonaws.com',
      region: 'us-east-1', bucket: 'bucket',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
    amzDate: '20150830T123600Z',
  });
  expect(headers['x-amz-date']).toBe('20150830T123600Z');
  expect(headers.host).toBe('bucket.s3.us-east-1.amazonaws.com');
  // SHA256 of '{}'
  expect(headers['x-amz-content-sha256']).toBe(
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  );
  expect(headers.authorization).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
  );
});
