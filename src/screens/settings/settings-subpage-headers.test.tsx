import { renderRouter, screen } from 'expo-router/testing-library';
import { Text } from 'react-native';
import * as ReactNative from 'react-native';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import RootLayout from '@/app/_layout';
import i18n from '@/i18n';
import { colors } from '@/theme/colors';
import { fontFamilies, settingsTypography } from '@/theme/typography';

jest.mock('@/providers/app-services', () => ({
  ...jest.requireActual('@/providers/app-services'),
  AppServicesProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/screens/settings/byos-settings-slot', () => ({
  ByosCloudLibraryProvider: ({ children }: { children: ReactNode }) => children,
}));

const routeCases = [
  ['settings/discover', 'settings.discover.title', '/settings/discover'],
  ['settings/reset', 'settings.reset.title', '/settings/reset'],
  ['settings/sources', 'settings.sources.title', '/settings/sources'],
] as const;

function routeBody({ label }: { label: string }) {
  return <Text testID={`body-${label}`}>{label}</Text>;
}

const headerCases = (['light', 'dark'] as const).flatMap((scheme) =>
  (['zh-Hans', 'zh-Hant', 'ja', 'en'] as const).flatMap((locale) =>
    routeCases.map(([routeName, titleKey, url]) => [scheme, locale, routeName, titleKey, url] as const)));

test.each(headerCases)('%s %s native %s header uses the page palette', async (scheme, locale, routeName, titleKey, url) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await i18n.changeLanguage(locale);
  const result = renderRouter({
        _layout: RootLayout,
        '(tabs)/_layout': () => null,
        '(tabs)/index': () => null,
        '(tabs)/search': () => null,
        '(tabs)/collection': () => null,
        '(tabs)/settings': () => null,
        'image/[id]': () => null,
        'library/trash': () => null,
        'settings/cloud': () => null,
        'settings/discover': () => routeName === 'settings/discover' ? routeBody({ label: routeName }) : null,
        'settings/reset': () => routeName === 'settings/reset' ? routeBody({ label: routeName }) : null,
        'settings/sources': () => routeName === 'settings/sources' ? routeBody({ label: routeName }) : null,
      }, { initialUrl: url });
  await result;

  const title = i18n.t(titleKey);
  const headers = screen.container.queryAll((node) => node.type === 'RNSScreenStackHeaderConfig' && node.props.title === title);
  expect(headers).toHaveLength(1);
  expect(headers[0].props.backgroundColor).toBe(colors[scheme].surface);
  expect(headers[0].props.color).toBe(colors[scheme].text);
  expect(headers[0].props.titleFontFamily).toBe(fontFamilies.sansHeavy);
  expect(headers[0].props.titleFontSize).toBe(settingsTypography.subpageHeader.fontSize);
  expect(headers[0].props.hideShadow).toBe(true);
  expect(screen.getByTestId(`body-${routeName}`)).toBeOnTheScreen();
  expect(screen.container.queryAll((node) => node.type === 'RNSScreenStackHeaderConfig')).toHaveLength(1);
});

test('header options cover every settings sub-page route', async () => {
  const source = readFileSync(resolve(process.cwd(), 'src/app/_layout.tsx'), 'utf8');
  expect(source).toContain('const u2SubpageOptions');
  expect(source).toContain('ThemeProvider value={colorScheme === \'dark\' ? appNavigationTheme.dark : appNavigationTheme.light}');
  expect(source).toContain('name="settings/discover"');
  expect(source).toContain('name="settings/reset"');
  expect(source).toContain('name="settings/sources"');
  expect(source).toContain('name="settings/cloud"');
  // N7 acceptance (owner, 2026-10-13): the cloud page's nav was the last
  // old-style header — every settings sub-page shares the unified options.
  expect(source.match(/\.\.\.u2SubpageOptions/g)).toHaveLength(4);
  // The flash fix: the options carry a native content background, not just header styling.
  expect(source).toContain('contentStyle: { backgroundColor: theme.surface }');
  expect(source).not.toMatch(/<Stack[^>]*screenOptions=\{[^}]*u2HeaderOptions/);
  expect(source).not.toContain('screenOptions={{ ...u2HeaderOptions');
});
