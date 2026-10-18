import {
  isLibraryPermanentlyUnavailable,
  isOnlyInCloud,
  isOriginalUnrecoverable,
} from '@/features/library/library-render-availability';

test('a servable file source is not unavailable', () => {
  expect(isLibraryPermanentlyUnavailable({ kind: 'file', uri: 'file:///x', tier: 'cloud-preview', role: 'preview' })).toBe(false);
});

test('a pending (not yet resolved) source is not unavailable', () => {
  expect(isLibraryPermanentlyUnavailable(undefined)).toBe(false);
  expect(isLibraryPermanentlyUnavailable(null)).toBe(false);
});

test.each(['offline', 'auth_attention', 'retryable_transfer', 'local_space', 'stale_client'] as const)(
  'a transient %s failure is not unavailable (the bytes may still be reachable later)',
  (category) => {
    expect(isLibraryPermanentlyUnavailable({ kind: 'unavailable', category })).toBe(false);
  },
);

test.each(['object_missing', 'integrity', 'unsupported_image'] as const)(
  'a permanent %s failure is unavailable (nothing will serve these bytes)',
  (category) => {
    expect(isLibraryPermanentlyUnavailable({ kind: 'unavailable', category })).toBe(true);
  },
);

describe('isOriginalUnrecoverable (K3 G3, role-gated: only an ORIGINAL-tier failure proves the original is gone)', () => {
  const derivedIntegrity = (role: 'thumbnail' | 'preview') =>
    ({ kind: 'unavailable', category: 'integrity', role } as const);
  const originalIntegrity = { kind: 'unavailable', category: 'integrity', role: 'original' } as const;
  const originalUnsupported = { kind: 'unavailable', category: 'unsupported_image', role: 'original' } as const;
  const originalMissing = { kind: 'unavailable', category: 'object_missing', role: 'original' } as const;

  test('a local original is never unrecoverable', () => {
    expect(isOriginalUnrecoverable({ hasLocalOriginal: true, originalGenerationId: null, resolved: originalIntegrity })).toBe(false);
    expect(isOriginalUnrecoverable({ hasLocalOriginal: true, originalGenerationId: 'gen-1', resolved: undefined })).toBe(false);
  });

  test('no original generation in the cloud is unrecoverable, whatever tier was rendered', () => {
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: null, resolved: undefined })).toBe(true);
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: null, resolved: derivedIntegrity('thumbnail') })).toBe(true);
  });

  test('a corrupted DERIVED tier (thumbnail/preview) with an original generation is NOT unrecoverable (fixes the K3 reversal)', () => {
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: 'gen-1', resolved: derivedIntegrity('thumbnail') })).toBe(false);
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: 'gen-1', resolved: derivedIntegrity('preview') })).toBe(false);
  });

  test('the ORIGINAL tier itself failing integrity/unsupported IS unrecoverable (spec §4.4 row 5)', () => {
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: 'gen-1', resolved: originalIntegrity })).toBe(true);
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: 'gen-1', resolved: originalUnsupported })).toBe(true);
  });

  test('object_missing on the original is the spec accepted cost, not repair (§4.4 row 4)', () => {
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: 'gen-1', resolved: originalMissing })).toBe(false);
  });

  test('transient / pending / file results with an original generation are not unrecoverable', () => {
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: 'gen-1', resolved: { kind: 'unavailable', category: 'offline', role: 'original' } })).toBe(false);
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: 'gen-1', resolved: undefined })).toBe(false);
    expect(isOriginalUnrecoverable({ hasLocalOriginal: false, originalGenerationId: 'gen-1', resolved: { kind: 'file', uri: 'file:///x', tier: 'cloud-original', role: 'original' } })).toBe(false);
  });
});

test.each([
  ['no local original with a cloud generation', { hasLocalOriginal: false, originalGenerationId: 'g1', resolved: undefined }, true],
  ['a local original', { hasLocalOriginal: true, originalGenerationId: 'g1', resolved: undefined }, false],
  ['no local original and no cloud generation', { hasLocalOriginal: false, originalGenerationId: null, resolved: undefined }, false],
  ['an unrecoverable original failure', {
    hasLocalOriginal: false,
    originalGenerationId: 'g1',
    resolved: { kind: 'unavailable', category: 'integrity', role: 'original' } as const,
  }, false],
  ['a transient original failure', {
    hasLocalOriginal: false,
    originalGenerationId: 'g1',
    resolved: { kind: 'unavailable', category: 'offline' } as const,
  }, true],
] as const)('only in the cloud: %s', (_name, input, expected) => {
  expect(isOnlyInCloud(input)).toBe(expected);
});
