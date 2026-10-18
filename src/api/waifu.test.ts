import { fetchWaifuBatch, WaifuApiError } from '../features/waifu/waifu-client';
import { fetchWaifuImages } from './waifu';

jest.mock('../features/waifu/waifu-client', () => {
  const actual = jest.requireActual('../features/waifu/waifu-client');
  return {
    ...actual,
    fetchWaifuBatch: jest.fn(),
  };
});

const mockFetchWaifuBatch = jest.mocked(fetchWaifuBatch);

test('exposes client cancellation as AbortError to the compatibility consumer', async () => {
  mockFetchWaifuBatch.mockRejectedValue(
    new WaifuApiError('aborted', 'Waifu.im request was aborted'),
  );

  await expect(fetchWaifuImages()).rejects.toMatchObject({
    name: 'AbortError',
  });
});
