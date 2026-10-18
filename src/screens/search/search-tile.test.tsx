/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { SearchHit } from '@/features/search/types';
import i18n from '@/i18n';
import { SearchTile } from '@/screens/search/search-tile';

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans');
});

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => <View {...props} /> };
});

jest.mock('lucide-react-native', () => ({
  EyeOff: () => null,
  Heart: () => null,
}));

function hit(overrides: Partial<SearchHit['image']> = {}): SearchHit {
  return {
    key: 'waifu_im:7',
    previewUrl: 'https://preview.example.com/7.jpg',
    image: {
      providerKey: 'waifu_im',
      providerItemId: '7',
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: 'https://cdn.example.com/7.jpg',
      sourceUrl: 'https://source.example.com/7',
      artistName: 'Artist 7',
      artistUrl: null,
      width: 900,
      height: 1200,
      byteSize: 500_000,
      extension: 'jpg',
      dominantColor: '#726A7D',
      isNsfw: false,
      isAnimated: false,
      tags: ['waifu'],
      ...overrides,
    },
  };
}

test('renders a stable square preview with cover and recycling identity', async () => {
  await render(
    <SearchTile
      hit={hit()}
      isFavorite={false}
      blurNsfwThumbnail
      onPress={jest.fn()}
    />,
  );

  const tile = screen.getByRole('button');
  const image = screen.getByLabelText('搜索缩略图 waifu_im:7');
  expect(tile).toHaveStyle({ width: '100%', aspectRatio: 1 });
  expect(image.props.source).toEqual({ uri: 'https://preview.example.com/7.jpg' });
  expect(image.props.contentFit).toBe('cover');
  expect(image.props.recyclingKey).toBe(JSON.stringify(['waifu_im:7', 0]));
});

test('retries a failed tile load with bounded backoff instead of a colour block', async () => {
  jest.useFakeTimers();
  try {
    await render(
      <SearchTile
        hit={hit()}
        isFavorite={false}
        blurNsfwThumbnail={false}
        onPress={jest.fn()}
      />,
    );

    const tileImage = () => screen.getByLabelText('搜索缩略图 waifu_im:7');
    const keyForAttempt = (attempt: number) =>
      JSON.stringify(['waifu_im:7', attempt]);
    expect(tileImage().props.recyclingKey).toBe(keyForAttempt(0));

    await act(async () => {
      (tileImage().props.onError as () => void)();
    });
    // Scheduled, not immediate: a stalled CDN must not trigger a reload storm.
    expect(tileImage().props.recyclingKey).toBe(keyForAttempt(0));

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(tileImage().props.recyclingKey).toBe(keyForAttempt(1));

    await act(async () => {
      (tileImage().props.onError as () => void)();
      jest.advanceTimersByTime(3_000);
    });
    expect(tileImage().props.recyclingKey).toBe(keyForAttempt(2));

    await act(async () => {
      (tileImage().props.onError as () => void)();
      jest.advanceTimersByTime(8_000);
    });
    expect(tileImage().props.recyclingKey).toBe(keyForAttempt(3));

    // Bounded: a fourth failure never reloads again.
    await act(async () => {
      (tileImage().props.onError as () => void)();
      jest.advanceTimersByTime(60_000);
    });
    expect(tileImage().props.recyclingKey).toBe(keyForAttempt(3));
  } finally {
    jest.useRealTimers();
  }
});

test('shows provider and favorite state with an accessible tile label', async () => {
  const onPress = jest.fn();
  await render(
    <SearchTile
      hit={hit({ providerKey: 'danbooru' })}
      isFavorite
      blurNsfwThumbnail={false}
      onPress={onPress}
    />,
  );

  const tile = screen.getByRole('button', {
    name: '搜索结果，Danbooru，普通内容，已收藏',
  });
  expect(tile.props.accessibilityState).toEqual({ selected: true });
  expect(screen.getByLabelText('已收藏')).toBeOnTheScreen();
  expect(screen.getByText('Danbooru')).toBeOnTheScreen();

  await fireEvent.press(tile);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('blurs only configured NSFW thumbnails', async () => {
  const nsfwHit = hit({ isNsfw: true });
  const { rerender } = await render(
    <SearchTile
      hit={nsfwHit}
      isFavorite={false}
      blurNsfwThumbnail
      onPress={jest.fn()}
    />,
  );

  expect(screen.getByLabelText('搜索缩略图 waifu_im:7').props.blurRadius).toBe(24);
  expect(screen.queryByText('敏感内容')).not.toBeOnTheScreen();

  await rerender(
    <SearchTile
      hit={nsfwHit}
      isFavorite={false}
      blurNsfwThumbnail={false}
      onPress={jest.fn()}
    />,
  );
  expect(screen.getByLabelText('搜索缩略图 waifu_im:7').props.blurRadius).toBe(0);
});

test('R8.28: a gelbooru preview carries the provider Referer', async () => {
  // Search returned Gelbooru hits but every tile stayed on its dominant colour:
  // img*.gelbooru.com 302s a Referer-less request to hotlink.php (HTML).
  await render(
    <SearchTile
      hit={{
        ...hit({ providerKey: 'gelbooru' }),
        key: 'gelbooru:7',
        previewUrl: 'https://img4.gelbooru.com/samples/a/b/sample_7.jpg',
      }}
      isFavorite={false}
      blurNsfwThumbnail
      onPress={jest.fn()}
    />,
  );

  expect(screen.getByLabelText('搜索缩略图 gelbooru:7').props.source).toEqual({
    uri: 'https://img4.gelbooru.com/samples/a/b/sample_7.jpg',
    headers: { Referer: 'https://gelbooru.com/' },
  });
});

test('R8.28: a headerless provider preview keeps a bare { uri } source', async () => {
  await render(
    <SearchTile
      hit={hit({ providerKey: 'danbooru' })}
      isFavorite={false}
      blurNsfwThumbnail
      onPress={jest.fn()}
    />,
  );

  const source = screen.getByLabelText('搜索缩略图 waifu_im:7').props.source;
  expect(source).toEqual({ uri: 'https://preview.example.com/7.jpg' });
  expect(Object.keys(source)).toEqual(['uri']);
});

test('A1: an NSFW animated search hit is covered and not autoplayed while blur is on', async () => {
  // Same Glide limitation as the collection tile: blurRadius never reached an
  // animated drawable, so the cover is the only honest blur for a gif. N10
  // (owner ruling 2026-10-13: keep the blur, fix the engine): static hits keep
  // their blur — the engine is NoRsBlurTransformation
  // (patches/expo-image*.patch), no RenderScript, so it is safe on Android 16.
  await render(
    <SearchTile
      hit={hit({ isNsfw: true, isAnimated: true })}
      isFavorite={false}
      blurNsfwThumbnail
      onPress={jest.fn()}
    />,
  );
  expect(screen.getByTestId('search-tile-cover-waifu_im:7')).toBeOnTheScreen();
  expect(screen.getByLabelText('搜索缩略图 waifu_im:7').props.autoplay).toBe(false);

  await render(
    <SearchTile
      hit={hit({ isNsfw: true, isAnimated: false })}
      isFavorite={false}
      blurNsfwThumbnail
      onPress={jest.fn()}
    />,
  );
  expect(screen.queryByTestId('search-tile-cover-waifu_im:7')).toBeNull();
});
