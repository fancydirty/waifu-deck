import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import i18n, { translationResources } from '@/i18n';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];

  return Object.entries(value)
    .flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

function canonicalLeafKeys(value: unknown): string[] {
  return [...new Set(
    leafKeys(value).map((key) => key.replace(/_(one|other)$/, '')),
  )].sort();
}

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path.endsWith(join('i18n', 'locales'))) return [];
      return productionSourceFiles(path);
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) return [];
    return [path];
  });
}

describe('translation resources', () => {
  test.each([
    ['en', 'This phone', 'General'], ['ja', 'このスマートフォン', '一般'],
    ['zh-Hans', '这台手机', '通用'], ['zh-Hant', '這台手機', '一般'],
  ] as const)('%s has exact home group labels and removes retired section leaves', (language, phone, general) => {
    const sections = i18n.getResource(language, 'translation', 'settings.sections') as Record<string, unknown>;
    expect(sections).toMatchObject({ phone, general });
    expect(sections).toHaveProperty('sources');
    for (const key of ['contentQuality', 'storageBackup', 'resetData']) expect(sections).not.toHaveProperty(key);
  });
  test.each([
    ['zh-Hans', '已用', '收藏', '预览缓存', '清除预览缓存', '预览缓存已清除。'],
    ['zh-Hant', '已用', '收藏', '預覽快取', '清除預覽快取', '預覽快取已清除。'],
    ['ja', '使用済み', 'コレクション', 'プレビューキャッシュ', 'プレビューキャッシュを消去', 'プレビューキャッシュを消去しました。'],
    ['en', 'used', 'Collection', 'Preview cache', 'Clear preview cache', 'Preview cache cleared.'],
  ] as const)('%s has exact storage-panel copy and removes the three retired row keys',
    (language, used, legendCollection, legendPreviewCache, clearPreviewCache, previewCacheCleared) => {
      const storage = i18n.getResource(language, 'translation', 'settings.storage');
      expect(storage).toMatchObject({ used, legendCollection, legendPreviewCache, clearPreviewCache, previewCacheCleared });
      for (const key of ['clearPreviewCacheDetail', 'collectionUsage', 'previewCache']) {
        expect(storage).not.toHaveProperty(key);
      }
    });

  test('all locales include keyed-provider health and Rule34 SFW notes', () => {
    for (const language of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
      expect(i18n.exists('settings.provider.credentialRejected', { lng: language })).toBe(true);
      expect(i18n.exists('settings.provider.rule34NsfwOnly', { lng: language })).toBe(true);
    }
    expect(i18n.t('settings.provider.credentialRejected', { lng: 'zh-Hans' }))
      .toBe('密钥被拒绝，请检查后重新保存');
  });

  test.each(['zh-Hans', 'zh-Hant', 'ja'] as const)(
    '%s has the same translation keys as English',
    (language) => {
      expect(canonicalLeafKeys(translationResources[language].translation))
        .toEqual(canonicalLeafKeys(translationResources.en.translation));
    },
  );

  // Board #24: the rewind button replaces the decision toast. Parity alone
  // passes when a key is added or removed in no locale at all, so pin both.
  test.each([
    ['zh-Hans', '回退上一张'],
    ['zh-Hant', '回退上一張'],
    ['en', 'Rewind last card'],
    ['ja', '前のカードに戻す'],
  ] as const)('%s labels the rewind button and drops the decision-toast strings', (
    language,
    label,
  ) => {
    const discover: Record<string, unknown> = translationResources[language].translation.discover;
    expect(discover.rewind).toBe(label);
    for (const retired of ['saved', 'dismissed', 'undo', 'undoError']) {
      expect(discover).not.toHaveProperty(retired);
    }
  });

  test('every static production translation call resolves in English', () => {
    const unresolved = productionSourceFiles(join(process.cwd(), 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const keys = [...source.matchAll(/(?:\bt|i18n\.t)\(\s*['"]([^'"`]+)['"]/g)]
        .map((match) => match[1]!);
      return keys
        .filter((key) => !i18n.exists(key, { lng: 'en' })
          && !i18n.exists(`${key}_one`, { lng: 'en' })
          && !i18n.exists(`${key}_other`, { lng: 'en' }))
        .map((key) => `${file.replace(`${process.cwd()}/`, '')}: ${key}`);
    });

    expect(unresolved).toEqual([]);
  });

  test.each(['en', 'zh-Hans', 'zh-Hant', 'ja'] as const)('%s has all interim cloud footer keys with matching interpolations', (language) => {
    for (const suffix of ['quotaFull', 'pending', 'downloading', 'synced']) {
      const key = `settings.cloudLibrary.footer.${suffix}`;
      const value = i18n.getResource(language, 'translation', key) as string;
      expect(typeof value).toBe('string');
      expect(value.match(/{{\w+}}/g)).toEqual(suffix === 'synced' ? ['{{age}}'] : ['{{count}}']);
      expect(i18n.t(key, { lng: language, count: 3, age: 'AGE' })).not.toMatch(/{{|settings\.cloudLibrary/);
    }
  });

  test.each([
    ['zh-Hans', '全部已备份 · {{age}}'],
    ['zh-Hant', '全部已備份 · {{age}}'],
    ['ja', 'すべてバックアップ済み · {{age}}'],
    ['en', 'All backed up · {{age}}'],
  ] as const)('%s keeps the synced footer copy free of a last-synced marker', (language, expected) => {
    expect(i18n.getResource(language, 'translation', 'settings.cloudLibrary.footer.synced')).toBe(expected);
  });

  test.each(['en', 'zh-Hans', 'zh-Hant', 'ja'] as const)('%s cloud card status keys and interpolation match the approved contract', (language) => {
    const card = i18n.getResource(language, 'translation', 'settings.cloudLibrary');
    expect(Object.keys(card.lockMessage).sort()).toEqual(['unlock', 'reauth', 'network', 'credentialRejected', 'unreadable', 'other', 'wrongPassword', 'passwordRequired', 'signInCancelled', 'networkAction'].sort());
    for (const key of ['inCloud', 'originalSize', 'pending']) {
      expect(card[key]).not.toMatch(/{{|\d/);
      expect(i18n.t(`settings.cloudLibrary.${key}`, { lng: language, count: 17 })).not.toContain('17');
    }
    if (language === 'en') {
      expect(card).not.toHaveProperty('image');
      expect(card).toMatchObject({ image_one: 'image', image_other: 'images' });
    } else {
      expect(card).toHaveProperty('image', language === 'zh-Hans' ? '张' : language === 'zh-Hant' ? '張' : '枚');
      expect(card).not.toHaveProperty('image_one');
      expect(card).not.toHaveProperty('image_other');
    }
    expect(i18n.t('settings.sections.cloudSync', { lng: language })).toBe(i18n.t('settings.byos.heading', { lng: language }));
  });

  test('the Cloud-Vault term is gone from every locale', () => {
    for (const language of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
      expect(translationResources[language].translation.libraryView)
        .not.toHaveProperty('cloudOnlyHint');
      const values: unknown[] = [];
      const collect = (value: unknown): void => {
        if (value !== null && typeof value === 'object') {
          Object.values(value).forEach(collect);
        } else {
          values.push(value);
        }
      };
      collect(translationResources[language].translation);
      expect(values.some((value) => (
        typeof value === 'string' && /保险库|保險庫|Cloud Vault/.test(value)
      ))).toBe(false);
    }
  });

  test('N6-B2: all four locales carry approved §4.11 collection.import copy and remove retired settings.library keys', () => {
    for (const language of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
      expect(translationResources[language].translation.settings).not.toHaveProperty('library');
    }
    expect(i18n.t('collection.import.sheetConstraint', { lng: 'zh-Hans' }))
      .toBe('导入后不能改分类，请确认后再选。');
    expect(i18n.t('collection.import.sheetConstraint', { lng: 'zh-Hant' }))
      .toBe('匯入後不能改分類，請確認後再選。');
    expect(i18n.t('collection.import.sheetConstraint', { lng: 'en' }))
      .toBe("You can't change the classification after import. Choose carefully.");
    expect(i18n.t('collection.import.sheetConstraint', { lng: 'ja' }))
      .toBe('読み込み後は分類を変更できません。確認してから選んでください。');

    expect(i18n.t('collection.import.retainedClassification', { lng: 'zh-Hans', count: 3 }))
      .toBe('3 张沿用了原来的分类。');
    expect(i18n.t('collection.import.retainedClassification', { lng: 'zh-Hant', count: 3 }))
      .toBe('3 張沿用了原來的分類。');
    expect(i18n.t('collection.import.retainedClassification', { lng: 'en', count: 3 }))
      .toBe('3 images kept their original classification.');
    expect(i18n.t('collection.import.retainedClassification', { lng: 'ja', count: 3 }))
      .toBe('3 枚は元の分類を引き継ぎました。');

    expect(i18n.t('collection.import.overCapRejected', { lng: 'zh-Hans', count: 2 }))
      .toBe('2 张图片太大，没导入。');
    expect(i18n.t('collection.import.overCapRejected', { lng: 'zh-Hant', count: 2 }))
      .toBe('2 張圖片太大，沒匯入。');
    expect(i18n.t('collection.import.overCapRejected', { lng: 'en', count: 2 }))
      .toBe('2 images were too large to import.');
    expect(i18n.t('collection.import.overCapRejected', { lng: 'ja', count: 2 }))
      .toBe('2 枚はサイズが大きすぎるため、読み込めませんでした。');
  });
});

// Board #27 S3b (§5.14): the copy is the approved table's, byte for byte, in all
// four locales. The table is read from docs/cloud-only-copy.md so a retyped cell fails here.
const SPEC = join(process.cwd(), 'docs/cloud-only-copy.md');
const S3B_ROWS = {
  'row label': 'label', 'mode: both': 'both', 'mode: cloud': 'cloudOnly',
  'row detail': 'detail', 'warn title': 'warn.title', 'warn body': 'warn.message',
  'warn confirm': 'warn.confirm', 'back title': 'back.title', 'back body': 'back.message',
  'back confirm': 'back.confirm', 'progress (cloud-only)': 'progress',
  'disconnect extra': 'disconnectExtra',
} as const;
const SPEC_LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const;

/** The rows of §5.14's table only, so another four-locale table can never shadow a row. */
function specCells(): Map<string, string[]> {
  const lines = readFileSync(SPEC, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('### 5.14 '));
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith('### '));
  const cells = new Map<string, string[]>();
  if (start < 0 || length < 0) return cells;
  for (const line of lines.slice(start + 1, start + 1 + length)) {
    if (!line.startsWith('| ') || !line.endsWith(' |')) continue;
    const parts = line.slice(2, -2).split(' | ');
    if (parts.length === 5) cells.set(parts[0]!, parts.slice(1));
  }
  return cells;
}

describe('board #27 S3b storage-mode copy', () => {
  test.each(Object.entries(S3B_ROWS))(
    'board #27 S3b: "%s" is the spec §5.14 cell in all four locales',
    (row, key) => {
      const cells = specCells().get(row);
      expect(cells).toHaveLength(4);
      SPEC_LANGUAGES.forEach((language, index) => {
        expect(i18n.getResource(language, 'translation', `settings.byos.storageMode.${key}`))
          .toBe(cells![index]);
      });
    },
  );

  test('board #27 S3b: the storage-mode group holds exactly the S3 rows (+ en singulars, S4)', () => {
    const s3 = [...Object.values(S3B_ROWS)];
    expect(leafKeys(i18n.getResource('en', 'translation', 'settings.byos.storageMode')))
      .toEqual([...s3, 'back.message_one', 'disconnectExtra_one'].sort());
    for (const language of ['zh-Hans', 'zh-Hant', 'ja'] as const) {
      expect(leafKeys(i18n.getResource(language, 'translation', 'settings.byos.storageMode')))
        .toEqual([...s3].sort());
    }
  });
});

// Board #27 S4 (spec §5.14): the S4 rows, byte for byte, in all four locales.
const S4_ROWS = {
  'detail offline note (S4)': 'libraryView.thumbnailNote.offline',
  'detail locked note (S4)': 'libraryView.thumbnailNote.locked',
  'detail disconnected note (S4)': 'libraryView.thumbnailNote.disconnected',
  'tile a11y state (S4)': 'collection.offlineCloudOnly',
  'share offline (S4)': 'detail.errorCloudOnlyOffline',
  'share disconnected (S4)': 'detail.errorCloudOnlyDisconnected',
  'backup summary (S4)': 'settings.backup.cloudOnly',
  'missing placeholder (S4)': 'libraryView.missingMessage',
  'disconnected placeholder (S4)': 'libraryView.disconnectedTitle',
  'offline placeholder detail (S4)': 'libraryView.offlineMessage',
  'no cloud library (S4)': 'settings.libraryCloud.unavailable',
  'trash delete confirm (S4)': 'libraryTrash.deletePermanentlyConfirmMessage',
  'disconnect failed (S4)': 'settings.byos.disconnectFailed',
  'delete-all forget label (S4)': 'settings.deleteAll.cloudRecords',
} as const;
const EN_ONE_ROWS = {
  'back body (en, one)': 'settings.byos.storageMode.back.message_one',
  'disconnect extra (en, one)': 'settings.byos.storageMode.disconnectExtra_one',
} as const;

describe('board #27 S4 copy', () => {
  test.each(Object.entries(S4_ROWS))('"%s" is the spec §5.14 cell in all four locales', (row, key) => {
    const cells = specCells().get(row);
    expect(cells).toHaveLength(4);
    SPEC_LANGUAGES.forEach((language, index) => {
      expect(i18n.getResource(language, 'translation', key)).toBe(cells![index]);
    });
  });

  test.each(Object.entries(EN_ONE_ROWS))('"%s" is the en cell; the other locales have one form', (row, key) => {
    expect(i18n.getResource('en', 'translation', key)).toBe(specCells().get(row)![2]);
    for (const language of ['zh-Hans', 'zh-Hant', 'ja'] as const) {
      expect(i18n.getResource(language, 'translation', key)).toBeUndefined();
    }
  });

  test.each([
    [1, 'en', '1 original (about 1.0 MB) will be downloaded to this phone again.'],
    [2, 'en', '2 originals (about 1.0 MB) will be downloaded to this phone again.'],
    [1, 'zh-Hans', '将把 1 张原图重新下载到这台手机（约 1.0 MB）。'],
    [1, 'ja', '1 枚のオリジナル（約 1.0 MB）をこの端末に再ダウンロードします。'],
  ] as const)('the switch-back body at count %i in %s', (count, language, text) => {
    expect(i18n.getFixedT(language)('settings.byos.storageMode.back.message', { count, size: '1.0 MB' }))
      .toBe(text);
  });

  test('the disconnect extra line at count 1 in en', () => {
    expect(i18n.getFixedT('en')('settings.byos.storageMode.disconnectExtra', { count: 1 }))
      .toBe(specCells().get('disconnect extra (en, one)')![2]!.replace('{{count}}', '1'));
  });
});
