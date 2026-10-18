import { createByosCredentialStore, type ByosBinding, type OneDriveBinding, type SecureStorePort } from '@/features/byos/byos-credentials';

import { fragmentsOf, persistRotatedToken } from './onedrive-store-production';

// Mirrors the unexported `memoryPort()` helper in `byos-context-resolver.test.ts`
// (not imported across test files): an in-memory `SecureStorePort` so
// `persistRotatedToken` is proven against the REAL credential store, including
// its own JSON serialization and `parseBinding` narrowing — not a hand-rolled
// fake that could pass while the real store drops a field.
function memoryPort(): SecureStorePort {
  const map = new Map<string, string>();
  return {
    getItemAsync: async (k) => map.get(k) ?? null,
    setItemAsync: async (k, v) => { map.set(k, v); },
    deleteItemAsync: async (k) => { map.delete(k); },
  };
}

describe('persistRotatedToken', () => {
  const binding: OneDriveBinding = { kind: 'onedrive', refreshToken: 'RT-old', accountEmail: 'a@b.com', rootFolderId: 'F1', stateFolderId: 'F2', blobsFolderId: 'F3' };

  test('writes the new refresh token over a stored onedrive binding with the same rootFolderId', async () => {
    const store = createByosCredentialStore(memoryPort());
    await store.saveBinding(binding);
    await persistRotatedToken(store, binding, 'RT-new');
    await expect(store.loadBinding()).resolves.toEqual({ ...binding, refreshToken: 'RT-new' });
  });

  test('does nothing when nothing is stored', async () => {
    const store = createByosCredentialStore(memoryPort());
    await persistRotatedToken(store, binding, 'RT-new');
    await expect(store.loadBinding()).resolves.toBeNull();
  });

  test('does nothing when the stored binding is a different kind', async () => {
    const store = createByosCredentialStore(memoryPort());
    const webdav: ByosBinding = { kind: 'webdav', baseUrl: 'https://x', username: 'u', password: 'p', rootPath: '/' };
    await store.saveBinding(webdav);
    await persistRotatedToken(store, binding, 'RT-new');
    await expect(store.loadBinding()).resolves.toEqual(webdav);
  });

  test('does nothing when the stored onedrive binding has switched to a different rootFolderId (user re-bound elsewhere)', async () => {
    const store = createByosCredentialStore(memoryPort());
    const other: OneDriveBinding = { ...binding, rootFolderId: 'OTHER' };
    await store.saveBinding(other);
    await persistRotatedToken(store, binding, 'RT-new');
    await expect(store.loadBinding()).resolves.toEqual(other);
  });
});

describe('fragmentsOf', () => {
  test('re-slices arbitrary producer chunks into exact fragmentBytes pieces, the last one shorter', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7, 8]), new Uint8Array([9, 10])];
    let i = 0;
    const stream = { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined }), releaseLock: () => {} }) } as unknown as ReadableStream<Uint8Array>;
    const out: number[][] = [];
    for await (const frag of fragmentsOf(stream, 4)) out.push(Array.from(frag));
    expect(out).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
  });
  test('yields standalone copies, not views into a producer buffer reused across reads', async () => {
    // The reused chunk is 3 bytes — NOT a multiple of fragmentBytes (4) — so a
    // correct copy must still be sitting in `pending` (part-consumed) when the
    // producer overwrites its buffer for the next read. A chunk sized exactly
    // `fragmentBytes` would already be fully drained out by `takeFragment`
    // before the next read, which is why that shape doesn't catch this bug.
    const shared = new Uint8Array(3);
    let call = 0;
    const stream = {
      getReader: () => ({
        read: async () => {
          call += 1;
          if (call === 1) { shared.set([1, 2, 3]); return { done: false, value: shared }; }
          if (call === 2) { shared.set([7, 8, 9]); return { done: false, value: shared }; }
          return { done: true, value: undefined };
        },
        releaseLock: () => {},
      }),
    } as unknown as ReadableStream<Uint8Array>;
    const out: number[][] = [];
    for await (const frag of fragmentsOf(stream, 4)) out.push(Array.from(frag));
    expect(out).toEqual([[1, 2, 3, 7], [8, 9]]);
  });
  test('on an empty stream yields nothing', async () => {
    const stream = { getReader: () => ({ read: async () => ({ done: true, value: undefined }), releaseLock: () => {} }) } as unknown as ReadableStream<Uint8Array>;
    const out: Uint8Array[] = [];
    for await (const frag of fragmentsOf(stream, 4)) out.push(frag);
    expect(out).toEqual([]);
  });
  test('a consumer that stops early (break) releases the reader and cancels the underlying stream', async () => {
    const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])];
    let i = 0;
    let released = false;
    let cancelled = 0;
    const stream = {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined }),
        releaseLock: () => { released = true; },
        cancel: async () => { cancelled += 1; },
      }),
    } as unknown as ReadableStream<Uint8Array>;
    for await (const frag of fragmentsOf(stream, 4)) {
      expect(Array.from(frag)).toEqual([1, 2, 3, 4]);
      break;
    }
    expect(cancelled).toBe(1);
    expect(released).toBe(true);
  });
});
