import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { SettingsGroup } from './settings-group';

function StatefulChild({ onMount }: { onMount: () => void }) {
  React.useEffect(onMount, [onMount]);
  return <Text testID="stateful-child">C</Text>;
}

test.each(['light', 'dark'] as const)('%s group uses the card tokens and only internal separators', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<SettingsGroup testID="group"><Text>First</Text><Text>Second</Text><Text>Third</Text></SettingsGroup>);
  const group = screen.getByTestId('group');
  expect(group).toHaveStyle({
    backgroundColor: colors[scheme].surfaceSecondary,
    borderWidth: 1,
    borderColor: colors[scheme].border,
    borderRadius: metrics.radius.card,
    overflow: 'hidden',
  });
  const separators = screen.container.queryAll((node) => typeof node.type === 'string'
    && StyleSheet.flatten(node.props.style)?.borderTopWidth === 1);
  expect(separators).toHaveLength(2);
  const bordered = screen.container.queryAll((node) => typeof node.type === 'string'
    && StyleSheet.flatten(node.props.style)?.borderBottomWidth !== undefined);
  expect(bordered).toHaveLength(0);
});

test('group keeps custom style on the outer card', async () => {
  await render(<SettingsGroup testID="group" style={{ marginTop: 4 }}><View /></SettingsGroup>);
  expect(screen.getByTestId('group')).toHaveStyle({ marginTop: 4 });
});

test.each(['light', 'dark'] as const)('%s group filters conditional children and colors each separator', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<SettingsGroup testID="conditional-group">
    <Text>A</Text>{null}{false}<Text>B</Text>{null}<Text>C</Text>
  </SettingsGroup>);
  const separators = screen.container.queryAll((node) => StyleSheet.flatten(node.props.style)?.borderTopWidth === 1);
  expect(separators).toHaveLength(2);
  separators.forEach((separator) => expect(separator).toHaveStyle({ borderTopColor: colors[scheme].hair }));
});

test('group preserves a stateful child when an earlier conditional child disappears', async () => {
  const onMount = jest.fn();
  const tree = (showA: boolean) => <SettingsGroup testID="stable-group">
    {showA ? <Text>A</Text> : null}
    <Text>B</Text>
    <StatefulChild onMount={onMount} />
  </SettingsGroup>;
  const view = await render(tree(true));
  expect(onMount).toHaveBeenCalledTimes(1);
  await view.rerender(tree(false));
  expect(onMount).toHaveBeenCalledTimes(1);
});

test('group source uses tokens and contains no inline colour, font or radius literals', () => {
  const source = readFileSync(join(__dirname, 'settings-group.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain('theme.surfaceSecondary');
  expect(source).toContain('theme.border');
  expect(source).toContain('theme.hair');
  expect(source).toContain('metrics.radius.card');
});
