import { runToEmpty, type SyncRoundResult } from '@/features/library/library-sync-run-to-empty';

const R = (upT: number, upD: number, upF: number, dnT = 0, dnD = 0, dnF = 0): SyncRoundResult => ({
  up: { total: upT, done: upD, failed: upF },
  down: { total: dnT, done: dnD, failed: dnF },
});
const seq = (rounds: SyncRoundResult[]) => {
  let i = 0;
  return jest.fn(async () => rounds[Math.min(i++, rounds.length - 1)]!);
};

test('A1 empty round → 1 round, clean', async () => {
  const round = seq([R(0, 0, 0)]);
  expect(await runToEmpty(round, { maxRounds: 20 })).toMatchObject({
    rounds: 1,
    clean: true,
    capped: false,
  });
});

test('A2 work then empty → 2 rounds, clean', async () => {
  const round = seq([R(3, 3, 0), R(0, 0, 0)]);
  const out = await runToEmpty(round, { maxRounds: 20 });
  expect(out).toMatchObject({ rounds: 2, clean: true });
  expect(round).toHaveBeenCalledTimes(2);
});

test('A3 perpetual partial progress → capped at maxRounds', async () => {
  const round = seq([R(5, 1, 4)]);
  expect(await runToEmpty(round, { maxRounds: 4 })).toMatchObject({
    rounds: 4,
    clean: false,
    capped: true,
  });
});

test('A4 a round with zero successes stops immediately (no spin on dead candidates)', async () => {
  const round = seq([R(5, 0, 5)]);
  expect(await runToEmpty(round, { maxRounds: 20 })).toMatchObject({
    rounds: 1,
    clean: false,
    capped: false,
  });
  expect(round).toHaveBeenCalledTimes(1);
});

test('A4b down-side progress counts as progress', async () => {
  const round = seq([R(0, 0, 0, 4, 4, 0), R(0, 0, 0)]);
  expect(await runToEmpty(round, { maxRounds: 20 })).toMatchObject({ rounds: 2, clean: true });
});

test('A5 a throwing round propagates', async () => {
  await expect(
    runToEmpty(
      async () => {
        throw new Error('x');
      },
      { maxRounds: 3 },
    ),
  ).rejects.toThrow('x');
});
