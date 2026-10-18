describe('test harness', () => {
  it('loads the Expo Jest environment', () => {
    expect(globalThis.__WAIFU_DECK_TEST_READY__).toBe(true);
  });
});
