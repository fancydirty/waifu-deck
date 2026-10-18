/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { forwardRef, useImperativeHandle } from 'react';
import { Alert, Text, View } from 'react-native';

import { IconButton } from '@/components/icon-button';
import type {
  SwipeCardHandle,
  SwipeCardProps,
} from '@/components/swipe-card';
import type { StoredImage } from '@/features/images/image-repository';
import { CollectionView } from '@/screens/collection/collection-screen';
import { CollectionTile } from '@/screens/collection/collection-tile';
import {
  DiscoverView,
  type DiscoverViewModel,
} from '@/screens/discover/discover-screen';

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View: NativeView } = require('react-native');
  return {
    FlashList: ({ data, renderItem, ...props }: any) => (
      <NativeView {...props}>
        {data.map((item: StoredImage, index: number) => (
          <React.Fragment key={item.id}>{renderItem({ item, index })}</React.Fragment>
        ))}
      </NativeView>
    ),
  };
});

jest.mock('expo-image', () => {
  const { View: NativeView } = require('react-native');
  return {
    Image: (props: Record<string, unknown>) => <NativeView {...props} />,
  };
});

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return {
    ArrowDownUp: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ExternalLink: Icon,
    EyeOff: Icon,
    Heart: Icon,
    Layers3: Icon,
    RotateCcw: Icon,
    Search: Icon,
    Trash2: Icon,
    WifiOff: Icon,
    X: Icon,
  };
});

function image(id: number, overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: `https://source.example.com/${id}`,
    artistName: `Artist ${id}`,
    artistUrl: null,
    width: 900,
    height: 1200,
    byteSize: 500_000,
    extension: 'jpg',
    dominantColor: '#726A7D',
    contentRating: 'safe',
    nativeRating: null,
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
    decision: 'saved',
    presentedAt: 1,
    decidedAt: id * 100,
    queueOrdinal: id,
    decisionOrdinal: id,
    localUri: `file:///collection/${id}.jpg`,
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

const TestCard = forwardRef<SwipeCardHandle, SwipeCardProps>(function TestCard(
  { accessibilityLabel },
  ref,
) {
  useImperativeHandle(ref, () => ({ dismiss: () => undefined }));
  return <View aria-label={accessibilityLabel} />;
});

function discoveryModel(overrides: Partial<DiscoverViewModel> = {}): DiscoverViewModel {
  const active = image(1, { decision: 'active', localUri: null });
  return {
    state: { kind: 'ready', deck: { active, queued: [] } },
    isDeciding: false,
    canDecide: true,
    canRewind: false,
    decisionError: null,
    commitDecision: jest.fn().mockReturnValue(true),
    rewind: jest.fn(() => false),
    retry: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('release accessibility contract', () => {
  test('icon commands expose role, label, and explicit disabled state', async () => {
    await render(
      <IconButton label="保存图片" disabled onPress={jest.fn()}>
        <Text>icon</Text>
      </IconButton>,
    );

    const button = screen.getByRole('button', { name: '保存图片' });
    expect(button).toBeDisabled();
    expect(button.props.accessibilityState).toEqual({ disabled: true });
  });

  test('collection tiles name the artist, content rating, and offline state', async () => {
    await render(
      <CollectionTile
        image={image(42, { isNsfw: true, downloadState: 'failed', localUri: null })}
        selected={false}
        selectionMode={false}
        blurNsfwThumbnail
        onOpen={jest.fn()}
        onLongPress={jest.fn()}
        onToggleSelection={jest.fn()}
        onLocalFileMissing={jest.fn()}
      />,
    );

    expect(screen.getByRole('button', {
      name: '收藏图片 42，画师 Artist 42，成人内容，离线文件需修复',
    })).toBeOnTheScreen();
  });

  test('batch destructive confirmation names the affected image count', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(
      <CollectionView
        images={[image(1), image(2)]}
        status="ready"
        errorMessage={null}
        blurNsfwThumbnails
        viewportWidth={390}
        onBrowse={jest.fn()}
        onOpen={jest.fn()}
        onRefresh={jest.fn()}
        onDelete={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    await fireEvent(screen.getByLabelText(/收藏图片 2/), 'longPress');
    await fireEvent.press(screen.getByLabelText(/收藏图片 1/));
    await fireEvent.press(screen.getByRole('button', { name: '删除所选图片' }));

    expect(alert).toHaveBeenCalledWith(
      '删除 2 张图片？',
      expect.stringContaining('永久移除'),
      expect.any(Array),
    );
  });

  test('collection browsing controls expose their active state without a database refresh', async () => {
    await render(
      <CollectionView
        images={[image(1)]}
        status="ready"
        errorMessage={null}
        blurNsfwThumbnails
        viewportWidth={390}
        onBrowse={jest.fn()}
        onOpen={jest.fn()}
        onRefresh={jest.fn()}
        onDelete={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText('搜索收藏')).toBeOnTheScreen();
    expect(screen.getByRole('button', {
      name: '来源：全部',
    }).props.accessibilityState).toEqual({ disabled: false, selected: false });
    expect(screen.getByRole('button', {
      name: '收藏排序，当前为 最新收藏',
    }).props.accessibilityState).toEqual({ disabled: false, selected: false });
  });

  test('large text keeps all three discovery commands reachable', async () => {
    await render(
      <DiscoverView
        viewModel={discoveryModel({ isDeciding: true, canDecide: false, canRewind: true })}
        SwipeCardComponent={TestCard}
        viewport={{ width: 360, height: 640, fontScale: 2 }}
      />,
    );

    expect(screen.getByRole('button', { name: '略过' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '收藏' })).toBeDisabled();
    // Board #24: rewind answers the history, not the card, so it stays a named,
    // enabled command while the card's own commands wait for the pipeline.
    expect(screen.getByRole('button', { name: '回退上一张' })).toBeEnabled();
  });
});
