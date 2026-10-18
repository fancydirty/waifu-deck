package expo.modules.waifusync;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Streams one response body into an already-reserved library file. */
public final class LibraryStreamCopy {
  private static final int CHUNK_BYTES = 64 * 1024;

  private LibraryStreamCopy() {
  }

  public enum Code {
    NETWORK,
    IO,
    FORMAT,
    CANCELLED,
  }

  public interface ProgressListener {
    void onProgress(long bytesSoFar);
  }

  public interface CancellationCheck {
    boolean isCancelled();
  }

  public static final class StreamCopyException extends Exception {
    public final Code code;

    StreamCopyException(Code code, String message) {
      super(message);
      this.code = code;
    }

    StreamCopyException(Code code, String message, Throwable cause) {
      super(message, cause);
      this.code = code;
    }

    public Code getCode() {
      return code;
    }
  }

  interface OutputStreamFactory {
    OutputStream open(File destination) throws IOException;
  }

  public static long copyToFile(
      InputStream input,
      File destination,
      long maxBytes,
      ProgressListener progress,
      CancellationCheck cancel
  ) throws StreamCopyException {
    return copyToFile(input, destination, maxBytes, progress, cancel, FileOutputStream::new);
  }

  static long copyToFile(
      InputStream input,
      File destination,
      long maxBytes,
      ProgressListener progress,
      CancellationCheck cancel,
      OutputStreamFactory outputFactory
  ) throws StreamCopyException {
    OutputStream output = null;
    byte[] buffer = new byte[CHUNK_BYTES];
    long copied = 0;
    long reported = 0;
    StreamCopyException failure = null;
    try {
      if (input == null || destination == null || progress == null || cancel == null
          || outputFactory == null || maxBytes < 0) {
        throw format("Library stream arguments are invalid.");
      }
      try {
        output = outputFactory.open(destination);
      } catch (Throwable error) {
        throw io("Library destination could not be opened.", error);
      }
      if (output == null) throw io("Library destination stream was not opened.", null);

      while (true) {
        if (isCancelled(cancel)) throw cancelled();
        int read;
        try {
          read = input.read(buffer, 0, buffer.length);
        } catch (Throwable error) {
          if (isCancelled(cancel)) throw cancelled();
          throw network("Library download stream read failed.", error);
        }
        if (read < 0) break;
        if (read == 0) continue;
        if ((long) read > maxBytes - copied) {
          throw format("Library download exceeded its maximum size.");
        }
        try {
          output.write(buffer, 0, read);
        } catch (Throwable error) {
          throw io("Library destination write failed.", error);
        }
        copied += read;
        if (copied - reported >= CHUNK_BYTES) {
          progress.onProgress(copied);
          reported = copied;
        }
      }

      if (copied > reported) {
        progress.onProgress(copied);
        reported = copied;
      }

      try {
        output.flush();
        output.close();
        output = null;
      } catch (Throwable error) {
        throw io("Library destination close failed.", error);
      }
      try {
        input.close();
        input = null;
      } catch (Throwable error) {
        throw io("Library download stream close failed.", error);
      }
      return copied;
    } catch (StreamCopyException error) {
      failure = error;
      throw error;
    } catch (Throwable error) {
      failure = io("Library stream copy failed.", error);
      throw failure;
    } finally {
      closeQuietly(output, failure);
      closeQuietly(input, failure);
      if (failure != null) deleteQuietly(destination, failure);
    }
  }

  private static boolean isCancelled(CancellationCheck cancel) throws StreamCopyException {
    try {
      return cancel.isCancelled();
    } catch (Throwable error) {
      throw io("Library cancellation check failed.", error);
    }
  }

  private static StreamCopyException network(String message, Throwable cause) {
    return new StreamCopyException(Code.NETWORK, message, cause);
  }

  private static StreamCopyException io(String message, Throwable cause) {
    return cause == null
        ? new StreamCopyException(Code.IO, message)
        : new StreamCopyException(Code.IO, message, cause);
  }

  private static StreamCopyException format(String message) {
    return new StreamCopyException(Code.FORMAT, message);
  }

  private static StreamCopyException cancelled() {
    return new StreamCopyException(Code.CANCELLED, "Library download was cancelled.");
  }

  private static void closeQuietly(AutoCloseable closeable, StreamCopyException failure) {
    if (closeable == null) return;
    try {
      closeable.close();
    } catch (Throwable error) {
      if (failure != null) failure.addSuppressed(error);
    }
  }

  private static void deleteQuietly(File file, StreamCopyException failure) {
    boolean deleted = false;
    try {
      deleted = file.delete();
    } catch (Throwable ignored) {
      // The original operation failure remains the primary error.
    }
    if (!deleted) failure.addSuppressed(new IOException("could not delete the output"));
  }
}
