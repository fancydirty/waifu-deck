const VERSION_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

/**
 * Ledger N11: derives the Android integer `versionCode` from a semantic
 * `MAJOR.MINOR.PATCH` string so version codes strictly increase with every
 * release (`1.2.0` -> `1002000`, `1.2.1` -> `1002001`).
 */
export function versionCodeOf(versionName: string): number {
  const match = VERSION_PATTERN.exec(versionName);
  if (!match) {
    throw new Error(`version must be MAJOR.MINOR.PATCH (0..999 each), got: ${versionName}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (code <= 0) {
    throw new Error(`version must be MAJOR.MINOR.PATCH (> 0.0.0), got: ${versionName}`);
  }
  return code;
}
