package expo.modules.waifusync;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.ShortBufferException;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** File-to-file WDLIB001 AES-GCM decrypt and encryption-off copy helpers. */
public final class LibraryObjectStreamCrypto {
  private static final int KEY_BYTES = 32;
  private static final int NONCE_BYTES = 12;
  private static final int TAG_BYTES = 16;
  private static final int WRAPPED_KEY_BYTES = 60;
  private static final int MAGIC_BYTES = 8;
  private static final int ENVELOPE_OVERHEAD = MAGIC_BYTES + WRAPPED_KEY_BYTES + NONCE_BYTES + TAG_BYTES;
  private static final long MAX_ENVELOPE_BYTES = 64L * 1024L * 1024L;
  private static final long MAX_PLAINTEXT_BYTES = MAX_ENVELOPE_BYTES - ENVELOPE_OVERHEAD;
  private static final int CHUNK_BYTES = 64 * 1024;
  private static final byte[] MAGIC = "WDLIB001".getBytes(StandardCharsets.UTF_8);
  private static final CancellationCheck NEVER_CANCELLED = () -> false;

  private LibraryObjectStreamCrypto() {
  }

  public enum Code {
    FORMAT,
    INTEGRITY,
    IO,
    CANCELLED,
  }

  public interface CancellationCheck {
    boolean isCancelled();
  }

  public static final class StreamCryptoException extends Exception {
    public final Code code;

    StreamCryptoException(Code code, String message) {
      super(message);
      this.code = code;
    }

    StreamCryptoException(Code code, String message, Throwable cause) {
      super(message, cause);
      this.code = code;
    }

    public Code getCode() {
      return code;
    }
  }

  public static final class Result {
    public final long plaintextBytes;
    public final String plaintextSha256;

    Result(long plaintextBytes, String plaintextSha256) {
      this.plaintextBytes = plaintextBytes;
      this.plaintextSha256 = plaintextSha256;
    }

    public long getPlaintextBytes() {
      return plaintextBytes;
    }

    public String getPlaintextSha256() {
      return plaintextSha256;
    }
  }

  public static final class EncryptResult {
    public final long plaintextBytes;
    public final long envelopeBytes;
    public final String plaintextSha256;
    public final String envelopeSha256;

    EncryptResult(
        long plaintextBytes,
        long envelopeBytes,
        String plaintextSha256,
        String envelopeSha256
    ) {
      this.plaintextBytes = plaintextBytes;
      this.envelopeBytes = envelopeBytes;
      this.plaintextSha256 = plaintextSha256;
      this.envelopeSha256 = envelopeSha256;
    }

    public long getPlaintextBytes() {
      return plaintextBytes;
    }

    public long getEnvelopeBytes() {
      return envelopeBytes;
    }

    public String getPlaintextSha256() {
      return plaintextSha256;
    }

    public String getEnvelopeSha256() {
      return envelopeSha256;
    }
  }

  public static EncryptResult encryptToFile(
      File source,
      File destination,
      byte[] masterKey,
      String assetId,
      String scope,
      CancellationCheck cancel
  ) throws StreamCryptoException {
    return encryptToFile(source, destination, masterKey, assetId, scope, cancel,
        FileOutputStream::new);
  }

