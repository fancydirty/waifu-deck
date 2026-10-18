package expo.modules.waifusync;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public final class LibraryStreamCopyTest {
  private static final int CHUNK = 64 * 1024;

  private Path temp;

  @Before
  public void setUp() throws Exception {
    temp = Files.createTempDirectory("stream-copy-test-");
  }

  @After
  public void tearDown() throws Exception {
    if (temp == null) return;
    Files.walk(temp)
        .sorted((a, b) -> b.compareTo(a))
        .forEach(path -> {
          try {
            Files.deleteIfExists(path);
          } catch (IOException ignored) {
            // Best-effort test cleanup.
          }
        });
  }

  @Test
  public void copiesBoundaryAndMultiMiBStreamsByteForByte() throws Exception {
    for (int size : new int[] {1, CHUNK, CHUNK + 1, 3 * 1024 * 1024 + 17}) {
      byte[] input = bytes(size, 0x31 + size);
      File destination = destination("copy-" + size);
      long copied = LibraryStreamCopy.copyToFile(
          new ByteArrayInputStream(input), destination, input.length,
          bytesSoFar -> {}, () -> false);
      assertEquals(size, copied);
      assertArrayEquals(input, Files.readAllBytes(destination.toPath()));
    }
  }

  @Test
  public void reportsAtMostOneProgressEventPer64KiBAndMonotonically() throws Exception {
    byte[] input = bytes(3 * CHUNK + 1, 0x44);
    File destination = destination("progress");
    List<Long> progress = new ArrayList<>();
    long copied = LibraryStreamCopy.copyToFile(
        new ChunkedInputStream(input, 257), destination, input.length,
        progress::add, () -> false);

    assertEquals(input.length, copied);
    assertTrue(progress.size() <= (input.length + CHUNK - 1) / CHUNK);
    long previous = 0;
    for (long value : progress) {
      assertTrue(value >= previous);
      assertTrue(value <= input.length);
      previous = value;
    }
    assertEquals(input.length, (long) progress.get(progress.size() - 1));
  }

  @Test
  public void maxBytesIsCheckedBeforeWritingAnOverLimitChunk() throws Exception {
    byte[] input = bytes(CHUNK + 1, 0x55);
    File destination = destination("too-large");
    ByteArrayOutputStream written = new ByteArrayOutputStream();
    LibraryStreamCopy.StreamCopyException error = expectFailure(() ->
        LibraryStreamCopy.copyToFile(
            new ByteArrayInputStream(input), destination, input.length - 1,
            bytesSoFar -> {}, () -> false,
            file -> written));

    assertEquals(LibraryStreamCopy.Code.FORMAT, error.code);
    assertEquals(input.length - 1, written.size());
    assertFalse(destination.exists());

    File oversizedChunkDestination = destination("too-large-chunk");
    ByteArrayOutputStream oversizedChunkWritten = new ByteArrayOutputStream();
    LibraryStreamCopy.StreamCopyException oversizedChunkError = expectFailure(() ->
        LibraryStreamCopy.copyToFile(
            new ByteArrayInputStream(input), oversizedChunkDestination, CHUNK - 1L,
            bytesSoFar -> {}, () -> false,
            file -> oversizedChunkWritten));
    assertEquals(LibraryStreamCopy.Code.FORMAT, oversizedChunkError.code);
    assertEquals(0, oversizedChunkWritten.size());
    assertFalse(oversizedChunkDestination.exists());
  }

  @Test
  public void inputReadFailureIsNetworkAndDeletesTheDestination() throws Exception {
    File destination = destination("network-failure");
    LibraryStreamCopy.StreamCopyException error = expectFailure(() ->
        LibraryStreamCopy.copyToFile(
            new ThrowingInputStream(bytes(CHUNK + 1, 0x66), CHUNK), destination,
            CHUNK + 1L, bytesSoFar -> {}, () -> false));

    assertEquals(LibraryStreamCopy.Code.NETWORK, error.code);
    assertFalse(destination.exists());
  }

  @Test
  public void outputWriteFailureIsIoAndDeletesTheDestination() throws Exception {
    byte[] input = bytes(CHUNK + 1, 0x77);
    File destination = destination("write-failure");
    List<Long> progress = new ArrayList<>();
    LibraryStreamCopy.StreamCopyException error = expectFailure(() ->
        LibraryStreamCopy.copyToFile(
            new ByteArrayInputStream(input), destination, input.length,
            progress::add, () -> false,
            file -> new FailingOutputStream(CHUNK - 1)));

    assertEquals(LibraryStreamCopy.Code.IO, error.code);
    assertTrue(progress.isEmpty());
    assertFalse(destination.exists());
  }

  @Test
  public void failedCleanupIsSuppressedOnTheOriginalFailure() throws Exception {
    File actualDestination = destination("undeletable");
    LibraryStreamCopy.StreamCopyException error = expectFailure(() ->
        LibraryStreamCopy.copyToFile(
            new ByteArrayInputStream(bytes(1, 0x79)),
            new NonDeletingFile(actualDestination.getPath()),
            1,
            bytesSoFar -> {},
            () -> false,
            file -> { throw new IOException("injected open failure"); }));

    assertEquals(LibraryStreamCopy.Code.IO, error.code);
    assertEquals(1, error.getSuppressed().length);
    assertEquals("could not delete the output", error.getSuppressed()[0].getMessage());
    assertTrue(actualDestination.exists());
  }

  @Test
  public void cancellationAfterThreeChunksDeletesTheDestination() throws Exception {
    byte[] input = bytes(CHUNK * 5, 0x88);
    File destination = destination("cancelled");
    int[] checks = {0};
    LibraryStreamCopy.StreamCopyException error = expectFailure(() ->
        LibraryStreamCopy.copyToFile(
            new ByteArrayInputStream(input), destination, input.length,
            bytesSoFar -> {}, () -> ++checks[0] > 3));

    assertEquals(LibraryStreamCopy.Code.CANCELLED, error.code);
    assertFalse(destination.exists());
    assertEquals(4, checks[0]);
  }

  @Test
  public void cancellationWhileAReadFailsIsCancelledNotNetwork() throws Exception {
    File destination = destination("cancelled-read");
    AtomicBoolean cancelled = new AtomicBoolean(false);
    InputStream input = new InputStream() {
      @Override
      public int read(byte[] buffer, int off, int len) throws IOException {
        cancelled.set(true);
        throw new IOException("injected socket close");
      }

      @Override
      public int read() throws IOException {
        cancelled.set(true);
        throw new IOException("injected socket close");
      }
    };
    LibraryStreamCopy.StreamCopyException error = expectFailure(() ->
        LibraryStreamCopy.copyToFile(input, destination, 1, bytesSoFar -> {}, cancelled::get));

    assertEquals(LibraryStreamCopy.Code.CANCELLED, error.code);
    assertFalse(destination.exists());
  }

  private File destination(String name) throws IOException {
    File file = temp.resolve(name).toFile();
    assertTrue(file.createNewFile());
    return file;
  }

  private static LibraryStreamCopy.StreamCopyException expectFailure(
      ThrowingRunnable operation) throws Exception {
    try {
      operation.run();
      fail("expected stream copy failure");
      return null;
    } catch (LibraryStreamCopy.StreamCopyException error) {
      return error;
    }
  }

  private static byte[] bytes(int size, int seed) {
    byte[] result = new byte[size];
    for (int i = 0; i < result.length; i++) result[i] = (byte) (seed + i * 31);
    return result;
  }

  private interface ThrowingRunnable {
    void run() throws Exception;
  }

  private static final class ChunkedInputStream extends InputStream {
    private final byte[] bytes;
    private final int chunk;
    private int offset;

    ChunkedInputStream(byte[] bytes, int chunk) {
      this.bytes = bytes;
      this.chunk = chunk;
    }

    @Override
    public int read(byte[] buffer, int off, int len) {
      if (offset == bytes.length) return -1;
      int count = Math.min(Math.min(len, chunk), bytes.length - offset);
      System.arraycopy(bytes, offset, buffer, off, count);
      offset += count;
      return count;
    }

    @Override
    public int read() {
      if (offset == bytes.length) return -1;
      return bytes[offset++] & 0xff;
    }
  }

  private static final class ThrowingInputStream extends InputStream {
    private final byte[] bytes;
    private final int failAfter;
    private int offset;

    ThrowingInputStream(byte[] bytes, int failAfter) {
      this.bytes = bytes;
      this.failAfter = failAfter;
    }

    @Override
    public int read(byte[] buffer, int off, int len) throws IOException {
      if (offset >= failAfter) throw new IOException("injected read failure");
      int count = Math.min(len, failAfter - offset);
      System.arraycopy(bytes, offset, buffer, off, count);
      offset += count;
      return count;
    }

    @Override
    public int read() throws IOException {
      if (offset >= failAfter) throw new IOException("injected read failure");
      return bytes[offset++] & 0xff;
    }
  }

  private static final class FailingOutputStream extends OutputStream {
    private final int failAfter;
    private int written;

    FailingOutputStream(int failAfter) {
      this.failAfter = failAfter;
    }

    @Override
    public void write(int value) throws IOException {
      if (written >= failAfter) throw new IOException("injected write failure");
      written++;
    }

    @Override
    public void write(byte[] bytes, int off, int len) throws IOException {
      if (written + len > failAfter) throw new IOException("injected write failure");
      written += len;
    }
  }

  private static final class NonDeletingFile extends File {
    NonDeletingFile(String pathname) {
      super(pathname);
    }

    @Override
    public boolean delete() {
      return false;
    }
  }
}
