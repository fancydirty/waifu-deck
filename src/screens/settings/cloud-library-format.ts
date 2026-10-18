type CloudAgeTranslate = (key: string, options?: { count?: number }) => string;

/** Card-only decimal size ladder (A8); the home/backup E12 formatter stays unchanged. */
export function formatCloudBytes(bytes: number): Readonly<{ value: string; unit: string }> {
  if (bytes >= 1_000_000_000) return { value: String(Number((bytes / 1_000_000_000).toFixed(1))), unit: 'GB' };
  if (bytes < 1_000) return { value: String(bytes), unit: 'B' };
  if (bytes < 1_000_000) return { value: String(Number((bytes / 1_000).toFixed(1))), unit: 'KB' };
  return { value: String(Number((bytes / 1_000_000).toFixed(1))), unit: 'MB' };
}

/**
 * The age text for the cloud card footer (spec §4.2). The clock is always
 * the explicit `nowMs` argument — never `Date.now()` — so home and page render
 * the same age from one provider clock and tests stay deterministic. Elapsed
 * time is floored, a future timestamp clamps to just-now, and there is no
 * `Intl` dependency (Hermes). `t` resolves `settings.cloudLibrary.age.*` with
 * i18next plural keys (`_one`/`_other`) where the language has them.
 */
export function formatSyncAge(at: number, nowMs: number, t: CloudAgeTranslate): string {
  const elapsed = Math.max(0, nowMs - at);
  if (elapsed < 60_000) return t('settings.cloudLibrary.age.justNow');
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return t('settings.cloudLibrary.age.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('settings.cloudLibrary.age.hoursAgo', { count: hours });
  return t('settings.cloudLibrary.age.daysAgo', { count: Math.floor(hours / 24) });
}
