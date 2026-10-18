import {
  PROVIDER_YIELD_WINDOW_ROUNDS,
  createProviderYieldLedger,
  type ProviderRoundRecord,
} from '@/features/providers/provider-yield-ledger';

const round = (
  overrides: Partial<ProviderRoundRecord> = {},
): ProviderRoundRecord => ({
  requested: 4,
  returned: 4,
  admitted: 2,
  inserted: 1,
  outcome: 'ok',
  ...overrides,
});

test('exposes the spec window of 8 rounds per provider', () => {
  expect(PROVIDER_YIELD_WINDOW_ROUNDS).toBe(8);
});

test('aggregates requested/admitted/inserted as rolling sums per provider', () => {
  const ledger = createProviderYieldLedger();

  ledger.record('danbooru', round({ requested: 4, admitted: 3, inserted: 2 }));
  ledger.record('danbooru', round({ requested: 2, admitted: 1, inserted: 1 }));
  ledger.record('e621', round({ requested: 2, admitted: 0, inserted: 0 }));

  const stats = ledger.stats();
  expect(stats.get('danbooru')).toEqual({
    requested: 6,
    admitted: 4,
    inserted: 3,
    consecutiveZeroRounds: 0,
    lastOutcome: 'ok',
  });
  expect(stats.get('e621')).toEqual({
    requested: 2,
    admitted: 0,
    inserted: 0,
    consecutiveZeroRounds: 1,
    lastOutcome: 'ok',
  });
});

test('omits providers that have never been recorded', () => {
  const ledger = createProviderYieldLedger();

  ledger.record('waifu_im', round());

  const stats = ledger.stats();
  expect(stats.has('waifu_im')).toBe(true);
  expect(stats.has('nekos_api')).toBe(false);
  expect(stats.size).toBe(1);
});

test('rolls the window: the 9th round evicts the 1st', () => {
  const ledger = createProviderYieldLedger();

  // Round 1 is the only one carrying 100s; rounds 2..9 each carry 1s.
  ledger.record('yandere', round({ requested: 100, admitted: 100, inserted: 100 }));
  for (let index = 0; index < PROVIDER_YIELD_WINDOW_ROUNDS; index += 1) {
    ledger.record('yandere', round({ requested: 1, admitted: 1, inserted: 1 }));
  }

  expect(ledger.stats().get('yandere')).toEqual({
    requested: PROVIDER_YIELD_WINDOW_ROUNDS,
    admitted: PROVIDER_YIELD_WINDOW_ROUNDS,
    inserted: PROVIDER_YIELD_WINDOW_ROUNDS,
    consecutiveZeroRounds: 0,
    lastOutcome: 'ok',
  });
});

test('keeps allocation bounded no matter how many rounds are recorded', () => {
  const ledger = createProviderYieldLedger();

  for (let index = 0; index < 500; index += 1) {
    ledger.record('konachan', round({ requested: 1, admitted: 1, inserted: 1 }));
  }

  expect(ledger.stats().get('konachan')?.requested).toBe(
    PROVIDER_YIELD_WINDOW_ROUNDS,
  );
});

// F1 (G3c Task 1): the quiet signal moved from `inserted === 0` to
// `admitted === 0`. `inserted` is measured after dedupe/merge-cap/post-rank
// truncation, all of which fall on the registry tail by construction, so an
// inserted-based signal would mark truncated sources as quiet. Every test below
// that turns on the zero-round run therefore drives `admitted`, not `inserted`.
test('counts consecutive zero-admit ok rounds and resets on a non-zero admit (F1)', () => {
  const ledger = createProviderYieldLedger();

  ledger.record('e926', round({ admitted: 0, inserted: 0 }));
  ledger.record('e926', round({ admitted: 0, inserted: 0 }));
  expect(ledger.stats().get('e926')?.consecutiveZeroRounds).toBe(2);

  ledger.record('e926', round({ admitted: 3, inserted: 3 }));
  expect(ledger.stats().get('e926')?.consecutiveZeroRounds).toBe(0);

  ledger.record('e926', round({ admitted: 0, inserted: 0 }));
  expect(ledger.stats().get('e926')?.consecutiveZeroRounds).toBe(1);
});

test('F1 regression: a truncated round (admitted > 0, inserted 0) is not quiet', () => {
  const ledger = createProviderYieldLedger();

  // The exact shape produced by the registry tail losing its whole slice to the
  // merge cap or the post-rank truncation: the provider answered with usable
  // posts, downstream policy threw them away. Not the provider's silence.
  for (let index = 0; index < 5; index += 1) {
    ledger.record('e621', round({ requested: 2, admitted: 2, inserted: 0 }));
  }

  const stat = ledger.stats().get('e621');
  expect(stat?.admitted).toBe(10);
  expect(stat?.inserted).toBe(0);
  expect(stat?.consecutiveZeroRounds).toBe(0);
});

