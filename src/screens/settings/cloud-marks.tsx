import type { ReactElement } from 'react';
import { Cloud, Server } from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';
import type { ByosBinding } from '@/features/byos/byos-credentials';
import { useAppThemeColors } from '@/theme/colors';
import { cloudBrandColors } from '@/theme/cloud-brand-colors';

export const CLOUD_MARK_GEOMETRY = {
  gdrive: {
    viewBox: '0 0 87 78',
    paths: [
      'M43.7 25L29.9 1.1 0 53h27.5z',
      'M43.7 25L57.5 1.1H29.9z',
      'M57.5 1.1L87 53H59.8L43.7 25z',
      'M27.5 53h32.3l13.8 24H13.7z',
      'M59.8 53H87L73.6 77z',
    ],
  },
  onedrive: {
    viewBox: '0 0 32 20',
    paths: ['M12 19h16a4 4 0 0 0 .6-8A8 8 0 0 0 13.4 8 6 6 0 0 0 5 14a5 5 0 0 0 7 5z'],
  },
  cloudflare: {
    viewBox: '0 0 96 64',
    paths: [
      'M32 52L11 52C5.5 52 1 47.5 1 42C1 37 4.7 33 9.5 32.2C10.4 25.3 16.3 20 23.5 20C28.4 20 32.8 22.5 35.3 26.4L32 52Z',
      'M84 52L27 52C19.8 52 14 46.2 14 39C14 32.6 18.6 27.3 24.7 26.2C26.3 17 34.3 10 44 10C52 10 58.9 14.8 61.9 21.7C63.3 21.2 64.9 21 66.5 21C73.7 21 79.6 26.5 80.2 33.5C86.1 34.2 90.5 39.1 90.5 45C90.5 48.9 87.6 52 84 52Z',
    ],
  },
  bunny: {
    viewBox: '0 0 24 24',
    paths: [
      'M9.2 11.2L5.2 3.6C4.7 2.6 5.7 1.6 6.7 2.2L13.6 7.8Z',
      'M12.2 9L7.8 2.4C7.3 1.6 8.3 0.9 9.2 1.5L16.8 7.6C19.6 9.4 21.5 11.8 21.5 14.2C21.5 16.5 19.4 18 16.5 18.2L13.4 22L8 22L10.5 15.6C8.8 14.5 8.5 11.8 12.2 9Z',
      'M16.6 12.6a1.15 1.15 0 1 1-2.3 0a1.15 1.15 0 1 1 2.3 0Z',
    ],
  },
  b2: {
    viewBox: '0 0 24 24',
    paths: [
      'M12.4 1.8C12.4 1.8 19.2 6.8 19.2 13.5C19.2 18.2 15.8 22 11.6 22C7.4 22 4.4 18.7 4.4 14.5C4.4 10.9 6.9 7.8 9.1 6.2C8.5 8.6 9.6 10.5 11.2 11.2C10.1 7.5 11.1 4.1 12.4 1.8Z',
      'M12.2 9.6C12.2 9.6 15.8 12.4 15.8 16C15.8 18.5 13.9 20.4 11.6 20.4C9.3 20.4 7.8 18.6 7.8 16.3C7.8 14 9.8 11.6 12.2 9.6Z',
    ],
  },
  s3Cube: {
    viewBox: '0 0 24 24',
    path: 'M12 2.5L20.5 7.25L20.5 16.75L12 21.5L3.5 16.75L3.5 7.25ZM3.5 7.25L12 12L20.5 7.25M12 12L12 21.5',
  },
  helpCircle: {
    viewBox: '0 0 24 24',
    strokePath:
      'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0ZM9.4 9.2C9.8 7.7 11.4 7 12.8 7.4C14.1 7.8 14.9 9.1 14.4 10.4C14 11.4 12.6 11.9 12.1 12.8C12 13.1 12 13.5 12 13.8',
    dotPath: 'M12 17.1a1.05 1.05 0 1 1 0-2.1a1.05 1.05 0 1 1 0 2.1Z',
  },
} as const;

export type S3BrandKind = 'r2' | 'bunny' | 'b2' | 's3-cube';

