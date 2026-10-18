import { useColorScheme } from 'react-native';

export const actionColors = {
  dismiss: '#7A736E',
  destructiveText: '#FFFFFF',
  save: '#F0637A',
  warning: '#E89A5C',
  /** K3: "synced to cloud" badge. Cloudflare orange, same in both themes. */
  cloud: '#F38020',
  cloudSoft: 'rgba(243, 128, 32, 0.12)',
  overlay: 'rgba(24, 22, 20, 0.44)',
  scrim: 'rgba(28, 20, 18, 0.60)',
  /** U3b: choice-sheet scrim, mockup v4 §3 (same ink, lighter veil). */
  sheetScrim: 'rgba(28, 20, 18, 0.45)',
} as const;

export const lightColors = {
  surface: '#FDF7F3',
  surfaceSecondary: '#FFFFFF',
  text: '#544B48',
  textSecondary: '#A48A82',
  border: '#F0E2DA',
  hair: '#F5EBE5',
  saveSoft: 'rgba(240, 99, 122, 0.10)',
  saveDeep: '#D94A64',
  danger: '#C73046',
  dangerSoft: 'rgba(199, 48, 70, 0.12)',
  ok: '#3F9A72',
  okSoft: 'rgba(63, 154, 114, 0.12)',
  warnInk: '#B4652A',
  warnSoft: 'rgba(232, 154, 92, 0.15)',
  storageCollection: '#F0637A',
  storagePreview: '#E89A5C',
  controlFill: '#F5EBE5',
  controlSelected: '#FFFFFF',
  switchTrackOff: '#F0E2DA',
  switchThumb: '#FFFFFF',
  toggleShadow: '#000000',
  ...actionColors,
} as const;

export const darkColors = {
  surface: '#1F1F33',
  surfaceSecondary: '#2A2A44',
  text: '#EDEAF2',
  textSecondary: '#8E8AA0',
  border: '#2E2E4A',
  hair: '#282842',
  saveSoft: 'rgba(242, 126, 147, 0.14)',
  saveDeep: '#E5657D',
  danger: '#EF6A74',
  dangerSoft: 'rgba(239, 106, 116, 0.16)',
  ok: '#6CC79B',
  okSoft: 'rgba(108, 199, 155, 0.16)',
  warnInk: '#E0A876',
  warnSoft: 'rgba(224, 168, 118, 0.16)',
  storageCollection: '#F27E93',
  storagePreview: '#E0A876',
  controlFill: '#35355A',
  controlSelected: '#4B4B7A',
  switchTrackOff: '#35355A',
  switchThumb: '#FFFFFF',
  toggleShadow: '#000000',
  ...actionColors,
  save: '#F27E93',
  warning: '#E0A876',
} as const;

export const colors = { light: lightColors, dark: darkColors } as const;

export function useAppThemeColors() {
  return useColorScheme() === 'dark' ? darkColors : lightColors;
}
