#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

JDK_HOME=""
if [ -x /usr/libexec/java_home ]; then
  JDK_HOME=$(/usr/libexec/java_home -v 17 2>/dev/null || true)
fi
if [ -z "$JDK_HOME" ]; then
  JDK_HOME=$(find /opt/homebrew/Cellar/openjdk@17 -path '*/libexec/openjdk.jdk/Contents/Home' -type d -print -quit 2>/dev/null || true)
fi
if [ -z "$JDK_HOME" ] || [ ! -x "$JDK_HOME/bin/javac" ] || [ ! -x "$JDK_HOME/bin/java" ]; then
  echo "run-sync-service-jvm-tests: JDK 17 not found (tried /usr/libexec/java_home and Homebrew openjdk@17)" >&2
  exit 2
fi

JUNIT_JAR=$(find "$HOME/.gradle/caches/modules-2/files-2.1/junit/junit/4.13.2" -name 'junit-4.13.2.jar' -type f -print -quit 2>/dev/null || true)
HAMCREST_JAR=$(find "$HOME/.gradle/caches/modules-2/files-2.1/org.hamcrest/hamcrest-core/1.3" -name 'hamcrest-core-1.3.jar' -type f -print -quit 2>/dev/null || true)
OKHTTP_JAR=$(find "$HOME/.gradle/caches/modules-2/files-2.1/com.squareup.okhttp3/okhttp/4.9.2" -name 'okhttp-4.9.2.jar' -type f -print -quit 2>/dev/null || true)
OKIO_JAR=$(find "$HOME/.gradle/caches/modules-2/files-2.1/com.squareup.okio/okio-jvm/3.16.0" -name 'okio-jvm-3.16.0.jar' -type f -print -quit 2>/dev/null || true)
KOTLIN_STDLIB_JAR=$(find "$HOME/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.2.20" -name 'kotlin-stdlib-2.2.20.jar' -type f -print -quit 2>/dev/null || true)
if [ -z "$JUNIT_JAR" ] || [ -z "$HAMCREST_JAR" ] || [ -z "$OKHTTP_JAR" ] || [ -z "$OKIO_JAR" ] || [ -z "$KOTLIN_STDLIB_JAR" ]; then
  echo "run-sync-service-jvm-tests: required JUnit 4.13.2, hamcrest-core 1.3, OkHttp 4.9.2, okio-jvm 3.16.0, or kotlin-stdlib 2.2.20 jar is missing under ~/.gradle/caches/modules-2" >&2
  exit 2
fi

BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/wdlib001-jvm-tests.XXXXXX")
trap 'rm -rf "$BUILD_DIR"' EXIT INT TERM

MAIN_DIR="$ROOT_DIR/modules/waifu-sync-service/android/src/main/java"
TEST_DIR="$ROOT_DIR/modules/waifu-sync-service/android/src/test/java"
RESOURCE_DIR="$ROOT_DIR/modules/waifu-sync-service/android/src/test/resources"
CLASSPATH="$JUNIT_JAR:$HAMCREST_JAR:$OKHTTP_JAR:$OKIO_JAR:$KOTLIN_STDLIB_JAR"

MAIN_SOURCES=$(find "$MAIN_DIR" -name '*.java' -type f -print)
TEST_SOURCES=$(find "$TEST_DIR" -name '*.java' -type f -print)
if [ -z "$TEST_SOURCES" ]; then
  echo "run-sync-service-jvm-tests: expected Java test sources" >&2
  exit 2
fi

# shellcheck disable=SC2086
"$JDK_HOME/bin/javac" --add-modules jdk.httpserver --release 11 -cp "$CLASSPATH" -d "$BUILD_DIR" $MAIN_SOURCES $TEST_SOURCES
"$JDK_HOME/bin/java" --add-modules jdk.httpserver -Xmx64m -cp "$BUILD_DIR:$RESOURCE_DIR:$CLASSPATH" \
  org.junit.runner.JUnitCore \
  expo.modules.waifusync.LibraryObjectStreamCryptoTest \
  expo.modules.waifusync.LibraryStreamCopyTest \
  expo.modules.waifusync.OkHttpRedirectSemanticsTest \
  expo.modules.waifusync.BatterySettingsOrderTest \
  expo.modules.waifusync.BackupFileCopyTest \
  expo.modules.waifusync.AppUpdateInstallerTest
