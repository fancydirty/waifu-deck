import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { Text } from 'react-native';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';
import { SettingsBlock } from './settings-block';

test.each(['light', 'dark'] as const)('%s block uses the exact padding and title gap', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<SettingsBlock title="Storage" testID="block"><Text testID="child">Content</Text></SettingsBlock>);
  expect(screen.getByTestId('block')).toHaveStyle({ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 });
  expect(screen.getByText('Storage')).toHaveStyle({ ...settingsTypography.rowTitle, color: colors[scheme].text, marginBottom: metrics.settingsBlockTitleGap });
});

test('block without a title does not render an extra host node', async () => {
  await render(<SettingsBlock testID="block"><Text testID="child">Content</Text></SettingsBlock>);
  const block = screen.getByTestId('block');
  const child = screen.getByTestId('child');
  const hostChildren = block.children.filter((node) => typeof node !== 'string');
  expect(hostChildren).toHaveLength(1);
  expect(hostChildren[0]).toBe(child);
  expect(screen.queryByText('undefined')).toBeNull();
});

test('block source uses tokenized title styling and no inline colour, font or radius literals', () => {
  const source = readFileSync(join(__dirname, 'settings-block.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain('settingsTypography.rowTitle');
  expect(source).toContain('metrics.settingsBlockTitleGap');
});
