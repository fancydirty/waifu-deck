/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, screen, userEvent } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestInstance } from 'test-renderer';
import { StyleSheet } from 'react-native';

import type { ProviderCredential } from '@/features/providers/provider-credentials';
import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import type { ProviderHealthEntry } from '@/features/providers/provider-resilience';
import type { ImageProviderKey } from '@/features/waifu/types';
import i18n from '@/i18n';
import { colors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';

import {
  CredentialProviderRow,
  type CredentialProviderRowProps,
} from './credential-provider-row';

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View: NativeView } = require('react-native');
  return {
    ChevronRight: (props: Record<string, unknown>) => React.createElement(NativeView, { ...props, testID: 'chevron' }),
  };
});

const SYNTHETIC: ProviderCredential = { apiKey: 'u2-synthetic-key', userId: '0' };

const adapters = {
  gelbooru: PROVIDER_REGISTRY.find((adapter) => adapter.settingsSlug === 'gelbooru')!,
  rule34: PROVIDER_REGISTRY.find((adapter) => adapter.settingsSlug === 'rule34')!,
};

const idleHealth: ProviderHealthEntry = {
  providerKey: 'gelbooru', status: 'idle', consecutiveFailures: 0,
  blockedUntil: null, lastErrorCode: null, updatedAt: 0,
};

