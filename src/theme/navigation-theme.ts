import { DarkTheme, DefaultTheme } from 'expo-router';

/**
 * The app's navigation themes.
 *
 * react-navigation's `DefaultTheme.colors.background` is `rgb(242, 242, 242)`
 * and the native stack paints it as `nativeContainerStyle` behind EVERY screen
 * (`NativeStackView.native.js`: `nativeContainerStyle: { backgroundColor:
 * colors.background }`). The app's screens are opaque, but the detail route is
 * a black card pushed over the container (and `image/[id]` explicitly sets
 * `contentStyle: { backgroundColor: '#000000' }`), so during the push the
 * library grey showed through for ~2 frames before the card covered it.
 *
 * Measured 2026-09-17 on the owner's phone (60 fps screen recording, frame
 * deltas of the image area): the viewer sequence was grid → 2 frames of a
 * *single* flat colour `rgb(242, 242, 242)` (`#F2F2F2`, = DefaultTheme's
 * background - the frames contained 5 unique colours total) → the image. The
 * owner reported it as "点击某张图片会首先闪纯色背景一瞬间再是图片本身".
 *
 * (2026-10-13, N7: the container is no longer solid ink — see the rule
 * below. The grey-flash fix's real invariant survives as the guard test in
 * src/theme/colors.test.ts: the container gap frame must match the pages
 * around it, which the grey violated then and the foreign black violated
 * now.)
 */
// N7 flash fix (owner report 2026-10-13): the container is theme-following
// surface now, not ink. The black container still shows for a frame or two
// while a pushed card's JS tree mounts (contentStyle paints no earlier), and
// between two light screens that black frame was the reported flash. With a
// surface container the gap reads as part of the surrounding pages; the dark
// theme's surface keeps the same property there. The detail viewer's own
// black card needs no container support: entry is from surface pages, so the
// gap frame matches what was on screen either way.
import { darkColors, lightColors } from '@/theme/colors';

export const appNavigationTheme = {
  light: {
    ...DefaultTheme,
    colors: { ...DefaultTheme.colors, background: lightColors.surface },
  },
  dark: {
    ...DarkTheme,
    colors: { ...DarkTheme.colors, background: darkColors.surface },
  },
} as const;
