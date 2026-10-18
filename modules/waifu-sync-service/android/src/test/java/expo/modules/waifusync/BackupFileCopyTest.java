package expo.modules.waifusync;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Random;
import org.junit.Test;

public final class BackupFileCopyTest {
  @Test
  public void validatesStrictLowercaseSha256Hex() {
    assertTrue(BackupImportStreamHelper.isValidSha256Hex(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
    assertFalse(BackupImportStreamHelper.isValidSha256Hex(null));
    assertFalse(BackupImportStreamHelper.isValidSha256Hex(""));
    assertFalse(BackupImportStreamHelper.isValidSha256Hex(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde"));
    assertFalse(BackupImportStreamHelper.isValidSha256Hex(
        "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"));
    assertFalse(BackupImportStreamHelper.isValidSha256Hex(
        "' OR 1=1 --00000000000000000000000000000000000000000000000000000"));
  }

  @Test
  public void requireValidSha256HexRejectsNonHexOrSqlInjectionDigests() {
    String[] invalidDigests = {
      "",
      "short",
      "A".repeat(64),
      "a".repeat(63) + "g",
      "' OR '1'='1' -- " + "a".repeat(48),
    };
    for (String bad : invalidDigests) {
      try {
        BackupImportStreamHelper.requireValidSha256Hex(bad);
        fail("Expected IllegalArgumentException for digest: " + bad);
      } catch (IllegalArgumentException expected) {
        assertTrue(expected.getMessage().contains("Invalid backup import sha256"));
      }
    }
  }

  @Test
  public void streamWithSha256CopiesMultiChunkPayloadsAndComputesExactHexDigest() throws Exception {
    byte[] payload = new byte[150 * 1024 + 37];
    new Random(0x6D4A11L).nextBytes(payload);
    ByteArrayInputStream input = new ByteArrayInputStream(payload);
    ByteArrayOutputStream output = new ByteArrayOutputStream();

    BackupImportStreamHelper.ImportCopyResult result =
        BackupImportStreamHelper.streamWithSha256(input, output);

    assertEquals(payload.length, result.getBytesWritten());
    assertArrayEquals(payload, output.toByteArray());

    byte[] digestBytes = MessageDigest.getInstance("SHA-256").digest(payload);
    StringBuilder expectedHex = new StringBuilder(64);
    for (byte b : digestBytes) {
      expectedHex.append(String.format("%02x", b & 0xff));
    }
    assertEquals(expectedHex.toString(), result.getPlaintextSha256());
  }

  @Test
  public void streamWithSha256MatchesKnownAsciiVector() throws Exception {
    byte[] payload = "abc".getBytes(StandardCharsets.UTF_8);
    ByteArrayInputStream input = new ByteArrayInputStream(payload);
    ByteArrayOutputStream output = new ByteArrayOutputStream();

    BackupImportStreamHelper.ImportCopyResult result =
        BackupImportStreamHelper.streamWithSha256(input, output);

    assertEquals(3L, result.getBytesWritten());
    assertEquals(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        result.getPlaintextSha256());
  }
}