test('stops the zero-round run at a non-ok outcome (health is provider-resilience territory)', () => {
  const ledger = createProviderYieldLedger();

  // F1: zero-admit rounds, not zero-insert rounds, open the run.
  ledger.record('safebooru', round({ admitted: 0, inserted: 0, outcome: 'ok' }));
  ledger.record('safebooru', round({ admitted: 0, inserted: 0, outcome: 'failed' }));
  ledger.record('safebooru', round({ admitted: 0, inserted: 0, outcome: 'ok' }));

  const stat = ledger.stats().get('safebooru');
  expect(stat?.consecutiveZeroRounds).toBe(1);
  expect(stat?.lastOutcome).toBe('ok');
});

test('reports the newest outcome for every outcome kind', () => {
  const ledger = createProviderYieldLedger();

  ledger.record('danbooru', round({ outcome: 'ok' }));
  ledger.record('danbooru', round({ inserted: 0, outcome: 'cooldown' }));
  expect(ledger.stats().get('danbooru')?.lastOutcome).toBe('cooldown');

  ledger.record('danbooru', round({ inserted: 0, outcome: 'skipped_capability' }));
  expect(ledger.stats().get('danbooru')?.lastOutcome).toBe('skipped_capability');
  expect(ledger.stats().get('danbooru')?.consecutiveZeroRounds).toBe(0);
});

test('reset clears every provider window', () => {
  const ledger = createProviderYieldLedger();

  ledger.record('danbooru', round());
  ledger.record('e621', round());
  ledger.reset();

  expect(ledger.stats().size).toBe(0);

  ledger.record('danbooru', round({ requested: 1, admitted: 1, inserted: 1 }));
  expect(ledger.stats().get('danbooru')).toEqual({
    requested: 1,
    admitted: 1,
    inserted: 1,
    consecutiveZeroRounds: 0,
    lastOutcome: 'ok',
  });
});

test('returns a snapshot that later records cannot mutate', () => {
  const ledger = createProviderYieldLedger();

  ledger.record('danbooru', round({ requested: 1, admitted: 1, inserted: 1 }));
  const snapshot = ledger.stats();
  ledger.record('danbooru', round({ requested: 5, admitted: 5, inserted: 5 }));

  expect(snapshot.get('danbooru')?.requested).toBe(1);
  expect(ledger.stats().get('danbooru')?.requested).toBe(6);
});

test('normalizes non-finite and negative counters instead of poisoning the sums', () => {
  const ledger = createProviderYieldLedger();

  ledger.record('nekos_api', round({
    requested: Number.NaN,
    returned: Number.POSITIVE_INFINITY,
    admitted: -3,
    inserted: 2.7,
  }));

  expect(ledger.stats().get('nekos_api')).toEqual({
    requested: 0,
    admitted: 0,
    inserted: 2,
    // F1: the normalized `admitted` is 0 and the outcome is `ok`, so this round
    // opens the zero-admit run (it did not before, when the run keyed off
    // `inserted`, which normalizes to 2 here).
    consecutiveZeroRounds: 1,
    lastOutcome: 'ok',
  });
});

test('is deterministic: no clock and no randomness feed the stats', () => {
  const now = jest.spyOn(Date, 'now');
  const random = jest.spyOn(Math, 'random');
  try {
    const replay = () => {
      const ledger = createProviderYieldLedger();
      ledger.record('danbooru', round({ requested: 4, admitted: 2, inserted: 0 }));
      ledger.record('e621', round({ requested: 2, admitted: 2, inserted: 1 }));
      ledger.record('danbooru', round({ requested: 4, admitted: 0, inserted: 0 }));
      return [...ledger.stats()];
    };

    expect(replay()).toEqual(replay());
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
});

// Spec §6.5 Hermes guard (hermes-node-globals-gap): the ledger is a pure ring
// buffer and must not lean on any Node global, because Jest cannot see that
// class of device crash. Same pattern as base64.test.ts.
test('records and aggregates with the Buffer global removed (device-runtime contract)', () => {
  const saved = (globalThis as { Buffer?: unknown }).Buffer;
  delete (globalThis as { Buffer?: unknown }).Buffer;
  try {
    expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();

    const ledger = createProviderYieldLedger();
    ledger.record('danbooru', round({ requested: 4, admitted: 3, inserted: 2 }));
    ledger.record('danbooru', round({ requested: 2, admitted: 0, inserted: 0 }));
    const stat = ledger.stats().get('danbooru');
    expect(stat).toMatchObject({ requested: 6, admitted: 3, inserted: 2 });
  } finally {
    (globalThis as { Buffer?: unknown }).Buffer = saved;
  }
});
