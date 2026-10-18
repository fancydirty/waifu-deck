import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionColors, colors, darkColors, lightColors } from './colors';
import { appNavigationTheme } from './navigation-theme';

describe('peach palette tokens', () => {
  test('save is pink per PRODUCT.md visual contract', () => {
    expect(actionColors.save).toBe('#F0637A');
    expect(darkColors.save).toBe('#F27E93');
    expect(darkColors.warning).toBe('#E0A876');
  });
  test('dismiss is AA-contrast warm gray per amended spec', () => {
    expect(actionColors.dismiss).toBe('#7A736E');
  });
  test('light is warm paper', () => {
    expect(lightColors.surface).toBe('#FDF7F3');
    expect(lightColors.surfaceSecondary).toBe('#FFFFFF');
    expect(lightColors.text).toBe('#544B48');
    expect(lightColors.textSecondary).toBe('#A48A82');
    expect(lightColors.border).toBe('#F0E2DA');
  });
  test('dark is warm night purple', () => {
    expect(darkColors.surface).toBe('#1F1F33');
    expect(darkColors.surfaceSecondary).toBe('#2A2A44');
    expect(darkColors.text).toBe('#EDEAF2');
    expect(darkColors.textSecondary).toBe('#8E8AA0');
    expect(darkColors.border).toBe('#2E2E4A');
  });
  test('destructive red exists per spec and is outline-only by convention', () => {
    expect(lightColors.danger).toBe('#C73046');
    expect(darkColors.danger).toBe('#EF6A74');
    expect(lightColors.dangerSoft).toBe('rgba(199, 48, 70, 0.12)');
    expect(darkColors.dangerSoft).toBe('rgba(239, 106, 116, 0.16)');
  });
  test('peach extras exist in both themes', () => {
    for (const k of ['hair', 'saveSoft', 'saveDeep', 'danger'] as const) {
      expect(typeof lightColors[k]).toBe('string');
      expect(typeof darkColors[k]).toBe('string');
    }
  });
  test.each([
    ['light', lightColors, { ok: '#3F9A72', okSoft: 'rgba(63, 154, 114, 0.12)', warnInk: '#B4652A', warnSoft: 'rgba(232, 154, 92, 0.15)' }],
    ['dark', darkColors, { ok: '#6CC79B', okSoft: 'rgba(108, 199, 155, 0.16)', warnInk: '#E0A876', warnSoft: 'rgba(224, 168, 118, 0.16)' }],
  ])('%s has the background-upload status tokens', (_name, theme, expected) => {
    expect(theme).toMatchObject(expected);
  });
  test.each([
    ['light', lightColors, '#F0637A', '#E89A5C'],
    ['dark', darkColors, '#F27E93', '#E0A876'],
  ] as const)('%s storage roles match the approved meter colours', (_name, theme, collection, preview) => {
    expect(theme).toHaveProperty('storageCollection', collection);
    expect(theme).toHaveProperty('storagePreview', preview);
  });
  test('role parity between themes and map intact', () => {
    for (const k of Object.keys(lightColors)) {
      expect(darkColors).toHaveProperty(k);
    }
    expect(colors.light).toBe(lightColors);
    expect(colors.dark).toBe(darkColors);
  });

  test('both themes expose the control and toggle tokens with exact values', () => {
    expect(lightColors).toMatchObject({
      controlFill: '#F5EBE5',
      controlSelected: '#FFFFFF',
      switchTrackOff: '#F0E2DA',
      switchThumb: '#FFFFFF',
      toggleShadow: '#000000',
      cloudSoft: 'rgba(243, 128, 32, 0.12)',
    });
    expect(darkColors).toMatchObject({
      controlFill: '#35355A',
      controlSelected: '#4B4B7A',
      switchTrackOff: '#35355A',
      switchThumb: '#FFFFFF',
      toggleShadow: '#000000',
      cloudSoft: 'rgba(243, 128, 32, 0.12)',
    });
    expect(lightColors.cloudSoft).toBe(darkColors.cloudSoft);
  });

  test('U3b sheet scrim is the v4 §3 scrim in both themes', () => {
    expect(actionColors.sheetScrim).toBe('rgba(28, 20, 18, 0.45)');
    expect(lightColors.sheetScrim).toBe('rgba(28, 20, 18, 0.45)');
    expect(darkColors.sheetScrim).toBe('rgba(28, 20, 18, 0.45)');
  });

  test('new token entries stay literal inside the theme objects', () => {
    const source = readFileSync(join(__dirname, 'colors.ts'), 'utf8');
    expect(source).toContain("cloudSoft: 'rgba(243, 128, 32, 0.12)'");
    expect(source).toContain("controlFill: '#F5EBE5'");
    expect(source).toContain("controlFill: '#35355A'");
    expect(source).toMatch(/export const (?:lightColors|darkColors) = \{[\s\S]*\} as const;/);
  });
});

describe('navigation theme', () => {
  test('the stack container never flashes the library default grey', () => {
    // react-navigation's DefaultTheme background is rgb(242,242,242). The
    // native stack paints it behind every screen (`nativeContainerStyle`), and
    // the detail route is black — pushing it showed ~2 frames of that grey
    // before the card covered the container (owner report 2026-09-17:
    // "点击某张图片会首先闪纯色背景一瞬间再是图片本身").
    expect(appNavigationTheme.light.colors.background).not.toBe('rgb(242, 242, 242)');
    expect(appNavigationTheme.dark.colors.background).not.toBe('rgb(242, 242, 242)');
  });

  test('the container gap frame matches the pages around it (N7 flash fix)', () => {
    // A pushed card's JS tree mounts a frame after the navigation commits, so
    // the container shows through in between (owner report 2026-10-13:
    // 「中间会闪烁，跳一下」 entering 云库 — a full-screen black frame caught in
    // a 60 fps recording). The container is therefore each theme's own
    // surface: the gap frame reads as part of the surrounding pages instead
    // of a foreign colour, and the detail viewer's black card still enters
    // from surface pages with no foreign frame of its own.
    expect(appNavigationTheme.light.colors.background).toBe(lightColors.surface);
    expect(appNavigationTheme.dark.colors.background).toBe(darkColors.surface);
  });

  test('the library palette is otherwise preserved', () => {
    expect(appNavigationTheme.light.dark).toBe(false);
    expect(appNavigationTheme.dark.dark).toBe(true);
    expect(appNavigationTheme.light.colors.card).toBe('rgb(255, 255, 255)');
    expect(appNavigationTheme.dark.colors.card).toBe('rgb(18, 18, 18)');
  });
});
