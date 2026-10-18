import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * N10 T3 (owner ruling 2026-10-13: keep the blur, fix the engine): the tile
 * blur must never route through RenderScript again — wasabeef 4.3.0's
 * intrinsic segfaults the whole app on Android 16 (Honor PGT-AN20, evidence
 * a local log). The engine lives in
 * patches/expo-image+<version>.patch, applied by postinstall `patch-package`.
 * A deliberate expo-image upgrade without regenerating the patch would fail
 * to match, skip silently, and bring the crash back — so pin the installed
 * version to the patch file and the applied state here.
 */

const repoRoot = join(__dirname, '..', '..');

describe('N10 T3: the expo-image blur patch guards', () => {
  const wrapperPath = join(
    repoRoot,
    'node_modules',
    'expo-image',
    'android',
    'src',
    'main',
    'java',
    'expo',
    'modules',
    'image',
    'ExpoImageViewWrapper.kt',
  );

  test('the installed expo-image version has a matching patch file', () => {
    const { version } = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules', 'expo-image', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(existsSync(join(repoRoot, 'patches', `expo-image+${version}.patch`))).toBe(true);
  });

  test('the installed wrapper routes blurRadius to NoRsBlurTransformation, not RenderScript', () => {
    const wrapper = readFileSync(wrapperPath, 'utf8');
    expect(wrapper).toContain('transform(NoRsBlurTransformation(min(it, 25), 4))');
    expect(wrapper).not.toContain('jp.wasabeef.glide.transformations.BlurTransformation');
    expect(existsSync(
      join(repoRoot, 'node_modules', 'expo-image', 'android', 'src', 'main', 'java', 'expo', 'modules', 'image', 'NoRsBlurTransformation.kt'),
    )).toBe(true);
  });
});
