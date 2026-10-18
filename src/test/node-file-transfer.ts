import {
  createWriteStream,
  promises as fs,
  mkdtempSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { S3DownloadFilePort } from '@/features/byos/s3-file-download';
import type { S3UploadFilePort } from '@/features/byos/s3-transport';
import type { S3LibraryBlobStagingPort } from '@/features/library/library-cloud-client-s3';
import type { FakeLibraryFilePort } from '@/features/library/library-test-support';

/**
 * Node implementations of the two K6-2 ports, for the MinIO/R2 integration
 * gates only.
 *
 * The gate's whole point is that the WIRE path is real: a blob PUT that streams
 * from a file must produce the same signed request, and the same object in the
 * bucket, as the in-memory PUT it replaces. `expo-file-system`'s upload task
 * has no native module under Node, so injecting these keeps the S3 half — SigV4
 * over the staged file's hash, the raw binary body, the response status — under
 * test against a real backend instead of skipping it.
 *
 * What these do NOT model is progress GRANULARITY: Node's `fetch` cannot report
 * bytes as they leave, so the upload port reports 0 and then the full length.
 * The per-chunk behaviour of the real task is proven in
 * `src/features/byos/s3-file-transfer.test.ts` against the explicit
 * `expo-file-system` double, and its aggregation in
 * `library-protect-action.test.ts`.
 */
export function createNodeUploadFilePort(): S3UploadFilePort {
  return async ({ url, fileUri, headers, onProgress, signal }) => {
    const body = await fs.readFile(fileURLToPath(fileUri));
    onProgress?.({ bytesSent: 0, totalBytes: body.byteLength });
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(body),
      ...(signal === undefined ? {} : { signal }),
    });
    // Drain so the connection is released before the next request.
    await response.arrayBuffer();
    onProgress?.({ bytesSent: body.byteLength, totalBytes: body.byteLength });
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    return { status: response.status, headers: responseHeaders };
  };
}

/** Node equivalent of the native GET-to-file port used by the MinIO gate. */
export function createNodeDownloadFilePort(fetchImpl: typeof fetch = fetch): S3DownloadFilePort {
  return async ({ url, fileUri, headers, maxBytes, onProgress, signal }) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      const failure = new Error(error instanceof Error ? error.message : String(error)) as Error & { code: string };
      failure.code = signal?.aborted ? 'ERR_DOWNLOAD_CANCELLED' : 'ERR_DOWNLOAD_NETWORK';
      throw failure;
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const total = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
    if (!response.ok) {
      const errorBody = (await response.text()).slice(0, 64 * 1024);
      return {
        status: response.status,
        headers: responseHeaders,
        redirected: response.redirected,
        errorBody,
        bytesWritten: 0,
      };
    }

    const path = fileURLToPath(fileUri);
    let writer: ReturnType<typeof createWriteStream> | undefined;
    let bytesWritten = 0;
    try {
      writer = createWriteStream(path, { flags: 'wx' });
      await new Promise<void>((resolve, reject) => {
        writer!.once('open', () => resolve());
        writer!.once('error', reject);
      });
      const reader = response.body?.getReader();
      if (reader === undefined) {
        throw new Error('download response has no body');
      }
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        bytesWritten += value.byteLength;
        if (bytesWritten > maxBytes) {
          const failure = new Error('download exceeds maxBytes') as Error & { code: string };
          failure.code = 'ERR_LIBRARY_FORMAT';
          throw failure;
        }
        if (!writer.write(value)) {
          await new Promise<void>((resolve, reject) => {
            writer!.once('drain', resolve);
            writer!.once('error', reject);
          });
        }
        onProgress?.({ bytesReceived: bytesWritten, total });
      }
      await new Promise<void>((resolve, reject) => {
        writer!.once('error', reject);
        writer!.end(resolve);
      });
      return {
        status: response.status,
        headers: responseHeaders,
        redirected: response.redirected,
        errorBody: '',
        bytesWritten,
      };
    } catch (error) {
      writer?.destroy();
      await fs.rm(path, { force: true });
      if (error instanceof Error && 'code' in error && (
        error as Error & { code?: string }
      ).code === 'ERR_LIBRARY_FORMAT') throw error;
      const failure = new Error(error instanceof Error ? error.message : String(error)) as Error & { code: string };
      failure.code = signal?.aborted ? 'ERR_DOWNLOAD_CANCELLED' : 'ERR_LIBRARY_IO';
      throw failure;
    }
  };
}

