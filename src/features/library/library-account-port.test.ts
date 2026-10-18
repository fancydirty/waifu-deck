import { createByosLibraryAccountPort } from './library-account-port';
import type {
  LibrarySessionContext,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';

function fixedSessionPort(
  context: LibrarySessionContext | null,
): LibrarySessionPort {
  return { async current() { return context; } };
}

describe('createByosLibraryAccountPort', () => {
  it('aes-gcm session: vaultMasterKey returns the real key and deviceId passes through', async () => {
    const masterKey = new Uint8Array(32).fill(9);
    const account = createByosLibraryAccountPort(fixedSessionPort({
      deviceId: 'device-1',
      masterKey,
      accountScope: 'scope-a',
    }));
    expect(Buffer.from((await account.vaultMasterKey())!).equals(Buffer.from(masterKey))).toBe(true);
    expect(await account.deviceId()).toBe('device-1');
  });

  it('none session: vaultMasterKey returns the non-null vaultId-derived pseudo key, not null', async () => {
    const pseudoKey = new Uint8Array(32).fill(3);
    const account = createByosLibraryAccountPort(fixedSessionPort({
      deviceId: 'device-1',
      masterKey: pseudoKey,
      accountScope: 'scope-a',
    }));
    const key = await account.vaultMasterKey();
    expect(key).not.toBeNull();
    expect(Buffer.from(key!).equals(Buffer.from(pseudoKey))).toBe(true);
    // The session itself is still usable: deviceId keeps flowing.
    expect(await account.deviceId()).toBe('device-1');
  });

  it('no session: both vaultMasterKey and deviceId return null (null is now strictly "no session")', async () => {
    const account = createByosLibraryAccountPort(fixedSessionPort(null));
    expect(await account.vaultMasterKey()).toBeNull();
    expect(await account.deviceId()).toBeNull();
  });

  it('accountScope returns the session scope; null only when no session', async () => {
    const withSession = createByosLibraryAccountPort(fixedSessionPort({
      deviceId: 'device-1',
      masterKey: new Uint8Array(32).fill(9),
      accountScope: 'scope-xyz',
    }));
    expect(await withSession.accountScope()).toBe('scope-xyz');

    const noSession = createByosLibraryAccountPort(fixedSessionPort(null));
    expect(await noSession.accountScope()).toBeNull();
  });
});