export function S3BrandMark({
  brand,
  size = 18,
  color,
  testID,
}: Readonly<{
  brand: S3BrandKind;
  size?: number;
  color?: string;
  testID?: string;
}>): ReactElement {
  const theme = useAppThemeColors();
  if (brand === 'r2') {
    const paths = CLOUD_MARK_GEOMETRY.cloudflare.paths;
    return (
      <Svg
        testID={testID}
        accessible={false}
        width={size * 1.5}
        height={size}
        viewBox={CLOUD_MARK_GEOMETRY.cloudflare.viewBox}>
        <Path d={paths[0]} fill={cloudBrandColors.cloudflareOrangeSoft} />
        <Path d={paths[1]} fill={cloudBrandColors.cloudflareOrange} />
      </Svg>
    );
  }
  if (brand === 'bunny') {
    const paths = CLOUD_MARK_GEOMETRY.bunny.paths;
    return (
      <Svg
        testID={testID}
        accessible={false}
        width={size}
        height={size}
        viewBox={CLOUD_MARK_GEOMETRY.bunny.viewBox}>
        <Path d={paths[0]} fill={cloudBrandColors.bunnyAmber} />
        <Path d={paths[1]} fill={cloudBrandColors.bunnyOrange} />
        <Path d={paths[2]} fill={cloudBrandColors.whiteCutout} />
      </Svg>
    );
  }
  if (brand === 'b2') {
    const paths = CLOUD_MARK_GEOMETRY.b2.paths;
    return (
      <Svg
        testID={testID}
        accessible={false}
        width={size}
        height={size}
        viewBox={CLOUD_MARK_GEOMETRY.b2.viewBox}>
        <Path d={paths[0]} fill={cloudBrandColors.backblazeRed} />
        <Path d={paths[1]} fill={cloudBrandColors.backblazeFlameInner} />
      </Svg>
    );
  }
  const strokeColor = color ?? theme.text;
  return (
    <Svg
      testID={testID}
      accessible={false}
      width={size}
      height={size}
      viewBox={CLOUD_MARK_GEOMETRY.s3Cube.viewBox}>
      <Path
        d={CLOUD_MARK_GEOMETRY.s3Cube.path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function StorageHelpCircleMark({
  size = 15,
  color,
  testID,
}: Readonly<{
  size?: number;
  color: string;
  testID?: string;
}>): ReactElement {
  return (
    <Svg
      testID={testID}
      accessible={false}
      width={size}
      height={size}
      viewBox={CLOUD_MARK_GEOMETRY.helpCircle.viewBox}>
      <Path
        d={CLOUD_MARK_GEOMETRY.helpCircle.strokePath}
        fill="none"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d={CLOUD_MARK_GEOMETRY.helpCircle.dotPath} fill={color} />
    </Svg>
  );
}

export type CloudMarkProps = Readonly<{
  kind: ByosBinding['kind'] | null;
  label?: string | null;
  size?: number;
  testID?: string;
}>;

export function CloudMark({ kind, label, size = 28, testID }: CloudMarkProps): ReactElement {
  const theme = useAppThemeColors();
  if (kind === 'gdrive') {
    const paths = CLOUD_MARK_GEOMETRY.gdrive.paths;
    return (
      <Svg testID={testID} accessible={false} width={size * 87 / 78} height={size} viewBox={CLOUD_MARK_GEOMETRY.gdrive.viewBox}>
        <Path d={paths[0]} fill={cloudBrandColors.googleGreen} />
        <Path d={paths[1]} fill={cloudBrandColors.googleYellow} />
        <Path d={paths[2]} fill={cloudBrandColors.googleYellow} />
        <Path d={paths[3]} fill={cloudBrandColors.googleBlue} />
        <Path d={paths[4]} fill={cloudBrandColors.googleRed} />
      </Svg>
    );
  }
  if (kind === 'onedrive') {
    return (
      <Svg testID={testID} accessible={false} width={size * 1.6} height={size} viewBox={CLOUD_MARK_GEOMETRY.onedrive.viewBox}>
        <Path d={CLOUD_MARK_GEOMETRY.onedrive.paths[0]} fill={cloudBrandColors.microsoftBlue} />
      </Svg>
    );
  }
  if (kind === 'webdav') return <Server testID={testID} accessible={false} size={size} color={theme.text} />;
  if (kind === 's3' && label === 'Bunny.net') {
    return <S3BrandMark brand="bunny" size={size} testID={testID} />;
  }
  if (kind === 's3' && label === 'Backblaze B2') {
    return <S3BrandMark brand="b2" size={size} testID={testID} />;
  }
  return <Cloud testID={testID} accessible={false} size={size} color={theme.cloud} />;
}
