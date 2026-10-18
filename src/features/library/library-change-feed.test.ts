import {
  createLibraryChangeFeed,
  type LibraryChange,
} from './library-change-feed';

describe('createLibraryChangeFeed', () => {
  test('delivers an emitted change to a subscriber', () => {
    const feed = createLibraryChangeFeed();
    const seen: LibraryChange[] = [];
    feed.subscribe((change) => seen.push(change));

    feed.emit({ kind: 'protected', plaintextSha256: 'sha-a' });

    expect(seen).toEqual([{ kind: 'protected', plaintextSha256: 'sha-a' }]);
  });

  test('delivers synchronously, before emit returns', () => {
    const feed = createLibraryChangeFeed();
    let delivered = false;
    feed.subscribe(() => { delivered = true; });

    feed.emit({ kind: 'ingested' });

    // No microtask, no timer: the grid must be able to start its re-read in
    // the same turn the upload finished in.
    expect(delivered).toBe(true);
  });

  test('delivers to every subscriber in subscription order', () => {
    const feed = createLibraryChangeFeed();
    const order: string[] = [];
    feed.subscribe(() => order.push('first'));
    feed.subscribe(() => order.push('second'));

    feed.emit({ kind: 'round-complete' });

    expect(order).toEqual(['first', 'second']);
  });

  test('unsubscribing stops delivery to that subscriber only', () => {
    const feed = createLibraryChangeFeed();
    const kept = jest.fn();
    const dropped = jest.fn();
    feed.subscribe(kept);
    const unsubscribe = feed.subscribe(dropped);

    unsubscribe();
    feed.emit({ kind: 'downloaded', plaintextSha256: 'sha-a' });

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  test('unsubscribing twice is harmless', () => {
    const feed = createLibraryChangeFeed();
    const listener = jest.fn();
    const unsubscribe = feed.subscribe(listener);

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    feed.emit({ kind: 'trashed', plaintextSha256: 'sha-a' });

    expect(listener).not.toHaveBeenCalled();
  });

  test('a throwing subscriber neither stops the others nor fails the emitter', () => {
    const feed = createLibraryChangeFeed();
    const after = jest.fn();
    feed.subscribe(() => { throw new Error('listener exploded'); });
    feed.subscribe(after);

    // The emitters are the protect action and the sync trigger: a screen that
    // unmounted mid-refresh must never be able to fail an upload.
    expect(() => feed.emit({ kind: 'protect-settled', plaintextSha256: 'sha-a' }))
      .not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  test('a subscriber that unsubscribes during delivery does not disturb the rest', () => {
    const feed = createLibraryChangeFeed();
    const last = jest.fn();
    const unsubscribeSelf = feed.subscribe(() => unsubscribeSelf());
    feed.subscribe(last);

    expect(() => feed.emit({ kind: 'restored', plaintextSha256: 'sha-a' }))
      .not.toThrow();
    expect(last).toHaveBeenCalledTimes(1);
  });

  test('emitting with no subscribers is a no-op', () => {
    const feed = createLibraryChangeFeed();
    expect(() => feed.emit({ kind: 'ingested' })).not.toThrow();
  });

  test('two feeds are independent', () => {
    const a = createLibraryChangeFeed();
    const b = createLibraryChangeFeed();
    const listener = jest.fn();
    a.subscribe(listener);

    b.emit({ kind: 'protected', plaintextSha256: 'sha-a' });

    expect(listener).not.toHaveBeenCalled();
  });
});
