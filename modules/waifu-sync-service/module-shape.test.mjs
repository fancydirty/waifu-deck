import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * K6-3 Task 1 text guards. The Kotlin in this module cannot be compiled or
 * executed by any gate that runs in this repository (no Gradle, no emulator in
 * the agent's environment), so the contract that keeps the foreground service
 * legal on Android 14+ — the two service permissions, the `dataSync` type on
 * both the manifest entry and the `startForeground` call — is asserted as text.
 * A missing `FOREGROUND_SERVICE_TYPE_DATA_SYNC` is not a compile error; it is a
 * `MissingForegroundServiceTypeException` at runtime, on the owner's phone,
 * the first time a save starts an upload.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const androidMain = path.join(moduleDir, 'android', 'src', 'main');
const javaDir = path.join(androidMain, 'java', 'expo', 'modules', 'waifusync');

const read = (...segments) => readFileSync(path.join(...segments), 'utf8');

/**
 * Assertions about what the code *does* run on comment-free source: the doc
 * comments deliberately name `createClientBuilder()` to explain why it is not
 * used, and a guard that cannot tell an explanation from a call would force
 * the explanation out of the file.
 */
const readCode = (...segments) => read(...segments)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');


test('expo-module.config.json registers an Android module class that exists', () => {
  const config = JSON.parse(read(moduleDir, 'expo-module.config.json'));
  assert.deepEqual(config.platforms, ['android']);
  const classes = config.android.modules;
  assert.equal(classes.length, 1);
  const [qualified] = classes;
  assert.equal(qualified, 'expo.modules.waifusync.WaifuSyncServiceModule');
  const file = path.join(javaDir, `${qualified.split('.').pop()}.kt`);
  assert.ok(existsSync(file), `${qualified} has no source file at ${file}`);
});

/**
 * Autolinking scans `./modules` and, per `scanning.js`, resolves each entry
 * through its `package.json`. Without one the module is still found by name but
 * carries no version, and `main` is what makes `import ... from
 * '../../modules/waifu-sync-service'` resolve to `index.ts` under Metro.
 */
test('the module is a resolvable package pointing at its JS entry', () => {
  const pkg = JSON.parse(read(moduleDir, 'package.json'));
  assert.equal(pkg.name, 'waifu-sync-service');
  assert.ok(existsSync(path.join(moduleDir, pkg.main)), `main ${pkg.main} does not exist`);
});

test('the manifest declares the data-sync foreground service and its permissions', () => {
  const manifest = read(androidMain, 'AndroidManifest.xml');
  for (const permission of [
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    'android.permission.POST_NOTIFICATIONS',
  ]) {
    assert.match(
      manifest,
      new RegExp(`<uses-permission[^>]*android:name="${permission}"`),
      `manifest is missing ${permission}`,
    );
  }
  assert.match(manifest, /android:name="\.SyncForegroundService"/);
  assert.match(manifest, /android:exported="false"/);
  assert.match(manifest, /android:foregroundServiceType="dataSync"/);
});

test('the manifest declares the battery allowance permission and all three settings queries', () => {
  const manifest = stripXmlComments(read(androidMain, 'AndroidManifest.xml'));
  assert.match(
    manifest,
    /<uses-permission\b[^>]*android:name="android\.permission\.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"/,
    'the one-tap battery allowance dialog requires REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  );
  const queries = manifest.match(/<queries\b[^>]*>([\s\S]*?)<\/queries>/);
  assert.ok(queries, 'settings resolution requires a queries block');
  const intents = [...queries[1].matchAll(/<intent\b[^>]*>([\s\S]*?)<\/intent>/g)];
  const actions = intents.flatMap(([, intent]) => (
    [...intent.matchAll(/<action\b[^>]*android:name="([^"]+)"/g)].map(([, action]) => action)
  ));
  for (const requiredAction of [
    'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
    'android.settings.APPLICATION_DETAILS_SETTINGS',
  ]) {
    assert.ok(
      actions.includes(requiredAction),
      `the three battery settings actions must be visible through queries intents (missing ${requiredAction})`,
    );
  }
});

test('the service stops timed-out data-sync work and guards every foreground start', () => {
  const service = readCode(javaDir, 'SyncForegroundService.kt');
  const timeoutAt = service.indexOf('override fun onTimeout(startId: Int, fgsType: Int)');
  const onStartAt = service.indexOf('override fun onStartCommand(', timeoutAt);
  assert.ok(timeoutAt >= 0, 'the service must override the two-argument timeout callback');
  assert.ok(onStartAt > timeoutAt, 'onTimeout must be a distinct method before onStartCommand');

  const timeout = service.slice(timeoutAt, onStartAt);
  assert.match(
    timeout,
    /if\s*\(\(fgsType\s+and\s+ServiceInfo\.FOREGROUND_SERVICE_TYPE_DATA_SYNC\)\s*==\s*0\)\s*return/,
    'data-sync timeout must return early only for non-data-sync types',
  );
  assert.match(timeout, /ServiceInfo\.FOREGROUND_SERVICE_TYPE_DATA_SYNC/);
  assert.match(timeout, /ServiceCompat\.STOP_FOREGROUND_REMOVE/);
  assert.match(timeout, /foreground\s*=\s*false/);
  assert.match(timeout, /stopSelf\(startId\)/);
  assert.doesNotMatch(timeout, /startForeground\(/);
  assert.doesNotMatch(timeout, /stopSelf\(\)/);
  assert.equal((timeout.match(/Log\./g) ?? []).length, 1, 'timeout must log exactly once');

  const helperAt = service.indexOf('private fun startForegroundSafely(');
  assert.ok(helperAt > onStartAt, 'all foreground starts must use the private helper');
  const onStart = service.slice(onStartAt, helperAt);
  const helperEnd = service.indexOf('private fun notificationManager()', helperAt);
  assert.ok(helperEnd > helperAt, 'the foreground helper must have a bounded body');
  const helper = service.slice(helperAt, helperEnd);
  assert.equal((service.match(/ServiceCompat\.startForeground\(/g) ?? []).length, 1);
  assert.match(helper, /try\s*\{[\s\S]*?ServiceCompat\.startForeground\(/);
  assert.match(helper, /catch\s*\(e: Exception\)/);
  assert.match(helper, /Log\.w\(/);
  assert.match(helper, /foreground\s*=\s*false/);
  assert.match(helper, /stopSelf\(startId\)/);
  const catchAt = helper.indexOf('} catch');
  assert.ok(catchAt > 0, 'the foreground helper must catch start failures');
  assert.match(helper.slice(0, catchAt), /true\s*$/);
  assert.match(helper.slice(catchAt), /false\s*\}\s*\}\s*$/);
  assert.match(onStart, /if\s*\(!foreground\)\s*\{/);
  assert.equal((onStart.match(/startForegroundSafely\(/g) ?? []).length, 2);
  assert.equal((onStart.match(/if\s*\(!startForegroundSafely\(/g) ?? []).length, 2);
  assert.equal((onStart.match(/return START_NOT_STICKY/g) ?? []).length, 3);
  const coldBranchEnd = onStart.indexOf('} else if (action != ACTION_STOP)', onStart.indexOf('if (!foreground)'));
  assert.ok(coldBranchEnd > 0, 'the cold foreground branch must precede UPDATE handling');
  const coldBranch = onStart.slice(onStart.indexOf('if (!foreground)'), coldBranchEnd);
  assert.match(coldBranch, /if\s*\(!startForegroundSafely\(/);
  assert.match(coldBranch.trim(), /foreground\s*=\s*true\s*$/);
  assert.match(service, /FOREGROUND_SERVICE_TYPE_DATA_SYNC/);
  assert.match(service, /STOP_FOREGROUND_REMOVE/);
  assert.equal((service.match(/stopSelf\(startId\)/g) ?? []).length, 3);
  assert.doesNotMatch(service, /stopSelf\(\)/);
});

test('the module exposes the JS API the guard and settings row call', () => {
  const source = read(javaDir, 'WaifuSyncServiceModule.kt');
  assert.match(source, /Name\("WaifuSyncService"\)/);
  for (const fn of [
    'start',
    'update',
    'stop',
    'isBatteryOptimizationIgnored',
    'requestIgnoreBatteryOptimizations',
    'uploadFile',
    'cancelUpload',
    'copyBackupFile',
    'copyBackupImportFile',
    // K6-4c: the parallel-range download and its cancel.
    'downloadRanges',
    'cancelDownload',
  ]) {
    assert.match(source, new RegExp(`(AsyncFunction|Function)\\("${fn}"\\)`), `missing ${fn}`);
  }
  assert.match(source, /Events\([^)]*"onUploadProgress"/);
  assert.match(source, /Events\([^)]*"onDownloadProgress"/);
});

test('the streamed library-file binding is cancellable, keyed, and shape-safe', () => {
  const source = readCode(javaDir, 'WaifuSyncServiceModule.kt');
  const types = readCode(moduleDir, 'src', 'WaifuSyncService.types.ts');
  const index = readCode(moduleDir, 'index.ts');

  for (const fn of [
    'decryptLibraryObjectToFile',
    'encryptLibraryObjectToFile',
    'copyFileToFileWithSha256',
    'cancelDecrypt',
  ]) {
    assert.match(source, new RegExp(`AsyncFunction\\("${fn}"\\)`), `missing ${fn}`);
  }
  assert.doesNotMatch(source, /runBlocking/);
  assert.match(source, /LibraryObjectStreamCrypto\.StreamCryptoException/);
  for (const [code, nativeCode] of [
    ['FORMAT', 'ERR_LIBRARY_FORMAT'],
    ['INTEGRITY', 'ERR_LIBRARY_INTEGRITY'],
    ['IO', 'ERR_LIBRARY_IO'],
    ['CANCELLED', 'ERR_LIBRARY_CANCELLED'],
  ]) {
    assert.match(source, new RegExp(`Code\\.${code}\\s*->\\s*${nativeCode}`), `missing ${code} mapping`);
  }

  const registerAt = source.indexOf('taskRegistry.putIfAbsent');
  const duplicateAt = source.indexOf('ERR_TASK_DUPLICATE', registerAt);
  const submitAt = source.indexOf('fileTaskExecutor.execute', registerAt);
  assert.ok(registerAt >= 0, 'tasks must register in one shared registry');
  assert.ok(duplicateAt > registerAt && duplicateAt < submitAt, 'duplicate ids must reject before submit');
  assert.ok((source.match(/finally\s*\{[^}]*taskRegistry\.remove\(/g) ?? []).length >= 2);
  assert.ok((source.match(/finally\s*\{[^}]*masterKey\.fill\(0\)/g) ?? []).length >= 2);
  assert.doesNotMatch(source, /Log\.[^(]*\([^)]*(masterKey|dataKey)/);

  assert.match(types, /type NativeDecryptResponse\s*=\s*Readonly/);
  assert.match(types, /type NativeFileErrorCode\s*=/);
  assert.match(types, /type LibraryObjectScope\s*=/);
  assert.match(types, /scope:\s*'original'\s*\|\s*'thumbnail'\s*\|\s*'preview'/);
  for (const signature of [
    'decryptLibraryObjectToFile',
    'encryptLibraryObjectToFile',
    'cancelDecrypt',
    'copyFileToFileWithSha256',
  ]) {
    assert.match(types, new RegExp(`${signature}\\s*\\(`), `missing TS ${signature}`);
  }
  assert.match(index, /NativeDecryptResponse/);
  assert.match(index, /NativeEncryptResponse/);
});

test('the native file-task binding enforces the exact async signatures and shared lifecycle', () => {
  const source = readCode(javaDir, 'WaifuSyncServiceModule.kt');
  const types = readCode(moduleDir, 'src', 'WaifuSyncService.types.ts');
  const between = (start, end) => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `missing ${start}`);
    const to = source.indexOf(end, from);
    assert.ok(to > from, `missing ${end}`);
    return source.slice(from, to);
  };
  const params = (name) => {
    const match = source.match(new RegExp(
      `AsyncFunction\\("${name}"\\)\\s*\\{([\\s\\S]*?)\\s*->`,
    ));
    assert.ok(match, `missing parameter list for ${name}`);
    return match[1].replace(/\s+/g, ' ').trim();
  };

  assert.equal(
    params('decryptLibraryObjectToFile'),
    'taskId: String, sourcePath: String, destPath: String, masterKey: ByteArray, assetId: String, scope: String, promise: Promise,',
  );
  assert.equal(
    params('encryptLibraryObjectToFile'),
    'taskId: String, sourcePath: String, destPath: String, masterKey: ByteArray, assetId: String, scope: String, promise: Promise,',
  );
  assert.equal(
    params('copyFileToFileWithSha256'),
    'taskId: String, sourcePath: String, destPath: String, promise: Promise,',
  );
  assert.equal(params('cancelDecrypt'), 'taskId: String');
  assert.match(source, /private\s+sealed\s+class\s+FileTask/);
  assert.doesNotMatch(source, /downloads/);
  assert.match(source, /newFixedThreadPool\(4\)/);
  assert.doesNotMatch(source, /newCachedThreadPool/);

  const range = between('AsyncFunction("downloadRanges")', 'AsyncFunction("cancelDownload")');
  const rangeRegisterAt = range.indexOf('taskRegistry.putIfAbsent');
  const rangeDestinationAt = range.indexOf('val destination');
  assert.ok(rangeRegisterAt >= 0 && rangeRegisterAt < rangeDestinationAt);
  assert.match(range, /FileTask\.Range/);
  assert.match(range, /ERR_TASK_DUPLICATE/);
  assert.match(
    range,
    /onSettled\s*=\s*\{\s*taskRegistry\.remove\(taskId,\s*rangeTask\)\s*\}/,
    'range download onSettled must remove its own task by identity',
  );

  const decrypt = between('AsyncFunction("decryptLibraryObjectToFile")', 'AsyncFunction("copyFileToFileWithSha256")');
  const copy = between('AsyncFunction("copyFileToFileWithSha256")', 'AsyncFunction("cancelDecrypt")');
  assert.match(decrypt, /submitFileTask\(taskId, masterKey, promise\)/);
  assert.match(copy, /submitFileTask\(taskId, null, promise\)/);
  assert.ok((source.match(/taskRegistry\.putIfAbsent/g) ?? []).length >= 2);

  const cancelDownload = between('AsyncFunction("cancelDownload")', 'private fun serviceIntent');
  const cancelDecrypt = between('AsyncFunction("cancelDecrypt")', 'AsyncFunction("downloadRanges")');
  assert.match(cancelDownload, /FileTask\.Range/);
  assert.match(
    cancelDownload,
    /if\s*\(\s*task\s+is\s+FileTask\.Range\s*&&\s*taskRegistry\.remove\(taskId,\s*task\)\s*\)\s*\{\s*task\.download\?\.fail\(/,
    'cancelDownload must remove the matching task before failing its download',
  );

  const registryRemovals = [...source.matchAll(/taskRegistry\.remove\(([^)]*)\)/g)]
    .map(([, args]) => args.split(',').map((argument) => argument.trim()));
  assert.ok(registryRemovals.length > 0, 'task registry must have removal call sites');
  assert.ok(
    registryRemovals.every((args) => args.length === 2 && args.every(Boolean)),
    `every taskRegistry.remove call must take task id and entry: ${JSON.stringify(registryRemovals)}`,
  );

  assert.doesNotMatch(cancelDownload, /FileTask\.Crypto/);
  assert.match(cancelDecrypt, /FileTask\.Crypto/);
  assert.match(cancelDecrypt, /\.cancelled\.set\(true\)/);
  assert.doesNotMatch(cancelDecrypt, /FileTask\.Range/);

  const submit = source.slice(source.indexOf('private fun submitFileTask'));
  assert.match(submit, /try\s*\{\s*if\s*\(taskRegistry\.putIfAbsent/);
  assert.match(submit, /catch\s*\(error: Throwable\)[\s\S]*?finally\s*\{\s*taskRegistry\.remove\(taskId, task\)/);
  assert.match(submit, /finally\s*\{\s*if\s*\(!submitted\s*&&\s*masterKey\s*!=\s*null\)[\s\S]*?masterKey\.fill\(0\)/);
  assert.match(submit, /catch\s*\(error: Throwable\)[\s\S]*?rejectLibraryError\(promise, error\)/);
  assert.match(submit, /return ERR_LIBRARY_IO/);

  const normalizedTypes = types.replace(/\s+/g, ' ');
  assert.match(
    normalizedTypes,
    /decryptLibraryObjectToFile\( taskId: string, sourcePath: string, destPath: string, masterKey: Uint8Array, assetId: string, scope: 'original' \| 'thumbnail' \| 'preview', \): Promise<NativeDecryptResponse>/,
  );
  assert.match(
    normalizedTypes,
    /cancelDecrypt\(taskId: string\): Promise<void>/,
  );
  assert.match(
    normalizedTypes,
    /copyFileToFileWithSha256\( taskId: string, sourcePath: string, destPath: string, \): Promise<NativeDecryptResponse>/,
  );
  assert.match(
    normalizedTypes,
    /encryptLibraryObjectToFile\( taskId: string, sourcePath: string, destPath: string, masterKey: Uint8Array, assetId: string, scope: 'original' \| 'thumbnail' \| 'preview', \): Promise<NativeEncryptResponse>/,
  );
});

test('the native streamed download is single-pass, bounded, and shared with range cancellation', () => {
  const source = readCode(javaDir, 'WaifuSyncServiceModule.kt');
  const types = readCode(moduleDir, 'src', 'WaifuSyncService.types.ts');
  const index = readCode(moduleDir, 'index.ts');
  const from = source.indexOf('AsyncFunction("downloadToFile")');
  const to = source.indexOf('AsyncFunction("copyBackupFile")', from);
  assert.ok(from >= 0 && to > from, 'missing streamed download block');
  const stream = source.slice(from, to);
  const params = stream.match(/AsyncFunction\("downloadToFile"\)\s*\{([\s\S]*?)\s*->/);
  assert.ok(params, 'missing downloadToFile parameter list');
  assert.equal(
    params[1].replace(/\s+/g, ' ').trim(),
    'taskId: String, url: String, destPath: String, headers: Map<String, String>, maxBytes: Long, promise: Promise,',
  );
  assert.match(stream, /FileTask\.Stream/);
  assert.match(stream, /OkHttpClientProvider\.createClient\(\)/);
  const registerAt = stream.indexOf('taskRegistry.putIfAbsent');
  const createAt = stream.indexOf('createNewFile');
  const requestAt = stream.indexOf('newCall');
  assert.ok(registerAt >= 0 && registerAt < createAt && registerAt < requestAt);
  assert.match(stream, /\.enqueue\(/);
  assert.doesNotMatch(stream, /\.execute\s*\(/);
  assert.match(stream, /(?:it|response)\.priorResponse\s*!=\s*null/);
  assert.match(source, /64\s*\*\s*1024/);
  assert.match(source, /remaining\s*=\s*maxBytes/);
  assert.match(stream, /readErrorBody\(it\.body\)/);
  assert.doesNotMatch(stream, /Accept-Encoding/i);
  assert.match(stream, /if\s*\(it\.code\s*!in\s*200\.\.299\)\s*\{\s*deleteDownloadFile\(destination\)/);
  assert.match(stream, /"bytesWritten"\s*to\s*0L/);
  assert.match(stream, /streamTask\.cancelled\.get\(\)\s*\)\s*\{\s*ERR_DOWNLOAD_CANCELLED/);
  assert.match(source, /(?:it|response)\.priorResponse\s*!=\s*null/);
  assert.doesNotMatch(source, /response\.isRedirect/);

  const kotlinSources = readdirSync(javaDir)
    .filter((name) => name.endsWith('.kt'))
    .map((name) => readCode(javaDir, name))
    .join('\n');
  for (const [pattern, label] of [
    [/\.followRedirects\s*\(/, '.followRedirects('],
    [/\.followSslRedirects\s*\(/, '.followSslRedirects('],
    [/\.addInterceptor\s*\(/, '.addInterceptor('],
    [/\.addNetworkInterceptor\s*\(/, '.addNetworkInterceptor('],
  ]) {
    assert.doesNotMatch(kotlinSources, pattern, `native Kotlin must not configure ${label}`);
  }

  const cancelFrom = source.indexOf('AsyncFunction("cancelDownload")');
  const cancelTo = source.indexOf('private fun serviceIntent', cancelFrom);
  const cancel = source.slice(cancelFrom, cancelTo);
  assert.match(cancel, /FileTask\.Stream/);
  assert.match(cancel, /if\s*\(\s*task\s+is\s+FileTask\.Stream\s+&&/);
  assert.match(cancel, /taskRegistry\.remove\(taskId, task\)/);
  assert.match(cancel, /cancelled\.set\(true\)/);
  assert.match(cancel, /call\?\.cancel\(\)/);
  assert.match(cancel, /FileTask\.Range/);
  assert.doesNotMatch(cancel, /FileTask\.Crypto/);

  for (const [code, nativeCode] of [
    ['NETWORK', 'ERR_DOWNLOAD_NETWORK'],
    ['IO', 'ERR_LIBRARY_IO'],
    ['FORMAT', 'ERR_LIBRARY_FORMAT'],
    ['CANCELLED', 'ERR_DOWNLOAD_CANCELLED'],
  ]) {
    assert.match(
      source,
      new RegExp(`LibraryStreamCopy\\.Code\\.${code}\\s*->\\s*${nativeCode}`),
      `missing streamed ${code} mapping`,
    );
  }

  const normalizedTypes = types.replace(/\s+/g, ' ');
  assert.match(types, /type NativeDownloadResponse\s*=\s*Readonly/);
  assert.match(
    normalizedTypes,
    /downloadToFile\( taskId: string, url: string, destPath: string, headers: Record<string, string>, maxBytes: number, \): Promise<NativeDownloadResponse>/,
  );
  assert.match(index, /NativeDownloadResponse/);
});

test('every native ERR identifier has an equal companion-object declaration', () => {
  const source = readCode(javaDir, 'WaifuSyncServiceModule.kt');
  const withoutStrings = source.replace(/"(?:\\.|[^"\\])*"/g, '');
  const identifiers = new Set(withoutStrings.match(/\bERR_[A-Z_]+\b/g) ?? []);
  const declarations = new Map(
    [...source.matchAll(/const\s+val\s+(ERR_[A-Z_]+)\s*=\s*"([^"]*)"/g)]
      .map(([, name, value]) => [name, value]),
  );
  for (const name of identifiers) {
    assert.equal(
      declarations.get(name),
      name,
      `${name} must be declared as const val ${name} = "${name}"`,
    );
  }
});

test('the native backup-file copy streams a SQLite blob without a Java-heap read', () => {
  const source = readCode(javaDir, 'BackupFileCopy.kt');
  const moduleSource = readCode(javaDir, 'WaifuSyncServiceModule.kt');
  const types = readCode(moduleDir, 'src', 'WaifuSyncService.types.ts');
  assert.match(source, /simpleQueryForBlobFileDescriptor/);
  assert.match(source, /OPEN_READONLY/);
  assert.match(source, /FileOutputStream\(destination, false\)/);
  assert.match(source, /SELECT data FROM backup_files WHERE image_id = \?/);
  assert.match(source, /SELECT data FROM backup_import_files WHERE plaintext_sha256 = \?/);
  assert.match(source, /statement\.bindLong\(1,\s*imageId\)/);
  assert.match(source, /statement\.bindString\(1,\s*plaintextSha256\)/);
  assert.match(source, /isValidSha256Hex/);
  assert.match(moduleSource, /backupCopyExecutor\.execute/);
  assert.match(moduleSource, /AsyncFunction\("copyBackupImportFile"\)/);
  assert.match(types, /copyBackupFile\s*\(/);
  assert.match(types, /copyBackupImportFile\s*\(/);
  for (const forbidden of ['getBlob', 'readBytes', 'readAllBytes']) {
    assert.doesNotMatch(source, new RegExp(forbidden));
  }
});

/**
 * K7 finding #36 (controller-verified): `expo-file-system`'s upload task builds
 * its own OkHttp client through `OkHttpClientProvider.createClientBuilder()`
 * and hardcodes 60 s connect/read/write timeouts, so it ignores the K6-1d
 * IPv4-first, pooled client factory and kills a slow-but-live upload at 60 s.
 * The native port exists only to avoid that, so both halves are asserted: it
 * must take the factory-built client, and it must not re-introduce a timeout.
 * Stall detection stays in the JS transport, which is the side that knows what
 * "no bytes moved" means for this request.
 */
test('the native upload path uses the tuned shared client and sets no timeouts', () => {
  const sources = ['WaifuSyncServiceModule.kt', 'ProgressRequestBody.kt', 'RangeDownload.kt']
    .map((name) => readCode(javaDir, name))
    .join('\n');
  assert.match(sources, /OkHttpClientProvider\.createClient\(\)/);
  assert.doesNotMatch(sources, /createClientBuilder\(\)/);
  // K6-1g: the upload must not block the module's single worker queue — a
  // blocking execute() serialised parallel putBlobs on device (3.6 s → 9.5 s).
  assert.doesNotMatch(sources, /call\.execute\(\)/, 'uploadFile must not block the module queue');
  assert.match(sources, /call\.enqueue\(/, "uploadFile must hand the call to OkHttp's dispatcher");
  for (const timeout of ['connectTimeout', 'readTimeout', 'writeTimeout']) {
    assert.doesNotMatch(
      sources,
      new RegExp(`\\.${timeout}\\(`),
      `${timeout} must not be set: RN's builder is no-timeout by default and the `
        + 'JS transport owns stall detection',
    );
  }
});

test('the progress body reports bytes as they are written', () => {
  const body = read(javaDir, 'ProgressRequestBody.kt');
  assert.match(body, /RequestBody\(\)/);
  assert.match(body, /writeTo\(/);
  assert.match(body, /onUploadProgress|onProgress/);
});

/**
 * K6-4c text guards. Measured on the owner's network 2026-09-14: the booru file
 * host serves ~150 KB/s *per stream* (`accept-ranges: bytes`, Cloudflare cache
 * HIT), so a 4.25 MB wallpaper takes 29 s on one stream and 9.5 s as four
 * parallel `Range` requests. Everything asserted below is a runtime property on
 * the owner's phone, not a compile error: a missing `setLength` silently
 * produces a truncated file, a blocking `execute()` re-serialises the segments
 * the split exists to parallelise, and a partial file left behind after a
 * failed segment is a corrupt image in the collection.
 */
test('the range download splits the file into offset writes on the tuned client', () => {
  const source = readCode(javaDir, 'WaifuSyncServiceModule.kt');
  const range = readCode(javaDir, 'RangeDownload.kt');
  const sources = `${source}\n${range}`;

  // One GET per segment, each asking for its own byte window.
  assert.match(sources, /"Range"/, 'each segment must send a Range header');
  assert.match(sources, /bytes=\$\{?/, 'the Range header must be a bytes= window');
  // Segments land at their offset in one pre-sized file rather than in temp
  // parts that would then have to be concatenated.
  assert.match(sources, /RandomAccessFile/);
  assert.match(sources, /setLength\(/);
  assert.match(sources, /\.seek\(/);
  // Same non-blocking dispatcher rule as uploadFile (K6-1g): the module's
  // single worker queue must not run the transfers.
  assert.match(sources, /\.enqueue\(/);
  assert.doesNotMatch(sources, /\.execute\(\)/);
  assert.match(sources, /OkHttpClientProvider\.createClient\(\)/);
  // Partial content only; a 200 means the host ignored the Range and is about
  // to write the whole body into one segment's window.
  assert.match(sources, /206/);
  assert.match(sources, /ERR_DOWNLOAD_RANGE/);
  // A failed segment cancels its siblings and takes the half-written file with
  // it, so the caller can fall back to a single stream from a clean slate.
  assert.match(sources, /\.cancel\(\)/);
  assert.match(sources, /delete\(\)/);
  // 64 KiB progress cadence (spec: `onDownloadProgress` every 64 KiB).
  assert.match(sources, /64 \* 1024|65_?536/);
  assert.match(sources, /sendEvent\(\s*"onDownloadProgress"/);
  assert.match(sources, /"bytesReceived"/);
  assert.match(sources, /"totalBytes"/);
});

/**
 * Board row 46. The app animates GIF and animated WebP. penfeizhou's
 * animated-AVIF check copies the bytes it reads into a `byte[]` and again into
 * a direct `ByteBuffer` (both on the Java heap on Android). expo-image's
 * generated `AppGlideModule` disables manifest parsing, so the default that
 * skips that check is installed by creating Glide before any image load. These
 * are text guards: the Kotlin is compiled by the release build, not here.
 */
const repoRoot = path.resolve(moduleDir, '../..');
const expoImageAndroid = path.join(repoRoot, 'node_modules', 'expo-image', 'android');
const glidePackageClass = 'WaifuGlidePackage.kt';

const versionList = (values) => `[${values.join(', ') || 'none'}]`;

const configuredBuilder = 'GlideBuilder().setDefaultRequestOptions(RequestOptions().set(AnimationDecoderOption.DISABLE_ANIMATION_AVIF_DECODER,true))';

const stripGradle = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const stripXmlComments = (source) => source.replace(/<!--[\s\S]*?-->/g, '');

/** Index of the delimiter that closes the one opened at `openIndex`. */
const closeOf = (source, openIndex, open, close) => {
  assert.equal(source[openIndex], open, `expected ${open} at ${openIndex}`);
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  assert.fail(`unbalanced ${open}${close}`);
};

const balancedInside = (source, openIndex, open, close) => (
  source.slice(openIndex + 1, closeOf(source, openIndex, open, close))
);

/** Drop whitespace and Kotlin trailing commas so the builder call has one spelling. */
const canonicalize = (text) => text.replace(/\s+/g, '').replace(/,(?=\))/g, '');

const topLevelArgs = (list) => {
  const args = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(list.slice(start, i));
      start = i + 1;
    }
  }
  args.push(list.slice(start));
  return args.filter((arg) => arg.trim());
};

const funBody = (code, name) => {
  const match = new RegExp(`\\bfun\\s+${name}\\s*\\(`).exec(code);
  assert.ok(match, `missing fun ${name} in the returned listener`);
  const openParen = match.index + match[0].length - 1;
  const afterParams = closeOf(code, openParen, '(', ')') + 1;
  const openBrace = code.indexOf('{', afterParams);
  assert.ok(openBrace >= 0, `fun ${name} has no body`);
  return balancedInside(code, openBrace, '{', '}');
};

/**
 * Body of `object <name>` or `class <name>`. The opening brace must belong to
 * that declaration: a following type with the brace would attribute `onCreate`
 * to a listener `listOf` does not return.
 */
const typeBody = (code, name) => {
  const match = new RegExp(`(?:object|class)\\s+${name}\\b`).exec(code);
  assert.ok(match, `missing object or class ${name}`);
  const after = match.index + match[0].length;
  const open = code.indexOf('{', after);
  const nextDecl = code.slice(after).search(/\b(?:object|class|fun)\s/);
  assert.ok(
    open >= 0 && (nextDecl < 0 || after + nextDecl > open),
    `${name} has no body`,
  );
  return balancedInside(code, open, '{', '}');
};

/**
 * The listener `createApplicationLifecycleListeners` returns. The whole
 * expression must be `listOf(<listener>)`: the next token closes the class or
 * starts another member, so a chained call such as `.take(0)` (same line or the
 * next) cannot empty the list.
 */
const returnedListenerName = (code) => {
  const returned = code.match(
    /override\s+fun\s+createApplicationLifecycleListeners\s*\([^()]*\)\s*(?::[^=]+?)?=\s*listOf\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)(?=\s*(?:\}|@|(?:override|private|public|internal|protected|fun|val|var|companion|init|class|object)\b))/,
  );
  assert.ok(returned, 'createApplicationLifecycleListeners must return exactly listOf(the listener)');
  return returned[1];
};

/**
 * Body of the returned listener's `onCreate`. It must be the one `fun onCreate`
 * in the listener and override `onCreate(<name>: Application)`: an overload such
 * as `onCreate(Context)` is never dispatched, and the interface default does nothing.
 */
const lifecycleOnCreate = (listener) => {
  const declared = listener.match(/\bfun\s+onCreate\b/g) ?? [];
  assert.equal(declared.length, 1, `the returned listener must declare exactly one fun onCreate, found ${declared.length}`);
  assert.match(
    listener,
    /\boverride\s+fun\s+onCreate\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*(?:android\.app\.)?Application\s*\)/,
    'the returned listener must override onCreate(application: Application)',
  );
  return funBody(listener, 'onCreate');
};

/**
 * `onCreate` of the returned listener is the guard, then one direct
 * `Glide.init` call. A nested fun, lambda, or other block cannot hold that call.
 * After `Glide.init`, the only other statement allowed is row 47's registration
 * thread. Row 47's own guard requires that thread; an empty tail is not it.
 */
const assertDirectInit = (onCreate) => {
  assert.doesNotMatch(onCreate, /\bfun\s/, 'onCreate must not declare a nested fun');
  const guard = onCreate.match(
    /^\s*if\s*\(\s*Glide\.isInitialized\(\)\s*\)\s*(?:return\b|\{\s*return\s*\})/,
  );
  assert.ok(guard, 'onCreate must open with if (Glide.isInitialized()) return');
  const rest = onCreate.slice(guard[0].length).trim();
  assert.match(rest, /^Glide\.init\s*\(/, 'Glide.init( must be a direct statement after the guard');
  const open = rest.indexOf('(');
  const close = closeOf(rest, open, '(', ')');
  const trailing = rest.slice(close + 1).trim();
  if (trailing !== '') {
    assert.match(
      trailing,
      /^thread\s*\(/,
      `nothing may follow Glide.init except one registration thread, found: ${trailing}`,
    );
    const threadParen = trailing.indexOf('(');
    const threadParenClose = closeOf(trailing, threadParen, '(', ')');
    const braceAt = trailing.indexOf('{', threadParenClose);
    assert.ok(braceAt > threadParenClose, 'the registration thread must take a lambda body');
    assert.equal(
      trailing.slice(threadParenClose + 1, braceAt).trim(),
      '',
      'the registration thread call must be followed only by its lambda',
    );
    const braceClose = closeOf(trailing, braceAt, '{', '}');
    assert.equal(
      trailing.slice(braceClose + 1).trim(),
      '',
      `nothing may follow the registration thread, found: ${trailing.slice(braceClose + 1).trim()}`,
    );
  }
  const args = topLevelArgs(rest.slice(open + 1, close));
  assert.equal(args.length, 2, `Glide.init must take the context and the configured builder, found ${args.length}`);
  assert.equal(
    canonicalize(args[1]),
    configuredBuilder,
    `Glide.init's second argument must be the configured GlideBuilder, found: ${canonicalize(args[1])}`,
  );
};

/**
 * Statements of a Kotlin block. A newline ends a statement only at depth 0
 * and only when the next line does not continue it (a chain, an operator).
 * An `if`/`run` body stays inside its statement because of the braces.
 */
const topLevelStatements = (source) => {
  const statements = [];
  let i = 0;
  const skipWs = () => {
    while (i < source.length && /\s/.test(source[i])) i += 1;
  };
  while (i < source.length) {
    skipWs();
    if (i >= source.length) break;
    const start = i;
    let paren = 0;
    let brace = 0;
    let bracket = 0;
    let quote = '';
    while (i < source.length) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = '';
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '(') paren += 1;
      else if (ch === ')') paren -= 1;
      else if (ch === '{') brace += 1;
      else if (ch === '}') brace -= 1;
      else if (ch === '[') bracket += 1;
      else if (ch === ']') bracket -= 1;
      if (paren < 0 || brace < 0 || bracket < 0) assert.fail('unbalanced registration body');
      const atRoot = paren === 0 && brace === 0 && bracket === 0;
      if (atRoot && (ch === '\n' || ch === ';')) {
        const next = source.slice(i + 1).match(/\S/);
        const continues = next && '.?+:&|,)'.includes(next[0]);
        if (!continues) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
    const statement = source.slice(start, i).replace(/;\s*$/, '').trim();
    if (statement) statements.push(statement);
  }
  return statements;
};

/**
 * The registration lambda's body is these statements and nothing else, so a
 * wrapper that merely contains the calls (`if`, `run`, `?.let`) cannot pass.
 */
const assertDirectRegistration = (body, bitmapClass, drawableClass) => {
  assert.doesNotMatch(body, /return@thread\b/, 'the registration lambda must not return early');
  assert.doesNotMatch(
    body,
    /\b(?:if|when|try)\b|\?\.let\b|\b(?:run|also|let|apply|with)\s*[({]/,
    'registration must be unconditional: no if/when/?.let/run/also/try around it',
  );
  const statements = topLevelStatements(body);
  const expected = [
    'valglide=Glide.get(application)',
    'valbitmapEncoder=BitmapEncoder(glide.arrayPool)',
    'valdrawableEncoder=BitmapDrawableEncoder(glide.bitmapPool,bitmapEncoder)',
    `glide.registry.prepend(Bitmap::class.java,${bitmapClass}(bitmapEncoder)).prepend(BitmapDrawable::class.java,${drawableClass}(drawableEncoder))`,
  ];
  assert.equal(
    statements.length,
    expected.length,
    `the registration thread must run ${expected.length} unconditional statements, found ${statements.length}: ${statements.map((statement) => statement.trim().slice(0, 80)).join(' || ')}`,
  );
  statements.forEach((statement, index) => {
    assert.equal(
      canonicalize(statement),
      expected[index],
      `registration statement ${index + 1} must run directly in the thread, found: ${statement.trim().slice(0, 160)}`,
    );
  });
};

/**
 * One `compileOnly` coordinate. `artifact` is a regex for group:name without
 * the version. Accepts single or double quotes and `compileOnly '…'` or
 * `compileOnly('…')`. `any` counts every occurrence, so a second configuration
 * or a duplicate line cannot hide behind one `compileOnly`.
 */
const gradleCoordinates = (source, artifact) => {
  const any = [...source.matchAll(new RegExp(`${artifact}:([^'"\\s)]+)`, 'g'))].map((match) => match[1]);
  const compileOnly = [...source.matchAll(new RegExp(
    `(?:^|\\n)\\s*compileOnly\\s*\\(?\\s*(['"])${artifact}:([^'"]+)\\1`,
    'g',
  ))].map((match) => match[2]);
  return { any, compileOnly };
};

const assertVersionOnce = (label, ours, theirs) => {
  const message = `${label} compileOnly ${versionList(ours.compileOnly)} (${versionList(ours.any)} occurrence(s)) must occur once and equal expo-image ${versionList(theirs)}`;
  assert.equal(ours.compileOnly.length, 1, message);
  assert.deepEqual(ours.any, ours.compileOnly, message);
  assert.equal(theirs.length, 1, message);
  assert.equal(ours.compileOnly[0], theirs[0], message);
};

test('board row 46 autolinks WaifuGlidePackage and returns its lifecycle listener', () => {
  assert.ok(glidePackageClass.endsWith('Package.kt'), `${glidePackageClass} must end in Package.kt`);
  const classFile = path.join(javaDir, glidePackageClass);
  assert.ok(existsSync(classFile), `${glidePackageClass} has no source file at ${classFile}`);

  const code = readCode(javaDir, glidePackageClass);
  assert.match(
    code,
    /\bimport\s+expo\.modules\.core\.(interfaces\.Package|BasePackage)\b/,
    'autolinking requires import expo.modules.core.interfaces.Package',
  );
  assert.match(
    code,
    /class\s+WaifuGlidePackage\s*:\s*Package\b/,
    'class WaifuGlidePackage must implement Package',
  );

  const name = returnedListenerName(code);
  assert.match(
    code,
    new RegExp(`(?:^|\\n)\\s*(?:private\\s+)?object\\s+${name}\\s*:\\s*ApplicationLifecycleListener\\b`),
    `listOf(${name}) must be the ApplicationLifecycleListener`,
  );
});

test('board row 46 creates Glide once with animated AVIF disabled and leaves a live instance alone', () => {
  const classFile = path.join(javaDir, glidePackageClass);
  assert.ok(existsSync(classFile), `${glidePackageClass} has no source file at ${classFile}`);
  const code = readCode(javaDir, glidePackageClass);

  const inits = code.match(/Glide\.init\s*\(/g) ?? [];
  assert.equal(inits.length, 1, `expected exactly one Glide.init(, found ${inits.length}`);

  const optionCalls = [...code.matchAll(/setDefaultRequestOptions\s*\(/g)];
  assert.equal(
    optionCalls.length,
    1,
    `expected exactly one setDefaultRequestOptions(, found ${optionCalls.length}`,
  );
  const argument = balancedInside(code, optionCalls[0].index + optionCalls[0][0].length - 1, '(', ')');
  assert.match(
    argument,
    /AnimationDecoderOption\.DISABLE_ANIMATION_AVIF_DECODER\s*,\s*true\b/,
    `setDefaultRequestOptions must set DISABLE_ANIMATION_AVIF_DECODER to true, argument was: ${argument}`,
  );

  const disabled = code.match(/DISABLE_ANIMATION_[A-Z0-9_]+/g) ?? [];
  assert.deepEqual(
    disabled,
    ['DISABLE_ANIMATION_AVIF_DECODER'],
    `only DISABLE_ANIMATION_AVIF_DECODER may appear, found ${disabled.join(', ') || 'none'}`,
  );
  assert.doesNotMatch(code, /\btearDown\s*\(/, 'must not tear down Glide');

  const listener = typeBody(code, returnedListenerName(code));
  assertDirectInit(lifecycleOnCreate(listener));
});

test('board row 46 compileOnly Glide versions stay equal to expo-image', () => {
  const ours = stripGradle(read(moduleDir, 'android', 'build.gradle'));
  const expoImage = stripGradle(read(expoImageAndroid, 'build.gradle'));
  const glideExpo = [...expoImage.matchAll(/def\s+GLIDE_VERSION\s*=\s*(['"])([^'"]+)\1/g)].map((match) => match[2]);
  const pluginExpo = [...expoImage.matchAll(/glide-plugin:([^"'\s)]+)/g)].map((match) => match[1]);

  assertVersionOnce(
    'glide',
    gradleCoordinates(ours, 'com\\.github\\.bumptech\\.glide:glide'),
    glideExpo,
  );
  assertVersionOnce(
    'glide-plugin',
    gradleCoordinates(ours, 'com\\.github\\.penfeizhou\\.android\\.animation:glide-plugin'),
    pluginExpo,
  );
});

test('board row 46 leaves no manifest GlideModule behind', () => {
  const optionsModule = path.join(javaDir, 'WaifuGlideOptionsModule.kt');
  assert.equal(existsSync(optionsModule), false, 'WaifuGlideOptionsModule.kt must stay deleted');

  const manifest = stripXmlComments(read(androidMain, 'AndroidManifest.xml'));
  const glideModules = [...manifest.matchAll(/<meta-data\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /android:value\s*=\s*(["'])GlideModule\1/.test(tag));
  assert.deepEqual(
    glideModules,
    [],
    `manifest must not declare a GlideModule meta-data, found ${glideModules.join(' | ') || 'none'}`,
  );
});

test('expo-image AppGlideModule does not replace Glide default request options', () => {
  const code = readCode(
    expoImageAndroid,
    'src',
    'main',
    'java',
    'expo',
    'modules',
    'image',
    'ExpoImageAppGlideModule.kt',
  );
  assert.doesNotMatch(
    code,
    /setDefaultRequestOptions/,
    'ExpoImageAppGlideModule must not call setDefaultRequestOptions; Glide runs its applyOptions after ours, so that would replace the default WaifuGlidePackage installs',
  );
});

/**
 * Board row 47. ImageLoadTask has no disk-cache option, and its two callers
 * re-encode into entries nothing reads. These guards are text: the Kotlin is
 * compiled by the release build, not here.
 */
const kotlinSources = () => readdirSync(javaDir)
  .filter((name) => name.endsWith('.kt'))
  .sort()
  .map((name) => ({
    name,
    code: readCode(javaDir, name),
    raw: read(javaDir, name),
  }));

const commentsOf = (raw) => (raw.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? []).join('\n');

const centerInsideComparison = /options\.get\(\s*DownsampleStrategy\.OPTION\s*\)\s*===\s*DownsampleStrategy\.CENTER_INSIDE\b/;

/**
 * The one function whose entire body is the referential CENTER_INSIDE check.
 * Both encoders call it, so a FIT_CENTER edit has a single match and changes both.
 */
const centerInsidePredicate = (code) => {
  const found = [...code.matchAll(new RegExp(centerInsideComparison, 'g'))];
  assert.equal(
    found.length,
    1,
    `expected exactly one options.get(DownsampleStrategy.OPTION) === DownsampleStrategy.CENTER_INSIDE comparison, found ${found.length}. The comparison must be referential (===), not ==`,
  );
  const before = code.slice(0, found[0].index);
  const header = before.match(/fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*options\s*:\s*Options\s*\)\s*:\s*Boolean\s*=\s*$/);
  assert.ok(
    header,
    `the identity comparison must be the entire body of one Boolean function of options, preceding text: ${before.slice(-200)}`,
  );
  const after = code.slice(found[0].index + found[0][0].length);
  assert.match(after, /^[ \t]*(?:\n|$)/, 'the identity comparison must end its line and not be part of a larger expression');
  return header[1];
};

const resourceEncoderClasses = (code) => {
  const found = [];
  const declared = /(?:^|\n)\s*(?:(?:public|private|internal|open|abstract|sealed)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const match of code.matchAll(declared)) {
    const brace = code.indexOf('{', match.index);
    assert.ok(brace > match.index, `${match[1]} has no body`);
    const header = code.slice(match.index, brace);
    const kind = /ResourceEncoder\s*<\s*BitmapDrawable\s*>/.test(header)
      ? 'drawable'
      : /ResourceEncoder\s*<\s*Bitmap\s*>/.test(header)
        ? 'bitmap'
        : null;
    if (!kind) continue;
    found.push({
      name: match[1],
      kind,
      header,
      body: typeBody(code, match[1]),
    });
  }
  return found;
};

const assertSkippingEncoder = (encoder, predicate) => {
  const delegateType = encoder.kind === 'bitmap' ? 'BitmapEncoder' : 'BitmapDrawableEncoder';
  assert.match(
    `${encoder.header}\n${encoder.body}`,
    new RegExp(`(?:val|var)\\s+delegate\\s*:\\s*${delegateType}\\b`),
    `${encoder.name} must delegate to ${delegateType}`,
  );
  assert.equal(
    (encoder.body.match(/\bfun\s+getEncodeStrategy\s*\(/g) ?? []).length,
    1,
    `${encoder.name} must declare one getEncodeStrategy`,
  );
  assert.equal(
    canonicalize(funBody(encoder.body, 'getEncodeStrategy').trim()),
    'returndelegate.getEncodeStrategy(options)',
    `${encoder.name} getEncodeStrategy must return the delegate's strategy`,
  );
  assert.equal(
    (encoder.body.match(/\bfun\s+encode\s*\(/g) ?? []).length,
    1,
    `${encoder.name} must declare one encode`,
  );
  const encodeBody = funBody(encoder.body, 'encode');
  const ifAt = encodeBody.search(/\bif\s*\(/);
  assert.ok(ifAt >= 0, `${encoder.name} encode must open with the center-inside branch`);
  assert.equal(encodeBody.slice(0, ifAt).trim(), '', `${encoder.name} encode must open with the center-inside branch`);
  const paren = encodeBody.indexOf('(', ifAt);
  const parenClose = closeOf(encodeBody, paren, '(', ')');
  assert.equal(
    encodeBody.slice(paren + 1, parenClose).replace(/\s+/g, ''),
    `${predicate}(options)`,
    `${encoder.name} must compare through ${predicate}(options)`,
  );
  const brace = encodeBody.indexOf('{', parenClose);
  assert.ok(brace > parenClose, `${encoder.name} center-inside branch must be a block`);
  assert.equal(encodeBody.slice(parenClose + 1, brace).trim(), '');
  const branch = balancedInside(encodeBody, brace, '{', '}').trim();
  assert.equal(
    branch,
    'return false',
    `${encoder.name} must return false in the center-inside branch before any write, found: ${branch}`,
  );
  const after = encodeBody.slice(closeOf(encodeBody, brace, '{', '}') + 1).trim();
  assert.equal(
    canonicalize(after),
    'returndelegate.encode(resource,file,options)',
    `${encoder.name} must otherwise return the delegate's encode result, found: ${after}`,
  );
};

const walkFiles = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full));
    else found.push(full);
  }
  return found;
};

test('board row 47 prepends both encoders on one background thread after Glide.init', () => {
  const sources = kotlinSources();
  const packageCode = sources.map((file) => file.code).join('\n');
  assert.equal(
    (packageCode.match(/\bthread\s*\(/g) ?? []).length,
    1,
    'the package must start exactly one background thread',
  );

  const code = readCode(javaDir, glidePackageClass);
  assert.equal(
    (code.match(/import\s+kotlin\.concurrent\.thread\b/g) ?? []).length,
    1,
    'the registration must use kotlin.concurrent.thread, which starts a new thread',
  );
  const listener = typeBody(code, returnedListenerName(code));
  const appParam = listener.match(/\boverride\s+fun\s+onCreate\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
  assert.ok(appParam, 'onCreate must take the Application parameter');
  const onCreate = lifecycleOnCreate(listener);
  const threadStarts = [...onCreate.matchAll(/\bthread\s*\(/g)];
  assert.equal(
    threadStarts.length,
    1,
    `the listener must start exactly one background thread after Glide.init, found ${threadStarts.length}`,
  );
  const inits = [...onCreate.matchAll(/Glide\.init\s*\(/g)];
  assert.equal(inits.length, 1, `expected exactly one Glide.init( in onCreate, found ${inits.length}`);
  const initClose = closeOf(onCreate, onCreate.indexOf('(', inits[0].index), '(', ')');
  assert.ok(
    threadStarts[0].index > initClose,
    'the registration thread must be started after Glide.init, not before',
  );

  const open = onCreate.indexOf('(', threadStarts[0].index);
  const close = closeOf(onCreate, open, '(', ')');
  const args = onCreate.slice(open + 1, close);
  assert.match(args, /\bname\s*=\s*"[^"]+"/, 'the registration thread must be named');
  assert.doesNotMatch(
    args,
    /\bstart\s*=\s*false\b/,
    'kotlin.concurrent.thread must be left to start (start = false would never prepend)',
  );
  const brace = onCreate.indexOf('{', close);
  assert.equal(onCreate.slice(close + 1, brace).trim(), '', 'thread(...) must be followed only by its lambda');
  const bodyEnd = closeOf(onCreate, brace, '{', '}');
  const body = onCreate.slice(brace + 1, bodyEnd);
  assert.equal(onCreate.slice(bodyEnd + 1).trim(), '', 'nothing may follow the registration thread');
  assert.doesNotMatch(body, /runOnUiThread|getMainLooper|Dispatchers\.Main|\bHandler\s*\(/);
  assert.equal(appParam[1], 'application', 'onCreate must name its Application parameter application');

  const encoders = resourceEncoderClasses(packageCode);
  const bitmap = encoders.find((encoder) => encoder.kind === 'bitmap');
  const drawable = encoders.find((encoder) => encoder.kind === 'drawable');
  assert.ok(bitmap, 'missing the Bitmap ResourceEncoder');
  assert.ok(drawable, 'missing the BitmapDrawable ResourceEncoder');
  assertDirectRegistration(body, bitmap.name, drawable.name);
  assertDirectInit(onCreate);
});

test('board row 47 encoders skip CENTER_INSIDE by identity and delegate every other encode', () => {
  const sources = kotlinSources();
  const packageCode = sources.map((file) => file.code).join('\n');
  const owner = sources.find((file) => centerInsideComparison.test(file.code));
  assert.ok(
    owner,
    'expected one Kotlin encoder file comparing options.get(DownsampleStrategy.OPTION) === DownsampleStrategy.CENTER_INSIDE by identity. A Java file cannot hold it: the JVM tests compile every .java without Glide',
  );
  const predicate = centerInsidePredicate(owner.code);
  const encoders = resourceEncoderClasses(owner.code);
  assert.deepEqual(
    encoders.map((encoder) => encoder.kind).sort(),
    ['bitmap', 'drawable'],
    `expected one Bitmap encoder and one BitmapDrawable encoder in ${owner.name}, found ${encoders.map((encoder) => `${encoder.name}:${encoder.kind}`).join(', ') || 'none'}`,
  );
  for (const encoder of encoders) assertSkippingEncoder(encoder, predicate);

  for (const name of readdirSync(javaDir)) {
    if (!name.endsWith('.kt') && !name.endsWith('.java')) continue;
    const raw = read(javaDir, name);
    assert.doesNotMatch(
      raw,
      /EncodeStrategy\.NONE/,
      `${name} must not contain EncodeStrategy.NONE; getEncodeStrategy has to return the delegate's strategy`,
    );
    if (name.endsWith('.java')) {
      assert.doesNotMatch(
        raw,
        /ResourceEncoder|BitmapEncoder|DownsampleStrategy/,
        `${name} is compiled by the JVM test script without Glide, so the skipping encoders must be Kotlin`,
      );
    }
  }
});

test('board row 47 records why ImageLoadTask writes are declined', () => {
  const comments = kotlinSources().map((file) => commentsOf(file.raw)).join('\n');
  for (const phrase of [
    'ImageLoadTask has no disk-cache option',
    'loadAsync',
    'useImage',
    '1316 ms',
    '42.5 MB',
    '11-35 ms',
    '15 of 18',
    '2-9 ms',
    'tiles are not CENTER_INSIDE',
    'Decline in encode',
    'getEncodeStrategy',
    'PNG-encoding a 42.5 MB bitmap',
    'every non-GIF save',
    'first-frame path',
    'library-decode-gate.ts',
    'at most one early entry per load',
  ]) {
    assert.match(comments, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `comment must say ${phrase}`);
  }
});

test('board row 47 ImageLoadTask is still the only expo-image centerInside load', () => {
  const imageLoadTask = path.join(
    expoImageAndroid,
    'src',
    'main',
    'java',
    'expo',
    'modules',
    'image',
    'ImageLoadTask.kt',
  );
  const code = readCode(imageLoadTask);
  const recheck = "An expo-image upgrade breaking this means the encoder's skip must be re-checked.";
  assert.match(
    code,
    /\.centerInside\s*\(\s*\)/,
    `ImageLoadTask must still call .centerInside(). ${recheck}`,
  );
  assert.doesNotMatch(
    code,
    /diskCacheStrategy/,
    `ImageLoadTask must set no diskCacheStrategy. ${recheck}`,
  );

  const selectors = [
    [/centerInside\s*\(/, 'centerInside('],
    [/optionalCenterInside\s*\(/, 'optionalCenterInside('],
    [/circleCrop\s*\(/, 'circleCrop('],
    [/optionalCircleCrop\s*\(/, 'optionalCircleCrop('],
    [/centerInsideTransform\s*\(/, 'centerInsideTransform('],
    [/DownsampleStrategy\.CENTER_INSIDE/, 'DownsampleStrategy.CENTER_INSIDE'],
  ];
  for (const file of walkFiles(expoImageAndroid)) {
    if (path.resolve(file) === path.resolve(imageLoadTask)) continue;
    const text = read(file);
    for (const [pattern, label] of selectors) {
      assert.doesNotMatch(
        text,
        pattern,
        `${path.relative(expoImageAndroid, file)} contains ${label}. ${recheck}`,
      );
    }
  }
});

const bodyOf = (source, signature) => {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `missing ${signature}`);
  const brace = source.indexOf('{', at);
  return balancedInside(source, brace, '{', '}');
};

test('the IME observer reports a keyboard height change without replacing React Native insets listeners', () => {
  const observerPath = path.join(javaDir, 'ImeHeightObserver.kt');
  assert.ok(existsSync(observerPath), 'ImeHeightObserver.kt must exist');
  const observer = readCode(observerPath);
  const moduleCode = readCode(javaDir, 'WaifuSyncServiceModule.kt');

  assert.match(moduleCode, /Events\([^)]*"onImeHeightChange"/);
  assert.match(observer, /ViewCompat\.getRootWindowInsets\(/);
  assert.match(observer, /WindowInsetsCompat\.Type\.ime\(\)/);
  assert.match(observer, /WindowInsetsCompat\.Type\.systemBars\(\)/);
  assert.match(observer, /imeBottom - barsBottom/);
  assert.match(
    observer,
    /if \(visible\) max\(0, imeBottom - barsBottom\) else 0/,
  );
  assert.match(observer, /PixelUtil\.toDIPFromPixel\(heightPx\.toFloat\(\)\)/);
  assert.match(observer, /visible == reportedVisible && heightDp == reportedHeightDp/);

  const attach = bodyOf(observer, 'fun attach(');
  assert.match(attach, /runOnUiThread/);
  assert.match(attach, /layoutListener != null && attachedDecor === decor/);
  assert.match(attach, /decor\.viewTreeObserver\.addOnGlobalLayoutListener\(/);
  assert.match(attach, /ViewTreeObserver\.OnGlobalLayoutListener \{ publish\(decor\) \}/);
  const detach = bodyOf(observer, 'fun detach(');
  assert.match(
    detach,
    /if \(activity != null\) \{\s*activity\.runOnUiThread \{ removeGlobalLayoutListener\(\) \}\s*\} else \{\s*UiThreadUtil\.runOnUiThread \{ removeGlobalLayoutListener\(\) \}\s*\}/,
  );
  const remove = bodyOf(observer, 'private fun removeGlobalLayoutListener(');
  const dropListener = remove.indexOf('layoutListener = null');
  const dropDecor = remove.indexOf('attachedDecor = null');
  const unhook = remove.indexOf('tree.removeOnGlobalLayoutListener(listener)');
  assert.ok(dropListener >= 0 && dropDecor > dropListener && unhook > dropDecor, 'detach must drop the decor view before unhooking');
  const publish = bodyOf(observer, 'private fun publish(');
  assert.match(
    publish,
    /reportedVisible = visible\s+reportedHeightDp = heightDp\s+onChange\(heightDp, visible\)/,
  );

  const start = bodyOf(moduleCode, 'OnStartObserving("onImeHeightChange")');
  assert.match(start, /appContext\.currentActivity \?:/);
  assert.match(start, /imeHeightObserver\.attach\(/);
  const stop = bodyOf(moduleCode, 'OnStopObserving("onImeHeightChange")');
  assert.match(stop, /imeHeightObserver\.detach\(/);
  const destroy = bodyOf(moduleCode, 'OnDestroy');
  assert.match(destroy, /imeHeightObserver\.detach\(\)/);
  const payload = bodyOf(moduleCode, 'ImeHeightObserver {');
  assert.match(
    payload,
    /sendEvent\(\s*"onImeHeightChange",\s*mapOf\("height" to heightDp, "visible" to visible\)/,
  );

  const js = readCode(moduleDir, 'src', 'WaifuSyncService.ts');
  const types = readCode(moduleDir, 'src', 'WaifuSyncService.types.ts');
  const index = readCode(moduleDir, 'index.ts');
  assert.match(js, /export function addImeHeightListener\(/);
  assert.match(js, /WaifuSyncService === null/);
  assert.match(js, /return \{ remove\(\) \{\} \}/);
  assert.match(js, /addListener\(\s*'onImeHeightChange'/);
  assert.match(types, /'onImeHeightChange'/);
  assert.match(index, /addImeHeightListener/);

  const androidSrc = path.join(moduleDir, 'android', 'src');
  for (const file of walkFiles(androidSrc)) {
    if (!file.endsWith('.kt') && !file.endsWith('.java')) continue;
    const text = read(file);
    assert.doesNotMatch(
      text,
      /setOnApplyWindowInsetsListener\(/,
      `${path.relative(moduleDir, file)} must not call setOnApplyWindowInsetsListener`,
    );
    assert.doesNotMatch(
      text,
      /setWindowInsetsAnimationCallback\(/,
      `${path.relative(moduleDir, file)} must not call setWindowInsetsAnimationCallback`,
    );
  }
});

test('N8 setModalStatusBarStyle updates the showing ReactModalHostView Dialog window', () => {
  const helperPath = path.join(javaDir, 'DialogStatusBarAppearance.kt');
  assert.ok(existsSync(helperPath), 'DialogStatusBarAppearance.kt must exist');
  const helper = readCode(helperPath);
  const moduleCode = readCode(javaDir, 'WaifuSyncServiceModule.kt');
  const js = readCode(moduleDir, 'src', 'WaifuSyncService.ts');
  const types = readCode(moduleDir, 'src', 'WaifuSyncService.types.ts');
  const index = readCode(moduleDir, 'index.ts');

  assert.match(moduleCode, /Function\("setModalStatusBarStyle"\)/);
  assert.match(moduleCode, /DialogStatusBarAppearance\.apply\(reactContext,\s*lightIcons\)/);
  assert.match(helper, /UiThreadUtil\.runOnUiThread/);
  assert.match(helper, /ReactModalHostView/);
  assert.match(helper, /view\.dialog\?\.isShowing == true/);
  assert.match(helper, /WindowInsetsControllerCompat\(window,\s*window\.decorView\)\.isAppearanceLightStatusBars\s*=\s*!lightIcons/);
  assert.match(js, /export function setModalStatusBarStyle\(/);
  assert.match(types, /setModalStatusBarStyle\(lightIcons:\s*boolean\):\s*void/);
  assert.match(index, /setModalStatusBarStyle/);
});

test('N11 in-app update installer exposes APK verification, permission check, FileProvider launch, and sweep', () => {
  const manifest = stripXmlComments(read(androidMain, 'AndroidManifest.xml'));
  assert.match(
    manifest,
    /<uses-permission\b[^>]*android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"/,
    'in-app APK update installation requires REQUEST_INSTALL_PACKAGES',
  );
  const queries = manifest.match(/<queries\b[^>]*>([\s\S]*?)<\/queries>/);
  assert.ok(queries, 'unknown-sources resolution requires a queries block');
  const queryActions = [...queries[1].matchAll(/<action\b[^>]*android:name="([^"]+)"/g)].map(([, a]) => a);
  for (const requiredQuery of [
    'android.settings.MANAGE_UNKNOWN_APP_SOURCES',
    'android.settings.SECURITY_SETTINGS',
    'android.settings.APPLICATION_DETAILS_SETTINGS',
  ]) {
    assert.ok(
      queryActions.includes(requiredQuery),
      `manifest queries must include ${requiredQuery} for Android 11+ resolveActivity`,
    );
  }

  const installerPath = path.join(javaDir, 'AppUpdateInstaller.kt');
  const helperPath = path.join(javaDir, 'AppUpdateHelper.java');
  assert.ok(existsSync(installerPath), 'AppUpdateInstaller.kt must exist');
  assert.ok(existsSync(helperPath), 'AppUpdateHelper.java must exist');

  const installer = readCode(installerPath);
  const helper = readCode(helperPath);
  const moduleCode = readCode(javaDir, 'WaifuSyncServiceModule.kt');
  const types = readCode(moduleDir, 'src', 'WaifuSyncService.types.ts');
  const index = readCode(moduleDir, 'index.ts');

  for (const fn of ['getInstalledAppVersion', 'canRequestPackageInstalls']) {
    assert.match(moduleCode, new RegExp(`Function\\("${fn}"\\)`), `missing Function("${fn}")`);
  }
  for (const fn of [
    'openUnknownAppSourcesSettings',
    'installUpdateApk',
    'sweepUpdateApks',
    'verifyDownloadedApk',
  ]) {
    assert.match(moduleCode, new RegExp(`AsyncFunction\\("${fn}"\\)`), `missing AsyncFunction("${fn}")`);
  }

  assert.match(installer, /FileProvider\.getUriForFile\(/);
  assert.match(installer, /application\/vnd\.android\.package-archive/);
  assert.match(installer, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(installer, /firstResolvableUnknownSourcesAction/);
  assert.match(helper, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
  assert.match(helper, /verifyFileAndArchive\(/);
  assert.match(helper, /sweepDirectory\(/);
  assert.match(types, /getInstalledAppVersion\(\):\s*InstalledAppVersionInfo/);
  assert.match(types, /canRequestPackageInstalls\(\):\s*boolean/);
  assert.match(types, /verifyDownloadedApk\(/);
  assert.match(types, /installUpdateApk\(apkPath:\s*string\):\s*Promise<void>/);
  assert.match(types, /sweepUpdateApks\(installedVersionCode:\s*number\):\s*Promise<number>/);
  assert.match(index, /ApkVerificationResponse/);
  assert.match(index, /InstalledAppVersionInfo/);
});


