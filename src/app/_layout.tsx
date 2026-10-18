import { QueryClientProvider } from '@tanstack/react-query';
import { Nunito_600SemiBold } from '@expo-google-fonts/nunito/600SemiBold';
import { Nunito_700Bold } from '@expo-google-fonts/nunito/700Bold';
import { Nunito_800ExtraBold } from '@expo-google-fonts/nunito/800ExtraBold';
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import { router, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { appNavigationTheme } from '@/theme/navigation-theme';
import { useAppThemeColors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';
import { StatusBar } from 'expo-status-bar';

import {
  AppServicesProvider,
  createAppQueryClient,
} from '@/providers/app-services';
import { discoveryRoundTrace } from '@/features/discovery/discovery-round-trace';
import { defineLibraryBackgroundTask } from '@/features/library/library-background-sync-entry';
import { AppUpdateHost } from '@/features/update/app-update-host';
import { ByosCloudLibraryProvider } from '@/screens/settings/byos-settings-slot';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

// Dev builds narrate each refill's per-provider rounds to logcat so the §6.5
// device gate can attribute a zero (never asked / failed / honestly empty /
// deduped) instead of guessing. Off everywhere else — see the module doc.
if (__DEV__) discoveryRoundTrace.enabled = true;

// K4 §4.5: `TaskManager.defineTask` must run in the module's global scope,
// not inside a component — a background wakeup spins up the JS app with no
// views mounted. The Store `.store.ts` shadow of the entry module is a no-op.
defineLibraryBackgroundTask();

export const rootStackScreenOptions = {
  animation: 'none' as const,
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const theme = useAppThemeColors();
  const [queryClient] = useState(createAppQueryClient);
  const { t } = useAppTranslation();
  // U2 header + N7 flash fix: every settings sub-page carries the unified
  // header AND a native content background. The stack container is each
  // theme's surface (theme/navigation-theme.ts), so the card's first
  // mount frame already reads as the page around it — contentStyle keeps
  // that true per route even if a future page paints differently.
  const u2SubpageOptions = {
    headerStyle: { backgroundColor: theme.surface },
    headerTintColor: theme.text,
    headerTitleStyle: settingsTypography.subpageHeader,
    headerShadowVisible: false,
    contentStyle: { backgroundColor: theme.surface },
  } as const;
  const [fontsLoaded] = useFonts({
    Nunito_600SemiBold,
    Nunito_700Bold,
    Nunito_800ExtraBold,
    IBMPlexMono_500Medium,
  });

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync().catch(() => undefined);
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* N8: the icons follow the system scheme — the transparent status bar
          drew white icons over the light settings pages. The detail viewer
          overrides with its own always-light bar (it is black in both modes). */}
      <StatusBar style="auto" />
      <ThemeProvider value={colorScheme === 'dark' ? appNavigationTheme.dark : appNavigationTheme.light}>
        <QueryClientProvider client={queryClient}>
          <AppServicesProvider>
            <ByosCloudLibraryProvider>
              <AppUpdateHost>
                <Stack screenOptions={rootStackScreenOptions}>
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen
                    name="image/[id]"
                    listeners={{
                      beforeRemove: (event) => {
                        if (event.data.action.type !== 'GO_BACK' && event.data.action.type !== 'POP') {
                          return;
                        }

                        event.preventDefault();
                        router.dismissTo('/collection');
                      },
                    }}
                    options={{
                      title: t('navigation.imageDetail'),
                      headerShown: false,
                      presentation: 'card',
                      contentStyle: { backgroundColor: '#000000' },
                    }}
                  />
                  <Stack.Screen
                    name="image/import/[sha256]"
                    listeners={{
                      beforeRemove: (event) => {
                        if (event.data.action.type !== 'GO_BACK' && event.data.action.type !== 'POP') {
                          return;
                        }

                        event.preventDefault();
                        router.dismissTo('/collection');
                      },
                    }}
                    options={{
                      title: t('navigation.imageDetail'),
                      headerShown: false,
                      presentation: 'card',
                      contentStyle: { backgroundColor: '#000000' },
                    }}
                  />
                  <Stack.Screen
                    name="library/trash"
                    options={{
                      title: t('libraryTrash.title'),
                      presentation: 'card',
                      contentStyle: { backgroundColor: theme.surfaceSecondary },
                    }}
                  />
                  <Stack.Screen
                    name="settings/sources"
                    options={{ ...u2SubpageOptions, title: t('settings.sources.title'), presentation: 'card' }}
                  />
                  <Stack.Screen
                    name="settings/cloud"
                    options={{ ...u2SubpageOptions, title: t('settings.byos.heading'), presentation: 'card' }}
                  />
                  <Stack.Screen
                    name="settings/discover"
                    options={{ ...u2SubpageOptions, title: t('settings.discover.title'), presentation: 'card' }}
                  />
                  <Stack.Screen
                    name="settings/reset"
                    options={{ ...u2SubpageOptions, title: t('settings.reset.title'), presentation: 'card' }}
                  />
                </Stack>
              </AppUpdateHost>
            </ByosCloudLibraryProvider>
          </AppServicesProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
