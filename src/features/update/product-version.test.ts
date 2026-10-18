import { readFileSync } from 'node:fs';
import path from 'node:path';
import { versionCodeOf } from './product-version';

describe('ProductVersion (versionCodeOf)', () => {
  it('derives versionCode = MAJOR * 1_000_000 + MINOR * 1_000 + PATCH', () => {
    expect(versionCodeOf('0.1.0')).toBe(1_000);
    expect(versionCodeOf('1.0.0')).toBe(1_000_000);
    expect(versionCodeOf('1.2.0')).toBe(1_002_000);
    expect(versionCodeOf('1.2.1')).toBe(1_002_001);
    expect(versionCodeOf('2.15.99')).toBe(2_015_099);
  });

  it(' guarantees strictly increasing versionCode across semantic version bumps', () => {
    const ordered = ['0.1.0', '0.1.1', '0.2.0', '1.0.0', '1.2.0', '1.2.1', '1.2.999', '1.3.0', '2.0.0'];
    const codes = ordered.map(versionCodeOf);
    for (let i = 1; i < codes.length; i += 1) {
      expect(codes[i]!).toBeGreaterThan(codes[i - 1]!);
    }
  });

  it('rejects malformed or out-of-range version strings', () => {
    for (const invalid of [
      '',
      '0.0.0',
      '01.2.0',
      '1.02.0',
      '1.2.00',
      '1.2',
      '1.2.0.1',
      'v1.2.0',
      '1.2.0-beta.1',
      '1.1000.0',
      '1.2.1000',
      '-1.2.0',
      '1.2.a',
    ]) {
      expect(() => versionCodeOf(invalid)).toThrow(/MAJOR\.MINOR\.PATCH/);
    }
  });

  it('keeps app.json version and versionCode in exact sync with ProductVersion', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const appJson = JSON.parse(readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
    const versionName: string = appJson.expo.version;
    const expectedCode = versionCodeOf(versionName);
    expect(appJson.expo.android.versionCode).toBe(expectedCode);

    const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkgJson.version).toBe(versionName);
  });
});
