import { formatTagCount } from './format-tag-count';
import type { AppLanguage } from '@/features/waifu/types';

test.each<[number, AppLanguage, string]>([
  [5579, 'zh-Hans', '5,579'], [5579, 'en', '5.6K'],
  [237991, 'zh-Hans', '23.8 万'], [237991, 'zh-Hant', '23.8 萬'],
  [237991, 'ja', '23.8万'], [237991, 'en', '238K'],
  [100000, 'zh-Hans', '10 万'], [123456789, 'zh-Hans', '1.2 亿'],
  [123456789, 'zh-Hant', '1.2 億'], [123456789, 'ja', '1.2億'],
  [123456789, 'en', '123.5M'], [2000000000, 'en', '2B'],
  [999, 'en', '999'], [9999, 'ja', '9,999'],
  [0, 'en', '0'], [0, 'zh-Hans', '0'], [0, 'zh-Hant', '0'], [0, 'ja', '0'],
])('%s in %s renders as %s', (count, language, expected) => {
  expect(formatTagCount(count, language)).toBe(expected);
});
