import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// D6 (owner decision 2026-08-30): one open-source distribution. Metro used to
// resolve `<name>.store.ts(x)` / `<name>.direct.ts(x)` ahead of the neutral
// module by APP_VARIANT, and a missing variable silently produced the SFW-only
// Store bundle. This guard pins the removal of that mechanism.
function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const root = process.cwd();

test('D6a: no Metro variant shadows remain under src', () => {
  const offenders = walk(resolve(root, 'src'))
    .filter((file) => /\.(store|direct)\.(ts|tsx)$/.test(file))
    .map((file) => file.slice(root.length + 1));
  expect(offenders).toEqual([]);
});

test('D6a: metro.config.js no longer resolves by APP_VARIANT', () => {
  const metro = readFileSync(resolve(root, 'metro.config.js'), 'utf8');
  expect(metro).not.toMatch(/APP_VARIANT/);
  expect(metro).not.toMatch(/sourceExts\.unshift/);
});

test('D6a: app.config.js no longer applies a distribution variant', () => {
  const appConfig = readFileSync(resolve(root, 'app.config.js'), 'utf8');
  expect(appConfig).not.toMatch(/distribution-variants|applyDistributionVariant|APP_VARIANT/);
});

test('D6a: no module keeps the "direct-impl" name', () => {
  const offenders = walk(resolve(root, 'src'))
    .filter((file) => /-direct-impl\.(ts|tsx)$/.test(file))
    .map((file) => file.slice(root.length + 1));
  expect(offenders).toEqual([]);
});

test('D6a: the variant bundle audit is gone and verify no longer runs it', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts['verify:variants']).toBeUndefined();
  expect(pkg.scripts['verify:variant-bundles']).toBeUndefined();
  expect(pkg.scripts.verify).not.toMatch(/variant/);
  expect(existsSync(resolve(root, 'scripts/variant-bundle-audit.mjs'))).toBe(false);
  expect(existsSync(resolve(root, 'scripts/verify-variant-bundles.mjs'))).toBe(false);
  expect(existsSync(resolve(root, 'scripts/verify-distribution-variants.mjs'))).toBe(false);
});
