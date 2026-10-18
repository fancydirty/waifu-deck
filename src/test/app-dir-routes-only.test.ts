import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

function testArtifacts(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return [
        ...(entry.name === '__tests__' ? [path] : []),
        ...testArtifacts(path),
      ];
    }
    return /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

test('src/app contains only routes and layouts, with no test files or __tests__ directories', () => {
  const root = resolve(__dirname, '../..');
  const artifacts = testArtifacts(join(root, 'src/app'))
    .map((path) => relative(root, path))
    .sort();

  expect(artifacts).toEqual([]);
});
