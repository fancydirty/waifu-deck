import {
  createSettingsRepository,
  type KeyValueStorage,
} from '@/features/settings/settings-repository';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';

const SETTINGS_KEY = 'waifu-deck/settings/v1';

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  setError: unknown = null;

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.setError !== null) throw this.setError;
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('settings repository', () => {
  test('returns defaults when data is missing', async () => {
    const repository = createSettingsRepository(new MemoryStorage());

    await expect(repository.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  test('returns defaults when stored JSON is malformed', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SETTINGS_KEY, '{not-json');
    const repository = createSettingsRepository(storage);

    await expect(repository.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  test('repairs invalid fields without discarding valid fields', async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      SETTINGS_KEY,
      JSON.stringify({
        version: 99,
        nsfwMode: 'mixed',
        nsfwConfirmed: 'yes',
        includedTags: ['WAIFU', 'Raiden_Shogun', 'bad tag', 2],
        excludedTags: ['raiden_shogun', 'Maid'],
        orientation: 'square',
        animationMode: 'only',
        minWidth: 123,
        maxBytes: 5_000_000,
        blurNsfwThumbnails: false,
      }),
    );
    const repository = createSettingsRepository(storage);

    await expect(repository.load()).resolves.toEqual({
      version: 5,
      language: 'system',
      providers: {
        waifu_im: true,
        nekos_api: true,
        danbooru: true,
        safebooru: true,
        yandere: true,
        konachan: true, e621: true, e926: true, gelbooru: false, rule34: false,
      },
      nsfwMode: 'sfw',
      nsfwConfirmed: false,
      includedTags: ['waifu', 'raiden_shogun'],
      excludedTags: ['maid'],
      orientation: 'portrait',
      animationMode: 'only',
      stylePreference: 'any',
      minWidth: 0,
      maxBytes: 5_000_000,
      prefetchDepth: 40,
      blurNsfwThumbnails: false,
    });
  });

  test('downgrades an unconfirmed stored adult mode to SFW', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SETTINGS_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      nsfwMode: 'nsfw',
      nsfwConfirmed: false,
    }));
    const repository = createSettingsRepository(storage);

    await expect(repository.load()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  test('loads a confirmed stored adult mode unchanged', async () => {
    const storage = new MemoryStorage();
    const confirmed = {
      ...DEFAULT_SETTINGS,
      nsfwMode: 'mixed' as const,
      nsfwConfirmed: true,
    };
    storage.values.set(SETTINGS_KEY, JSON.stringify(confirmed));
    const repository = createSettingsRepository(storage);

    await expect(repository.load()).resolves.toEqual(confirmed);
  });

  test('saves one normalized versioned object', async () => {
    const storage = new MemoryStorage();
    const repository = createSettingsRepository(storage);

    await expect(
      repository.save({
        nsfwMode: 'invalid',
        includedTags: [' Maid ', 'maid'],
        excludedTags: ['maid', 'uniform'],
      }),
    ).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      includedTags: ['waifu', 'maid'],
      excludedTags: ['uniform'],
    });

    expect(JSON.parse(storage.values.get(SETTINGS_KEY)!)).toEqual({
      ...DEFAULT_SETTINGS,
      includedTags: ['waifu', 'maid'],
      excludedTags: ['uniform'],
    });
  });

  // K7 cut 8 (audit ㊳): the vault-dirty callback was never supplied in
  // production, so the read that only decided whether to call it was pure cost
  // on every settings write.
  test('saving settings reads nothing and writes once', async () => {
    const storage = new MemoryStorage();
    const getItem = jest.spyOn(storage, 'getItem');
    const setItem = jest.spyOn(storage, 'setItem');
    const repository = createSettingsRepository(storage);

    await repository.save({ ...DEFAULT_SETTINGS, minWidth: 1080 });

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).toHaveBeenCalledTimes(1);

    // An identical second save still costs exactly one write and no read.
    await repository.save({ ...DEFAULT_SETTINGS, minWidth: 1080 });

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  test('reset removes the versioned object', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
    const repository = createSettingsRepository(storage);

    await repository.reset();

    expect(storage.values.has(SETTINGS_KEY)).toBe(false);
  });
});