function rowProps(overrides: Partial<CredentialProviderRowProps> = {}): CredentialProviderRowProps {
  return {
    adapter: adapters.gelbooru,
    enabled: true,
    enabledProviderCount: 8,
    busy: false,
    credential: undefined,
    health: idleHealth,
    onSaveCredential: jest.fn(async () => true),
    onClearCredential: jest.fn(async () => true),
    onToggle: jest.fn(async () => true),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function allHosts(): TestInstance[] {
  return screen.container.queryAll(() => true);
}

function indexTestId(list: TestInstance[], testID: string): number {
  return list.findIndex((node) => node.props.testID === testID);
}

function indexText(list: TestInstance[], text: string): number {
  return list.findIndex((node) => typeof node.props.children === 'string' && node.props.children === text);
}

/** The internal 1dp hair is a leaf View carrying only a top hair border. */
function hairLeaves(list: TestInstance[]): TestInstance[] {
  return list.filter((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.borderTopWidth === 1
      && style?.borderTopColor === colors.light.hair
      && node.children.length === 0;
  });
}

function roundedCards(list: TestInstance[]): TestInstance[] {
  return list.filter((node) => StyleSheet.flatten(node.props.style)?.borderRadius === 14);
}

type KeyedSlugCopy = { description: string; enable: string; host: string };
type KeyedCopy = {
  language: string;
  off: string;
  idle: string;
  apiKey: string;
  userId: string;
  save: string;
  clear: string;
  set: string;
  hint: string;
  gelbooru: KeyedSlugCopy;
  rule34: KeyedSlugCopy;
};

/**
 * Independent literals from the current locale files (CD11): a fallback or a
 * copy mutation cannot silently pass against these.
 */
const KEYED_COPY: KeyedCopy[] = [
  {
    language: 'en',
    off: 'Off',
    idle: 'No images fetched yet',
    apiKey: 'API key',
    userId: 'User ID',
    save: 'Save & enable',
    clear: 'Remove key',
    set: '•••• key saved',
    hint: 'Saving your key enables this source. Get a free key from your {{host}} account settings.',
    gelbooru: { description: 'Large tagged gallery, requires your free API key', enable: 'Enable Gelbooru', host: 'gelbooru.com' },
    rule34: { description: 'Large NSFW imageboard, requires your free API key', enable: 'Enable Rule34', host: 'rule34.xxx' },
  },
  {
    language: 'ja',
    off: 'オフ',
    idle: 'まだ画像を取得していません',
    apiKey: 'APIキー',
    userId: 'ユーザーID',
    save: '保存して有効化',
    clear: 'キーを削除',
    set: '•••• キー保存済み',
    hint: 'キーを保存するとこのソースが有効になります。{{host}}のアカウント設定から無料キーを取得できます。',
    gelbooru: { description: 'タグが豊富な大規模ギャラリー（無料APIキーが必要）', enable: 'Gelbooru を有効にする', host: 'gelbooru.com' },
    rule34: { description: '大規模なNSFWイメージボード（無料APIキーが必要）', enable: 'Rule34 を有効にする', host: 'rule34.xxx' },
  },
  {
    language: 'zh-Hans',
    off: '已关闭',
    idle: '本次尚未取图',
    apiKey: 'API 密钥',
    userId: '用户 ID',
    save: '保存并启用',
    clear: '移除密钥',
    set: '•••• 密钥已保存',
    hint: '保存密钥即可启用该源。可在 {{host}} 的账户设置中获取免费密钥。',
    gelbooru: { description: '大型标签图库，需要你的免费 API 密钥', enable: '启用 Gelbooru', host: 'gelbooru.com' },
    rule34: { description: '大型 NSFW 图板，需要你的免费 API 密钥', enable: '启用 Rule34', host: 'rule34.xxx' },
  },
  {
    language: 'zh-Hant',
    off: '已關閉',
    idle: '本次尚未取圖',
    apiKey: 'API 金鑰',
    userId: '使用者 ID',
    save: '儲存並啟用',
    clear: '移除金鑰',
    set: '•••• 金鑰已儲存',
    hint: '儲存金鑰即可啟用此來源。可在 {{host}} 的帳戶設定中取得免費金鑰。',
    gelbooru: { description: '大型標籤圖庫，需要你的免費 API 金鑰', enable: '啟用 Gelbooru', host: 'gelbooru.com' },
    rule34: { description: '大型 NSFW 圖板，需要你的免費 API 金鑰', enable: '啟用 Rule34', host: 'rule34.xxx' },
  },
];

const SLUGS = ['gelbooru', 'rule34'] as const;

describe.each(KEYED_COPY)('U2c2 keyed row look in $language', (copy) => {
  describe.each(SLUGS)('%s', (slug) => {
    const cap = slug.charAt(0).toUpperCase() + slug.slice(1);
    const slugCopy = copy[slug];

    test('saved state is title → toggle → hair → masked clear with chevron', async () => {
      await i18n.changeLanguage(copy.language);
      expect(i18n.getResource(copy.language, 'translation', `settings.provider.${slug}Description`))
        .toBe(slugCopy.description);
      expect(i18n.getResource(copy.language, 'translation', `settings.provider.enable${cap}`)).toBe(slugCopy.enable);
      expect(i18n.getResource(copy.language, 'translation', 'settings.provider.credentialClear')).toBe(copy.clear);
      expect(i18n.getResource(copy.language, 'translation', 'settings.provider.credentialSet')).toBe(copy.set);

      await render(<CredentialProviderRow {...rowProps({
        adapter: adapters[slug], credential: SYNTHETIC, enabled: true, enabledProviderCount: 8,
      })} />);

      expect(screen.getByText(adapters[slug].label)).toBeOnTheScreen();
      const detail = `${slugCopy.description} · ${copy.idle}`;
      expect(screen.getByText(detail)).toBeOnTheScreen();
      const toggle = screen.getByTestId(`provider-${slug}-toggle`);
      expect(toggle.props.accessibilityLabel).toBe(slugCopy.enable);
      const clear = screen.getByTestId(`provider-${slug}-credential-clear`);
      expect(screen.getByText(copy.clear)).toBeOnTheScreen();
      expect(screen.getByText(copy.set)).toBeOnTheScreen();
      expect(clear.queryAll((node) => node.props.testID === 'chevron')).toHaveLength(1);

      // v4 row look: both keyed children are ordinary SettingsRows (52dp row,
      // 15/heavy title, 12.5 detail), not the old home SettingRow (56dp/16px).
      expect(screen.getByText(adapters[slug].label)).toHaveStyle(settingsTypography.rowTitle);
      expect(screen.getByText(detail)).toHaveStyle(settingsTypography.detail);
      expect(screen.getByText(adapters[slug].label).parent!.parent!)
        .toHaveStyle({ minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, gap: 12 });
      expect(clear).toHaveStyle({ minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, gap: 12 });

      const hosts = allHosts();
      const hair = hairLeaves(hosts);
      expect(hair).toHaveLength(1);
      const order = [
        indexText(hosts, adapters[slug].label),
        indexText(hosts, detail),
        indexTestId(hosts, `provider-${slug}-toggle`),
        hosts.indexOf(hair[0]!),
        indexTestId(hosts, `provider-${slug}-credential-clear`),
      ];
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      // Saved state renders no form and never echoes the raw key/user ID.
      expect(hosts.filter((node) => node.type === 'TextInput')).toHaveLength(0);
      for (const id of ['apikey', 'userid', 'save']) {
        expect(screen.queryByTestId(`provider-${slug}-credential-${id}`)).toBeNull();
      }
      expect(screen.queryByText(/u2-synthetic-key/)).toBeNull();
      expect(roundedCards(hosts)).toHaveLength(0);
    });

    test('keyless state is title/Off → hair → field block with no toggle', async () => {
      await i18n.changeLanguage(copy.language);
      expect(i18n.getResource(copy.language, 'translation', `settings.provider.${slug}Description`))
        .toBe(slugCopy.description);
      expect(i18n.getResource(copy.language, 'translation', 'settings.provider.disabled'))
        .toBe(`{{description}} · ${copy.off}`);
      expect(i18n.getResource(copy.language, 'translation', 'settings.provider.credentialApiKey')).toBe(copy.apiKey);
      expect(i18n.getResource(copy.language, 'translation', 'settings.provider.credentialUserId')).toBe(copy.userId);
      expect(i18n.getResource(copy.language, 'translation', 'settings.provider.credentialSave')).toBe(copy.save);
      expect(i18n.getResource(copy.language, 'translation', 'settings.provider.credentialHint')).toBe(copy.hint);

      await render(<CredentialProviderRow {...rowProps({
        adapter: adapters[slug], credential: undefined, enabled: false, enabledProviderCount: 8,
      })} />);

      expect(screen.getByText(adapters[slug].label)).toBeOnTheScreen();
      const detail = `${slugCopy.description} · ${copy.off}`;
      expect(screen.getByText(detail)).toBeOnTheScreen();
      expect(screen.queryByTestId(`provider-${slug}-toggle`)).toBeNull();
      expect(screen.queryAllByRole('switch')).toHaveLength(0);

      // v4 row look: the disabled-description row is a SettingsRow too.
      expect(screen.getByText(adapters[slug].label)).toHaveStyle(settingsTypography.rowTitle);
      expect(screen.getByText(detail)).toHaveStyle(settingsTypography.detail);
      expect(screen.getByText(adapters[slug].label).parent!.parent!)
        .toHaveStyle({ minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, gap: 12 });

      const apikey = screen.getByTestId(`provider-${slug}-credential-apikey`);
      const userid = screen.getByTestId(`provider-${slug}-credential-userid`);
      expect(apikey.props.accessibilityLabel).toBe(copy.apiKey);
      expect(apikey.props.placeholder).toBe(copy.apiKey);
      expect(apikey.props.secureTextEntry).toBe(true);
      expect(userid.props.accessibilityLabel).toBe(copy.userId);
      expect(userid.props.placeholder).toBe(copy.userId);
      expect(userid.props.secureTextEntry).toBeUndefined();
      for (const field of [apikey, userid]) {
        expect(field).toHaveStyle({
          minHeight: 48, paddingVertical: 10, paddingHorizontal: 12,
          borderWidth: 1.5, borderRadius: 12,
          borderColor: colors.light.border,
          color: colors.light.text,
          backgroundColor: colors.light.surfaceSecondary,
        });
        const style = StyleSheet.flatten(field.props.style);
        expect(style.margin ?? 0).toBe(0);
        expect(style.marginTop ?? 0).toBe(0);
        expect(style.marginVertical ?? 0).toBe(0);
        expect(style.marginHorizontal ?? 0).toBe(0);
      }

      const hint = copy.hint.replace('{{host}}', slugCopy.host);
      expect(screen.getByText(hint)).toHaveStyle({
        fontSize: 12.5, lineHeight: 18.75, marginTop: 8, color: colors.light.textSecondary,
      });

      const save = screen.getByTestId(`provider-${slug}-credential-save`);
      expect(save).toBeDisabled();
      expect(screen.getByText(copy.save)).toBeOnTheScreen();
      // Save frame: 34 draw + 14 frame extension (−7/+7 on the pressable host).
      expect(save).toHaveStyle({ marginVertical: -7, paddingVertical: 7 });
      const draw = save.queryAll((node) => StyleSheet.flatten(node.props.style)?.minHeight === 34);
      expect(draw).toHaveLength(1);
      expect(draw[0]).toHaveStyle({
        borderRadius: 10, backgroundColor: colors.light.save,
      });

      const hosts = allHosts();
      const hair = hairLeaves(hosts);
      expect(hair).toHaveLength(1);
      const order = [
        indexText(hosts, adapters[slug].label),
        indexText(hosts, detail),
        hosts.indexOf(hair[0]!),
        indexTestId(hosts, `provider-${slug}-credential-apikey`),
        indexTestId(hosts, `provider-${slug}-credential-userid`),
        indexText(hosts, hint),
        indexTestId(hosts, `provider-${slug}-credential-save`),
      ];
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      // Block geometry: 12/14/14 insets, second field owns the 8 gap, the
      // button holder owns the 10 gap, and the save frame stays inside.
      expect(apikey.parent).toHaveStyle({ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 });
      expect(userid.parent).toHaveStyle({ marginTop: 8 });
      expect(save.parent).toHaveStyle({ marginTop: 10 });
      expect(roundedCards(hosts)).toHaveLength(0);
    });
  });
});

test('U2c2 save and clear reach services through host presses', async () => {
  await i18n.changeLanguage('zh-Hans');

  // ---- keyless: canSave gating, trimming, one call per host press, held save,
  // false save retaining input + unlock + retry, success alone clearing fields.
  const heldSave = deferred<boolean>();
  const saved: { key: ImageProviderKey; credential: ProviderCredential }[] = [];
  const onSaveCredential = jest.fn((key: ImageProviderKey, credential: ProviderCredential) => {
    saved.push({ key, credential });
    return saved.length === 1 ? heldSave.promise : Promise.resolve(saved.length === 3);
  });
  const onClearCredential = jest.fn(async () => true);
  const onToggle = jest.fn(async () => true);
  const keylessProps = () => rowProps({
    adapter: adapters.gelbooru, credential: undefined, enabled: false, enabledProviderCount: 8,
    onSaveCredential, onClearCredential, onToggle,
  });
  const firstView = await render(<CredentialProviderRow {...keylessProps()} />);
  const apikey = () => screen.getByTestId('provider-gelbooru-credential-apikey');
  const userid = () => screen.getByTestId('provider-gelbooru-credential-userid');
  const save = () => screen.getByTestId('provider-gelbooru-credential-save');

  await fireEvent.changeText(apikey(), '   ');
  await fireEvent.changeText(userid(), '\t ');
  expect(save()).toBeDisabled();
  await fireEvent.changeText(apikey(), '  u2-synthetic-key  ');
  expect(save()).toBeDisabled();
  await fireEvent.changeText(userid(), ' 0 ');
  expect(save()).toBeEnabled();

  await userEvent.press(save());
  expect(onSaveCredential).toHaveBeenCalledTimes(1);
  expect(saved[0]).toEqual({ key: 'gelbooru', credential: { apiKey: 'u2-synthetic-key', userId: '0' } });
  // Held save disables the fields and the button.
  expect(apikey().props.editable).toBe(false);
  expect(userid().props.editable).toBe(false);
  expect(save()).toBeDisabled();
  await act(async () => { heldSave.resolve(false); });
  // A false save keeps the inputs and unlocks everything for a retry.
  expect(apikey().props.value).toBe('  u2-synthetic-key  ');
  expect(userid().props.value).toBe(' 0 ');
  expect(apikey().props.editable).toBe(true);
  expect(save()).toBeEnabled();

  await userEvent.press(save());
  expect(onSaveCredential).toHaveBeenCalledTimes(2);
  await act(async () => {});
  // False save again: still retained, still unlocked, still retryable.
  expect(apikey().props.value).toBe('  u2-synthetic-key  ');
  expect(save()).toBeEnabled();

  await userEvent.press(save());
  expect(onSaveCredential).toHaveBeenCalledTimes(3);
  await act(async () => {});
  // Success alone clears the fields.
  expect(apikey().props.value).toBe('');
  expect(userid().props.value).toBe('');
  expect(save()).toBeDisabled();
  await firstView.unmount();

  // ---- saved: false clear unlocks and retries, saved state kept by the
  // supplied credential prop, toggle-off keeps the key, last-source guards.
  const heldClear = deferred<boolean>();
  const clearCalls: ImageProviderKey[] = [];
  const onClearCredentialSaved = jest.fn((key: ImageProviderKey) => {
    clearCalls.push(key);
    return clearCalls.length === 1 ? heldClear.promise : Promise.resolve(clearCalls.length > 1);
  });
  const toggleCalls: { key: ImageProviderKey; value: boolean }[] = [];
  const heldToggle = deferred<boolean>();
  const onToggleSaved = jest.fn((key: ImageProviderKey, value: boolean) => {
    toggleCalls.push({ key, value });
    return heldToggle.promise;
  });
  const savedProps = (overrides: Partial<CredentialProviderRowProps> = {}) => rowProps({
    adapter: adapters.rule34, credential: SYNTHETIC, enabled: true, enabledProviderCount: 8,
    onSaveCredential, onClearCredential: onClearCredentialSaved, onToggle: onToggleSaved,
    ...overrides,
  });
  const secondView = await render(<CredentialProviderRow {...savedProps()} />);
  const clear = () => screen.getByTestId('provider-rule34-credential-clear');
  const toggle = () => screen.getByTestId('provider-rule34-toggle');

  await userEvent.press(clear());
  expect(onClearCredentialSaved).toHaveBeenCalledTimes(1);
  expect(clearCalls[0]).toBe('rule34');
  expect(clear()).toBeDisabled();
  await act(async () => { heldClear.resolve(false); });
  // False clear unlocks and the saved state stays (the credential prop is
  // still supplied) — retryable.
  expect(clear()).toBeEnabled();
  expect(screen.getByText('•••• 密钥已保存')).toBeOnTheScreen();
  await userEvent.press(clear());
  expect(onClearCredentialSaved).toHaveBeenCalledTimes(2);
  await act(async () => {});
  expect(clear()).toBeEnabled();

  // Toggle-off keeps the key; the toggle and its write policy behave like the
  // ordinary rows: a held write blocks second presses without dimming.
  await userEvent.press(toggle());
  expect(onToggleSaved).toHaveBeenCalledTimes(1);
  expect(toggleCalls[0]).toEqual({ key: 'rule34', value: false });
  expect(toggle()).toBeDisabled();
  expect(StyleSheet.flatten(toggle().props.style).opacity).toBe(1);
  await userEvent.press(toggle());
  expect(onToggleSaved).toHaveBeenCalledTimes(1);
  await act(async () => { heldToggle.resolve(true); });

  await secondView.rerender(<CredentialProviderRow {...savedProps({ enabled: false })} />);
  // Toggle-off keeps the credential: still the saved layout, no form.
  expect(screen.getByTestId('provider-rule34-credential-clear')).toBeOnTheScreen();
  expect(screen.queryByTestId('provider-rule34-credential-apikey')).toBeNull();

  // An external provider save locks the toggle without ever dimming it.
  await secondView.rerender(<CredentialProviderRow {...savedProps({ enabled: false, busy: true })} />);
  expect(toggle()).toBeDisabled();
  expect(StyleSheet.flatten(toggle().props.style).opacity).toBe(1);
  await userEvent.press(toggle());
  expect(onToggleSaved).toHaveBeenCalledTimes(1);

  // The natural last-source guard disables and dims both controls and swallows
  // their presses.
  await secondView.rerender(<CredentialProviderRow {...savedProps({
    enabled: true, busy: false, enabledProviderCount: 1,
  })} />);
  expect(toggle()).toBeDisabled();
  expect(StyleSheet.flatten(toggle().props.style).opacity).toBe(0.38);
  expect(clear()).toBeDisabled();
  await userEvent.press(toggle());
  await userEvent.press(clear());
  expect(onToggleSaved).toHaveBeenCalledTimes(1);
  expect(onClearCredentialSaved).toHaveBeenCalledTimes(2);
  await secondView.unmount();

  // ---- publication/remount gives the saved state.
  const thirdView = await render(<CredentialProviderRow {...rowProps({
    adapter: adapters.gelbooru, credential: undefined, enabled: false, enabledProviderCount: 8,
    onSaveCredential: jest.fn(async () => true),
  })} />);
  await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-apikey'), 'u2-synthetic-key');
  await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-userid'), '0');
  await userEvent.press(screen.getByTestId('provider-gelbooru-credential-save'));
  await act(async () => {});
  expect(screen.getByTestId('provider-gelbooru-credential-apikey').props.value).toBe('');
  await thirdView.rerender(<CredentialProviderRow {...rowProps({
    adapter: adapters.gelbooru, credential: SYNTHETIC, enabled: true, enabledProviderCount: 8,
  })} />);
  expect(screen.getByTestId('provider-gelbooru-toggle')).toBeOnTheScreen();
  expect(screen.getByTestId('provider-gelbooru-credential-clear')).toBeOnTheScreen();
  expect(screen.queryByTestId('provider-gelbooru-credential-apikey')).toBeNull();
  await thirdView.unmount();

  await render(<CredentialProviderRow {...rowProps({
    adapter: adapters.gelbooru, credential: SYNTHETIC, enabled: true, enabledProviderCount: 8,
  })} />);
  expect(screen.getByTestId('provider-gelbooru-toggle')).toBeOnTheScreen();
  expect(screen.getByTestId('provider-gelbooru-credential-clear')).toBeOnTheScreen();
});

test('U2c2 home keeps only the compatibility re-export; neither file carries the old body', () => {
  const home = readFileSync(resolve(process.cwd(), 'src/screens/settings/settings-screen.tsx'), 'utf8');
  expect(home).toContain('CredentialProviderRow');
  expect(home).toMatch(/export \{ CredentialProviderRow \}/);
  // "leave home body/import" mutant: the old keyed body and its field/credential
  // imports must be gone from home.
  expect(home).not.toContain('SettingRow');
  expect(home).not.toMatch(/credential-(?:apikey|userid|save|clear)/);
  // "old field component" composition guard: the retired legacy field component
  // is deleted outright (ui/single-field-component guard covers the settings screens),
  // so only the forbidden row token is detected here (behavioural pins above are
  // the mutation evidence).
  const row = readFileSync(resolve(process.cwd(), 'src/screens/settings/credential-provider-row.tsx'), 'utf8');
  expect(row).not.toContain('SettingRow');
});
