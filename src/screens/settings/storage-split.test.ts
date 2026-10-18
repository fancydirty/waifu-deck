import { storageSplit, type StorageBytes } from './storage-split';

function expected(status: 'measured' | 'loading' | 'unavailable', total: number | null = null,
  collectionFlex = 0, previewFlex = 0, zeroTotal = false) {
  return { status, total, collectionFlex, previewFlex, zeroTotal };
}

describe('storageSplit', () => {
  test.each([
    [3_000_000, 1_500_000, 4_500_000],
    [0, 1_500_000, 1_500_000],
    [3_000_000, 0, 3_000_000],
    [0.5, 1.5, 2],
  ])('measured %s + %s uses raw bytes as flex values', (collection, preview, total) => {
    expect(storageSplit(collection, preview)).toEqual(expected('measured', total, collection, preview));
  });

  test('measured zero/zero is an empty track, never a fabricated ratio', () => {
    expect(storageSplit(0, 0)).toEqual(expected('measured', 0, 0, 0, true));
  });

  test.each<[StorageBytes, StorageBytes, 'loading' | 'unavailable']>([
    [null, null, 'loading'], [null, 3_000, 'loading'], [3_000, null, 'loading'],
    ['unavailable', 'unavailable', 'unavailable'], ['unavailable', 3_000, 'unavailable'],
    [3_000, 'unavailable', 'unavailable'], [null, 'unavailable', 'unavailable'],
    ['unavailable', null, 'unavailable'],
  ])('%s + %s has no total or ratio (%s)', (collection, preview, status) => {
    expect(storageSplit(collection, preview)).toEqual(expected(status));
  });

  test.each([-1, NaN, Infinity, -Infinity])('invalid %s fails on either side, even against loading', (invalid) => {
    for (const other of [0, null, 'unavailable'] as const) {
      expect(storageSplit(invalid, other)).toEqual(expected('unavailable'));
      expect(storageSplit(other, invalid)).toEqual(expected('unavailable'));
    }
  });

  test('an overflowed total is unavailable with no ratio', () => {
    expect(storageSplit(Number.MAX_VALUE, Number.MAX_VALUE)).toEqual(expected('unavailable'));
    expect(storageSplit(Number.MAX_VALUE, 0)).toEqual(expected('measured', Number.MAX_VALUE, Number.MAX_VALUE));
  });
});
