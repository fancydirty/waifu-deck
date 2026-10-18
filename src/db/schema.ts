import type { SqlDatabasePort } from '@/db/sql-port';
import { canonicalizeSourceUrl } from '@/features/providers/source-identity';

export const DATABASE_VERSION = 23;

export async function migrateDatabase(database: SqlDatabasePort): Promise<void> {
  await database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);

  await database.transaction(async (transaction) => {
    const versionRow = await transaction.getFirst<{ user_version: number }>(
      'PRAGMA user_version',
    );
    let currentVersion = versionRow?.user_version ?? 0;
    const startingVersion = currentVersion;
    if (currentVersion >= DATABASE_VERSION) return;

    if (currentVersion < 1) {
      await transaction.exec(`
        CREATE TABLE IF NOT EXISTS images (
          id INTEGER PRIMARY KEY NOT NULL,
          remote_url TEXT NOT NULL,
          source_url TEXT,
          artist_name TEXT,
          artist_url TEXT,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          byte_size INTEGER NOT NULL,
          extension TEXT NOT NULL,
          dominant_color TEXT NOT NULL,
          is_nsfw INTEGER NOT NULL CHECK (is_nsfw IN (0, 1)),
          is_animated INTEGER NOT NULL CHECK (is_animated IN (0, 1)),
          tags_json TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('queued', 'active', 'dismissed', 'saved')),
          presented_at INTEGER,
          decided_at INTEGER,
          local_uri TEXT,
          download_state TEXT NOT NULL CHECK (download_state IN ('none', 'pending', 'ready', 'failed')),
          download_error TEXT
        );

        CREATE INDEX IF NOT EXISTS images_decision_decided_at
          ON images(decision, decided_at DESC);
        CREATE INDEX IF NOT EXISTS images_download_state
          ON images(download_state);

        PRAGMA user_version = 1;
      `);
      currentVersion = 1;
    }

    if (currentVersion < 2) {
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(images)',
      );
      if (!columns.some(({ name }) => name === 'queue_ordinal')) {
        await transaction.exec('ALTER TABLE images ADD COLUMN queue_ordinal INTEGER');
      }
      await transaction.exec(`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS ordinal
          FROM images
        )
        UPDATE images
        SET queue_ordinal = (
          SELECT ordinal FROM ranked WHERE ranked.id = images.id
        )
        WHERE queue_ordinal IS NULL;

        UPDATE images
        SET decision = 'queued', presented_at = NULL
        WHERE decision = 'active'
          AND id NOT IN (
            SELECT id
            FROM images
            WHERE decision = 'active'
            ORDER BY presented_at DESC, id DESC
            LIMIT 1
          );

        CREATE INDEX IF NOT EXISTS images_decision_decided_at
          ON images(decision, decided_at DESC);
        CREATE INDEX IF NOT EXISTS images_download_state
          ON images(download_state);
        CREATE INDEX IF NOT EXISTS images_queue_ordinal
          ON images(queue_ordinal);
        CREATE UNIQUE INDEX IF NOT EXISTS images_one_active
          ON images((1)) WHERE decision = 'active';

        PRAGMA user_version = 2;
      `);
      currentVersion = 2;
    }

    if (currentVersion < 3) {
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(images)',
      );
      if (!columns.some(({ name }) => name === 'decision_ordinal')) {
        await transaction.exec(
          'ALTER TABLE images ADD COLUMN decision_ordinal INTEGER',
        );
      }
      await transaction.exec(`
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (ORDER BY decided_at, id) AS ordinal
          FROM images
          WHERE decision IN ('dismissed', 'saved')
        )
        UPDATE images
        SET decision_ordinal = (
          SELECT ordinal FROM ranked WHERE ranked.id = images.id
        )
        WHERE decision IN ('dismissed', 'saved')
          AND decision_ordinal IS NULL;

        UPDATE images
        SET decision_ordinal = NULL
        WHERE decision NOT IN ('dismissed', 'saved');

        CREATE UNIQUE INDEX IF NOT EXISTS images_decision_ordinal
          ON images(decision_ordinal)
          WHERE decision_ordinal IS NOT NULL;

        PRAGMA user_version = 3;
      `);
      currentVersion = 3;
    }

    if (currentVersion < 4) {
      await transaction.exec(`
        CREATE TABLE images_v4 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_key TEXT NOT NULL CHECK (provider_key IN ('waifu_im', 'nekos_api')),
          provider_item_id TEXT NOT NULL,
          canonical_source_key TEXT,
          perceptual_hash TEXT,
          remote_url TEXT NOT NULL,
          source_url TEXT,
          artist_name TEXT,
          artist_url TEXT,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          byte_size INTEGER NOT NULL,
          extension TEXT NOT NULL,
          dominant_color TEXT NOT NULL,
          is_nsfw INTEGER NOT NULL CHECK (is_nsfw IN (0, 1)),
          is_animated INTEGER NOT NULL CHECK (is_animated IN (0, 1)),
          tags_json TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('queued', 'active', 'dismissed', 'saved')),
          presented_at INTEGER,
          decided_at INTEGER,
          queue_ordinal INTEGER NOT NULL,
          decision_ordinal INTEGER,
          local_uri TEXT,
          download_state TEXT NOT NULL CHECK (download_state IN ('none', 'pending', 'ready', 'failed')),
          download_error TEXT
        );

        INSERT INTO images_v4 (
          id, provider_key, provider_item_id, canonical_source_key, perceptual_hash,
          remote_url, source_url, artist_name, artist_url, width, height, byte_size,
          extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
          presented_at, decided_at, queue_ordinal, decision_ordinal, local_uri,
          download_state, download_error
        )
        SELECT
          id, 'waifu_im', CAST(id AS TEXT), NULL, NULL,
          remote_url, source_url, artist_name, artist_url, width, height, byte_size,
          extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
          presented_at, decided_at, queue_ordinal, decision_ordinal, local_uri,
          download_state, download_error
        FROM images;

        DROP TABLE images;
        ALTER TABLE images_v4 RENAME TO images;

        CREATE UNIQUE INDEX images_provider_identity
          ON images(provider_key, provider_item_id);
        CREATE INDEX images_canonical_source_key
          ON images(canonical_source_key)
          WHERE canonical_source_key IS NOT NULL;
        CREATE INDEX images_perceptual_hash
          ON images(perceptual_hash)
          WHERE perceptual_hash IS NOT NULL;
        CREATE INDEX images_decision_decided_at
          ON images(decision, decided_at DESC);
        CREATE INDEX images_download_state
          ON images(download_state);
        CREATE INDEX images_queue_ordinal
          ON images(queue_ordinal);
        CREATE UNIQUE INDEX images_one_active
          ON images((1)) WHERE decision = 'active';
        CREATE UNIQUE INDEX images_decision_ordinal
          ON images(decision_ordinal)
          WHERE decision_ordinal IS NOT NULL;

        PRAGMA user_version = 4;
      `);
      const legacySources = await transaction.getAll<{
        id: number;
        source_url: string | null;
      }>('SELECT id, source_url FROM images WHERE source_url IS NOT NULL');
      for (const row of legacySources) {
        const canonicalSourceKey = canonicalizeSourceUrl(row.source_url);
        if (canonicalSourceKey !== null) {
          await transaction.run(
            'UPDATE images SET canonical_source_key = ? WHERE id = ?',
            [canonicalSourceKey, row.id],
          );
        }
      }
      currentVersion = 4;
    }

    if (currentVersion < 5) {
      await transaction.exec(`
        CREATE TABLE images_v5 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_key TEXT NOT NULL,
          provider_item_id TEXT NOT NULL,
          canonical_source_key TEXT,
          perceptual_hash TEXT,
          remote_url TEXT NOT NULL,
          source_url TEXT,
          artist_name TEXT,
          artist_url TEXT,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          byte_size INTEGER NOT NULL,
          extension TEXT NOT NULL,
          dominant_color TEXT NOT NULL,
          is_nsfw INTEGER NOT NULL CHECK (is_nsfw IN (0, 1)),
          is_animated INTEGER NOT NULL CHECK (is_animated IN (0, 1)),
          tags_json TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('queued', 'active', 'dismissed', 'saved')),
          presented_at INTEGER,
          decided_at INTEGER,
          queue_ordinal INTEGER NOT NULL,
          decision_ordinal INTEGER,
          local_uri TEXT,
          download_state TEXT NOT NULL CHECK (download_state IN ('none', 'pending', 'ready', 'failed')),
          download_error TEXT
        );

        INSERT INTO images_v5 (
          id, provider_key, provider_item_id, canonical_source_key, perceptual_hash,
          remote_url, source_url, artist_name, artist_url, width, height, byte_size,
          extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
          presented_at, decided_at, queue_ordinal, decision_ordinal, local_uri,
          download_state, download_error
        )
        SELECT
          id, provider_key, provider_item_id, canonical_source_key, perceptual_hash,
          remote_url, source_url, artist_name, artist_url, width, height, byte_size,
          extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
          presented_at, decided_at, queue_ordinal, decision_ordinal, local_uri,
          download_state, download_error
        FROM images;

        DROP TABLE images;
        ALTER TABLE images_v5 RENAME TO images;

        CREATE UNIQUE INDEX images_provider_identity
          ON images(provider_key, provider_item_id);
        CREATE INDEX images_canonical_source_key
          ON images(canonical_source_key)
          WHERE canonical_source_key IS NOT NULL;
        CREATE INDEX images_perceptual_hash
          ON images(perceptual_hash)
          WHERE perceptual_hash IS NOT NULL;
        CREATE INDEX images_decision_decided_at
          ON images(decision, decided_at DESC);
        CREATE INDEX images_download_state
          ON images(download_state);
        CREATE INDEX images_queue_ordinal
          ON images(queue_ordinal);
        CREATE UNIQUE INDEX images_one_active
          ON images((1)) WHERE decision = 'active';
        CREATE UNIQUE INDEX images_decision_ordinal
          ON images(decision_ordinal)
          WHERE decision_ordinal IS NOT NULL;

        PRAGMA user_version = 5;
      `);
      currentVersion = 5;
    }

    if (currentVersion < 6) {
      // Queued candidates are transient; refill them so upgraded installs use
      // the newly enabled provider set immediately.
      if (startingVersion > 0) {
        await transaction.run("DELETE FROM images WHERE decision = 'queued'");
      }
      await transaction.exec('PRAGMA user_version = 6;');
      currentVersion = 6;
    }

    if (currentVersion < 7) {
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(images)',
      );
      const columnNames = new Set(columns.map(({ name }) => name));
      if (!columnNames.has('content_rating')) {
        await transaction.exec(`
          ALTER TABLE images ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'safe'
            CHECK (content_rating IN (
              'safe', 'suggestive', 'nsfw_unspecified', 'explicit', 'unknown'
            ));
        `);
      }
      if (!columnNames.has('native_rating')) {
        await transaction.exec('ALTER TABLE images ADD COLUMN native_rating TEXT;');
      }
      if (!columnNames.has('taste_signal')) {
        await transaction.exec(`
          ALTER TABLE images ADD COLUMN taste_signal TEXT
            CHECK (taste_signal IN ('saved', 'dismissed'));
        `);
      }
      if (!columnNames.has('taste_recorded_at')) {
        await transaction.exec(
          'ALTER TABLE images ADD COLUMN taste_recorded_at INTEGER;',
        );
      }
      await transaction.exec(`
        UPDATE images
        SET content_rating = CASE
          WHEN is_nsfw = 1 THEN 'nsfw_unspecified'
          ELSE 'safe'
        END;

        UPDATE images
        SET taste_signal = 'saved',
            taste_recorded_at = decided_at
        WHERE decision = 'saved'
          AND decided_at IS NOT NULL;

        CREATE INDEX IF NOT EXISTS images_taste_recorded_at
          ON images(taste_recorded_at DESC)
          WHERE taste_signal IS NOT NULL;

        PRAGMA user_version = 7;
      `);
      currentVersion = 7;
    }

    if (currentVersion < 8) {
      // Early v7 builds could not distinguish left swipes from system retirement.
      await transaction.exec(`
        UPDATE images
        SET taste_signal = NULL,
            taste_recorded_at = NULL
        WHERE taste_signal = 'dismissed';

        PRAGMA user_version = 8;
      `);
      currentVersion = 8;
    }

    if (currentVersion < 9) {
      // Additive private-library tables. `images` is never dropped or rebuilt
      // here; `source_image_id` is a soft bridge with no foreign key because
      // earlier ladder steps rebuild `images` wholesale.
      //
      // Layer A (`device_library_assets`) is account-free: a signed-out Store
      // or Direct device owns local originals keyed by their plaintext digest.
      // Layer B (`library_account_assets`, `library_outbox`) adds the
      // Vault-scoped keyed identity and the durable sync intent, and is
      // written only when an account session exists.
      await transaction.exec(`
        CREATE TABLE IF NOT EXISTS device_library_assets (
          plaintext_sha256 TEXT NOT NULL PRIMARY KEY
            CHECK (length(plaintext_sha256) = 64),
          format TEXT NOT NULL
            CHECK (format IN ('jpeg', 'png', 'webp', 'gif')),
          canonical_extension TEXT NOT NULL
            CHECK (canonical_extension IN ('jpg', 'png', 'webp', 'gif')),
          byte_size INTEGER NOT NULL CHECK (byte_size > 0),
          width INTEGER NOT NULL CHECK (width > 0),
          height INTEGER NOT NULL CHECK (height > 0),
          origin TEXT NOT NULL CHECK (origin IN ('provider', 'import')),
          source_image_id INTEGER,
          local_original_uri TEXT,
          residency TEXT NOT NULL
            CHECK (residency IN ('local-original', 'cached', 'cloud-only')),
          protect_eligible INTEGER NOT NULL
            CHECK (protect_eligible IN (0, 1)),
          missing_original_since INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS device_library_assets_created_at
          ON device_library_assets(created_at DESC);
        CREATE INDEX IF NOT EXISTS device_library_assets_source_image
          ON device_library_assets(source_image_id)
          WHERE source_image_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS device_library_assets_missing_original
          ON device_library_assets(missing_original_since)
          WHERE missing_original_since IS NOT NULL;

        CREATE TABLE IF NOT EXISTS library_account_assets (
          account_scope TEXT NOT NULL
            CHECK (length(account_scope) > 0),
          asset_id TEXT NOT NULL CHECK (length(asset_id) = 64),
          plaintext_sha256 TEXT NOT NULL
            CHECK (length(plaintext_sha256) = 64),
          device_id TEXT NOT NULL CHECK (length(device_id) > 0),
          enrolled_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_scope, asset_id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS library_account_assets_scope_digest
          ON library_account_assets(account_scope, plaintext_sha256);
        CREATE INDEX IF NOT EXISTS library_account_assets_digest
          ON library_account_assets(plaintext_sha256);

        CREATE TABLE IF NOT EXISTS library_outbox (
          mutation_id TEXT NOT NULL PRIMARY KEY
            CHECK (length(mutation_id) = 36),
          account_scope TEXT NOT NULL
            CHECK (length(account_scope) > 0),
          device_id TEXT NOT NULL CHECK (length(device_id) > 0),
          asset_id TEXT NOT NULL CHECK (length(asset_id) = 64),
          kind TEXT NOT NULL CHECK (kind IN (
            'collect', 'protect', 'trash', 'restore', 'stop-protection'
          )),
          base_revision INTEGER,
          observed_generation INTEGER,
          state TEXT NOT NULL
            CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0
            CHECK (attempt_count >= 0),
          next_attempt_at INTEGER,
          last_error_code TEXT,
          local_metadata_json TEXT NOT NULL,
          encrypted_payload BLOB,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS library_outbox_account_kind_asset
          ON library_outbox(account_scope, kind, asset_id);
        CREATE INDEX IF NOT EXISTS library_outbox_ready
          ON library_outbox(state, next_attempt_at);

        PRAGMA user_version = 9;
      `);
      currentVersion = 9;
    }

    if (currentVersion < 10) {
      // Additive SP7 tables. Nothing in v9 is dropped or rebuilt: the account
      // projection, the per-device sidecar, and the batch queue are new
      // siblings keyed by the identities v9 already established.
      await transaction.exec(`
        CREATE TABLE IF NOT EXISTS library_device_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          save_policy TEXT NOT NULL CHECK (save_policy IN (
            'this-device-only', 'this-device-and-cloud', 'cloud-only'
          )),
          updated_at INTEGER NOT NULL
        );

        INSERT OR IGNORE INTO library_device_settings (id, save_policy, updated_at)
          VALUES (1, 'this-device-only', 0);

        CREATE TABLE IF NOT EXISTS library_asset_protection (
          account_scope TEXT NOT NULL CHECK (length(account_scope) > 0),
          asset_id TEXT NOT NULL CHECK (length(asset_id) = 64),
          plaintext_sha256 TEXT NOT NULL CHECK (length(plaintext_sha256) = 64),
          lifecycle TEXT NOT NULL
            CHECK (lifecycle IN ('active', 'trash', 'purged')),
          protection TEXT NOT NULL CHECK (protection IN (
            'unprotected', 'pending', 'protected', 'failed'
          )),
          generation INTEGER NOT NULL CHECK (generation >= 0),
          revision INTEGER,
          original_generation_id TEXT,
          original_ciphertext_bytes INTEGER
            CHECK (original_ciphertext_bytes IS NULL
              OR original_ciphertext_bytes > 0),
          verified_at INTEGER,
          failure_category TEXT,
          trashed_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_scope, asset_id)
        );

        CREATE INDEX IF NOT EXISTS library_asset_protection_digest
          ON library_asset_protection(account_scope, plaintext_sha256);
        CREATE INDEX IF NOT EXISTS library_asset_protection_state
          ON library_asset_protection(account_scope, protection, lifecycle);

        CREATE TABLE IF NOT EXISTS library_device_asset_state (
          plaintext_sha256 TEXT NOT NULL PRIMARY KEY
            CHECK (length(plaintext_sha256) = 64),
          cached_roles_json TEXT NOT NULL DEFAULT '[]',
          last_verified_at INTEGER,
          device_trash_uri TEXT,
          device_trashed_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS library_device_asset_state_trashed
          ON library_device_asset_state(device_trashed_at)
          WHERE device_trashed_at IS NOT NULL;

        CREATE TABLE IF NOT EXISTS library_batch_operations (
          batch_id TEXT NOT NULL PRIMARY KEY CHECK (length(batch_id) = 36),
          account_scope TEXT NOT NULL CHECK (length(account_scope) > 0),
          kind TEXT NOT NULL CHECK (kind IN (
            'protect-all', 'download-all', 'free-all'
          )),
          state TEXT NOT NULL
            CHECK (state IN ('running', 'paused', 'completed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Lookup aid for per-scope open-batch checks. Intentionally not a
        -- UNIQUE partial on (account_scope) WHERE state <> 'completed': a
        -- pre-existing plurality within one scope must remain recoverable
        -- (Task 10 sequential recovery). Single-open going forward is
        -- enforced by transactional recheck-then-insert in enqueue.
        CREATE INDEX IF NOT EXISTS library_batch_operations_open
          ON library_batch_operations(account_scope, state);

        CREATE TABLE IF NOT EXISTS library_batch_items (
          batch_id TEXT NOT NULL
            REFERENCES library_batch_operations(batch_id) ON DELETE CASCADE,
          plaintext_sha256 TEXT NOT NULL CHECK (length(plaintext_sha256) = 64),
          position INTEGER NOT NULL CHECK (position >= 0),
          state TEXT NOT NULL
            CHECK (state IN ('pending', 'running', 'done', 'failed')),
          failure_category TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (batch_id, plaintext_sha256)
        );

        CREATE INDEX IF NOT EXISTS library_batch_items_ready
          ON library_batch_items(batch_id, state, position);

        UPDATE device_library_assets
           SET protect_eligible = CASE
                 WHEN byte_size <= 67108768 THEN 1 ELSE 0 END
         WHERE protect_eligible <> CASE
                 WHEN byte_size <= 67108768 THEN 1 ELSE 0 END;

        PRAGMA user_version = 10;
      `);
      currentVersion = 10;
    }

    if (currentVersion < 11) {
      // Additive SP8 table. Nothing in v10 is dropped or rebuilt: the durable
      // per-account-scope sync cursor is a new sibling of the v10 projection.
      // No Store build ever writes it, and a device with no account never has
      // a row here at all.
      await transaction.exec(`
        CREATE TABLE IF NOT EXISTS library_sync_state (
          account_scope TEXT NOT NULL PRIMARY KEY
            CHECK (length(account_scope) > 0),
          change_cursor INTEGER NOT NULL DEFAULT 0
            CHECK (change_cursor >= 0),
          min_base_cursor INTEGER NOT NULL DEFAULT 0
            CHECK (min_base_cursor >= 0),
          latest_revision INTEGER NOT NULL DEFAULT 0
            CHECK (latest_revision >= 0),
          resync_pending INTEGER NOT NULL DEFAULT 0
            CHECK (resync_pending IN (0, 1)),
          last_synced_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        PRAGMA user_version = 11;
      `);
      currentVersion = 11;
    }

    if (currentVersion < 12) {
      // Additive SP9A step plus the one CHECK rebuild SP8 left owed. The three
      // new projection columns are nullable so no v11 row needs a backfill; a
      // NULL `object_refs_revision` simply means "never swept", which is what
      // the bounded index sweep wants. `library_outbox` is rebuilt only to
      // widen its `kind` CHECK; every column, row, BLOB, and index is copied
      // across unchanged.
      const protectionColumns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(library_asset_protection)',
      );
      const protectionNames = new Set(
        protectionColumns.map(({ name }) => name),
      );
      if (!protectionNames.has('thumbnail_generation_id')) {
        await transaction.exec(
          'ALTER TABLE library_asset_protection ADD COLUMN thumbnail_generation_id TEXT;',
        );
      }
      if (!protectionNames.has('preview_generation_id')) {
        await transaction.exec(
          'ALTER TABLE library_asset_protection ADD COLUMN preview_generation_id TEXT;',
        );
      }
      if (!protectionNames.has('object_refs_revision')) {
        await transaction.exec(
          'ALTER TABLE library_asset_protection ADD COLUMN object_refs_revision INTEGER;',
        );
      }

      await transaction.exec(`
        CREATE TABLE IF NOT EXISTS library_cache_entries (
          account_scope TEXT NOT NULL CHECK (length(account_scope) > 0),
          plaintext_sha256 TEXT NOT NULL
            CHECK (length(plaintext_sha256) = 64),
          role TEXT NOT NULL CHECK (role IN ('thumbnail', 'preview', 'original')),
          uri TEXT NOT NULL CHECK (length(uri) > 0),
          byte_size INTEGER NOT NULL CHECK (byte_size > 0),
          generation_id TEXT,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          PRIMARY KEY (account_scope, plaintext_sha256, role)
        );

        CREATE INDEX IF NOT EXISTS library_cache_entries_lru
          ON library_cache_entries(account_scope, last_used_at ASC);

        CREATE TABLE library_outbox_v12 (
          mutation_id TEXT NOT NULL PRIMARY KEY
            CHECK (length(mutation_id) = 36),
          account_scope TEXT NOT NULL
            CHECK (length(account_scope) > 0),
          device_id TEXT NOT NULL CHECK (length(device_id) > 0),
          asset_id TEXT NOT NULL CHECK (length(asset_id) = 64),
          kind TEXT NOT NULL CHECK (kind IN (
            'collect', 'protect', 'trash', 'restore', 'stop-protection',
            'permanent-delete'
          )),
          base_revision INTEGER,
          observed_generation INTEGER,
          state TEXT NOT NULL
            CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0
            CHECK (attempt_count >= 0),
          next_attempt_at INTEGER,
          last_error_code TEXT,
          local_metadata_json TEXT NOT NULL,
          encrypted_payload BLOB,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        INSERT INTO library_outbox_v12 (
          mutation_id, account_scope, device_id, asset_id, kind, base_revision,
          observed_generation, state, attempt_count, next_attempt_at,
          last_error_code, local_metadata_json, encrypted_payload,
          created_at, updated_at
        )
        SELECT
          mutation_id, account_scope, device_id, asset_id, kind, base_revision,
          observed_generation, state, attempt_count, next_attempt_at,
          last_error_code, local_metadata_json, encrypted_payload,
          created_at, updated_at
        FROM library_outbox;

        DROP TABLE library_outbox;
        ALTER TABLE library_outbox_v12 RENAME TO library_outbox;

        CREATE UNIQUE INDEX library_outbox_account_kind_asset
          ON library_outbox(account_scope, kind, asset_id);
        CREATE INDEX library_outbox_ready
          ON library_outbox(state, next_attempt_at);

        PRAGMA user_version = 12;
      `);
      currentVersion = 12;
    }

    if (currentVersion < 13) {
      // Additive SP9C export mark for the remove-device-data gate. A non-null
      // `exported_at` means the user explicitly exported that durable original
      // via the export-for-removal path. Protected assets do not need this mark.
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(library_device_asset_state)',
      );
      const names = new Set(columns.map(({ name }) => name));
      if (!names.has('exported_at')) {
        await transaction.exec(
          'ALTER TABLE library_device_asset_state ADD COLUMN exported_at INTEGER;',
        );
      }
      await transaction.exec('PRAGMA user_version = 13;');
      currentVersion = 13;
    }

    if (currentVersion < 14) {
      // P3C-2 Task 7d: widen library_batch_operations.kind to admit
      // 'empty-trash' (client-side orchestration of the trash purge). Same
      // rebuild-in-place shape as v12's library_outbox widening, but this
      // table has a child (library_batch_items, ON DELETE CASCADE), and
      // `foreign_keys = ON` (line 9 above) means DROP TABLE performs an
      // implicit DELETE that WOULD cascade-empty the child. Items are backed
      // up to a plain scratch copy first and reinserted after the parent is
      // rebuilt so no in-flight batch's items are lost.
      await transaction.exec(`
        CREATE TABLE library_batch_items_v14_backup AS
          SELECT * FROM library_batch_items;

        CREATE TABLE library_batch_operations_v14 (
          batch_id TEXT NOT NULL PRIMARY KEY CHECK (length(batch_id) = 36),
          account_scope TEXT NOT NULL CHECK (length(account_scope) > 0),
          kind TEXT NOT NULL CHECK (kind IN (
            'protect-all', 'download-all', 'free-all', 'empty-trash'
          )),
          state TEXT NOT NULL
            CHECK (state IN ('running', 'paused', 'completed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        INSERT INTO library_batch_operations_v14 (
          batch_id, account_scope, kind, state, created_at, updated_at
        )
        SELECT batch_id, account_scope, kind, state, created_at, updated_at
          FROM library_batch_operations;

        DROP TABLE library_batch_operations;
        ALTER TABLE library_batch_operations_v14
          RENAME TO library_batch_operations;

        CREATE INDEX IF NOT EXISTS library_batch_operations_open
          ON library_batch_operations(account_scope, state);

        -- Deterministic pre-restore state. Today this is a no-op: the DROP
        -- above already cascade-emptied library_batch_items because
        -- foreign_keys = ON (line 9) is set for the whole connection. But
        -- that emptiness is only true *because* enforcement happens to be on
        -- at this exact moment -- there is no way to assert PRAGMA
        -- foreign_keys mid-transaction (SQLite ignores the pragma inside an
        -- active transaction), so nothing here actually guarantees it. If
        -- enforcement were ever off, or a row were somehow orphaned, the
        -- restore INSERT below would collide on the primary key and abort
        -- the whole migration, permanently stranding the database. Making
        -- the pre-restore state explicit removes that assumption.
        DELETE FROM library_batch_items;

        INSERT INTO library_batch_items (
          batch_id, plaintext_sha256, position, state, failure_category,
          updated_at
        )
        SELECT
          batch_id, plaintext_sha256, position, state, failure_category,
          updated_at
        FROM library_batch_items_v14_backup;

        DROP TABLE library_batch_items_v14_backup;

        PRAGMA user_version = 14;
      `);
      currentVersion = 14;
    }

    if (currentVersion < 15) {
      // G2b Signal B: the byte-exact MD5 the booru APIs already publish, so
      // the persistence gate can recognise the same file re-offered by a
      // different source. Purely additive, in the same shape as the v4
      // `perceptual_hash` column plus its partial index: nothing is rebuilt
      // and no row is rewritten. Existing rows keep md5 = NULL and are
      // excluded from the new gate arm by its `? IS NOT NULL` guard, exactly
      // like a null perceptual_hash is today. There is deliberately no
      // backfill -- the digest only becomes known when an item is re-seen
      // from a provider that publishes it, at which point the gate's
      // COALESCE update fills it in.
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(images)',
      );
      if (!columns.some(({ name }) => name === 'md5')) {
        await transaction.exec('ALTER TABLE images ADD COLUMN md5 TEXT;');
      }
      await transaction.exec(`
        CREATE INDEX IF NOT EXISTS images_md5
          ON images(md5)
          WHERE md5 IS NOT NULL;

        PRAGMA user_version = 15;
      `);
      currentVersion = 15;
    }

    if (currentVersion < 16) {
      // R8.18: the medium-size display image each source publishes next to
      // the original (moebooru/gelbooru `sample_url`, danbooru
      // `large_file_url`, e621 `sample.url`). The discover deck and its
      // prefetch render this instead of the full-resolution `remote_url`,
      // whose decode + texture upload of 4000x7000 originals froze the swipe
      // animation on device (98% janky frames, 1190ms single frames).
      // Purely additive like v15's md5: existing rows keep NULL and the
      // repository row mapper falls back to remote_url for them, so nothing
      // is rebuilt or backfilled. Saving still downloads remote_url.
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(images)',
      );
      if (!columns.some(({ name }) => name === 'sample_url')) {
        await transaction.exec('ALTER TABLE images ADD COLUMN sample_url TEXT;');
      }
      await transaction.exec('PRAGMA user_version = 16;');
      currentVersion = 16;
    }

    if (currentVersion < 17) {
      // K2 (2026-09-11): a fourth download_state, `mirrored` — the row's bytes
      // are owned by the private library (library/originals/<sha> or the BYOS
      // bucket), not by the collection directory. The collection never
      // downloads or holds a file for it: local_uri and download_error are
      // NULL by invariant. Restored rows from another device are written in
      // this state so the startup sweeper (`resumePendingDownloads`) no longer
      // re-fetches them from the original booru.
      //
      // SQLite cannot ALTER a CHECK, so rebuild in place exactly like v4/v5:
      // full current DDL (v5 base + v7..v16 additive columns), copy every
      // column, swap, recreate the same index set. No table has a FOREIGN KEY
      // to images (verified against a device DB), so DROP cannot cascade.
      await transaction.exec(`
        CREATE TABLE images_v17 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_key TEXT NOT NULL,
          provider_item_id TEXT NOT NULL,
          canonical_source_key TEXT,
          perceptual_hash TEXT,
          remote_url TEXT NOT NULL,
          source_url TEXT,
          artist_name TEXT,
          artist_url TEXT,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          byte_size INTEGER NOT NULL,
          extension TEXT NOT NULL,
          dominant_color TEXT NOT NULL,
          is_nsfw INTEGER NOT NULL CHECK (is_nsfw IN (0, 1)),
          is_animated INTEGER NOT NULL CHECK (is_animated IN (0, 1)),
          tags_json TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('queued', 'active', 'dismissed', 'saved')),
          presented_at INTEGER,
          decided_at INTEGER,
          queue_ordinal INTEGER NOT NULL,
          decision_ordinal INTEGER,
          local_uri TEXT,
          download_state TEXT NOT NULL
            CHECK (download_state IN ('none', 'pending', 'ready', 'failed', 'mirrored')),
          download_error TEXT,
          content_rating TEXT NOT NULL DEFAULT 'safe'
            CHECK (content_rating IN (
              'safe', 'suggestive', 'nsfw_unspecified', 'explicit', 'unknown'
            )),
          native_rating TEXT,
          taste_signal TEXT CHECK (taste_signal IN ('saved', 'dismissed')),
          taste_recorded_at INTEGER,
          md5 TEXT,
          sample_url TEXT
        );

        INSERT INTO images_v17 (
          id, provider_key, provider_item_id, canonical_source_key, perceptual_hash,
          remote_url, source_url, artist_name, artist_url, width, height, byte_size,
          extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
          presented_at, decided_at, queue_ordinal, decision_ordinal, local_uri,
          download_state, download_error, content_rating, native_rating,
          taste_signal, taste_recorded_at, md5, sample_url
        )
        SELECT
          id, provider_key, provider_item_id, canonical_source_key, perceptual_hash,
          remote_url, source_url, artist_name, artist_url, width, height, byte_size,
          extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
          presented_at, decided_at, queue_ordinal, decision_ordinal, local_uri,
          download_state, download_error, content_rating, native_rating,
          taste_signal, taste_recorded_at, md5, sample_url
        FROM images;

        DROP TABLE images;
        ALTER TABLE images_v17 RENAME TO images;

        CREATE UNIQUE INDEX images_provider_identity
          ON images(provider_key, provider_item_id);
        CREATE INDEX images_canonical_source_key
          ON images(canonical_source_key)
          WHERE canonical_source_key IS NOT NULL;
        CREATE INDEX images_perceptual_hash
          ON images(perceptual_hash)
          WHERE perceptual_hash IS NOT NULL;
        CREATE INDEX images_decision_decided_at
          ON images(decision, decided_at DESC);
        CREATE INDEX images_download_state
          ON images(download_state);
        CREATE INDEX images_queue_ordinal
          ON images(queue_ordinal);
        CREATE UNIQUE INDEX images_one_active
          ON images((1)) WHERE decision = 'active';
        CREATE UNIQUE INDEX images_decision_ordinal
          ON images(decision_ordinal)
          WHERE decision_ordinal IS NOT NULL;
        CREATE INDEX images_taste_recorded_at
          ON images(taste_recorded_at DESC)
          WHERE taste_signal IS NOT NULL;
        CREATE INDEX images_md5
          ON images(md5)
          WHERE md5 IS NOT NULL;

        -- Data migration: a saved row that another device restored here carries
        -- a device_library_assets.source_image_id pointer and never received a
        -- collection file (pending, or failed after a booru re-fetch). Its bytes
        -- can only be the library's. Rows that DID get a collection file
        -- ('ready') are indistinguishable from this device's own collects and
        -- are left alone (spec §3). K2b: a pointer whose library original is
        -- already known-missing cannot vouch for the bytes; that row keeps its
        -- repairable 'failed' state.
        UPDATE images
           SET download_state = 'mirrored', local_uri = NULL, download_error = NULL
         WHERE decision = 'saved'
           AND download_state IN ('pending', 'failed')
           AND id IN (
             SELECT source_image_id FROM device_library_assets
              WHERE source_image_id IS NOT NULL
                AND missing_original_since IS NULL
           );

        PRAGMA user_version = 17;
      `);
      currentVersion = 17;
    }

    if (currentVersion < 18) {
      // K7 cut 3: the BYOS change-discovery ETag index, made durable.
      //
      // Change discovery LISTs the whole `assets/` prefix and re-reads only
      // the keys whose ETag differs from what this device last read. That
      // index lived in an in-process Map, so it was empty on every cold start
      // and the first sync round after each launch GOT every `state.json` in
      // the bucket, one at a time (measured: ~55 s of network on a 450-asset
      // library, with exactly one request in flight). An ETag is a
      // server-side content hash, so a persisted (key, etag, record) triple
      // cannot be stale while the ETag still matches — the only reason the
      // index was in memory was that nobody had written the table.
      //
      // Purely additive, like v15/v16: a new sibling table, no rebuild, no
      // backfill. An empty table simply means "nothing indexed yet", which is
      // exactly today's every-launch state, so a device that migrates mid-vault
      // pays one ordinary full pass and is warm from then on. The CHECKs
      // encode the port's own invariant at rest: an empty ETag proves nothing
      // about freshness (`remember` evicts instead of caching it), so it must
      // never reach a row that could later suppress a real read.
      await transaction.exec(`
        CREATE TABLE IF NOT EXISTS library_remote_state_cache (
          account_scope TEXT NOT NULL CHECK (length(account_scope) > 0),
          key TEXT NOT NULL PRIMARY KEY CHECK (length(key) > 0),
          etag TEXT NOT NULL CHECK (length(etag) > 0),
          record_json TEXT NOT NULL CHECK (length(record_json) > 0),
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS library_remote_state_cache_scope
          ON library_remote_state_cache(account_scope);

        PRAGMA user_version = 18;
      `);
      currentVersion = 18;
    }

    if (currentVersion < 19) {
      // K6-5 C: where a collected save went when it never reached the library.
      //
      // The download chain ends at `markDownloadReady` -> the collect adapter ->
      // `ingest.ingestUri`, and ingest can throw: `empty_file`,
      // `unreadable_source`, `unsupported_format`, `decode_failed`, storage, or
      // database. Nothing persisted that. The row stayed `ready` with a local
      // file, so the tile rendered an ordinary offline image with no ring, no
      // cloud, and no repair affordance — a blank tile the user cannot act on,
      // and no later pass re-ingested it (owner phone 2026-09-14: 82 saved,
      // 42 in the bucket).
      //
      // `download_error` is taken: it means the *provider* fetch failed and is
      // bound to `download_state = 'failed'` by the row mapper's state check.
      // This is a different failure of a row whose download succeeded, so it
      // gets its own column and does not touch `download_state`.
      //
      // The sibling counter is what makes `unsupported_format` / `decode_failed`
      // terminal *after a second try* rather than immediately: both can be
      // transient on a device (a copy that raced a concurrent write, a decode
      // under memory pressure with six ingest lanes), so one occurrence is not
      // proof that the bytes are unusable. Additive like v15/v16 — existing rows
      // read NULL/0, which is exactly "nothing has failed yet".
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(images)',
      );
      if (!columns.some(({ name }) => name === 'library_error')) {
        await transaction.exec('ALTER TABLE images ADD COLUMN library_error TEXT;');
      }
      if (!columns.some(({ name }) => name === 'library_error_attempts')) {
        await transaction.exec(
          'ALTER TABLE images ADD COLUMN library_error_attempts INTEGER NOT NULL DEFAULT 0;',
        );
      }
      await transaction.exec('PRAGMA user_version = 19;');
      currentVersion = 19;
    }

    if (currentVersion < 20) {
      // Board #5 (2026-09-18): WHY a download failed, not just that it did.
      //
      // `download_error` carries one generic code, so the app could not tell
      // "the source returned 404/410 — this image is gone, retrying is
      // pointless" from "the network dropped — retrying works". Both sat as a
      // manual 「需修复」 tile until the user noticed. The kind lets the resume
      // sweep re-download transient failures on its own (on the sweep the app
      // already runs — cold start and pull-to-refresh; owner ruled 2026-09-18 to
      // keep those two triggers, no Collection-tab focus sweep) and lets the
      // tile say 「源站已删除」 for the
      // gone ones — and it never deletes a row: a right-swipe is an explicit
      // "keep", and only the user may reverse it.
      //
      // Additive like v15/v16/v19: existing rows read NULL, which the sweep and
      // the UI treat exactly like `transient` (never hide something that might
      // come back). Values are validated by the row mapper, not a CHECK, because
      // ADD COLUMN cannot attach a CHECK to a populated table portably.
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(images)',
      );
      if (!columns.some(({ name }) => name === 'download_error_kind')) {
        await transaction.exec('ALTER TABLE images ADD COLUMN download_error_kind TEXT;');
      }
      await transaction.exec('PRAGMA user_version = 20;');
      currentVersion = 20;
    }

    if (currentVersion < 21) {
      // Board #27 S2 (spec §5.9): the durable thumbnail this device keeps in
      // Paths.document/library/thumbnails, so 收藏 renders offline once an
      // original has left the phone (S3). Device-level, never account-scoped.
      // Additive like v19/v20: existing rows read NULL, "none yet".
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(device_library_assets)',
      );
      if (!columns.some(({ name }) => name === 'local_thumbnail_uri')) {
        await transaction.exec(
          'ALTER TABLE device_library_assets ADD COLUMN local_thumbnail_uri TEXT;',
        );
      }
      await transaction.exec('PRAGMA user_version = 21;');
      currentVersion = 21;
    }

    if (currentVersion < 22) {
      // N6-A1 (spec §4.3, §4.4): import classification ('safe' | 'adult' |
      // 'unknown', default 'unknown' for all pre-N6 rows), device-local import
      // deletion timestamp (`import_deleted_at`), and committed provider
      // image-to-digest association table (`library_provider_image_assets`).
      const columns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(device_library_assets)',
      );
      if (!columns.some(({ name }) => name === 'import_classification')) {
        await transaction.exec(
          `ALTER TABLE device_library_assets
             ADD COLUMN import_classification TEXT NOT NULL DEFAULT 'unknown'
             CHECK (import_classification IN ('safe', 'adult', 'unknown'));`,
        );
      }
      if (!columns.some(({ name }) => name === 'import_deleted_at')) {
        await transaction.exec(
          'ALTER TABLE device_library_assets ADD COLUMN import_deleted_at INTEGER;',
        );
      }
      await transaction.exec(`
        CREATE TABLE IF NOT EXISTS library_provider_image_assets (
          image_id INTEGER NOT NULL PRIMARY KEY,
          plaintext_sha256 TEXT NOT NULL CHECK (length(plaintext_sha256) = 64),
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS library_provider_image_assets_digest
          ON library_provider_image_assets(plaintext_sha256);

        INSERT OR IGNORE INTO library_provider_image_assets (
          image_id, plaintext_sha256, updated_at
        )
        SELECT a.source_image_id, a.plaintext_sha256, a.updated_at
          FROM device_library_assets a
         WHERE a.source_image_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM device_library_assets n
              WHERE n.source_image_id = a.source_image_id
                AND (
                  n.created_at > a.created_at
                  OR (n.created_at = a.created_at AND n.plaintext_sha256 < a.plaintext_sha256)
                )
           );

        PRAGMA user_version = 22;
      `);
      currentVersion = 22;
    }

    if (currentVersion < 23) {
      // N6-A3 (spec §4.3, §4.4): account-scoped validated metadata summary
      // (`library_account_metadata_summary`), surviving device-local delete
      // without rendering a tile and cleared with `clearAccountProjection` /
      // `forgetEveryAccount`, plus `applied_state_key` on
      // `library_asset_protection` so whole-winning-state apply tracks the
      // winning append note (`state/<name>`) or S3 CAS revision (`s3:<rev>`).
      const protectionColumns = await transaction.getAll<{ name: string }>(
        'PRAGMA table_info(library_asset_protection)',
      );
      if (!protectionColumns.some(({ name }) => name === 'applied_state_key')) {
        await transaction.exec(
          'ALTER TABLE library_asset_protection ADD COLUMN applied_state_key TEXT;',
        );
      }
      await transaction.exec(`
        CREATE TABLE IF NOT EXISTS library_account_metadata_summary (
          account_scope TEXT NOT NULL CHECK (length(account_scope) > 0),
          asset_id TEXT NOT NULL CHECK (length(asset_id) = 64),
          plaintext_sha256 TEXT NOT NULL CHECK (length(plaintext_sha256) = 64),
          origin TEXT NOT NULL CHECK (origin IN ('provider', 'import')),
          collected_at INTEGER NOT NULL,
          import_classification TEXT NOT NULL DEFAULT 'unknown'
            CHECK (import_classification IN ('safe', 'adult', 'unknown')),
          source_json TEXT,
          state_key TEXT NOT NULL CHECK (length(state_key) > 0),
          sealed_meta TEXT NOT NULL CHECK (length(sealed_meta) > 0),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_scope, asset_id)
        );

        CREATE INDEX IF NOT EXISTS library_account_metadata_summary_digest
          ON library_account_metadata_summary(account_scope, plaintext_sha256);

        PRAGMA user_version = 23;
      `);
      currentVersion = 23;
    }
  });
}
