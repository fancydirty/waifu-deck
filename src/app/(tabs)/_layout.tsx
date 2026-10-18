import { Tabs } from 'expo-router';
import {
  Images,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react-native';

import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';

export default function TabsLayout() {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  return (
    <Tabs
      screenOptions={{
        // R8.17 (owner 2026-09-08): no headers on ANY tab — the swipe deck
        // owns its full screen and the other three surfaces self-identify
        // by icon+position. Uniform chrome across all four tabs.
        headerShown: false,
        tabBarActiveTintColor: theme.save,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarShowLabel: true,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
        // R8.17: a REAL floating bar — absolutely positioned, detached from
        // layout flow. The old "floating look while staying in flow" style
        // claimed it never overlapped content, but the bar's 64px height +
        // margins exceeded what react-navigation budgeted, which is exactly
        // how the like/dislike buttons ended up underneath it. Every surface
        // now reserves for it via the shared geometry module
        // (src/theme/tab-bar-geometry.ts) instead of guessing.
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: theme.surfaceSecondary,
          borderTopWidth: 0,
          borderRadius: 26,
          marginHorizontal: 16,
          marginBottom: 10,
          paddingTop: 6,
          height: 64,
          borderWidth: 1,
          borderColor: theme.border,
          boxShadow: '0 8px 22px rgba(84, 75, 72, 0.14)',
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Waifu Deck',
          tabBarLabel: t('navigation.discover'),
          tabBarAccessibilityLabel: t('navigation.discover'),
          tabBarButtonTestID: 'tab-discover',
          tabBarIcon: ({ color, size }) => <Sparkles color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: t('navigation.search'),
          tabBarAccessibilityLabel: t('navigation.search'),
          tabBarButtonTestID: 'tab-search',
          tabBarIcon: ({ color, size }) => <Search color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="collection"
        options={{
          title: t('navigation.collection'),
          tabBarAccessibilityLabel: t('navigation.collection'),
          tabBarButtonTestID: 'tab-collection',
          tabBarIcon: ({ color, size }) => <Images color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('navigation.settings'),
          tabBarAccessibilityLabel: t('navigation.settings'),
          tabBarButtonTestID: 'tab-settings',
          tabBarIcon: ({ color, size }) => <Settings2 color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
