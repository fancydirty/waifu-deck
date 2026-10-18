package expo.modules.waifusync;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Pure-JVM helpers for streaming and verifying v2 backup import blobs. */
public final class BackupImportStreamHelper {
  public static final int BUFFER_SIZE = 64 * 1024;
  private static final char[] HEX_CHARS = "0123456789abcdef".toCharArray();

  private BackupImportStreamHelper() {
  }

  public static final class ImportCopyResult {
    private final long bytesWritten;
    private final String plaintextSha256;

    public ImportCopyResult(long bytesWritten, String plaintextSha256) {
      this.bytesWritten = bytesWritten;
      this.plaintextSha256 = plaintextSha256;
    }

    public long getBytesWritten() {
      return bytesWritten;
    }

    public String getPlaintextSha256() {
      return plaintextSha256;
    }
  }

  public static boolean isValidSha256Hex(String value) {
    if (value == null || value.length() != 64) {
      return false;
    }
    for (int i = 0; i < 64; i += 1) {
      char ch = value.charAt(i);
      boolean isDigit = ch >= '0' && ch <= '9';
      boolean isLowerHex = ch >= 'a' && ch <= 'f';
      if (!isDigit && !isLowerHex) {
        return false;
      }
    }
    return true;
  }

  public static void requireValidSha256Hex(String value) {
    if (!isValidSha256Hex(value)) {
      throw new IllegalArgumentException("Invalid backup import sha256 digest.");
    }
  }

  public static ImportCopyResult streamWithSha256(
      InputStream input,
      OutputStream output
  ) throws IOException {
    MessageDigest digest;
    try {
      digest = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("SHA-256 is unavailable.", error);
    }
    byte[] buffer = new byte[BUFFER_SIZE];
    long written = 0L;
    while (true) {
      int read = input.read(buffer);
      if (read < 0) break;
      if (read == 0) continue;
      output.write(buffer, 0, read);
      digest.update(buffer, 0, read);
      written += read;
    }
    output.flush();
    byte[] hashBytes = digest.digest();
    char[] hex = new char[hashBytes.length * 2];
    for (int i = 0; i < hashBytes.length; i += 1) {
      int v = hashBytes[i] & 0xFF;
      hex[i * 2] = HEX_CHARS[v >>> 4];
      hex[i * 2 + 1] = HEX_CHARS[v & 0x0F];
    }
    return new ImportCopyResult(written, new String(hex));
  }
}