/** A real on-disk staging area, mirroring the device's cache temp directory. */
export function createNodeBlobStaging(): S3LibraryBlobStagingPort {
  const directory = mkdtempSync(join(tmpdir(), 'byos-blob-staging-'));
  return {
    resolveTemp: (name) => pathToFileURL(join(directory, name)).href,
    async writeBytes(uri, bytes) {
      await fs.writeFile(fileURLToPath(uri), bytes);
    },
    async delete(uri) {
      await fs.rm(fileURLToPath(uri), { force: true });
    },
  };
}

/**
 * Gives the Node integration fake two real directories: the stream root its
 * name promises, and (board row 45) the library share staging area, so staged
 * share copies are real files like the device's native `File.copy` produces.
 * The fake map stays authoritative for every other library area, while stream
 * and share files can be written by the real Node download/staging ports.
 */
export function withNodeStreamRoot(port: FakeLibraryFilePort): FakeLibraryFilePort {
  const directory = mkdtempSync(join(tmpdir(), 'waifudeck-library-stream-'));
  const rootPath = directory;
  const rootUri = pathToFileURL(directory).href;
  const sharePath = mkdtempSync(join(tmpdir(), 'waifudeck-library-share-'));
  const shareUri = pathToFileURL(sharePath).href;

  const realRootPaths = [rootPath, sharePath];
  const realPathFor = (uri: string): string | null => {
    let candidate: string;
    try {
      candidate = fileURLToPath(uri);
    } catch {
      return null;
    }
    for (const rootPath of realRootPaths) {
      const relativePath = relative(rootPath, candidate);
      if (
        relativePath.length === 0
        || relativePath === '..'
        || relativePath.startsWith(`..${sep}`)
        || isAbsolute(relativePath)
      ) {
        continue;
      }
      return candidate;
    }
    return null;
  };

  const readReal = async (uri: string): Promise<Uint8Array> => (
    new Uint8Array(await fs.readFile(realPathFor(uri) as string))
  );

  const writeReal = async (uri: string, bytes: Uint8Array): Promise<void> => {
    if (port.failWrites) throw new Error('disk full');
    await fs.writeFile(realPathFor(uri) as string, bytes);
  };

  const isRealFile = async (uri: string): Promise<boolean> => {
    const path = realPathFor(uri);
    if (path === null) return false;
    try {
      return (await fs.stat(path)).isFile();
    } catch {
      return false;
    }
  };

  const wrapped: FakeLibraryFilePort = {
    ...port,
    streamRootUri: rootUri,
    resolveStream: (name) => pathToFileURL(join(rootPath, name)).href,
    shareRootUri: shareUri,
    resolveShare: (name) => pathToFileURL(join(sharePath, name)).href,
    async ensureDirectories() {
      await port.ensureDirectories();
      await fs.mkdir(rootPath, { recursive: true });
      await fs.mkdir(sharePath, { recursive: true });
    },
    async exists(uri) {
      return realPathFor(uri) === null ? port.exists(uri) : isRealFile(uri);
    },
    async probe(uri) {
      if (realPathFor(uri) === null) return port.probe(uri);
      return (await isRealFile(uri)) ? 'present' : 'absent';
    },
    async size(uri) {
      const path = realPathFor(uri);
      if (path === null) return port.size(uri);
      try {
        return (await fs.stat(path)).size;
      } catch {
        return 0;
      }
    },
    async readBytes(uri) {
      return realPathFor(uri) === null ? port.readBytes(uri) : readReal(uri);
    },
    async readPrefix(uri, length) {
      const path = realPathFor(uri);
      if (path === null) return port.readPrefix(uri, length);
      const handle = await fs.open(path, 'r');
      try {
        const prefix = new Uint8Array(length);
        // A single read may come back short before EOF; the contract is
        // exactly min(length, size) bytes, so keep filling from where the
        // last read stopped until the length or a zero-byte read.
        let total = 0;
        while (total < length) {
          const { bytesRead } = await handle.read(prefix, total, length - total, total);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        return prefix.subarray(0, total);
      } finally {
        await handle.close();
      }
    },
    async writeBytes(uri, bytes) {
      if (port.failWrites) throw new Error('disk full');
      if (realPathFor(uri) === null) {
        await port.writeBytes(uri, bytes);
        return;
      }
      await writeReal(uri, bytes);
    },
    async delete(uri) {
      if (realPathFor(uri) === null) {
        await port.delete(uri);
        return;
      }
      port.deletedFiles.push(uri);
      await fs.rm(realPathFor(uri) as string, { force: true });
    },
    async listStream() {
      try {
        const entries = await fs.readdir(rootPath, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => pathToFileURL(join(rootPath, entry.name)).href);
      } catch {
        return [];
      }
    },
    async listShare() {
      try {
        const entries = await fs.readdir(sharePath, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => pathToFileURL(join(sharePath, entry.name)).href);
      } catch {
        return [];
      }
    },
    async copyFrom(sourceUri, destinationUri) {
      const sourcePath = realPathFor(sourceUri);
      const destinationPath = realPathFor(destinationUri);
      if (sourcePath === null && destinationPath === null) {
        await port.copyFrom(sourceUri, destinationUri);
        return;
      }
      if (port.unreadableSources.has(sourceUri)) {
        throw new Error(`permission revoked for ${sourceUri}`);
      }
      const bytes = sourcePath === null
        ? await port.readBytes(sourceUri)
        : await readReal(sourceUri);
      if (destinationPath === null) {
        await wrapped.writeBytes(destinationUri, bytes);
        return;
      }
      await writeReal(destinationUri, bytes);
    },
    async move(sourceUri, destinationUri) {
      const sourcePath = realPathFor(sourceUri);
      if (sourcePath === null) {
        await port.move(sourceUri, destinationUri);
        return;
      }
      if (port.failMoves) throw new Error('rename failed');
      if (port.unreadableSources.has(sourceUri)) {
        throw new Error(`permission revoked for ${sourceUri}`);
      }
      const bytes = await readReal(sourceUri);
      if (realPathFor(destinationUri) === null) {
        await wrapped.writeBytes(destinationUri, bytes);
      } else {
        await writeReal(destinationUri, bytes);
      }
      await fs.rm(sourcePath);
    },
  };

  Object.defineProperties(wrapped, {
    failWrites: {
      configurable: true,
      enumerable: true,
      get: () => port.failWrites,
      set: (value: boolean) => { port.failWrites = value; },
    },
    failMoves: {
      configurable: true,
      enumerable: true,
      get: () => port.failMoves,
      set: (value: boolean) => { port.failMoves = value; },
    },
  });

  return wrapped;
}

/**
 * Byte length of a staged file, or null when it does not exist — the adapter's
 * `statFile` port. Synchronous `statSync` under the async signature on purpose:
 * a real `fs.stat` resolves on the libuv poll phase, which
 * `jest.advanceTimersByTimeAsync` does not pump, so an async stat would leave
 * the upload watchdog's fake timer un-armed inside the single-advance
 * fake-timer tests. Staged files are tiny, so reading them synchronously keeps
 * the port a pure microtask without changing its observable behaviour.
 */
export function createNodeFileStat(): (fileUri: string) => Promise<number | null> {
  return async (fileUri) => {
    try {
      return statSync(fileURLToPath(fileUri)).size;
    } catch {
      return null;
    }
  };
}

/** Sequential `fragmentBytes` slices of a staged file (the last one shorter) — the adapter's `readFragments` port. Synchronous read for the same fake-timer reason as `createNodeFileStat`. */
export function createNodeFragmentReader(): (fileUri: string, fragmentBytes: number) => AsyncIterable<Uint8Array> {
  return async function* fragments(fileUri, fragmentBytes) {
    const bytes = new Uint8Array(readFileSync(fileURLToPath(fileUri)));
    for (let offset = 0; offset < bytes.byteLength; offset += fragmentBytes) {
      yield bytes.subarray(offset, Math.min(offset + fragmentBytes, bytes.byteLength));
    }
  };
}
