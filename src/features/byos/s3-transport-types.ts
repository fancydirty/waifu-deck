/** User-supplied S3-compatible bucket credentials (four-field config). */
export type S3Credentials = Readonly<{
  endpoint: string; // e.g. https://<accountid>.r2.cloudflarestorage.com
  region: string;   // 'auto' for R2; real region for AWS; 'us-east-1' default for MinIO
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;

/** Product-facing failure categories for the transport layer. */
export type S3FailureCategory =
  | 'network'         // no HTTP response (offline, DNS, TLS)
  | 'credential'      // 401/403 — key/secret/permission problem
  | 'precondition'    // 412/409 — conditional write lost (CAS conflict)
  | 'not_found'       // 404
  | 'rate_limited'    // 429/503 slow-down
  | 'server'          // 5xx other
  | 'client';         // other 4xx (bad request, etc.)

export class S3TransportError extends Error {
  constructor(
    readonly status: number, // 0 when no response was received
    readonly category: S3FailureCategory,
    message: string,
    /**
     * `true` only when the store answered and refused, so nothing was written.
     * `false` when the request may already have taken effect and the caller
     * must not discard durable intent (network cut after send).
     */
    readonly outcomeKnown: boolean = true,
  ) {
    super(message);
    this.name = 'S3TransportError';
    Object.setPrototypeOf(this, S3TransportError.prototype);
  }
}

/** A streamed GET reached the local filesystem but could not be written. */
export class S3LocalWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3LocalWriteError';
    Object.setPrototypeOf(this, S3LocalWriteError.prototype);
  }
}
