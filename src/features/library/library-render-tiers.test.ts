import { tiersFor, tiersForRole } from '@/features/library/library-render-tiers';

describe('render tiers', () => {
  test.each([
    [
      'grid prefers a verified local original',
      'grid',
      { hasLocalThumbnail: false, hasLocalOriginal: true, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['local-original', 'cached-thumbnail', 'cloud-thumbnail'],
    ],
    [
      'grid falls to the thumbnail object when cloud-only',
      'grid',
      { hasLocalThumbnail: false, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['cached-thumbnail', 'cloud-thumbnail'],
    ],
    [
      'grid never fetches a preview or an original when no thumbnail object exists',
      'grid',
      { hasLocalThumbnail: false, hasLocalOriginal: false, thumbnail: null, preview: 'p', original: 'o', animated: false },
      [],
    ],
    [
      'grid with a local original and no thumbnail object stops at the local original',
      'grid',
      { hasLocalThumbnail: false, hasLocalOriginal: true, thumbnail: null, preview: 'p', original: 'o', animated: false },
      ['local-original'],
    ],
    [
      'detail with a local original prefers it then the preview tiers',
      'detail',
      { hasLocalThumbnail: false, hasLocalOriginal: true, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['local-original', 'cached-preview', 'cloud-preview'],
    ],
    [
      'detail never reads the original while a preview object exists',
      'detail',
      { hasLocalThumbnail: false, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['cached-preview', 'cloud-preview'],
    ],
    [
      'detail falls back to the original only when no preview object exists',
      'detail',
      { hasLocalThumbnail: false, hasLocalOriginal: false, thumbnail: 't', preview: null, original: 'o', animated: false },
      ['cached-original', 'cloud-original'],
    ],
    [
      'detail on an animated asset resolves the original, not a still frame',
      'detail',
      { hasLocalThumbnail: false, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: 'o', animated: true },
      ['cached-original', 'cloud-original'],
    ],
    [
      'full quality reads the exact original',
      'full',
      { hasLocalThumbnail: false, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['cached-original', 'cloud-original'],
    ],
    [
      'full with a local original prefers it then the cached and cloud original',
      'full',
      { hasLocalThumbnail: false, hasLocalOriginal: true, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['local-original', 'cached-original', 'cloud-original'],
    ],
    [
      'no readable role yields no tier',
      'detail',
      { hasLocalThumbnail: false, hasLocalOriginal: false, thumbnail: null, preview: null, original: null, animated: false },
      [],
    ],
    [
      'S2 grid without a local original serves the local thumbnail before the cloud tiers',
      'grid',
      { hasLocalThumbnail: true, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['local-thumbnail', 'cached-thumbnail', 'cloud-thumbnail'],
    ],
    [
      'S2 grid with a local original keeps it first, then the local thumbnail',
      'grid',
      { hasLocalThumbnail: true, hasLocalOriginal: true, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['local-original', 'local-thumbnail', 'cached-thumbnail', 'cloud-thumbnail'],
    ],
    [
      'S2 detail keeps the local thumbnail as the last resort after the preview tiers',
      'detail',
      { hasLocalThumbnail: true, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['cached-preview', 'cloud-preview', 'local-thumbnail'],
    ],
    [
      'S2 detail on an animated asset lists the local thumbnail after the original tiers',
      'detail',
      { hasLocalThumbnail: true, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: 'o', animated: true },
      ['cached-original', 'cloud-original', 'local-thumbnail'],
    ],
    [
      'S2 detail with no role objects still has the local thumbnail',
      'detail',
      { hasLocalThumbnail: true, hasLocalOriginal: false, thumbnail: null, preview: null, original: null, animated: false },
      ['local-thumbnail'],
    ],
    [
      'S2 full never lists the local thumbnail',
      'full',
      { hasLocalThumbnail: true, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['cached-original', 'cloud-original'],
    ],
    [
      'S2 full with no original object has no tier at all, even with a local thumbnail',
      'full',
      { hasLocalThumbnail: true, hasLocalOriginal: false, thumbnail: 't', preview: 'p', original: null, animated: false },
      [],
    ],
  ] as const)('%s', (_name, intent, state, expected) => {
    expect(tiersFor(intent, state)).toEqual(expected);
  });

  test.each([
    [
      'still: local original, local thumbnail, and a thumbnail generation',
      { hasLocalOriginal: true, hasLocalThumbnail: true, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['local-thumbnail', 'cached-thumbnail'],
    ],
    [
      'animated: local original, local thumbnail, and a thumbnail generation',
      { hasLocalOriginal: true, hasLocalThumbnail: true, thumbnail: 't', preview: 'p', original: 'o', animated: true },
      ['local-thumbnail', 'cached-thumbnail'],
    ],
    [
      'still: no local thumbnail, thumbnail generation present, original on the device',
      { hasLocalOriginal: true, hasLocalThumbnail: false, thumbnail: 't', preview: 'p', original: 'o', animated: false },
      ['cached-thumbnail'],
    ],
    [
      'animated: no local thumbnail, thumbnail generation present, original on the device',
      { hasLocalOriginal: true, hasLocalThumbnail: false, thumbnail: 't', preview: 'p', original: 'o', animated: true },
      ['cached-thumbnail'],
    ],
    [
      'still: no thumbnail generation and no local thumbnail, even with preview and original',
      { hasLocalOriginal: true, hasLocalThumbnail: false, thumbnail: null, preview: 'p', original: 'o', animated: false },
      [],
    ],
    [
      'animated: no thumbnail generation and no local thumbnail, even with preview and original',
      { hasLocalOriginal: true, hasLocalThumbnail: false, thumbnail: null, preview: 'p', original: 'o', animated: true },
      [],
    ],
    [
      'still: a local thumbnail and no thumbnail generation',
      { hasLocalOriginal: false, hasLocalThumbnail: true, thumbnail: null, preview: 'p', original: 'o', animated: false },
      ['local-thumbnail'],
    ],
    [
      'animated: a local thumbnail and no thumbnail generation',
      { hasLocalOriginal: false, hasLocalThumbnail: true, thumbnail: null, preview: 'p', original: 'o', animated: true },
      ['local-thumbnail'],
    ],
  ] as const)('placeholder %s', (_name, state, expected) => {
    expect(tiersFor('placeholder', state)).toEqual(expected);
  });

  test.each([
    [
      'S2 role reader: a thumbnail with an object lists its cached and cloud tiers',
      'thumbnail',
      { hasLocalThumbnail: true, hasLocalOriginal: true, thumbnail: 't', preview: null, original: null, animated: false },
      ['cached-thumbnail', 'cloud-thumbnail'],
    ],
    [
      'S2 role reader: a preview without an object lists only its cached tier',
      'preview',
      { hasLocalThumbnail: false, hasLocalOriginal: false, thumbnail: 't', preview: null, original: 'o', animated: false },
      ['cached-preview'],
    ],
    [
      'S2 role reader: the original reads the original generation, not another role',
      'original',
      { hasLocalThumbnail: false, hasLocalOriginal: true, thumbnail: null, preview: null, original: 'o', animated: false },
      ['cached-original', 'cloud-original'],
    ],
  ] as const)('%s', (_name, role, state, expected) => {
    expect(tiersForRole(role, state)).toEqual(expected);
  });
});
