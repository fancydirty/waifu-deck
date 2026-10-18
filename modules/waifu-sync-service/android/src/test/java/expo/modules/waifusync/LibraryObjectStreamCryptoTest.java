package expo.modules.waifusync;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public final class LibraryObjectStreamCryptoTest {
  private static final int CHUNK = 64 * 1024;
  private static final int OVERHEAD = 96;
  private static final int MAX_ENVELOPE = 64 * 1024 * 1024;
  private static final int MAX_PLAINTEXT = MAX_ENVELOPE - OVERHEAD;
  private static final String ASSET_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  private static final byte[] MAGIC = "WDLIB001".getBytes(StandardCharsets.UTF_8);
  private static final Random RANDOM = new Random(0x31A5EEDL);

  private Path temp;

  @Before
  public void setUp() throws Exception {
    temp = Files.createTempDirectory("wdlib001-test-");
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
  public void ghashTableMatchesTheReferenceMultiply() {
    Random random = new Random(0x5EED1234L);
    for (int i = 0; i < 10_000; i++) {
      byte[] h = new byte[16];
      byte[] x = new byte[16];
      random.nextBytes(h);
      random.nextBytes(x);
      assertArrayEquals("pair " + i,
          referenceMultiply(h, x),
          LibraryObjectStreamCrypto.multiplyGhashForTest(h, x));
    }
  }

  @Test
  public void nistGcmVectorsDecrypt() throws Exception {
    // NIST SP 800-38D Appendix B/C AES-256, 96-bit-IV test cases 13--16:
    // empty, 16-byte, 64-byte without AAD, and 60-byte with 20-byte AAD.
    byte[] zeroKey = new byte[32];
    byte[] zeroIv = new byte[12];
    assertArrayEquals(new byte[0], LibraryObjectStreamCrypto.decryptPayloadForTest(
        zeroKey, zeroIv, new byte[0], hex("530f8afbc74536b9a963b4f1c4cb738b")));
    byte[] zero16 = new byte[16];
    assertArrayEquals(zero16, LibraryObjectStreamCrypto.decryptPayloadForTest(
        zeroKey, zeroIv, new byte[0],
        hex("cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919")));

    final byte[] key = hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308");
    final byte[] iv = hex("cafebabefacedbaddecaf888");
    byte[] p64 = hex(
        "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72"
            + "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255");
    assertArrayEquals(p64, LibraryObjectStreamCrypto.decryptPayloadForTest(
        key, iv, new byte[0], hex(
            "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa"
                + "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad"
                + "b094dac5d93471bdec1a502270e3cc6c")));

    byte[] aad = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
    byte[] p60 = hex(
        "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72"
            + "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
    assertArrayEquals(p60, LibraryObjectStreamCrypto.decryptPayloadForTest(
        key, iv, aad, hex(
            "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa"
                + "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662"
                + "76fc6ece0f4e1768cddf8853bb2d551b")));
  }

  @Test
  public void matchesThePlatformOneShotGcmAtBoundarySizes() throws Exception {
    int[] sizes = {1, 15, 16, 17, 65_535, 65_536, 65_537, 1_048_579};
    SecureRandom random = new SecureRandom();
    for (int size : sizes) {
      byte[] key = new byte[32];
      byte[] iv = new byte[12];
      byte[] aad = new byte[1 + random.nextInt(80)];
      byte[] plain = new byte[size];
      random.nextBytes(key);
      random.nextBytes(iv);
      random.nextBytes(aad);
      random.nextBytes(plain);
      assertArrayEquals("size " + size, plain,
          LibraryObjectStreamCrypto.decryptPayloadForTest(key, iv, aad,
              gcmEncrypt(key, iv, aad, plain)));
    }
  }

  @Test
  public void bulkPathCrossesChunkBoundaryWithPartialTail() throws Exception {
    int size = CHUNK + 17;
    byte[] key = bytes(32, 22);
    byte[] nonce = bytes(12, 23);
    byte[] aad = "bulk-boundary-aad".getBytes(StandardCharsets.UTF_8);
    byte[] plaintext = bytes(size, 24);
    assertArrayEquals(plaintext, LibraryObjectStreamCrypto.decryptPayloadForTest(
        key, nonce, aad, gcmEncrypt(key, nonce, aad, plaintext)));
  }

  @Test
  public void decryptsFixtureEnvelopesToTheirDigests() throws Exception {
    List<Fixture> fixtures = readFixtures();
    assertEquals(12, fixtures.size());
    for (Fixture fixture : fixtures) {
      File source = copyResourceToTemp("wdlib001/" + fixture.file);
      File dest = temp.resolve(fixture.file + ".plain").toFile();
      LibraryObjectStreamCrypto.Result result = LibraryObjectStreamCrypto.decryptToFile(
          source, dest, hex(fixture.masterKey), fixture.assetId, fixture.scope,
          () -> false);
      assertEquals(fixture.plaintextBytes, result.plaintextBytes);
      assertEquals(fixture.plaintextSha256, result.plaintextSha256);
      assertEquals(fixture.plaintextSha256, sha256Hex(Files.readAllBytes(dest.toPath())));
      if ("original".equals(fixture.scope)) assertEquals(fixture.assetId, result.plaintextSha256);
    }
  }

  @Test
  public void tamperingIsIntegrityAndDeletesDestination() throws Exception {
    byte[] master = bytes(32, 1);
    Envelope envelope = makeEnvelope(master, ASSET_ID, "original", bytes(65_537, 2));
    int[] offsets = {80 + 123, envelope.bytes.length - 1};
    for (int offset : offsets) {
      File source = write("tamper-" + offset + ".wdlib", envelope.bytes);
      byte[] before = Files.readAllBytes(source.toPath());
      byte[] changed = before.clone();
      changed[offset] ^= 1;
      Files.write(source.toPath(), changed);
      File dest = temp.resolve(source.getName() + ".out").toFile();
      expectCode(LibraryObjectStreamCrypto.Code.INTEGRITY, () ->
          LibraryObjectStreamCrypto.decryptToFile(source, dest, master, ASSET_ID, "original", () -> false));
      assertFalse(dest.exists());
      assertArrayEquals(changed, Files.readAllBytes(source.toPath()));
    }

    File source = write("wrong-key.wdlib", envelope.bytes);
    for (int i = 0; i < 3; i++) {
      File dest = temp.resolve("wrong-" + i).toFile();
      if (i == 0) {
        expectCode(LibraryObjectStreamCrypto.Code.INTEGRITY, () ->
            LibraryObjectStreamCrypto.decryptToFile(source, dest, bytes(32, 9), ASSET_ID, "original", () -> false));
      } else if (i == 1) {
        expectCode(LibraryObjectStreamCrypto.Code.INTEGRITY, () ->
            LibraryObjectStreamCrypto.decryptToFile(source, dest, master,
                "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd", "original", () -> false));
      } else {
        expectCode(LibraryObjectStreamCrypto.Code.INTEGRITY, () ->
            LibraryObjectStreamCrypto.decryptToFile(source, dest, master, ASSET_ID, "thumbnail", () -> false));
      }
      assertFalse(dest.exists());
    }
  }

  @Test
  public void truncationAndExtensionAreIntegrityAndDeleteDestination() throws Exception {
    byte[] master = bytes(32, 3);
    Envelope envelope = makeEnvelope(master, ASSET_ID, "preview", bytes(257, 4));
    for (int delta : new int[] {-1, 1}) {
      File source = temp.resolve("shape-" + delta).toFile();
      byte[] changed = Arrays.copyOf(envelope.bytes, envelope.bytes.length + delta);
      if (delta > 0) changed[changed.length - 1] = 0x55;
      Files.write(source.toPath(), changed);
      File dest = temp.resolve(source.getName() + ".out").toFile();
      expectCode(LibraryObjectStreamCrypto.Code.INTEGRITY, () ->
          LibraryObjectStreamCrypto.decryptToFile(source, dest, master, ASSET_ID, "preview", () -> false));
      assertFalse(dest.exists());
    }
  }

  @Test
  public void formatFailuresHappenBeforeDestinationCreation() throws Exception {
    byte[] master = bytes(32, 5);
    Envelope envelope = makeEnvelope(master, ASSET_ID, "original", bytes(17, 6));
    File wrongMagic = write("bad-magic", envelope.bytes);
    byte[] bad = Files.readAllBytes(wrongMagic.toPath());
    bad[0] = 'X';
    Files.write(wrongMagic.toPath(), bad);
    expectFormat(wrongMagic, master, ASSET_ID, "original");

    File minimum = temp.resolve("minimum").toFile();
    try (OutputStream output = Files.newOutputStream(minimum.toPath())) {
      output.write(new byte[OVERHEAD]);
    }
    expectFormat(minimum, master, ASSET_ID, "original");

    File oversized = temp.resolve("oversized").toFile();
    try (OutputStream output = Files.newOutputStream(oversized.toPath())) {
      output.write(MAGIC);
    }
    try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(oversized, "rw")) {
      raf.setLength((long) MAX_ENVELOPE + 1);
    }
    expectFormat(oversized, master, ASSET_ID, "original");

    File valid = write("valid-envelope", envelope.bytes);
    expectFormat(valid, master, "not-an-asset", "original");
    expectFormat(valid, master, ASSET_ID, "metadata");
    expectFormat(valid, bytes(31, 7), ASSET_ID, "original");
    expectFormat(valid, null, ASSET_ID, "original");
  }

  @Test
  public void closeErrorsStillDeleteDecryptAndCopyDestinations() throws Exception {
    byte[] master = bytes(32, 16);
    Envelope envelope = makeEnvelope(master, ASSET_ID, "original", bytes(257, 17));
    File source = write("close-error-source.wdlib", envelope.bytes);
    File decryptDest = temp.resolve("close-error-decrypt").toFile();
    expectCode(LibraryObjectStreamCrypto.Code.IO, () ->
        LibraryObjectStreamCrypto.decryptToFile(source, decryptDest, master, ASSET_ID, "original", () -> false,
            file -> new ErrorOnCloseOutputStream(new java.io.FileOutputStream(file))));
    assertFalse(decryptDest.exists());

    File plain = write("close-error-plain", bytes(257, 18));
    File copyDest = temp.resolve("close-error-copy").toFile();
    expectCode(LibraryObjectStreamCrypto.Code.IO, () ->
        LibraryObjectStreamCrypto.copyWithSha256(plain, copyDest, () -> false,
            file -> new ErrorOnCloseOutputStream(new java.io.FileOutputStream(file))));
    assertFalse(copyDest.exists());
  }

  @Test
  public void failedDeleteIsSuppressedOnTheOriginalFailure() throws Exception {
    byte[] master = bytes(32, 19);
    Envelope envelope = makeEnvelope(master, ASSET_ID, "original", bytes(257, 20));
    File source = write("delete-failure-source.wdlib", envelope.bytes);
    File actualDecrypt = temp.resolve("delete-failure-decrypt").toFile();
    LibraryObjectStreamCrypto.StreamCryptoException decryptError = expectStreamError(() ->
        LibraryObjectStreamCrypto.decryptToFile(source, new NonDeletingFile(actualDecrypt.getPath()), master,
            ASSET_ID, "original", () -> false,
            file -> { throw new IOException("injected output failure"); }));
    assertEquals(LibraryObjectStreamCrypto.Code.IO, decryptError.code);
    assertSuppressedDeleteFailure(decryptError);
    assertTrue(actualDecrypt.exists());

    File plain = write("delete-failure-plain", bytes(257, 21));
    File actualCopy = temp.resolve("delete-failure-copy").toFile();
    LibraryObjectStreamCrypto.StreamCryptoException copyError = expectStreamError(() ->
        LibraryObjectStreamCrypto.copyWithSha256(plain, new NonDeletingFile(actualCopy.getPath()), () -> false,
            file -> { throw new IOException("injected output failure"); }));
    assertEquals(LibraryObjectStreamCrypto.Code.IO, copyError.code);
    assertSuppressedDeleteFailure(copyError);
    assertTrue(actualCopy.exists());
  }

  @Test
  public void refusesAnExistingDestination() throws Exception {
    byte[] master = bytes(32, 8);
    Envelope envelope = makeEnvelope(master, ASSET_ID, "original", bytes(16, 9));
    File source = write("existing-source", envelope.bytes);
    File dest = write("existing-dest", "keep-me".getBytes(StandardCharsets.UTF_8));
    expectCode(LibraryObjectStreamCrypto.Code.IO, () ->
        LibraryObjectStreamCrypto.decryptToFile(source, dest, master, ASSET_ID, "original", () -> false));
    assertArrayEquals("keep-me".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(dest.toPath()));
  }

  @Test
  public void cancellationStopsWithinOneChunkAndDeletesTheOutput() throws Exception {
    byte[] master = bytes(32, 10);
    Envelope envelope = makeEnvelope(master, ASSET_ID, "original", bytes(CHUNK * 4 + 17, 11));
    File source = write("cancel-source", envelope.bytes);
    byte[] before = Files.readAllBytes(source.toPath());
    File dest = temp.resolve("cancel-dest").toFile();
    final int[] checks = {0};
    expectCode(LibraryObjectStreamCrypto.Code.CANCELLED, () ->
        LibraryObjectStreamCrypto.decryptToFile(source, dest, master, ASSET_ID, "original", () -> ++checks[0] > 3));
    assertFalse(dest.exists());
    assertArrayEquals(before, Files.readAllBytes(source.toPath()));
    assertTrue(checks[0] <= 5);
  }

  @Test
  public void aWriteFailureIsIoAndLeavesNoOutput() throws Exception {
    byte[] master = bytes(32, 12);
    Envelope envelope = makeEnvelope(master, ASSET_ID, "thumbnail", bytes(100_000, 13));
    File source = write("write-failure-source", envelope.bytes);
    File dest = temp.resolve("write-failure-dest").toFile();
    expectCode(LibraryObjectStreamCrypto.Code.IO, () ->
        LibraryObjectStreamCrypto.decryptToFile(source, dest, master, ASSET_ID, "thumbnail", () -> false,
            file -> new FailingOutputStream(new java.io.FileOutputStream(file), 5_000)));
    assertFalse(dest.exists());
  }

  @Test
  public void passthroughCopyHashesAndEnforcesTheSizeRule() throws Exception {
    File source = write("plain", bytes(100_003, 14));
    File dest = temp.resolve("plain-copy").toFile();
    LibraryObjectStreamCrypto.Result result = LibraryObjectStreamCrypto.copyWithSha256(
        source, dest, () -> false);
    assertEquals(source.length(), result.plaintextBytes);
    assertEquals(sha256Hex(Files.readAllBytes(source.toPath())), result.plaintextSha256);
    assertArrayEquals(Files.readAllBytes(source.toPath()), Files.readAllBytes(dest.toPath()));

    File empty = write("empty", new byte[0]);
    File emptyDest = temp.resolve("empty-out").toFile();
    expectCode(LibraryObjectStreamCrypto.Code.FORMAT, () ->
        LibraryObjectStreamCrypto.copyWithSha256(empty, emptyDest, () -> false));
    assertFalse(emptyDest.exists());
    File tooLarge = temp.resolve("too-large").toFile();
    try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(tooLarge, "rw")) {
      raf.setLength((long) MAX_PLAINTEXT + 1);
    }
    File largeDest = temp.resolve("large-out").toFile();
    expectCode(LibraryObjectStreamCrypto.Code.FORMAT, () ->
        LibraryObjectStreamCrypto.copyWithSha256(tooLarge, largeDest, () -> false));
    assertFalse(largeDest.exists());

    File existing = write("copy-existing", "untouched".getBytes(StandardCharsets.UTF_8));
    expectCode(LibraryObjectStreamCrypto.Code.IO, () ->
        LibraryObjectStreamCrypto.copyWithSha256(source, existing, () -> false));
    assertArrayEquals("untouched".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(existing.toPath()));

    File cancelDest = temp.resolve("copy-cancel").toFile();
    expectCode(LibraryObjectStreamCrypto.Code.CANCELLED, () ->
        LibraryObjectStreamCrypto.copyWithSha256(source, cancelDest, () -> true));
    assertFalse(cancelDest.exists());
  }

  @Test
  public void memoryDoesNotScaleWithTheObject() throws Exception {
    byte[] master = bytes(32, 15);
    File source = temp.resolve("large.wdlib").toFile();
    final int plaintextBytes = 32 * 1024 * 1024;
    writeLargeEnvelope(source, master, ASSET_ID, "original", plaintextBytes);
    File dest = temp.resolve("large.out").toFile();
    LibraryObjectStreamCrypto.Result result = LibraryObjectStreamCrypto.decryptToFile(
        source, dest, master, ASSET_ID, "original", () -> false);
    assertEquals(plaintextBytes, result.plaintextBytes);
    assertEquals(sha256Deterministic(plaintextBytes, 0x55), result.plaintextSha256);

    File sealed = temp.resolve("large.sealed.wdlib").toFile();
    LibraryObjectStreamCrypto.EncryptResult encrypted = LibraryObjectStreamCrypto.encryptToFile(
        dest, sealed, master, ASSET_ID, "original", () -> false);
    assertEquals(plaintextBytes, encrypted.plaintextBytes);
    assertEquals((long) plaintextBytes + OVERHEAD, encrypted.envelopeBytes);
    assertEquals(result.plaintextSha256, encrypted.plaintextSha256);

    File roundTrip = temp.resolve("large.roundtrip.out").toFile();
    LibraryObjectStreamCrypto.Result reopened = LibraryObjectStreamCrypto.decryptToFile(
        sealed, roundTrip, master, ASSET_ID, "original", () -> false);
    assertEquals(plaintextBytes, reopened.plaintextBytes);
    assertEquals(result.plaintextSha256, reopened.plaintextSha256);
  }

  @Test
  public void encryptToFileRoundTripsBoundarySizesAndEnforcesFormatAndCancellation() throws Exception {
    byte[] master = bytes(32, 41);
    int[] sizes = {1, 15, 16, 17, 65_535, 65_536, 65_537, CHUNK * 2 + 19};
    for (int size : sizes) {
      byte[] plainBytes = bytes(size, 100 + size);
      File plain = write("enc-plain-" + size, plainBytes);
      File env = temp.resolve("enc-env-" + size + ".wdlib").toFile();
      LibraryObjectStreamCrypto.EncryptResult enc = LibraryObjectStreamCrypto.encryptToFile(
          plain, env, master, ASSET_ID, "original", () -> false);
      assertEquals(size, enc.plaintextBytes);
      assertEquals((long) size + OVERHEAD, enc.envelopeBytes);
      assertEquals(sha256Hex(plainBytes), enc.plaintextSha256);
      assertEquals(sha256Hex(Files.readAllBytes(env.toPath())), enc.envelopeSha256);

      File dec = temp.resolve("enc-dec-" + size).toFile();
      LibraryObjectStreamCrypto.Result opened = LibraryObjectStreamCrypto.decryptToFile(
          env, dec, master, ASSET_ID, "original", () -> false);
      assertEquals(size, opened.plaintextBytes);
      assertEquals(enc.plaintextSha256, opened.plaintextSha256);
      assertArrayEquals(plainBytes, Files.readAllBytes(dec.toPath()));
    }

    File empty = write("enc-empty", new byte[0]);
    File emptyOut = temp.resolve("enc-empty.wdlib").toFile();
    expectCode(LibraryObjectStreamCrypto.Code.FORMAT, () ->
        LibraryObjectStreamCrypto.encryptToFile(empty, emptyOut, master, ASSET_ID, "original", () -> false));
    assertFalse(emptyOut.exists());

    File overPlain = temp.resolve("enc-over-plain").toFile();
    try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(overPlain, "rw")) {
      raf.setLength((long) MAX_PLAINTEXT + 1);
    }
    File overOut = temp.resolve("enc-over.wdlib").toFile();
    expectCode(LibraryObjectStreamCrypto.Code.FORMAT, () ->
        LibraryObjectStreamCrypto.encryptToFile(overPlain, overOut, master, ASSET_ID, "original", () -> false));
    assertFalse(overOut.exists());

    File cancelSource = write("enc-cancel-src", bytes(CHUNK * 4 + 9, 77));
    File cancelDest = temp.resolve("enc-cancel-dest.wdlib").toFile();
    final int[] checks = {0};
    expectCode(LibraryObjectStreamCrypto.Code.CANCELLED, () ->
        LibraryObjectStreamCrypto.encryptToFile(
            cancelSource, cancelDest, master, ASSET_ID, "original", () -> ++checks[0] > 2));
    assertFalse(cancelDest.exists());
  }

  private void expectFormat(File source, byte[] master, String assetId, String scope) throws Exception {
    File dest = temp.resolve("format-" + Math.abs(source.getName().hashCode()) + "-" + scope).toFile();
    expectCode(LibraryObjectStreamCrypto.Code.FORMAT, () ->
        LibraryObjectStreamCrypto.decryptToFile(source, dest, master, assetId, scope, () -> false));
    assertFalse(dest.exists());
  }

  private static void expectCode(LibraryObjectStreamCrypto.Code expected, ThrowingRunnable operation)
      throws Exception {
    assertEquals(expected, expectStreamError(operation).code);
  }

  private static LibraryObjectStreamCrypto.StreamCryptoException expectStreamError(
      ThrowingRunnable operation) throws Exception {
    try {
      operation.run();
      fail("expected stream crypto failure");
      return null;
    } catch (LibraryObjectStreamCrypto.StreamCryptoException error) {
      return error;
    }
  }

  private static void assertSuppressedDeleteFailure(
      LibraryObjectStreamCrypto.StreamCryptoException error) {
    assertEquals(1, error.getSuppressed().length);
    assertEquals("could not delete the output", error.getSuppressed()[0].getMessage());
  }

  private File write(String name, byte[] bytes) throws IOException {
    File file = temp.resolve(name).toFile();
    Files.write(file.toPath(), bytes);
    return file;
  }

  private File copyResourceToTemp(String resource) throws IOException {
    File destination = temp.resolve(Path.of(resource).getFileName().toString()).toFile();
    try (InputStream input = getClass().getClassLoader().getResourceAsStream(resource)) {
      if (input == null) throw new IOException("missing test resource " + resource);
      Files.copy(input, destination.toPath());
    }
    return destination;
  }

  private List<Fixture> readFixtures() throws IOException {
    String json;
    try (InputStream input = getClass().getClassLoader().getResourceAsStream("wdlib001/fixtures.json")) {
      if (input == null) throw new IOException("missing fixture manifest");
      json = new String(input.readAllBytes(), StandardCharsets.UTF_8);
    }
    Pattern pattern = Pattern.compile(
        "\\{\\s*\\\"file\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"\\s*,\\s*"
            + "\\\"scope\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"\\s*,\\s*"
            + "\\\"assetId\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"\\s*,\\s*"
            + "\\\"masterKey\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"\\s*,\\s*"
            + "\\\"plaintextBytes\\\"\\s*:\\s*(\\d+)\\s*,\\s*"
            + "\\\"plaintextSha256\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"\\s*\\}");
    Matcher matcher = pattern.matcher(json);
    List<Fixture> fixtures = new ArrayList<>();
    while (matcher.find()) {
      fixtures.add(new Fixture(matcher.group(1), matcher.group(2), matcher.group(3), matcher.group(4),
          Long.parseLong(matcher.group(5)), matcher.group(6)));
    }
    return fixtures;
  }

  private Envelope makeEnvelope(byte[] master, String assetId, String scope, byte[] plaintext)
      throws Exception {
    byte[] dataKey = bytes(32, 0x7100 + plaintext.length + scope.length());
    byte[] keyNonce = bytes(12, 0x7200 + scope.length());
    byte[] payloadNonce = bytes(12, 0x7300 + plaintext.length);
    byte[] wrapped = gcmEncrypt(master, keyNonce,
        ("waifu-deck:library:v3:object-key:" + assetId + ":" + scope).getBytes(StandardCharsets.UTF_8), dataKey);
    byte[] payload = gcmEncrypt(dataKey, payloadNonce,
        ("waifu-deck:library:v3:object:" + assetId + ":" + scope + ":" + plaintext.length)
            .getBytes(StandardCharsets.UTF_8), plaintext);
    ByteArrayOutputStream output = new ByteArrayOutputStream(MAGIC.length + 60 + 12 + payload.length);
    output.write(MAGIC);
    output.write(keyNonce);
    output.write(wrapped);
    output.write(payloadNonce);
    output.write(payload);
    return new Envelope(output.toByteArray());
  }

  private void writeLargeEnvelope(File destination, byte[] master, String assetId, String scope, int size)
      throws Exception {
    byte[] dataKey = bytes(32, 0x7400);
    byte[] keyNonce = bytes(12, 0x7500);
    byte[] payloadNonce = bytes(12, 0x7600);
    byte[] wrapped = gcmEncrypt(master, keyNonce,
        ("waifu-deck:library:v3:object-key:" + assetId + ":" + scope).getBytes(StandardCharsets.UTF_8), dataKey);
    try (OutputStream output = Files.newOutputStream(destination.toPath())) {
      output.write(MAGIC);
      output.write(keyNonce);
      output.write(wrapped);
      output.write(payloadNonce);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(dataKey, "AES"),
          new GCMParameterSpec(128, payloadNonce));
      cipher.updateAAD(("waifu-deck:library:v3:object:" + assetId + ":" + scope + ":" + size)
          .getBytes(StandardCharsets.UTF_8));
      byte[] buffer = new byte[CHUNK];
      int offset = 0;
      while (offset < size) {
        int length = Math.min(buffer.length, size - offset);
        fillDeterministic(buffer, length, offset, 0x55);
        byte[] encrypted = cipher.update(buffer, 0, length);
        if (encrypted != null && encrypted.length > 0) output.write(encrypted);
        offset += length;
      }
      byte[] tag = cipher.doFinal();
      output.write(tag);
    }
  }

  private static byte[] gcmEncrypt(byte[] key, byte[] iv, byte[] aad, byte[] plaintext) throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
    cipher.updateAAD(aad);
    return cipher.doFinal(plaintext);
  }

  private static byte[] referenceMultiply(byte[] h, byte[] x) {
    long hHi = be64(h, 0);
    long hLo = be64(h, 8);
    long zHi = 0;
    long zLo = 0;
    long vHi = hHi;
    long vLo = hLo;
    for (int i = 0; i < 128; i++) {
      int bit = ((x[i / 8] >>> (7 - (i % 8))) & 1);
      if (bit != 0) {
        zHi ^= vHi;
        zLo ^= vLo;
      }
      boolean lsb = (vLo & 1) != 0;
      vLo = (vLo >>> 1) | (vHi << 63);
      vHi >>>= 1;
      if (lsb) vHi ^= 0xE100000000000000L;
    }
    byte[] result = new byte[16];
    put64(result, 0, zHi);
    put64(result, 8, zLo);
    return result;
  }

  private static byte[] bytes(int size, int seed) {
    byte[] value = new byte[size];
    Random random = new Random(seed);
    random.nextBytes(value);
    return value;
  }

  private static void fillDeterministic(byte[] buffer, int length, int offset, int seed) {
    for (int i = 0; i < length; i++) {
      long value = (long) seed * 0x9E3779B97F4A7C15L + offset + i;
      value ^= value >>> 30;
      value *= 0xBF58476D1CE4E5B9L;
      value ^= value >>> 27;
      buffer[i] = (byte) value;
    }
  }

  private static String sha256Deterministic(int size, int seed) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    byte[] buffer = new byte[CHUNK];
    int offset = 0;
    while (offset < size) {
      int length = Math.min(buffer.length, size - offset);
      fillDeterministic(buffer, length, offset, seed);
      digest.update(buffer, 0, length);
      offset += length;
    }
    return hex(digest.digest());
  }

  private static String sha256Hex(byte[] bytes) throws Exception {
    return hex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }

  private static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) result.append(String.format("%02x", value & 0xff));
    return result.toString();
  }

  private static byte[] hex(String value) {
    if ((value.length() & 1) != 0) throw new IllegalArgumentException("odd hex");
    byte[] result = new byte[value.length() / 2];
    for (int i = 0; i < result.length; i++) {
      result[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
    }
    return result;
  }

  private static long be64(byte[] bytes, int offset) {
    long value = 0;
    for (int i = 0; i < 8; i++) value = (value << 8) | (bytes[offset + i] & 0xffL);
    return value;
  }

  private static void put64(byte[] bytes, int offset, long value) {
    for (int i = 7; i >= 0; i--) {
      bytes[offset + i] = (byte) value;
      value >>>= 8;
    }
  }

  @FunctionalInterface
  private interface ThrowingRunnable {
    void run() throws Exception;
  }

  private static final class Envelope {
    final byte[] bytes;
    Envelope(byte[] bytes) { this.bytes = bytes; }
  }

  private static final class Fixture {
    final String file;
    final String scope;
    final String assetId;
    final String masterKey;
    final long plaintextBytes;
    final String plaintextSha256;
    Fixture(String file, String scope, String assetId, String masterKey, long plaintextBytes, String plaintextSha256) {
      this.file = file;
      this.scope = scope;
      this.assetId = assetId;
      this.masterKey = masterKey;
      this.plaintextBytes = plaintextBytes;
      this.plaintextSha256 = plaintextSha256;
    }
  }

  private static final class ErrorOnCloseOutputStream extends FilterOutputStream {
    ErrorOnCloseOutputStream(OutputStream output) {
      super(output);
    }

    @Override
    public void close() {
      throw new AssertionError("injected close error");
    }
  }

  private static final class NonDeletingFile extends File {
    NonDeletingFile(String path) {
      super(path);
    }

    @Override
    public boolean delete() {
      return false;
    }
  }

  private static final class FailingOutputStream extends FilterOutputStream {
    private int remaining;
    FailingOutputStream(OutputStream output, int bytesBeforeFailure) {
      super(output);
      remaining = bytesBeforeFailure;
    }
    @Override
    public void write(byte[] bytes, int offset, int length) throws IOException {
      if (remaining <= 0) throw new IOException("injected write failure");
      int allowed = Math.min(length, remaining);
      out.write(bytes, offset, allowed);
      remaining -= allowed;
      if (allowed != length) throw new IOException("injected write failure");
    }
    @Override
    public void write(int value) throws IOException {
      if (remaining <= 0) throw new IOException("injected write failure");
      out.write(value);
      remaining--;
    }
  }
}