  static EncryptResult encryptToFile(
      File source,
      File destination,
      byte[] masterKey,
      String assetId,
      String scope,
      CancellationCheck cancel,
      OutputStreamFactory outputFactory
  ) throws StreamCryptoException {
    validateCommon(source, destination, masterKey, cancel, true);
    validateAssetAndScope(assetId, scope);

    long plaintextBytes = source.length();
    if (plaintextBytes <= 0 || plaintextBytes > MAX_PLAINTEXT_BYTES) {
      throw format("Library object plaintext size is invalid.");
    }
    long envelopeBytes = plaintextBytes + ENVELOPE_OVERHEAD;
    if (envelopeBytes <= ENVELOPE_OVERHEAD || envelopeBytes > MAX_ENVELOPE_BYTES) {
      throw format("Library object envelope size is invalid.");
    }

    boolean destinationCreated = false;
    byte[] masterKeyCopy = Arrays.copyOf(masterKey, masterKey.length);
    byte[] dataKey = new byte[KEY_BYTES];
    byte[] keyNonce = new byte[NONCE_BYTES];
    byte[] payloadNonce = new byte[NONCE_BYTES];
    byte[] wrapped = null;
    InputStream input = null;
    OutputStream output = null;
    StreamCryptoException failure = null;
    try {
      SecureRandom random = new SecureRandom();
      random.nextBytes(dataKey);
      random.nextBytes(keyNonce);
      random.nextBytes(payloadNonce);
      try {
        wrapped = wrapDataKey(masterKeyCopy, keyNonce, dataKey, assetId, scope);
      } catch (GeneralSecurityException error) {
        throw integrity("Library object key wrap failed.", error);
      }
      if (wrapped.length != WRAPPED_KEY_BYTES) {
        throw integrity("Library object key wrap has an unexpected size.", null);
      }

      try {
        destinationCreated = destination.createNewFile();
      } catch (SecurityException error) {
        throw io("Library object destination could not be created.", error);
      }
      if (!destinationCreated) {
        throw io("Library object destination already exists.", null);
      }
      output = outputFactory.open(destination);
      if (output == null) {
        throw io("Library object destination stream was not opened.", null);
      }
      input = new BufferedInputStream(new FileInputStream(source), CHUNK_BYTES);
      MessageDigest envelopeDigest = sha256Digest();
      output.write(MAGIC);
      envelopeDigest.update(MAGIC, 0, MAGIC.length);
      output.write(wrapped);
      envelopeDigest.update(wrapped, 0, wrapped.length);
      output.write(payloadNonce);
      envelopeDigest.update(payloadNonce, 0, payloadNonce.length);

      Result plainResult = encryptPayloadStream(
          input,
          output,
          envelopeDigest,
          plaintextBytes,
          dataKey,
          payloadNonce,
          payloadAdditionalData(assetId, scope, plaintextBytes),
          cancel
      );
      output.close();
      output = null;
      input.close();
      input = null;
      destinationCreated = false;
      return new EncryptResult(
          plainResult.plaintextBytes,
          envelopeBytes,
          plainResult.plaintextSha256,
          lowercaseHex(envelopeDigest.digest())
      );
    } catch (StreamCryptoException error) {
      failure = error;
      throw error;
    } catch (IOException error) {
      failure = io("Library object stream I/O failed.", error);
      throw failure;
    } catch (Throwable error) {
      failure = io("Library object stream failed.", error);
      throw failure;
    } finally {
      closeQuietly(output);
      closeQuietly(input);
      if (destinationCreated) deleteQuietly(destination, failure);
      zero(masterKeyCopy);
      zero(dataKey);
      zero(keyNonce);
      zero(payloadNonce);
      zero(wrapped);
    }
  }

  interface OutputStreamFactory {
    OutputStream open(File destination) throws IOException;
  }

  public static Result decryptToFile(
      File source,
      File destination,
      byte[] masterKey,
      String assetId,
      String scope,
      CancellationCheck cancel
  ) throws StreamCryptoException {
    return decryptToFile(source, destination, masterKey, assetId, scope, cancel,
        FileOutputStream::new);
  }

