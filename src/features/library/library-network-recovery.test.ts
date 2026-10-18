import {
  createExpoLibraryNetworkRecovery,
} from '@/features/library/library-network-recovery';

type Listener = (event: { isConnected?: boolean }) => void;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeModule(
  getNetworkStateAsync: (() => Promise<{ isConnected?: boolean }>) | undefined =
    async () => ({ isConnected: true }),
  clearListenerOnRemove = true,
) {
  let listener: Listener | null = null;
  let removed = false;
  return {
    module: {
      getNetworkStateAsync,
      addNetworkStateListener(cb: Listener) {
        listener = cb;
        return {
          remove: () => {
            removed = true;
            if (clearListenerOnRemove) listener = null;
          },
        };
      },
    } as unknown as typeof import('expo-network'),
    emit: (isConnected: boolean | undefined) => listener?.({ isConnected }),
    get removed() { return removed; },
    get subscribed() { return listener !== null; },
  };
}

describe('createExpoLibraryNetworkRecovery', () => {
  it('fires only on the offline -> online edge, not on every connected event', () => {
    const f = fakeModule();
    const onReturn = jest.fn();
    createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);

    f.emit(true);            // starts "connected"; no edge
    expect(onReturn).toHaveBeenCalledTimes(0);
    f.emit(false);           // went offline
    f.emit(false);           // still offline
    expect(onReturn).toHaveBeenCalledTimes(0);
    f.emit(true);            // recovered -> edge
    expect(onReturn).toHaveBeenCalledTimes(1);
    f.emit(true);            // still online, no new edge
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('treats unknown connectivity as connected so it never fires a false edge', () => {
    const f = fakeModule();
    const onReturn = jest.fn();
    createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);
    f.emit(undefined);
    f.emit(undefined);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('unsubscribes the native listener', () => {
    const f = fakeModule();
    const stop = createExpoLibraryNetworkRecovery(() => f.module).subscribe(jest.fn());
    expect(f.subscribed).toBe(true);
    stop();
    expect(f.removed).toBe(true);
  });

  it('degrades to a no-op when the network module is unavailable', () => {
    const throwing = () => { throw new Error('no expo-network'); };
    const stop = createExpoLibraryNetworkRecovery(throwing as never).subscribe(jest.fn());
    expect(() => stop()).not.toThrow();
  });

  it('a subscription that starts offline fires on the first connected event', async () => {
    const f = fakeModule(async () => ({ isConnected: false }));
    const onReturn = jest.fn();
    createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);

    await Promise.resolve();
    f.emit(true);
    expect(onReturn).toHaveBeenCalledTimes(1);
    f.emit(true);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('an event before the seed resolves wins', async () => {
    const seed = deferred<{ isConnected?: boolean }>();
    const f = fakeModule(() => seed.promise);
    const onReturn = jest.fn();
    createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);

    f.emit(false);
    seed.resolve({ isConnected: true });
    await Promise.resolve();
    f.emit(true);

    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('a seed that fails keeps the connected assumption', async () => {
    const seed = deferred<{ isConnected?: boolean }>();
    const f = fakeModule(() => seed.promise);
    const onReturn = jest.fn();
    createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);

    void seed.promise.catch(() => undefined);
    seed.reject(new Error('network state unavailable'));
    await Promise.resolve();
    f.emit(true);
    expect(onReturn).toHaveBeenCalledTimes(0);
    f.emit(false);
    f.emit(true);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing before the seed answers fires nothing', async () => {
    const seed = deferred<{ isConnected?: boolean }>();
    const f = fakeModule(() => seed.promise);
    const onReturn = jest.fn();
    const stop = createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);

    stop();
    seed.resolve({ isConnected: false });
    await Promise.resolve();
    f.emit(true);

    expect(f.removed).toBe(true);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('a missing seed keeps the connected assumption', () => {
    const f = fakeModule(undefined);
    const onReturn = jest.fn();
    createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);

    f.emit(true);
    expect(onReturn).not.toHaveBeenCalled();
    f.emit(false);
    f.emit(true);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('an unknown seed keeps the connected assumption', async () => {
    const f = fakeModule(async () => ({ isConnected: undefined }));
    const onReturn = jest.fn();
    createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);

    await Promise.resolve();
    f.emit(true);
    expect(onReturn).not.toHaveBeenCalled();
    f.emit(false);
    f.emit(true);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('an unsubscribed listener ignores a late native event', async () => {
    const seed = deferred<{ isConnected?: boolean }>();
    const f = fakeModule(() => seed.promise, false);
    const onReturn = jest.fn();
    const stop = createExpoLibraryNetworkRecovery(() => f.module).subscribe(onReturn);

    stop();
    seed.resolve({ isConnected: false });
    await Promise.resolve();
    f.emit(false);
    f.emit(true);

    expect(f.removed).toBe(true);
    expect(onReturn).not.toHaveBeenCalled();
  });

  it('a seed that throws synchronously leaves the listener removable', () => {
    const f = fakeModule((() => {
      throw new Error('network state unavailable');
    }) as never);
    const stop = createExpoLibraryNetworkRecovery(() => f.module).subscribe(jest.fn());

    expect(f.subscribed).toBe(true);
    stop();
    expect(f.removed).toBe(true);
  });
});
