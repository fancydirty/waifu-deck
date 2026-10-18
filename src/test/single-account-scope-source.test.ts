import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// K1 root cause 1: account_scope must have ONE production source — the session
// port. If ANY production file re-derives it from the master key again, aes-gcm
// vaults split every collect intent from the scope protect/sync read, and the
// mirror silently uploads nothing.
//
// The guard walks the whole `src/` tree rather than an allowlist of the two
// files this cut happened to fix: an allowlist cannot see the second formula
// reappear in a file nobody thought to list, which is exactly how the original
// split survived review.
const ROOT = resolve(process.cwd(), 'src');
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** `deriveLibraryAccountScope` is defined here, so its own file is not a caller. */
const DEFINITION = join('src', 'features', 'library', 'library-identity.ts');

function isProductionSource(relativePath: string): boolean {
  if (!SOURCE_EXTENSIONS.some((extension) => relativePath.endsWith(extension))) {
    return false;
  }
  if (/\.test\.tsx?$/.test(relativePath)) return false;
  // Test harnesses legitimately compute the scope to stand in for a session.
  if (/-test-support\.ts$/.test(relativePath)) return false;
  return relativePath !== DEFINITION;
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

test('the whole src tree has exactly one production caller of deriveLibraryAccountScope', () => {
  const files = walk(ROOT)
    .map((file) => relative(process.cwd(), file))
    .filter(isProductionSource);
  // Sanity: a broken walk would make the assertion below vacuously true.
  expect(files.length).toBeGreaterThan(100);

  const callers = files
    .filter((file) => /deriveLibraryAccountScope\(/.test(
      readFileSync(resolve(process.cwd(), file), 'utf8'),
    ))
    .map((file) => file.split(sep).join('/'))
    .sort();

  expect(callers).toEqual(['src/features/library/library-session-port.ts']);
});

test('the session port derives the scope from the identity digest, not the master key', () => {
  const sessionPort = readFileSync(
    resolve(process.cwd(), 'src/features/library/library-session-port.ts'),
    'utf8',
  );
  expect(sessionPort).toMatch(/deriveLibraryAccountScope\(identityDigest\)/);
});