  static Result decryptToFile(
      File source,
      File destination,
      byte[] masterKey,
      String assetId,
      String scope,
      CancellationCheck cancel,
      OutputStreamFactory outputFactory
  ) throws StreamCryptoException {
    validateCommon(source, destination, masterKey, cancel, true);
    validateAssetAndScope(assetId, scope);

    long envelopeBytes = source.length();
    if (envelopeBytes <= ENVELOPE_OVERHEAD || envelopeBytes > MAX_ENVELOPE_BYTES) {
      throw format("Library object envelope size is invalid.");
    }
    long plaintextBytes = envelopeBytes - ENVELOPE_OVERHEAD;
    if (plaintextBytes <= 0 || plaintextBytes > MAX_PLAINTEXT_BYTES) {
      throw format("Library object plaintext size is invalid.");
    }

    boolean destinationCreated = false;
    byte[] masterKeyCopy = Arrays.copyOf(masterKey, masterKey.length);
    byte[] dataKey = null;
    byte[] wrapped = null;
    byte[] payloadNonce = null;
    InputStream input = null;
    OutputStream output = null;
    StreamCryptoException failure = null;
    try {
      input = new BufferedInputStream(new FileInputStream(source), CHUNK_BYTES);
      byte[] header = new byte[MAGIC_BYTES + WRAPPED_KEY_BYTES + NONCE_BYTES];
      readFully(input, header, 0, header.length);
      if (!constantTimeEquals(MAGIC, Arrays.copyOfRange(header, 0, MAGIC_BYTES))) {
        throw format("Unsupported library object envelope.");
      }

      wrapped = Arrays.copyOfRange(header, MAGIC_BYTES, MAGIC_BYTES + WRAPPED_KEY_BYTES);
      payloadNonce = Arrays.copyOfRange(header, MAGIC_BYTES + WRAPPED_KEY_BYTES, header.length);

      try {
        dataKey = unwrapDataKey(masterKeyCopy, wrapped, assetId, scope);
      } catch (GeneralSecurityException error) {
        throw integrity("Library object key wrap failed.", error);
      }
      if (dataKey.length != KEY_BYTES) {
        throw integrity("Library object key wrap has an unexpected size.", null);
      }

      try {
        destinationCreated = destination.createNewFile();
      } catch (SecurityException error) {
        throw io("Library object destination could not be created.", error);
      }
      if (!destinationCreated) {
        throw io("Library object destination already exists.", null);
      }
      output = outputFactory.open(destination);
      if (output == null) {
        throw io("Library object destination stream was not opened.", null);
      }
      Result result = decryptPayloadStream(
          input,
          output,
          plaintextBytes,
          dataKey,
          payloadNonce,
          payloadAdditionalData(assetId, scope, plaintextBytes),
          cancel
      );
      output.close();
      output = null;
      input.close();
      input = null;
      destinationCreated = false;
      return result;
    } catch (StreamCryptoException error) {
      failure = error;
      throw error;
    } catch (IOException error) {
      failure = io("Library object stream I/O failed.", error);
      throw failure;
    } catch (Throwable error) {
      failure = io("Library object stream failed.", error);
      throw failure;
    } finally {
      closeQuietly(output);
      closeQuietly(input);
      if (destinationCreated) deleteQuietly(destination, failure);
      zero(masterKeyCopy);
      zero(dataKey);
      zero(wrapped);
      zero(payloadNonce);
    }
  }

  public static Result copyWithSha256(
      File source,
      File destination,
      CancellationCheck cancel
  ) throws StreamCryptoException {
    return copyWithSha256(source, destination, cancel, FileOutputStream::new);
  }

  static Result copyWithSha256(
      File source,
      File destination,
      CancellationCheck cancel,
      OutputStreamFactory outputFactory
  ) throws StreamCryptoException {
    validateCommon(source, destination, null, cancel, false);
    long plaintextBytes = source.length();
    if (plaintextBytes <= 0 || plaintextBytes > MAX_PLAINTEXT_BYTES) {
      throw format("Library plaintext size is invalid.");
    }

    boolean destinationCreated = false;
    InputStream input = null;
    OutputStream output = null;
    byte[] buffer = new byte[CHUNK_BYTES];
    StreamCryptoException failure = null;
    try {
      destinationCreated = destination.createNewFile();
      if (!destinationCreated) {
        throw io("Library destination already exists.", null);
      }
      output = outputFactory.open(destination);
      if (output == null) throw io("Library destination stream was not opened.", null);
      MessageDigest digest = sha256Digest();
      input = new BufferedInputStream(new FileInputStream(source), CHUNK_BYTES);
      long copied = 0;
      while (copied < plaintextBytes) {
        if (isCancelled(cancel)) throw cancelled();
        int wanted = (int) Math.min((long) buffer.length, plaintextBytes - copied);
        int read = readChunk(input, buffer, wanted);
        if (read <= 0) throw io("Library source ended unexpectedly.", null);
        output.write(buffer, 0, read);
        digest.update(buffer, 0, read);
        copied += read;
      }
      Result result = new Result(copied, lowercaseHex(digest.digest()));
      output.flush();
      output.close();
      output = null;
      input.close();
      input = null;
      destinationCreated = false;
      return result;
    } catch (StreamCryptoException error) {
      failure = error;
      throw error;
    } catch (IOException error) {
      failure = io("Library copy I/O failed.", error);
      throw failure;
    } catch (Throwable error) {
      failure = io("Library copy failed.", error);
      throw failure;
    } finally {
      closeQuietly(output);
      closeQuietly(input);
      zero(buffer);
      if (destinationCreated) deleteQuietly(destination, failure);
    }
  }

