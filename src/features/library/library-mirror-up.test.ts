import { createLibraryMirrorUp, LIBRARY_MIRROR_UPLOAD_CONCURRENCY } from '@/features/library/library-mirror-up';

const scope = 'scope-1';

function deps(candidates: string[], protectMock: jest.Mock, enrollMock?: jest.Mock) {
  return {
    enrollMissing: enrollMock ?? jest.fn(async () => undefined),
    getAccountScope: jest.fn(async () => scope),
    listProtectCandidates: jest.fn(async (s: string) => (s === scope ? candidates : [])),
    protect: protectMock,
  };
}

describe('createLibraryMirrorUp', () => {
  it('enrolls first, then uploads every protect candidate and reports counts', async () => {
    const order: string[] = [];
    const enroll = jest.fn(async () => { order.push('enroll'); });
    const protect = jest.fn(async (_d: string) => { order.push('protect'); return { status: 'applied' as const }; });
    const mirror = createLibraryMirrorUp(deps(['a', 'b', 'c'], protect, enroll));
    expect(await mirror.mirrorUp()).toEqual({ total: 3, done: 3, failed: 0 });
    expect(protect.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'c']);
    // enroll must precede the first protect: protect reads the collect intent
    // enroll writes, so listing/protecting before enroll would object_missing.
    expect(order[0]).toBe('enroll');
  });

  it('counts a blocked protect as failed and still finishes the rest', async () => {
    const protect = jest.fn(async (d: string) =>
      d === 'b' ? { status: 'blocked' as const, category: 'offline' as const } : { status: 'applied' as const });
    const mirror = createLibraryMirrorUp(deps(['a', 'b', 'c'], protect));
    expect(await mirror.mirrorUp()).toEqual({ total: 3, done: 2, failed: 1 });
  });

  it('treats a noop protect (already satisfied) as done', async () => {
    const protect = jest.fn(async () => ({ status: 'noop' as const, reason: 'already-satisfied' as const }));
    const mirror = createLibraryMirrorUp(deps(['a', 'b'], protect));
    expect(await mirror.mirrorUp()).toEqual({ total: 2, done: 2, failed: 0 });
  });

  it('still enrolls but does not protect when there is no account scope', async () => {
    const enroll = jest.fn(async () => undefined);
    const protect = jest.fn();
    const mirror = createLibraryMirrorUp({
      enrollMissing: enroll,
      getAccountScope: jest.fn(async () => null),
      listProtectCandidates: jest.fn(),
      protect,
    });
    expect(await mirror.mirrorUp()).toEqual({ total: 0, done: 0, failed: 0 });
    expect(protect).not.toHaveBeenCalled();
    // 'still enrolls' is the whole point of this case: enrolment is what gives
    // a later cycle something to protect, and it must not be gated behind the
    // scope read. Without this assertion the test passes just as well when
    // enrolment is skipped entirely.
    expect(enroll).toHaveBeenCalled();
  });

  it('does not call protect when the account has no upload candidates', async () => {
    const protect = jest.fn();
    const mirror = createLibraryMirrorUp(deps([], protect));
    expect(await mirror.mirrorUp()).toEqual({ total: 0, done: 0, failed: 0 });
    expect(protect).not.toHaveBeenCalled();
  });

  it('keeps the default number of uploads actually in flight at once', async () => {
    // Asserting the exported constant is > 1 proves nothing about the pool: it
    // stays green if mirrorUp never passes the constant on, or hands the pool a
    // `concurrency: 1`. This observes the real in-flight count with the DEFAULT
    // wiring, which is what the owner's no-throttle ruling is about.
    const candidates = Array.from({ length: 20 }, (_, index) => `digest-${index}`);
    let inFlight = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const protect = jest.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return { status: 'applied' as const };
    });

    const mirror = createLibraryMirrorUp(deps(candidates, protect));
    const running = mirror.mirrorUp();
    // Give every lane a chance to take its first item before any can finish.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();

    expect(await running).toEqual({ total: 20, done: 20, failed: 0 });
    expect(peak).toBe(LIBRARY_MIRROR_UPLOAD_CONCURRENCY);
    expect(LIBRARY_MIRROR_UPLOAD_CONCURRENCY).toBe(8);
  });
});
