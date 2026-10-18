import {
  discoveryRoundTrace,
  traceProviderRounds,
} from '@/features/discovery/discovery-round-trace';
import type { DiscoveryProviderRound } from '@/features/providers/provider-adapter';

const round = (
  overrides: Partial<DiscoveryProviderRound> = {},
): DiscoveryProviderRound => ({
  providerKey: 'konachan',
  requested: 2,
  returned: 0,
  admitted: 0,
  outcome: 'failed',
  ...overrides,
});

/** Captures the trace lines this module writes, with the flag left restored. */
function capture(run: () => void): string[] {
  const lines: string[] = [];
  const debug = jest
    .spyOn(console, 'debug')
    .mockImplementation((message?: unknown) => {
      lines.push(String(message));
    });
  const wasEnabled = discoveryRoundTrace.enabled;
  try {
    run();
  } finally {
    discoveryRoundTrace.enabled = wasEnabled;
    debug.mockRestore();
  }
  return lines;
}

describe('discoveryRoundTrace', () => {
  test('stays silent unless a dev build turned it on', () => {
    // Jest drives real refills all over this suite; a trace that defaulted to on
    // would bury every other suite's output.
    expect(discoveryRoundTrace.enabled).toBe(false);
    const lines = capture(() => {
      traceProviderRounds([round()], {});
    });
    expect(lines).toEqual([]);
  });

  test('names the reason a source produced nothing, not just that it did', () => {
    // The whole point of the module: a bare zero cannot be acted on, because
    // never-asked / refused / timed-out / unparseable all look the same in the
    // persisted deck. This is the §6.5 konachan case.
    const lines = capture(() => {
      discoveryRoundTrace.enabled = true;
      traceProviderRounds(
        [
          round({ failureCode: 'invalid_response', failureStatus: 500 }),
          round({
            providerKey: 'yandere',
            requested: 4,
            returned: 4,
            admitted: 3,
            outcome: 'ok',
          }),
        ],
        { yandere: 2 },
      );
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'konachan req=2 ret=0 adm=0 ins=0 failed (invalid_response 500)',
    );
    // An `ok` round must not gain a reason suffix — it had no failure.
    expect(lines[0]).toContain('yandere req=4 ret=4 adm=3 ins=2 ok');
    expect(lines[0]).not.toMatch(/ok \(/);
  });

  test('reports a code with no HTTP status without a dangling number', () => {
    const lines = capture(() => {
      discoveryRoundTrace.enabled = true;
      traceProviderRounds([round({ failureCode: 'timeout' })], {});
    });
    expect(lines[0]).toContain('failed (timeout)');
  });

  test('says nothing when there were no rounds to report', () => {
    const lines = capture(() => {
      discoveryRoundTrace.enabled = true;
      traceProviderRounds(undefined, {});
      traceProviderRounds([], {});
    });
    expect(lines).toEqual([]);
  });
});
