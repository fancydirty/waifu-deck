import { fireEvent, render, screen } from '@testing-library/react-native';

import type { WaifuImage } from '@/features/waifu/types';
import { PeekInfoLayer } from '@/screens/discover/peek-info-layer';

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { ExternalLink: Icon };
});

const card = {
  id: 1,
  remoteUrl: 'https://example.test/a.jpg',
  providerKey: 'danbooru',
  width: 3840,
  height: 5120,
  artistName: 'artist_name',
  sourceUrl: null,
} as unknown as WaifuImage;

describe('PeekInfoLayer', () => {
  test('renders artist and dimensions rows', async () => {
    await render(<PeekInfoLayer card={card} onOpenSource={undefined} />);

    expect(screen.getByLabelText('图片元数据')).toBeOnTheScreen();
    expect(screen.getByText('artist_name')).toBeOnTheScreen();
    expect(screen.getByText(/3840 x 5120/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '查看来源' })).toBeNull();
  });

  test('falls back to the unknown-artist copy when artistName is null', async () => {
    await render(
      <PeekInfoLayer
        card={{ ...card, artistName: null } as WaifuImage}
        onOpenSource={undefined}
      />,
    );

    expect(screen.getByText('未知画师')).toBeOnTheScreen();
  });

  test('renders a source action when onOpenSource provided', async () => {
    const onOpenSource = jest.fn();
    await render(<PeekInfoLayer card={card} onOpenSource={onOpenSource} />);

    const sourceButton = screen.getByRole('button', { name: '查看来源' });
    expect(sourceButton).toBeOnTheScreen();
    await fireEvent.press(sourceButton);
    expect(onOpenSource).toHaveBeenCalledTimes(1);
  });
});