  static byte[] decryptPayloadForTest(
      byte[] key,
      byte[] nonce,
      byte[] aad,
      byte[] ciphertextAndTag
  ) throws StreamCryptoException {
    if (key == null || key.length != KEY_BYTES || nonce == null || nonce.length != NONCE_BYTES
        || aad == null || ciphertextAndTag == null || ciphertextAndTag.length < TAG_BYTES) {
      throw format("Invalid GCM test input.");
    }
    byte[] keyCopy = Arrays.copyOf(key, key.length);
    byte[] nonceCopy = Arrays.copyOf(nonce, nonce.length);
    try (InputStream input = new ByteArrayInputStream(ciphertextAndTag);
        OutputStream output = new ByteArrayOutputStream(ciphertextAndTag.length - TAG_BYTES)) {
      return decryptPayloadStreamBytes(input, output, ciphertextAndTag.length - TAG_BYTES,
          keyCopy, nonceCopy, aad, NEVER_CANCELLED);
    } catch (StreamCryptoException error) {
      throw error;
    } catch (IOException error) {
      throw io("GCM test stream failed.", error);
    } finally {
      zero(keyCopy);
      zero(nonceCopy);
    }
  }

  static byte[] multiplyGhashForTest(byte[] h, byte[] x) {
    if (h == null || h.length != 16 || x == null || x.length != 16) {
      throw new IllegalArgumentException("GHASH blocks must be 16 bytes.");
    }
    Ghash ghash = new Ghash(h);
    ghash.multiplyBlock(x, 0, 16);
    return ghash.stateBytes();
  }

  private static byte[] decryptPayloadStreamBytes(
      InputStream input,
      OutputStream output,
      long plaintextBytes,
      byte[] key,
      byte[] nonce,
      byte[] aad,
      CancellationCheck cancel
  ) throws StreamCryptoException, IOException {
    ByteArrayOutputStream bytes = (ByteArrayOutputStream) output;
    decryptPayloadStream(input, output, plaintextBytes, key, nonce, aad, cancel);
    return bytes.toByteArray();
  }

