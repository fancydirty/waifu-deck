import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

test('U4: the settings screens keep exactly one field component', () => {
  const root = resolve(__dirname, '..');
  const files = sourceFiles(root);
  const paths = files.map((path) => relative(root, path));
  // The one remaining field component.
  expect(paths).toContain(join('ui', 'settings-field.tsx'));
  // No second field-component module: a standalone field file must never
  // reappear alongside the shared one (U4 deleted the retired one outright).
  expect(paths.filter((path) => /input\.tsx?$/.test(path))).toEqual([]);
  // The drift note's residual-strength case: a second field module named *field*
  // (not *input*) must not slip past the file-inventory check either.
  expect(paths.filter((path) => /field\.tsx?$/.test(path))).toEqual([join('ui', 'settings-field.tsx')]);
  // Every field usage imports the shared component from its ui/ home.
  const uiDirectory = join('ui', '');
  const offenders = files
    .filter((path) => !relative(root, path).startsWith(uiDirectory))
    .filter((path) => readFileSync(path, 'utf8').includes('SettingsField'))
    .filter((path) => !/from ['"][^'"]*ui\/settings-field['"]/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path));
  expect(offenders).toEqual([]);
});
