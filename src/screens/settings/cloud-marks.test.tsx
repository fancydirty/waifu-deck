import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react-native';
import { Cloud, Server } from 'lucide-react-native';
import { cloudBrandColors } from '@/theme/cloud-brand-colors';
import { lightColors } from '@/theme/colors';
import frozen from '@/test/cloud-mark-drawings.json';
import { CloudMark, S3BrandMark, StorageHelpCircleMark } from './cloud-marks';

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Cloud: jest.fn((props) => React.createElement(View, props)), Server: jest.fn((props) => React.createElement(View, props)) };
});

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: (props: Record<string, unknown>) => React.createElement(View, props), Path: (props: Record<string, unknown>) => React.createElement(View, props) };
});

for (const kind of ['gdrive', 'onedrive'] as const) {
  test.each([24, 28])(`${kind} chosen drawing matches independent geometry/palette at size %s`, async (size) => {
    const record = frozen[kind];
    const hashInput = kind === 'gdrive' ? record.paths.map((d) => `${d}\n`).join('') : record.paths[0];
    expect(createHash('sha256').update(hashInput).digest('hex')).toBe(record.pathSha256);
    await render(<CloudMark kind={kind} size={size} testID="mark" />);
    const svg = screen.getByTestId('mark');
    expect(svg.props.viewBox).toBe(record.viewBox);
    expect(svg.props.accessible).toBe(false);
    const [, , width, height] = record.viewBox.split(' ').map(Number);
    expect(svg.props.width / svg.props.height).toBeCloseTo(width / height);
    const paths = screen.container.queryAll((node) => typeof node.props.d === 'string');
    expect(paths.map((p) => p.props.d)).toEqual(record.paths);
    expect(paths.map((p) => p.props.fill)).toEqual(record.fills);
    record.paletteKeys.forEach((key, i) => expect(cloudBrandColors[key as keyof typeof cloudBrandColors]).toBe(record.fills[i]));
  });
}
test.each(['s3', null, 'webdav'] as const)('lucide %s uses its semantic theme tint', async (kind) => {
  jest.mocked(Cloud).mockClear(); jest.mocked(Server).mockClear();
  await render(<CloudMark kind={kind} testID="mark" />);
  const chosen = kind === 'webdav' ? Server : Cloud;
  expect(chosen).toHaveBeenCalledWith(expect.objectContaining({ accessible: false, size: 28, color: kind === 'webdav' ? lightColors.text : lightColors.cloud }), undefined);
});
test('S3BrandMark, StorageHelpCircleMark, and CloudMark render Bunny.net, Backblaze B2, Cloudflare R2, and S3 cube vector paths', async () => {
  await render(<CloudMark kind="s3" label="Bunny.net" testID="bunny-mark" />);
  expect(screen.getByTestId('bunny-mark').props.viewBox).toBe('0 0 24 24');
  await render(<CloudMark kind="s3" label="Backblaze B2" testID="b2-mark" />);
  expect(screen.getByTestId('b2-mark').props.viewBox).toBe('0 0 24 24');
  await render(<S3BrandMark brand="r2" testID="r2-mark" />);
  expect(screen.getByTestId('r2-mark').props.viewBox).toBe('0 0 96 64');
  await render(<S3BrandMark brand="s3-cube" testID="s3-cube-mark" />);
  expect(screen.getByTestId('s3-cube-mark').props.viewBox).toBe('0 0 24 24');
  await render(<StorageHelpCircleMark color={lightColors.saveDeep} testID="help-mark" />);
  expect(screen.getByTestId('help-mark').props.viewBox).toBe('0 0 24 24');
});
test('SVG fills reference brand tokens; no inline brand literals or remote/raster asset', () => {
  const source = readFileSync(path.join(__dirname, 'cloud-marks.tsx'), 'utf8');
  expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}|https?:\/\/|\bImage\b/);
  expect(source.match(/fill=\{cloudBrandColors\.\w+\}/g)).toHaveLength(13);
});
