package expo.modules.waifusync

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDoneException
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

internal object BackupFileCopy {
  private const val BUFFER_SIZE = 64 * 1024
  private const val SELECT_PROVIDER_FILE_SQL = "SELECT data FROM backup_files WHERE image_id = ?"
  private const val SELECT_IMPORT_FILE_SQL =
    "SELECT data FROM backup_import_files WHERE plaintext_sha256 = ?"

  @JvmStatic
  fun isValidSha256Hex(value: String?): Boolean =
    BackupImportStreamHelper.isValidSha256Hex(value)

  @JvmStatic
  fun streamWithSha256(
    input: InputStream,
    output: OutputStream,
  ): BackupImportStreamHelper.ImportCopyResult =
    BackupImportStreamHelper.streamWithSha256(input, output)

  fun copy(archiveUri: String, imageId: Long, destinationUri: String): Long {
    val archive = File(Uri.parse(archiveUri).path ?: archiveUri)
    val destination = File(Uri.parse(destinationUri).path ?: destinationUri)
    return SQLiteDatabase.openDatabase(
      archive.path,
      null,
      SQLiteDatabase.OPEN_READONLY or SQLiteDatabase.NO_LOCALIZED_COLLATORS,
    ).use { database ->
      database.compileStatement(SELECT_PROVIDER_FILE_SQL).use { statement ->
        statement.bindLong(1, imageId)
        val descriptor = try {
          statement.simpleQueryForBlobFileDescriptor()
        } catch (_: SQLiteDoneException) {
          return -1L
        }
        if (descriptor == null) return -1L

        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
          FileOutputStream(destination, false).use { output ->
            val buffer = ByteArray(BUFFER_SIZE)
            var written = 0L
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              if (read == 0) continue
              output.write(buffer, 0, read)
              written += read
            }
            output.flush()
            written
          }
        }
      }
    }
  }

  fun copyImport(
    archiveUri: String,
    plaintextSha256: String,
    destinationUri: String,
  ): BackupImportStreamHelper.ImportCopyResult {
    BackupImportStreamHelper.requireValidSha256Hex(plaintextSha256)
    val archive = File(Uri.parse(archiveUri).path ?: archiveUri)
    val destination = File(Uri.parse(destinationUri).path ?: destinationUri)
    return SQLiteDatabase.openDatabase(
      archive.path,
      null,
      SQLiteDatabase.OPEN_READONLY or SQLiteDatabase.NO_LOCALIZED_COLLATORS,
    ).use { database ->
      database.compileStatement(SELECT_IMPORT_FILE_SQL).use { statement ->
        statement.bindString(1, plaintextSha256)
        val descriptor = try {
          statement.simpleQueryForBlobFileDescriptor()
        } catch (_: SQLiteDoneException) {
          return BackupImportStreamHelper.ImportCopyResult(-1L, "")
        }
        if (descriptor == null) {
          return BackupImportStreamHelper.ImportCopyResult(-1L, "")
        }

        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
          FileOutputStream(destination, false).use { output ->
            BackupImportStreamHelper.streamWithSha256(input, output)
          }
        }
      }
    }
  }
}
