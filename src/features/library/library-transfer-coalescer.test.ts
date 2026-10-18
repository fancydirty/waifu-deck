import { createTransferCoalescer } from '@/features/library/library-transfer-coalescer';

describe('library transfer coalescer', () => {
  it('shares the in-flight promise and clears it after settlement', async () => {
    const coalescer = createTransferCoalescer<string>();
    let resolveTask!: (value: string) => void;
    const task = new Promise<string>((resolve) => { resolveTask = resolve; });
    const first = coalescer.run('asset:original', () => task);
    const second = coalescer.run('asset:original', () => Promise.resolve('wrong'));

    expect(second).toBe(first);
    resolveTask('done');
    await expect(first).resolves.toBe('done');

    await expect(coalescer.run('asset:original', () => Promise.resolve('fresh')))
      .resolves.toBe('fresh');
  });

  it('reports owner versus waiter while sharing the same promise', async () => {
    const coalescer = createTransferCoalescer<string>();
    let resolveTask!: (value: string) => void;
    const task = new Promise<string>((resolve) => { resolveTask = resolve; });

    const owner = coalescer.runWithOwnership!('asset:original', () => task);
    const waiter = coalescer.runWithOwnership!('asset:original', () => Promise.resolve('wrong'));

    expect(owner.owner).toBe(true);
    expect(waiter.owner).toBe(false);
    expect(waiter.promise).toBe(owner.promise);
    resolveTask('done');
    await expect(owner.promise).resolves.toBe('done');

    const later = coalescer.runWithOwnership!('asset:original', () => Promise.resolve('fresh'));
    expect(later.owner).toBe(true);
    expect(later.promise).not.toBe(owner.promise);
    await expect(later.promise).resolves.toBe('fresh');
  });

  it('shares a failure, then allows a later attempt', async () => {
    const coalescer = createTransferCoalescer<number>();
    const failure = new Error('failed');
    const first = coalescer.run('asset:original', async () => { throw failure; });
    const second = coalescer.run('asset:original', () => Promise.resolve(2));

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(coalescer.run('asset:original', () => Promise.resolve(3)))
      .resolves.toBe(3);
  });
});