  private static Result decryptPayloadStream(
      InputStream input,
      OutputStream output,
      long plaintextBytes,
      byte[] key,
      byte[] nonce,
      byte[] aad,
      CancellationCheck cancel
  ) throws StreamCryptoException, IOException {
    byte[] h = null;
    byte[] j0 = null;
    byte[] tagMask = null;
    byte[] counter = null;
    byte[] inputBuffer = new byte[CHUNK_BYTES];
    byte[] outputBuffer = new byte[CHUNK_BYTES];
    byte[] tag = new byte[TAG_BYTES];
    long[] bulkLongs = new long[CHUNK_BYTES / Long.BYTES];
    Ghash ghash = null;
    try {
      Cipher ecb = Cipher.getInstance("AES/ECB/NoPadding");
      SecretKeySpec secret = secretKeySpec(key);
      ecb.init(Cipher.ENCRYPT_MODE, secret);
      h = ecb.doFinal(new byte[16]);
      j0 = new byte[16];
      System.arraycopy(nonce, 0, j0, 0, NONCE_BYTES);
      j0[15] = 1;
      tagMask = ecb.doFinal(j0);
      counter = Arrays.copyOf(j0, j0.length);
      increment32(counter);

      Cipher ctr = Cipher.getInstance("AES/CTR/NoPadding");
      ctr.init(Cipher.DECRYPT_MODE, secret, new IvParameterSpec(counter));
      ghash = new Ghash(h);
      ghash.update(aad, 0, aad.length, bulkLongs);
      MessageDigest digest = sha256Digest();
      long processed = 0;
      while (processed < plaintextBytes) {
        if (isCancelled(cancel)) throw cancelled();
        int wanted = (int) Math.min((long) inputBuffer.length, plaintextBytes - processed);
        readFully(input, inputBuffer, 0, wanted);
        ghash.update(inputBuffer, 0, wanted, bulkLongs);
        int produced;
        try {
          produced = ctr.update(inputBuffer, 0, wanted, outputBuffer, 0);
        } catch (ShortBufferException error) {
          throw io("Library stream cipher output failed.", error);
        }
        if (produced != wanted) {
          throw io("Library stream cipher returned an unexpected size.", null);
        }
        output.write(outputBuffer, 0, produced);
        digest.update(outputBuffer, 0, produced);
        processed += wanted;
      }
      readFully(input, tag, 0, TAG_BYTES);
      byte[] lengths = new byte[16];
      putBigEndianLong(lengths, 0, ((long) aad.length) * 8L);
      putBigEndianLong(lengths, 8, plaintextBytes * 8L);
      ghash.multiplyBlock(lengths, 0, lengths.length);
      byte[] expectedTag = ghash.stateBytes();
      for (int i = 0; i < TAG_BYTES; i++) expectedTag[i] ^= tagMask[i];
      boolean valid = MessageDigest.isEqual(expectedTag, tag);
      zero(lengths);
      zero(expectedTag);
      if (!valid) throw integrity("Library object authentication failed.", null);
      output.flush();
      return new Result(plaintextBytes, lowercaseHex(digest.digest()));
    } catch (GeneralSecurityException error) {
      throw integrity("Library object cipher failed.", error);
    } finally {
      zero(h);
      zero(j0);
      zero(tagMask);
      zero(counter);
      if (ghash != null) ghash.clear();
      zero(inputBuffer);
      zero(outputBuffer);
      zero(tag);
      zero(bulkLongs);
    }
  }

  private static Result encryptPayloadStream(
      InputStream input,
      OutputStream output,
      MessageDigest envelopeDigest,
      long plaintextBytes,
      byte[] key,
      byte[] nonce,
      byte[] aad,
      CancellationCheck cancel
  ) throws StreamCryptoException, IOException {
    byte[] h = null;
    byte[] j0 = null;
    byte[] tagMask = null;
    byte[] counter = null;
    byte[] inputBuffer = new byte[CHUNK_BYTES];
    byte[] outputBuffer = new byte[CHUNK_BYTES];
    long[] bulkLongs = new long[CHUNK_BYTES / Long.BYTES];
    Ghash ghash = null;
    try {
      Cipher ecb = Cipher.getInstance("AES/ECB/NoPadding");
      SecretKeySpec secret = secretKeySpec(key);
      ecb.init(Cipher.ENCRYPT_MODE, secret);
      h = ecb.doFinal(new byte[16]);
      j0 = new byte[16];
      System.arraycopy(nonce, 0, j0, 0, NONCE_BYTES);
      j0[15] = 1;
      tagMask = ecb.doFinal(j0);
      counter = Arrays.copyOf(j0, j0.length);
      increment32(counter);

      Cipher ctr = Cipher.getInstance("AES/CTR/NoPadding");
      ctr.init(Cipher.ENCRYPT_MODE, secret, new IvParameterSpec(counter));
      ghash = new Ghash(h);
      ghash.update(aad, 0, aad.length, bulkLongs);
      MessageDigest plainDigest = sha256Digest();
      long processed = 0;
      while (processed < plaintextBytes) {
        if (isCancelled(cancel)) throw cancelled();
        int wanted = (int) Math.min((long) inputBuffer.length, plaintextBytes - processed);
        readFully(input, inputBuffer, 0, wanted);
        plainDigest.update(inputBuffer, 0, wanted);
        int produced;
        try {
          produced = ctr.update(inputBuffer, 0, wanted, outputBuffer, 0);
        } catch (ShortBufferException error) {
          throw io("Library stream cipher output failed.", error);
        }
        if (produced != wanted) {
          throw io("Library stream cipher returned an unexpected size.", null);
        }
        ghash.update(outputBuffer, 0, produced, bulkLongs);
        output.write(outputBuffer, 0, produced);
        envelopeDigest.update(outputBuffer, 0, produced);
        processed += wanted;
      }
      byte[] lengths = new byte[16];
      putBigEndianLong(lengths, 0, ((long) aad.length) * 8L);
      putBigEndianLong(lengths, 8, plaintextBytes * 8L);
      ghash.multiplyBlock(lengths, 0, lengths.length);
      byte[] tag = ghash.stateBytes();
      for (int i = 0; i < TAG_BYTES; i++) tag[i] ^= tagMask[i];
      output.write(tag, 0, TAG_BYTES);
      envelopeDigest.update(tag, 0, TAG_BYTES);
      zero(lengths);
      zero(tag);
      output.flush();
      return new Result(plaintextBytes, lowercaseHex(plainDigest.digest()));
    } catch (GeneralSecurityException error) {
      throw integrity("Library object cipher failed.", error);
    } finally {
      zero(h);
      zero(j0);
      zero(tagMask);
      zero(counter);
      if (ghash != null) ghash.clear();
      zero(inputBuffer);
      zero(outputBuffer);
      zero(bulkLongs);
    }
  }

