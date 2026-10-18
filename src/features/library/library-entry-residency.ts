import type { LibraryEntry } from '@/features/library/library-view-model';

/** Board #27 S3b + N6-B1 (spec §5.12, §4.5): what a screen's resolved source was made for. */
function residencyOf(entry: LibraryEntry): string {
  return `${entry.residency}|${entry.hasLocalOriginal ? 1 : 0}|${entry.localOriginalUri ?? ''}|${entry.origin ?? 'import'}|${entry.importClassification ?? 'unknown'}`;
}

/**
 * The digests whose residency moved since `seen` last saw them — evicted
 * (`freed`), downloaded, flagged missing or handed over — and `seen` updated
 * in place. A digest seen for the first time moved nowhere; one that leaves
 * the list is remembered, so it is reported if it comes back changed.
 */
export function takeResidencyChanges(
  seen: Map<string, string>,
  entries: readonly LibraryEntry[],
): string[] {
  const changed: string[] = [];
  for (const entry of entries) {
    const now = residencyOf(entry);
    const before = seen.get(entry.plaintextSha256);
    if (before !== undefined && before !== now) changed.push(entry.plaintextSha256);
    seen.set(entry.plaintextSha256, now);
  }
  return changed;
}
