import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet } from 'react-native';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';
import { SectionHeading } from './section-heading';

test.each(['light', 'dark'] as const)('%s section heading matches the new group label language', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<SectionHeading>Discover</SectionHeading>);
  const heading = screen.getByText('Discover');
  const style = StyleSheet.flatten(heading.props.style);
  expect(heading).toHaveStyle({
    ...settingsTypography.groupLabel,
    color: colors[scheme].textSecondary,
    paddingHorizontal: metrics.settingsGutter + 6,
    paddingTop: 20,
    paddingBottom: 8,
  });
  expect(style.textTransform).toBeUndefined();
  expect(style.letterSpacing).toBe(0.72);
  expect(style.paddingHorizontal).toBe(20);
});

test('section heading source uses tokens and no inline colour or font literals', () => {
  const source = readFileSync(join(__dirname, 'section-heading.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain('settingsTypography.groupLabel');
  expect(source).toContain('metrics.settingsGutter + 6');
  expect(source).not.toContain('metrics.contentPadding');
});

test('an optional style is applied after the default heading geometry', async () => {
  await render(<SectionHeading style={{ paddingTop: 8 }}>Sources</SectionHeading>);
  expect(screen.getByText('Sources')).toHaveStyle({ paddingTop: 8, paddingBottom: 8, paddingHorizontal: 20 });
});