  // JCE providers keep their own key copy until GC; app-owned key arrays are zeroed in finally.
  private static SecretKeySpec secretKeySpec(byte[] key) {
    return new SecretKeySpec(key, "AES");
  }

  private static byte[] wrapDataKey(
      byte[] masterKey,
      byte[] keyNonce,
      byte[] dataKey,
      String assetId,
      String scope
  ) throws GeneralSecurityException {
    byte[] ciphertextAndTag = null;
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, secretKeySpec(masterKey),
          new GCMParameterSpec(128, keyNonce));
      cipher.updateAAD(keyAdditionalData(assetId, scope));
      ciphertextAndTag = cipher.doFinal(dataKey);
      byte[] wrapped = new byte[NONCE_BYTES + ciphertextAndTag.length];
      System.arraycopy(keyNonce, 0, wrapped, 0, NONCE_BYTES);
      System.arraycopy(ciphertextAndTag, 0, wrapped, NONCE_BYTES, ciphertextAndTag.length);
      return wrapped;
    } finally {
      zero(ciphertextAndTag);
    }
  }

  private static byte[] unwrapDataKey(
      byte[] masterKey,
      byte[] wrapped,
      String assetId,
      String scope
  ) throws GeneralSecurityException {
    byte[] nonce = Arrays.copyOfRange(wrapped, 0, NONCE_BYTES);
    byte[] ciphertextAndTag = Arrays.copyOfRange(wrapped, NONCE_BYTES, wrapped.length);
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, secretKeySpec(masterKey),
          new GCMParameterSpec(128, nonce));
      cipher.updateAAD(keyAdditionalData(assetId, scope));
      return cipher.doFinal(ciphertextAndTag);
    } finally {
      zero(nonce);
      zero(ciphertextAndTag);
    }
  }

  private static byte[] keyAdditionalData(String assetId, String scope) {
    return ("waifu-deck:library:v3:object-key:" + assetId + ":" + scope)
        .getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] payloadAdditionalData(String assetId, String scope, long plaintextBytes) {
    return ("waifu-deck:library:v3:object:" + assetId + ":" + scope + ":" + plaintextBytes)
        .getBytes(StandardCharsets.UTF_8);
  }

  private static void validateCommon(
      File source,
      File destination,
      byte[] masterKey,
      CancellationCheck cancel,
      boolean requiresMasterKey
  ) throws StreamCryptoException {
    if (requiresMasterKey && (masterKey == null || masterKey.length != KEY_BYTES)) {
      throw format("Vault master key length is invalid.");
    }
    if (source == null || destination == null || cancel == null) {
      throw format("Library stream arguments are invalid.");
    }
    if (!source.isFile() || !source.canRead()) {
      throw io("Library source could not be read.", null);
    }
  }

  private static void validateAssetAndScope(String assetId, String scope) throws StreamCryptoException {
    if (assetId == null || !assetId.matches("[0-9a-f]{64}")) {
      throw format("Library asset id is invalid.");
    }
    if (!("original".equals(scope) || "thumbnail".equals(scope) || "preview".equals(scope))) {
      throw format("Library object scope is invalid.");
    }
  }

  private static int readChunk(InputStream input, byte[] buffer, int wanted) throws IOException {
    int total = 0;
    while (total < wanted) {
      int read = input.read(buffer, total, wanted - total);
      if (read < 0) break;
      if (read == 0) continue;
      total += read;
    }
    return total;
  }

  private static void readFully(InputStream input, byte[] buffer, int offset, int length)
      throws IOException {
    int total = 0;
    while (total < length) {
      int read = input.read(buffer, offset + total, length - total);
      if (read < 0) throw new IOException("Library source ended unexpectedly.");
      if (read == 0) continue;
      total += read;
    }
  }

  private static boolean isCancelled(CancellationCheck cancel) throws StreamCryptoException {
    try {
      return cancel.isCancelled();
    } catch (Throwable error) {
      throw io("Library cancellation check failed.", error);
    }
  }

  private static MessageDigest sha256Digest() throws StreamCryptoException {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (GeneralSecurityException error) {
      throw io("SHA-256 is unavailable.", error);
    }
  }

  private static void increment32(byte[] counter) {
    for (int index = 15; index >= 12; index--) {
      counter[index]++;
      if (counter[index] != 0) break;
    }
  }

  private static boolean constantTimeEquals(byte[] left, byte[] right) {
    return MessageDigest.isEqual(left, right);
  }

  private static String lowercaseHex(byte[] bytes) {
    char[] digits = "0123456789abcdef".toCharArray();
    char[] result = new char[bytes.length * 2];
    for (int i = 0; i < bytes.length; i++) {
      int value = bytes[i] & 0xff;
      result[i * 2] = digits[value >>> 4];
      result[i * 2 + 1] = digits[value & 0x0f];
    }
    return new String(result);
  }

  private static StreamCryptoException format(String message) {
    return new StreamCryptoException(Code.FORMAT, message);
  }

  private static StreamCryptoException integrity(String message, Throwable cause) {
    return cause == null
        ? new StreamCryptoException(Code.INTEGRITY, message)
        : new StreamCryptoException(Code.INTEGRITY, message, cause);
  }

  private static StreamCryptoException io(String message, Throwable cause) {
    return cause == null
        ? new StreamCryptoException(Code.IO, message)
        : new StreamCryptoException(Code.IO, message, cause);
  }

  private static StreamCryptoException cancelled() {
    return new StreamCryptoException(Code.CANCELLED, "Library operation was cancelled.");
  }

  private static void closeQuietly(AutoCloseable closeable) {
    if (closeable == null) return;
    try {
      closeable.close();
    } catch (Throwable ignored) {
      // Cleanup must continue even when a provider or stream throws an Error.
    }
  }

  private static void deleteQuietly(File file, StreamCryptoException failure) {
    boolean deleted = false;
    try {
      deleted = file.delete();
    } catch (Throwable ignored) {
      // The original operation failure remains the primary error.
    }
    if (!deleted && failure != null) {
      failure.addSuppressed(new IOException("could not delete the output"));
    }
  }

  private static void zero(byte[] bytes) {
    if (bytes != null) Arrays.fill(bytes, (byte) 0);
  }

  private static void zero(long[] values) {
    if (values != null) Arrays.fill(values, 0L);
  }

  /**
   * Per-position 8-bit Shoup tables: 16 byte positions x 256 entries x 16
   * bytes = 64 KiB per key. This removes shifts/reduction from the hot loop;
   * the phone benchmark measured 716--723 ms with bulk long reads versus
   * 1,010--1,030 ms for one shared 8-bit table.
   */
  private static final class Ghash {
    private static final long REDUCTION = 0xE100000000000000L;
    private static final int POSITION_COUNT = 16;
    private static final int ENTRY_COUNT = 256;
    private final long[] table = new long[POSITION_COUNT * ENTRY_COUNT * 2];
    private long yHi;
    private long yLo;

    Ghash(byte[] h) {
      long hHi = getBigEndianLong(h, 0);
      long hLo = getBigEndianLong(h, 8);
      long[] basisHi = new long[8];
      long[] basisLo = new long[8];
      for (int position = 0; position < POSITION_COUNT; position++) {
        basisHi[0] = hHi;
        basisLo[0] = hLo;
        for (int bit = 1; bit < basisHi.length; bit++) {
          long hi = basisHi[bit - 1];
          long lo = basisLo[bit - 1];
          boolean lsb = (lo & 1L) != 0;
          basisLo[bit] = (lo >>> 1) | (hi << 63);
          basisHi[bit] = hi >>> 1;
          if (lsb) basisHi[bit] ^= REDUCTION;
        }
        int tableOffset = position * ENTRY_COUNT * 2;
        for (int value = 0; value < ENTRY_COUNT; value++) {
          long valueHi = 0;
          long valueLo = 0;
          for (int bit = 0; bit < basisHi.length; bit++) {
            if ((value & (0x80 >>> bit)) != 0) {
              valueHi ^= basisHi[bit];
              valueLo ^= basisLo[bit];
            }
          }
          int entry = tableOffset + value * 2;
          table[entry] = valueHi;
          table[entry + 1] = valueLo;
        }
        for (int bit = 0; bit < 8; bit++) {
          boolean lsb = (hLo & 1L) != 0;
          hLo = (hLo >>> 1) | (hHi << 63);
          hHi >>>= 1;
          if (lsb) hHi ^= REDUCTION;
        }
      }
      Arrays.fill(basisHi, 0L);
      Arrays.fill(basisLo, 0L);
    }

    void update(byte[] bytes, int offset, int length, long[] bulkLongs) {
      int fullLength = length - (length % 16);
      int longCount = fullLength / Long.BYTES;
      if (longCount > 0) {
        ByteBuffer.wrap(bytes, offset, fullLength)
            .order(ByteOrder.BIG_ENDIAN)
            .asLongBuffer()
            .get(bulkLongs, 0, longCount);
        for (int index = 0; index < longCount; index += 2) {
          multiplyBlock(bulkLongs[index], bulkLongs[index + 1]);
        }
      }
      if (fullLength < length) {
        // Only the final partial block is assembled byte-by-byte; GHASH pads it with zeroes.
        multiplyBlock(bytes, offset + fullLength, length - fullLength);
      }
    }

    void multiplyBlock(byte[] bytes, int offset, int length) {
      long xHi = 0;
      long xLo = 0;
      for (int i = 0; i < length; i++) {
        if (i < 8) {
          xHi |= (bytes[offset + i] & 0xffL) << ((7 - i) * 8);
        } else {
          xLo |= (bytes[offset + i] & 0xffL) << ((15 - i) * 8);
        }
      }
      multiplyBlock(xHi, xLo);
    }

    void multiplyBlock(long xHi, long xLo) {
      yHi ^= xHi;
      yLo ^= xLo;
      multiplyState();
    }

    byte[] stateBytes() {
      byte[] result = new byte[16];
      putBigEndianLong(result, 0, yHi);
      putBigEndianLong(result, 8, yLo);
      return result;
    }

    void clear() {
      Arrays.fill(table, 0L);
      yHi = 0;
      yLo = 0;
    }

    private void multiplyState() {
      long xHi = yHi;
      long xLo = yLo;
      long zHi = 0;
      long zLo = 0;
      for (int position = 0; position < 8; position++) {
        int value = (int) (xHi >>> (56 - position * 8)) & 0xff;
        int entry = (position * ENTRY_COUNT + value) * 2;
        zHi ^= table[entry];
        zLo ^= table[entry + 1];
      }
      for (int position = 0; position < 8; position++) {
        int value = (int) (xLo >>> (56 - position * 8)) & 0xff;
        int entry = ((position + 8) * ENTRY_COUNT + value) * 2;
        zHi ^= table[entry];
        zLo ^= table[entry + 1];
      }
      yHi = zHi;
      yLo = zLo;
    }
  }

  private static long getBigEndianLong(byte[] bytes, int offset) {
    long result = 0;
    for (int i = 0; i < 8; i++) result = (result << 8) | (bytes[offset + i] & 0xffL);
    return result;
  }

  private static void putBigEndianLong(byte[] bytes, int offset, long value) {
    for (int i = 7; i >= 0; i--) {
      bytes[offset + i] = (byte) value;
      value >>>= 8;
    }
  }
}
