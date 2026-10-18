import { render, screen } from '@testing-library/react-native';
import type { SharedValue } from 'react-native-reanimated';

import { SwipeCard } from '@/components/swipe-card';
import type { WaifuImage } from '@/features/waifu/types';

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { Heart: Icon, X: Icon };
});

const card = {
  id: 'x1',
  remoteUrl: 'https://example.test/a.jpg',
  providerKey: 'danbooru',
  width: 3840,
  height: 5120,
  artistName: 'artist_name',
  sourceUrl: null,
} as unknown as WaifuImage;

const fakeShared = {
  value: 0,
  addListener: () => () => undefined,
  removeListener: () => undefined,
} as unknown as SharedValue<number>;

async function renderCard(peekProgress?: SharedValue<number>) {
  return render(
    <SwipeCard
      card={card}
      cardWidth={320}
      cardHeight={480}
      onCommit={async () => true}
      onExitComplete={() => undefined}
      peekProgress={peekProgress}
    />,
  );
}

describe('SwipeCard peach peek contract', () => {
  test('renders with optional peekProgress shared value prop', async () => {
    await renderCard(fakeShared);
    expect(screen.toJSON()).not.toBeNull();
  });

  test('stamps are symbol-only: the card renders no text nodes', async () => {
    await renderCard();
    // Badge labels (略过/收藏) and the caption (artist/dimensions/来源) are
    // removed per peach spec §3.1 default state: the card carries no copy.
    expect(screen.queryByText(/.+/, { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByText('略过')).toBeNull();
    expect(screen.queryByText('收藏')).toBeNull();
    expect(screen.queryByText('artist_name')).toBeNull();
    expect(screen.queryByText(/3840/)).toBeNull();
  });
});
