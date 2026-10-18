import { takeResidencyChanges } from '@/features/library/library-entry-residency';
import type { LibraryEntry } from '@/features/library/library-view-model';
import { viewDigest } from '@/features/library/library-view-test-support';

const A = viewDigest('residency-a');
const B = viewDigest('residency-b');

function entry(digest: string, overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    plaintextSha256: digest,
    sourceImageId: null,
    format: 'jpeg',
    byteSize: 400_000,
    width: 800,
    height: 1200,
    residency: 'local-original',
    lifecycle: 'active',
    protection: 'protected',
    failureCategory: null,
    hasLocalOriginal: true,
    localOriginalUri: 'file:///data/library/originals/o.jpg',
    originalGenerationId: 'gen-orig',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('takeResidencyChanges (board #27 S3b, spec §5.12)', () => {
  test('a first read reports nothing', () => {
    const seen = new Map<string, string>();

    expect(takeResidencyChanges(seen, [entry(A), entry(B)])).toEqual([]);
    expect(seen.size).toBe(2);
  });

  test.each([
    ['residency', { residency: 'cloud-only' }],
    ['hasLocalOriginal', { hasLocalOriginal: false }],
    ['localOriginalUri', { localOriginalUri: 'file:///data/library/originals/other.jpg' }],
    ['origin', { origin: 'provider' }],
    ['importClassification', { importClassification: 'safe' }],
  ] as const)('%s alone is a move', (_name, overrides) => {
    const seen = new Map<string, string>();
    takeResidencyChanges(seen, [entry(A), entry(B)]);

    expect(takeResidencyChanges(seen, [entry(A, overrides), entry(B)])).toEqual([A]);
  });

  test.each([
    ['protection', { protection: 'pending' }],
    ['failureCategory', { failureCategory: 'offline' }],
    ['lifecycle', { lifecycle: 'trash' }],
    ['originalGenerationId', { originalGenerationId: 'g2' }],
    ['byteSize', { byteSize: 9 }],
  ] as const)('%s alone is not', (_name, overrides) => {
    const seen = new Map<string, string>();
    takeResidencyChanges(seen, [entry(A), entry(B)]);

    expect(takeResidencyChanges(seen, [entry(A, overrides), entry(B)])).toEqual([]);
  });

  test('a digest that leaves and comes back changed is reported', () => {
    const seen = new Map<string, string>();

    expect(takeResidencyChanges(seen, [entry(A), entry(B)])).toEqual([]);
    expect(takeResidencyChanges(seen, [entry(B)])).toEqual([]);
    expect(takeResidencyChanges(seen, [
      entry(A, { residency: 'cloud-only', hasLocalOriginal: false, localOriginalUri: null }),
      entry(B),
    ])).toEqual([A]);
  });

  test('a move is reported once: the next identical read reports nothing', () => {
    const seen = new Map<string, string>();
    takeResidencyChanges(seen, [entry(A), entry(B)]);
    const moved = [entry(A, { residency: 'cloud-only', hasLocalOriginal: false, localOriginalUri: null }), entry(B)];

    expect(takeResidencyChanges(seen, moved)).toEqual([A]);
    expect(takeResidencyChanges(seen, moved)).toEqual([]);
  });

  test('a second identical read reports nothing', () => {
    const seen = new Map<string, string>();
    takeResidencyChanges(seen, [entry(A), entry(B)]);

    expect(takeResidencyChanges(seen, [entry(A), entry(B)])).toEqual([]);
  });
});
