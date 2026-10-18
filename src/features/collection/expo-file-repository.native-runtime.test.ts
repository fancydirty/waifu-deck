import { createExpoFileRepository } from '@/features/collection/expo-file-repository';

const mockRequestPermissionsAsync = jest.fn(async () => ({ granted: true }));
const mockCreateAssetAsync = jest.fn(async () => ({ id: 'asset-1' }));
let mockMediaLibraryLoadCount = 0;

jest.mock('expo-media-library/legacy', () => {
  mockMediaLibraryLoadCount += 1;
  return {
    requestPermissionsAsync: mockRequestPermissionsAsync,
    createAssetAsync: mockCreateAssetAsync,
  };
});

jest.mock('expo-file-system', () => {
  class Directory {
    readonly uri = 'file:///documents/collection';
    readonly exists = true;
    readonly size = 0;

    create() {}
    list() { return []; }
  }

  class File {
    readonly uri: string;
    readonly exists = true;
    readonly size = 1;

    constructor(location: { uri: string } | string, name = '') {
      this.uri = typeof location === 'string'
        ? location
        : `${location.uri}/${name}`;
    }

    delete() {}
    copy() {}
    move() {}

    static createDownloadTask() {
      return { downloadAsync: async () => null };
    }
  }

  return {
    Directory,
    File,
    Paths: { document: 'file:///documents' },
  };
});

jest.mock('expo-image', () => ({
  Image: { getCachePathAsync: async () => null },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async () => undefined,
}));

describe('Expo Go 56 collection adapter', () => {
  test('loads the bundled media-library module and exports a private image', async () => {
    const repository = createExpoFileRepository({ platform: 'android' });
    const uri = 'file:///documents/collection/7.webp';

    expect(mockMediaLibraryLoadCount).toBe(0);
    await repository.exportToPhotos(uri);

    expect(mockMediaLibraryLoadCount).toBe(1);
    expect(mockRequestPermissionsAsync).toHaveBeenCalledWith(true, ['photo']);
    expect(mockCreateAssetAsync).toHaveBeenCalledWith(uri);
  });
});
