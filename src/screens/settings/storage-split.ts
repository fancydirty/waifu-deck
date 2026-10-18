export type StorageBytes = number | null | 'unavailable';

export type StorageSplit = Readonly<{
  status: 'measured' | 'loading' | 'unavailable';
  total: number | null;
  collectionFlex: number;
  previewFlex: number;
  zeroTotal: boolean;
}>;

export function isValidStorageBytes(value: StorageBytes): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A missing or failed reading cannot claim a total or a proportion. */
export function storageSplit(collectionBytes: StorageBytes, previewCacheBytes: StorageBytes): StorageSplit {
  if (collectionBytes === 'unavailable' || previewCacheBytes === 'unavailable'
    || (typeof collectionBytes === 'number' && !isValidStorageBytes(collectionBytes))
    || (typeof previewCacheBytes === 'number' && !isValidStorageBytes(previewCacheBytes))) {
    return { status: 'unavailable', total: null, collectionFlex: 0, previewFlex: 0, zeroTotal: false };
  }
  if (collectionBytes === null || previewCacheBytes === null) {
    return { status: 'loading', total: null, collectionFlex: 0, previewFlex: 0, zeroTotal: false };
  }
  const total = collectionBytes + previewCacheBytes;
  if (!Number.isFinite(total)) {
    return { status: 'unavailable', total: null, collectionFlex: 0, previewFlex: 0, zeroTotal: false };
  }
  if (total === 0) {
    return { status: 'measured', total: 0, collectionFlex: 0, previewFlex: 0, zeroTotal: true };
  }
  return {
    status: 'measured',
    total,
    collectionFlex: collectionBytes,
    previewFlex: previewCacheBytes,
    zeroTotal: false,
  };
}
