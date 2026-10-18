import { act, fireEvent, render, screen, userEvent } from '@testing-library/react-native';

import type {
  ConnectResult, OneDriveSource, ProbeResult, SignInResult,
} from '@/features/byos/byos-connect-flow';
import i18n from '@/i18n';
import { OneDriveConnectForm } from '@/screens/settings/onedrive-connect-form';

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { ChevronRight: Icon };
});

const SOURCE: OneDriveSource = {
  binding: {
    kind: 'onedrive',
    refreshToken: 'RT',
    accountEmail: 'owner@example.com',
    rootFolderId: 'F1',
    stateFolderId: 'F2',
    blobsFolderId: 'F3',
  },
  accessToken: 'AT',
  expiresAt: 9,
};

function form(over: Partial<React.ComponentProps<typeof OneDriveConnectForm>> = {}) {
  return (
    <OneDriveConnectForm
      signIn={jest.fn(async (): Promise<SignInResult> => ({ ok: true, source: SOURCE }))}
      probe={jest.fn(async (): Promise<ProbeResult> => ({ kind: 'empty' }))}
      connect={jest.fn(async (): Promise<ConnectResult> => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' }))}
      onConnected={jest.fn()}
      busy={false}
      setBusy={jest.fn()}
      {...over}
    />
  );
}

describe('OneDriveConnectForm', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('starts with the intro and one 「Sign in with Microsoft」 row; no fields, no VPN caveat', async () => {
    await render(form());
    expect(screen.getByTestId('onedrive-sign-in')).toBeTruthy();
    expect(screen.getByText(/Apps → Waifu Deck/)).toBeTruthy();
    expect(screen.queryByTestId('byos-field-password')).toBeNull();
    expect(screen.queryByText(/VPN/i)).toBeNull();
  });

  it('sign-in → probe empty: shows the account e-mail, password + confirm, no encryption toggle; create shows the warning; confirm connects with the source', async () => {
    const connect = jest.fn(async (): Promise<ConnectResult> => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' }));
    const probe = jest.fn(async (): Promise<ProbeResult> => ({ kind: 'empty' }));
    const onConnected = jest.fn();
    await render(form({ connect, probe, onConnected }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    expect(probe).toHaveBeenCalledWith(SOURCE);
    expect(await screen.findByTestId('onedrive-account')).toHaveTextContent(/owner@example\.com/);
    expect(screen.getByTestId('onedrive-probe-empty')).toBeTruthy();
    expect(screen.queryByTestId('byos-encryption-toggle')).toBeNull();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('byos-field-password'), 'pw');
      fireEvent.changeText(screen.getByTestId('byos-field-password-confirm'), 'pw');
    });
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-create'));
    });
    expect(screen.getByText('Your password cannot be recovered')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Create' });
    await act(async () => {
      await userEvent.press(buttons[buttons.length - 1]!);
    });
    expect(connect).toHaveBeenCalledWith({
      source: SOURCE, probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw',
    });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('create with an empty or mismatched password shows the local error and never opens the warning', async () => {
    await render(form());
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    await screen.findByTestId('byos-create');
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-create'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Enter a password.');
    expect(screen.queryByText('Your password cannot be recovered')).toBeNull();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('byos-field-password'), 'a');
      fireEvent.changeText(screen.getByTestId('byos-field-password-confirm'), 'b');
    });
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-create'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('The passwords do not match.');
  });

  it('sign-in → existing encrypted library: password + join; a wrong password shows the error and keeps the account', async () => {
    const meta = {
      format: 'waifu-deck-byos' as const,
      protocolVersion: 2,
      encryption: 'aes-gcm' as const,
      vaultId: 'v',
      kdf: {
        algo: 'scrypt' as const, N: 16384, r: 8, p: 1, saltB64: 'c2FsdA',
      },
      keyCheckB64: 'a2V5',
      createdAt: '2026-09-20T00:00:00.000Z',
    };
    const connect = jest.fn(async (): Promise<ConnectResult> => ({ ok: false, category: 'wrong_password' }));
    await render(form({
      probe: jest.fn(async (): Promise<ProbeResult> => ({ kind: 'existing-encrypted', meta })),
      connect,
    }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    await screen.findByTestId('byos-probe-existing-encrypted');
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('byos-field-password'), 'nope');
    });
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-join'));
    });
    expect(connect).toHaveBeenCalledWith({
      source: SOURCE, probe: { kind: 'existing-encrypted', meta }, password: 'nope',
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Incorrect password.');
    expect(screen.getByTestId('onedrive-account')).toBeTruthy();
  });

  it('a cancelled sign-in shows the cancelled copy and keeps the sign-in row', async () => {
    await render(form({
      signIn: jest.fn(async (): Promise<SignInResult> => ({ ok: false, category: 'sign_in_cancelled' })),
    }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Sign-in was cancelled.');
    expect(screen.getByTestId('onedrive-sign-in')).toBeTruthy();
    expect(screen.queryByTestId('onedrive-account')).toBeNull();
  });

  it('sign in twice — cancelled then ok — clears the stale cancelled-copy error once the account line appears', async () => {
    const signIn = jest
      .fn<Promise<SignInResult>, []>()
      .mockResolvedValueOnce({ ok: false, category: 'sign_in_cancelled' })
      .mockResolvedValueOnce({ ok: true, source: SOURCE });
    await render(form({ signIn }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Sign-in was cancelled.');
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    expect(screen.getByTestId('onedrive-account')).toBeTruthy();
    expect(screen.queryByTestId('byos-error')).toBeNull();
  });

  it('board row 15: a stale sign-in error is gone the moment a new sign-in starts, not only once it succeeds (aligned with the Drive form)', async () => {
    let finish: (value: SignInResult) => void = () => {};
    const signIn = jest
      .fn<Promise<SignInResult>, []>()
      .mockResolvedValueOnce({ ok: false, category: 'network' })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(form({ signIn }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    expect(screen.queryByTestId('byos-error')).toBeNull();
    await act(async () => {
      finish({ ok: false, category: 'sign_in_cancelled' });
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Sign-in was cancelled.');
  });

  it('a probe failure after a successful sign-in shows its copy and keeps the account line', async () => {
    await render(form({
      probe: jest.fn(async (): Promise<ProbeResult> => ({ kind: 'error', category: 'not_onedrive' })),
    }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent(/OneDrive did not answer as expected/);
    expect(screen.getByTestId('onedrive-account')).toBeTruthy();
  });

  it('a network failure during sign-in uses the Microsoft-specific network copy (signInFlowErrorKey), not the generic vault-network copy', async () => {
    await render(form({
      signIn: jest.fn(async (): Promise<SignInResult> => ({ ok: false, category: 'network' })),
    }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('onedrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Could not reach Microsoft. Check your network and try again.');
  });
});
