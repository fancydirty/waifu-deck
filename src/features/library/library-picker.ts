export const LIBRARY_PICKER_SELECTION_LIMIT = 50;

export type PickedLibraryImage = Readonly<{
  uri: string;
  fileName: string | null;
  mimeType: string | null;
}>;

export type LibraryPickerPort = Readonly<{
  pickImages(input?: {
    selectionLimit?: number;
  }): Promise<readonly PickedLibraryImage[]>;
}>;

export type ExpoImagePickerModule = {
  launchImageLibraryAsync(options: {
    mediaTypes: 'images'[];
    allowsMultipleSelection: boolean;
    selectionLimit: number;
    exif: boolean;
    base64: boolean;
  }): Promise<{
    canceled: boolean;
    assets: readonly {
      uri: string;
      fileName?: string | null;
      mimeType?: string | null;
    }[] | null;
  }>;
};

function loadExpoImagePicker(): ExpoImagePickerModule {
  // Lazy native import keeps Store bundles free of the picker module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-image-picker') as unknown as ExpoImagePickerModule;
}

/**
 * Uses the Android system photo picker. No permanent gallery permission is
 * requested; the caller must copy the returned URIs immediately because they
 * are temporary grants that do not survive process death or revocation.
 */
export function createExpoLibraryPickerPort(
  picker: ExpoImagePickerModule = loadExpoImagePicker(),
): LibraryPickerPort {
  return {
    async pickImages(input = {}) {
      const result = await picker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: input.selectionLimit ?? LIBRARY_PICKER_SELECTION_LIMIT,
        exif: false,
        base64: false,
      });
      if (result.canceled || result.assets === null) return [];
      return result.assets.map((asset) => ({
        uri: asset.uri,
        fileName: asset.fileName ?? null,
        mimeType: asset.mimeType ?? null,
      }));
    },
  };
}
