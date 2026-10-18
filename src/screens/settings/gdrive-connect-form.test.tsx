import { act, fireEvent, render, screen, userEvent, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type {
  ConnectResult, GdriveSignInResult, GdriveSource, ProbeResult,
} from '@/features/byos/byos-connect-flow';
import i18n from '@/i18n';
import { GdriveConnectForm } from '@/screens/settings/gdrive-connect-form';
import { metrics } from '@/theme/metrics';

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { ChevronRight: Icon };
});

const SOURCE: GdriveSource = {
  binding: {
    kind: 'gdrive',
    refreshToken: 'RT',
    accountEmail: 'owner@gmail.com',
    rootFolderId: 'G1',
    stateFolderId: 'G2',
    blobsFolderId: 'G3',
  },
  accessToken: 'AT',
  expiresAt: 9,
};

const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const;
const MICROSOFT = /OneDrive|Microsoft|微软|微軟|マイクロソフト/;

function form(over: Partial<React.ComponentProps<typeof GdriveConnectForm>> = {}) {
  return (
    <GdriveConnectForm
      signIn={jest.fn(async (): Promise<GdriveSignInResult> => ({ ok: true, source: SOURCE }))}
      probe={jest.fn(async (): Promise<ProbeResult> => ({ kind: 'empty' }))}
      connect={jest.fn(async (): Promise<ConnectResult> => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' }))}
      onConnected={jest.fn()}
      busy={false}
      setBusy={jest.fn()}
      {...over}
    />
  );
}

describe('GdriveConnectForm', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('starts with the intro, the needs-Google caveat and one 「Sign in with Google」 row; no fields', async () => {
    await render(form());
    expect(screen.getByTestId('gdrive-sign-in')).toHaveTextContent('Sign in with Google');
    expect(screen.getByText(/“Waifu Deck” folder in your Google Drive/)).toBeTruthy();
    expect(screen.getByTestId('gdrive-needs-google')).toHaveTextContent('Needs a network that can reach Google.');
    expect(screen.queryByTestId('byos-field-password')).toBeNull();
  });

  it('U4-design visual pass: the explanation prose is one card and the sign-in row is its own row card', async () => {
    await render(form());
    const cards = screen.container.queryAll((node) => {
      const style = StyleSheet.flatten(node.props.style);
      return style?.borderRadius === metrics.radius.card && style?.marginHorizontal === metrics.settingsGutter;
    });
    expect(cards).toHaveLength(2);
    const explanation = cards.find((card) =>
      within(card).queryByTestId('gdrive-needs-google') !== null);
    expect(explanation).toBeDefined();
    expect(within(explanation!).getByText(/“Waifu Deck” folder in your Google Drive/)).toBeOnTheScreen();
    const signIn = cards.find((card) => within(card).queryByTestId('gdrive-sign-in') !== null);
    expect(signIn).toBeDefined();
  });

  it('zh-Hans: the sign-in row reads 「用 Google 登录」 and the caveat carries 「需要能访问 Google」 (补裁 12)', async () => {
    await i18n.changeLanguage('zh-Hans');
    await render(form());
    expect(screen.getByTestId('gdrive-sign-in')).toHaveTextContent('用 Google 登录');
    expect(screen.getByTestId('gdrive-needs-google')).toHaveTextContent(/需要能访问 Google/);
  });

  it.each(LOCALES)('%s: nothing on the Drive form names Microsoft', async (lng) => {
    await i18n.changeLanguage(lng);
    await render(form());
    expect(screen.getByTestId('gdrive-connect-form')).not.toHaveTextContent(MICROSOFT);
  });

  it('sign-in → probe empty: shows the account e-mail, password + confirm, no encryption toggle; create shows the warning; confirm connects with the source', async () => {
    const connect = jest.fn(async (): Promise<ConnectResult> => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' }));
    const probe = jest.fn(async (): Promise<ProbeResult> => ({ kind: 'empty' }));
    const onConnected = jest.fn();
    await render(form({ connect, probe, onConnected }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(probe).toHaveBeenCalledWith(SOURCE);
    expect(await screen.findByTestId('gdrive-account')).toHaveTextContent('Signed in as owner@gmail.com');
    expect(screen.queryByTestId('gdrive-sign-in')).toBeNull();
    expect(screen.getByTestId('gdrive-probe-empty')).toBeTruthy();
    expect(screen.getByText('Cloud-drive libraries are always encrypted with your password.')).toBeTruthy();
    expect(screen.queryByTestId('byos-encryption-toggle')).toBeNull();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('byos-field-password'), 'pw');
      fireEvent.changeText(screen.getByTestId('byos-field-password-confirm'), 'pw');
    });
    await act(async () => {
      await userEvent.press(screen.getByTestId('byos-create'));
    });
    expect(screen.getByText('Your password cannot be recovered')).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
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
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
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
    expect(screen.queryByText('Your password cannot be recovered')).toBeNull();
  });

  it('sign-in → existing encrypted library: ONE password field + join (no confirm, no toggle); a wrong password shows the error and keeps the account', async () => {
    const meta = {
      format: 'waifu-deck-byos' as const,
      protocolVersion: 2,
      encryption: 'aes-gcm' as const,
      vaultId: 'v',
      kdf: {
        algo: 'scrypt' as const, N: 16384, r: 8, p: 1, saltB64: 'c2FsdA',
      },
      keyCheckB64: 'a2V5',
      createdAt: '2026-09-25T00:00:00.000Z',
    };
    const connect = jest.fn(async (): Promise<ConnectResult> => ({ ok: false, category: 'wrong_password' }));
    await render(form({
      probe: jest.fn(async (): Promise<ProbeResult> => ({ kind: 'existing-encrypted', meta })),
      connect,
    }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    await screen.findByTestId('byos-probe-existing-encrypted');
    expect(screen.getAllByTestId('byos-field-password')).toHaveLength(1);
    expect(screen.queryByTestId('byos-field-password-confirm')).toBeNull();
    expect(screen.queryByTestId('byos-encryption-toggle')).toBeNull();
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
    expect(screen.getByTestId('gdrive-account')).toBeTruthy();
  });

  it('a cancelled sign-in shows the cancelled copy and keeps the sign-in row', async () => {
    await render(form({
      signIn: jest.fn(async (): Promise<GdriveSignInResult> => ({ ok: false, category: 'sign_in_cancelled' })),
    }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Sign-in was cancelled.');
    expect(screen.getByTestId('gdrive-sign-in')).toBeTruthy();
    expect(screen.queryByTestId('gdrive-account')).toBeNull();
  });

  it('sign in twice — cancelled then ok — clears the stale cancelled-copy error once the account line appears (P12-C f3c24f2)', async () => {
    const signIn = jest
      .fn<Promise<GdriveSignInResult>, []>()
      .mockResolvedValueOnce({ ok: false, category: 'sign_in_cancelled' })
      .mockResolvedValueOnce({ ok: true, source: SOURCE });
    await render(form({ signIn }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Sign-in was cancelled.');
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(screen.getByTestId('gdrive-account')).toBeTruthy();
    expect(screen.queryByTestId('byos-error')).toBeNull();
  });

  it('a stale sign-in error is gone the moment a new sign-in starts, not only once it succeeds', async () => {
    let finish: (value: GdriveSignInResult) => void = () => {};
    const signIn = jest
      .fn<Promise<GdriveSignInResult>, []>()
      .mockResolvedValueOnce({ ok: false, category: 'network' })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(form({ signIn }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(screen.queryByTestId('byos-error')).toBeNull();
    await act(async () => {
      finish({ ok: false, category: 'sign_in_cancelled' });
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Sign-in was cancelled.');
  });

  it('a probe failure after a successful sign-in shows the Drive copy and keeps the account line', async () => {
    await render(form({
      probe: jest.fn(async (): Promise<ProbeResult> => ({ kind: 'error', category: 'not_gdrive' })),
    }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent(/Google Drive did not answer as expected/);
    expect(screen.getByTestId('gdrive-account')).toBeTruthy();
  });

  it('a network failure during sign-in uses the Google network copy (signInFlowErrorKey gdrive), never Microsoft or the vault-network copy', async () => {
    await render(form({
      signIn: jest.fn(async (): Promise<GdriveSignInResult> => ({ ok: false, category: 'network' })),
    }));
    await act(async () => {
      await userEvent.press(screen.getByTestId('gdrive-sign-in'));
    });
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Could not reach Google. Check your network and try again.');
  });
});
