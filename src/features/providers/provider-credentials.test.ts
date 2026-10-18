import {
  PROVIDER_CREDENTIALS_KEY,
  createProviderCredentialStore,
  type ProviderCredential,
} from '@/features/providers/provider-credentials';

function memoryPort() {
  const store = new Map<string, string>();
  return {
    port: {
      getItemAsync: async (k: string) => store.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => void store.set(k, v),
      deleteItemAsync: async (k: string) => void store.delete(k),
    },
    raw: store,
  };
}

const CRED: ProviderCredential = { apiKey: 'k'.repeat(128), userId: '2047386' };

test('secure-store key has no slashes (expo-secure-store /^[\\w.-]+$/ rule)', () => {
  expect(PROVIDER_CREDENTIALS_KEY).toMatch(/^[\w.-]+$/);
});

test('save → load → clear round-trip, keyed by provider', async () => {
  const { port } = memoryPort();
  const credentials = createProviderCredentialStore(port);
  await credentials.save('gelbooru', CRED);
  expect(await credentials.load()).toEqual({ gelbooru: CRED });
  await credentials.clear('gelbooru');
  expect(await credentials.load()).toEqual({});
});

test('save/clear resolve to the post-write map (no separate load needed)', async () => {
  const { port } = memoryPort();
  const credentials = createProviderCredentialStore(port);
  const other: ProviderCredential = { apiKey: 'other', userId: '1' };
  // The returned map is the exact one just written inside the serialized block,
  // so a caller's live ref can be refreshed from it without a racing load().
  expect(await credentials.save('gelbooru', CRED)).toEqual({ gelbooru: CRED });
  expect(await credentials.save('e621', other)).toEqual({ gelbooru: CRED, e621: other });
  expect(await credentials.clear('gelbooru')).toEqual({ e621: other });
});

test('malformed JSON in the store is treated as no credentials, not a crash', async () => {
  const { port, raw } = memoryPort();
  raw.set(PROVIDER_CREDENTIALS_KEY, '{not json');
  expect(await createProviderCredentialStore(port).load()).toEqual({});
});

test('per-entry validation: one corrupt entry does not discard the others', async () => {
  const { port, raw } = memoryPort();
  raw.set(PROVIDER_CREDENTIALS_KEY, JSON.stringify({
    gelbooru: CRED,
    rule34: { apiKey: 'only-key-no-user' },
    not_a_provider: { apiKey: 'x', userId: 'y' },
    konachan: 'garbage',
  }));
  expect(await createProviderCredentialStore(port).load()).toEqual({ gelbooru: CRED });
});

test('save preserves the other provider entries', async () => {
  const { port } = memoryPort();
  const credentials = createProviderCredentialStore(port);
  await credentials.save('gelbooru', CRED);
  await credentials.save('e621', { apiKey: 'other', userId: '1' });
  await credentials.clear('e621');
  expect(await credentials.load()).toEqual({ gelbooru: CRED });
});

test('two overlapping saves without awaiting the first both land', async () => {
  const { port } = memoryPort();
  const credentials = createProviderCredentialStore(port);
  const other: ProviderCredential = { apiKey: 'other', userId: '1' };
  const [first, second] = await Promise.all([
    credentials.save('gelbooru', CRED),
    credentials.save('e621', other),
  ]);
  // Each save resolves to the map as of its own serialized write: the first
  // sees only its key, the second (chained after it) sees both. The returns
  // never settle out of order, so a live ref refreshed from them is never left
  // pointing at a stale snapshot.
  expect(first).toEqual({ gelbooru: CRED });
  expect(second).toEqual({ gelbooru: CRED, e621: other });
  expect(await credentials.load()).toEqual({ gelbooru: CRED, e621: other });
});

test('works with the Buffer global removed', async () => {
  const saved = (globalThis as { Buffer?: unknown }).Buffer;
  delete (globalThis as { Buffer?: unknown }).Buffer;
  try {
    const { port } = memoryPort();
    const credentials = createProviderCredentialStore(port);
    await credentials.save('gelbooru', CRED);
    expect(await credentials.load()).toEqual({ gelbooru: CRED });
  } finally {
    (globalThis as { Buffer?: unknown }).Buffer = saved;
  }
});
