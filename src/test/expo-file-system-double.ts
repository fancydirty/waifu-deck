/**
 * An explicit, inspectable stand-in for the `expo-file-system` SDK 56 network
 * task surface (`File#createUploadTask` / `UploadTask#uploadAsync` /
 * `UploadType`), for Jest only.
 *
 * It exists for the same reason `expo-crypto-double.ts` does. Under
 * `jest-expo` an unmocked native module does not fail — it answers with
 * silently wrong values (the crypto module returns a 32-byte ZERO digest), so a
 * test can pass against garbage and only break on a real device. There is no
 * safe "partial" version of that hazard for an upload task: an auto-mocked
 * `createUploadTask` would return `undefined` and any assertion about the
 * request it made would be vacuous. Everything below is therefore explicit —
 * the module records exactly what the production adapter asked for, and a test
 * scripts exactly what the task answers.
 *
 * Only the members `src/features/byos/s3-file-transfer.ts` actually uses are
 * implemented; anything else is deliberately absent so a future caller that
 * needs more has to add it here rather than silently receive a mock.
 */
import type {
  UploadOptions,
  UploadProgress,
  UploadResult,
} from 'expo-file-system';

export type RecordedUpload = Readonly<{
  fileUri: string;
  url: string;
  options: UploadOptions | undefined;
}>;

export type UploadPlan = Readonly<{
  /** Progress events emitted, in order, before the result settles. */
  progress?: readonly UploadProgress[];
  /** Resolved result. Mutually exclusive with `failWith`. */
  result?: UploadResult;
  /** Rejection thrown from `uploadAsync()` (a dead socket, an abort). */
  failWith?: Error;
}>;

const DEFAULT_RESULT: UploadResult = { status: 200, headers: {}, body: '' };

let plan: UploadPlan = {};
const calls: RecordedUpload[] = [];

/** Every `createUploadTask` the code under test issued, in order. */
export function recordedUploads(): readonly RecordedUpload[] {
  return calls;
}

/** Scripts what the next `uploadAsync()` calls report and answer. */
export function setUploadPlan(next: UploadPlan): void {
  plan = next;
}

export function resetExpoFileSystemDouble(): void {
  plan = {};
  calls.length = 0;
}

/** Mirrors the real module's enum values (BINARY_CONTENT is 0, the default). */
export const UploadType = {
  BINARY_CONTENT: 0,
  MULTIPART: 1,
} as const;

export class UploadTask {
  constructor(
    private readonly file: File,
    private readonly url: string,
    private readonly options: UploadOptions | undefined,
  ) {}

  async uploadAsync(): Promise<UploadResult> {
    for (const event of plan.progress ?? []) {
      this.options?.onProgress?.(event);
    }
    if (plan.failWith !== undefined) throw plan.failWith;
    return plan.result ?? DEFAULT_RESULT;
  }
}

export class File {
  constructor(readonly uri: string) {}

  createUploadTask(url: string, options?: UploadOptions): UploadTask {
    calls.push({ fileUri: this.uri, url, options });
    return new UploadTask(this, url, options);
  }
}
