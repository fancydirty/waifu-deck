import { createDataResetCoordinator } from '@/features/data-reset/data-reset-coordinator';

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('DataResetCoordinator', () => {
  test('aborts and drains active mutations before running reset participants', async () => {
    const coordinator = createDataResetCoordinator();
    let finishActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      finishActive = resolve;
    });
    const abort = jest.fn();
    const active = coordinator.runMutation(async () => {
      await activeGate;
      return 'active';
    }, { abort });
    let finishParticipant!: () => void;
    const participantGate = new Promise<void>((resolve) => {
      finishParticipant = resolve;
    });
    const participant = jest.fn(() => participantGate);
    coordinator.registerResetParticipant(participant);

    let resetGranted = false;
    const reset = coordinator.beginReset().then((lease) => {
      resetGranted = true;
      return lease;
    });
    await nextTurn();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(participant).not.toHaveBeenCalled();
    expect(resetGranted).toBe(false);

    finishActive();
    await expect(active).resolves.toBe('active');
    await nextTurn();
    expect(participant).toHaveBeenCalledTimes(1);
    expect(resetGranted).toBe(false);

    finishParticipant();
    const lease = await reset;
    expect(resetGranted).toBe(true);
    lease.release();
  });

  test('aborts and drains active mutations while blocking new work until release', async () => {
    const coordinator = createDataResetCoordinator();
    let finishActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      finishActive = resolve;
    });
    const abort = jest.fn();
    const active = coordinator.runMutation(async () => {
      await activeGate;
      return 'active';
    }, { abort });
    await nextTurn();

    let resetGranted = false;
    const reset = coordinator.beginReset().then((lease) => {
      resetGranted = true;
      return lease;
    });
    let queuedStarted = false;
    const queued = coordinator.runMutation(async () => {
      queuedStarted = true;
      return 'queued';
    });
    await nextTurn();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(resetGranted).toBe(false);
    expect(queuedStarted).toBe(false);

    finishActive();
    await expect(active).resolves.toBe('active');
    const lease = await reset;
    expect(queuedStarted).toBe(false);

    lease.release();
    await expect(queued).resolves.toBe('queued');
  });

  test('board #32: an exclusive lease holds mutations and resets off, but aborts nothing and runs no participant', async () => {
    const coordinator = createDataResetCoordinator();
    let finishActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { finishActive = resolve; });
    const abort = jest.fn();
    const active = coordinator.runMutation(async () => { await activeGate; return 'active'; }, { abort });
    const participant = jest.fn();
    coordinator.registerResetParticipant(participant);

    let granted = false;
    const exclusive = coordinator.beginExclusive().then((lease) => { granted = true; return lease; });
    await nextTurn();
    expect(abort).not.toHaveBeenCalled();
    expect(granted).toBe(false);

    finishActive();
    await expect(active).resolves.toBe('active');
    const lease = await exclusive;

    let queuedStarted = false;
    const queued = coordinator.runMutation(async () => { queuedStarted = true; return 'queued'; });
    let resetGranted = false;
    const reset = coordinator.beginReset().then((resetLease) => { resetGranted = true; return resetLease; });
    await nextTurn();
    expect(queuedStarted).toBe(false);
    expect(resetGranted).toBe(false);
    expect(participant).not.toHaveBeenCalled();

    lease.release();
    lease.release(); // idempotent
    await expect(queued).resolves.toBe('queued');
    (await reset).release();
    expect(participant).toHaveBeenCalledTimes(1); // the reset's own run, never the exclusive lease's
  });

  test('board #32: an exclusive lease waits for a reset to be released', async () => {
    const coordinator = createDataResetCoordinator();
    const participant = jest.fn();
    coordinator.registerResetParticipant(participant);
    const resetLease = await coordinator.beginReset();
    expect(participant).toHaveBeenCalledTimes(1);

    let granted = false;
    const exclusive = coordinator.beginExclusive().then((lease) => { granted = true; return lease; });
    await nextTurn();
    expect(granted).toBe(false);

    resetLease.release();
    (await exclusive).release();
    expect(granted).toBe(true);
    // A queued exclusive lease stays exclusive when it is granted: re-acquiring
    // as a reset would run the participants and empty the discovery deck again.
    expect(participant).toHaveBeenCalledTimes(1);
  });

  test('board #32: a stale second release of an exclusive lease does not free the next lease', async () => {
    const coordinator = createDataResetCoordinator();
    const first = await coordinator.beginExclusive();
    let secondGranted = false;
    const secondPending = coordinator.beginExclusive().then((lease) => { secondGranted = true; return lease; });
    first.release();
    const second = await secondPending;
    expect(secondGranted).toBe(true);

    first.release(); // a stale, repeated release must not touch the second lease
    let queuedStarted = false;
    const queued = coordinator.runMutation(async () => { queuedStarted = true; return 'queued'; });
    await nextTurn();
    expect(queuedStarted).toBe(false);

    second.release();
    await expect(queued).resolves.toBe('queued');
  });
});
