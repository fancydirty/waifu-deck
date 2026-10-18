/**
 * An in-memory stand-in for the `expo-secure-store` surface the BYOS modules
 * use, for Jest only. The real module needs a native keystore, which no test
 * environment provides; production code takes a `SecureStorePort`, so this
 * double only has to satisfy the module-level import.
 *
 * Key validation mirrors the real module exactly
 * (node_modules/expo-secure-store/build/SecureStore.js:145-151):
 * `getItemAsync`/`setItemAsync`/`deleteItemAsync` all call `ensureValidKey`
 * before touching storage, so an invalid key throws even when the caller
 * only ever reads. Without this check here, a slash-delimited key (which
 * throws on a real device) would silently succeed against this double.
 */
const store = new Map<string, string>();

export function ensureValidKey(key: string): void {
  if (!(typeof key === 'string' && /^[\w.-]+$/.test(key))) {
    throw new Error(
      'Invalid key provided to SecureStore. Keys must not be empty and '
      + 'contain only alphanumeric characters, ".", "-", and "_".',
    );
  }
}

export function resetExpoSecureStoreDouble(): void {
  store.clear();
}

export async function getItemAsync(key: string): Promise<string | null> {
  ensureValidKey(key);
  return store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  ensureValidKey(key);
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  ensureValidKey(key);
  store.delete(key);
}
