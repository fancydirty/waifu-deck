import { act, fireEvent, render, screen, userEvent, within } from '@testing-library/react-native';
import * as Linking from 'expo-linking';
import { StyleSheet } from 'react-native';
import type { TestInstance } from 'test-renderer';

import type { ConnectResult, ProbeResult, WebdavConnectFields } from '@/features/byos/byos-connect-flow';
import i18n from '@/i18n';
import { WebdavConnectForm } from '@/screens/settings/webdav-connect-form';
import { metrics } from '@/theme/metrics';

jest.mock('lucide-react-native', () => ({ ChevronRight: () => null }));
jest.mock('expo-linking', () => ({ openURL: jest.fn(async () => undefined) }));

const AWESOME = 'https://github.com/fstanis/awesome-webdav#cloud-providers';

function form(over: Partial<React.ComponentProps<typeof WebdavConnectForm>> = {}) {
  return (
    <WebdavConnectForm
      probe={jest.fn(async () => ({ kind: 'empty' }) as ProbeResult)}
      connect={jest.fn(async () => ({ ok: true, vaultId: 'v', encryption: 'aes-gcm' }) as ConnectResult)}
      onConnected={jest.fn()}
      busy={false}
      setBusy={jest.fn()}
      {...over}
    />
  );
}

beforeEach(async () => i18n.changeLanguage('en'));

const httpsHint = () => i18n.t('settings.byos.webdav.httpsHint');
const securityHint = () => i18n.t('settings.byos.webdav.securityHint');

/** Depth-first render order of testIDs (`#id`) and non-empty text. */
function marksIn(node: TestInstance): string[] {
  const marks: string[] = [];
  const visit = (current: TestInstance) => {
    if (typeof current.props.testID === 'string') marks.push(`#${current.props.testID}`);
    for (const child of current.children) {
      if (typeof child === 'string') {
        if (child.trim() !== '') marks.push(child);
      } else {
        visit(child);
      }
    }
  };
  visit(node);
  return marks;
}

function formMarks(): string[] {
  return marksIn(screen.getByTestId('webdav-connect-form'));
}

/** The v4 group cards on the form (U4-design visual pass). */
function connectCards() {
  return screen.container.queryAll((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.borderRadius === metrics.radius.card && style?.marginHorizontal === metrics.settingsGutter;
  });
}

function betweenLastFieldAndCheck(marks: string[]): string[] {
  // The root-path field is gone (U4-design 2026-10-12): the login password
  // field is now the last field before the hints and the check row.
  const start = marks.indexOf('#webdav-field-password');
  const end = marks.indexOf('#webdav-check');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return marks.slice(start + 1, end);
}

const hintsBetweenFieldAndCheck = () => [httpsHint(), securityHint()];

test('leaves only the https hint and the security hint between the last field and the check row', async () => {
  await render(form());
  expect(betweenLastFieldAndCheck(formMarks())).toEqual(hintsBetweenFieldAndCheck());
});

test('an error line is the only extra node between the last field and the check row', async () => {
  await render(form({
    probe: jest.fn(async () => ({ kind: 'error', category: 'insecure_url' }) as ProbeResult),
  }));
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  await screen.findByTestId('byos-error');
  expect(betweenLastFieldAndCheck(formMarks())).toEqual([
    ...hintsBetweenFieldAndCheck(),
    '#byos-error',
    i18n.t('settings.byos.error.insecureUrl'),
  ]);
});

test('a probe result stays after the check row, so it is not between the last field and the check', async () => {
  await render(form());
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  await screen.findByTestId('webdav-probe-empty');
  const emptyMarks = formMarks();
  expect(betweenLastFieldAndCheck(emptyMarks)).toEqual(hintsBetweenFieldAndCheck());
  expect(emptyMarks.indexOf('#webdav-check')).toBeLessThan(emptyMarks.indexOf('#webdav-probe-empty'));
});

test('an existing-encrypted probe result also stays after the check row', async () => {
  const meta = {
    format: 'waifu-deck-byos' as const,
    protocolVersion: 2,
    encryption: 'aes-gcm' as const,
    vaultId: 'v1',
    kdf: { algo: 'scrypt' as const, N: 16384, r: 8, p: 1, saltB64: 'c2FsdA==' },
    keyCheckB64: 'a2V5',
    createdAt: '2026-09-19T00:00:00.000Z',
  };
  await render(form({
    probe: jest.fn(async () => ({ kind: 'existing-encrypted', meta }) as ProbeResult),
  }));
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  await screen.findByTestId('byos-probe-existing-encrypted');
  const marks = formMarks();
  expect(betweenLastFieldAndCheck(marks)).toEqual(hintsBetweenFieldAndCheck());
  expect(marks.indexOf('#webdav-check')).toBeLessThan(marks.indexOf('#byos-probe-existing-encrypted'));
});

test('U4-design visual pass: fields + both footnotes share ONE card, and the link/check rows are row cards', async () => {
  await render(form());
  const fieldCards = connectCards().filter((card) => within(card).queryByTestId('webdav-field-url') !== null);
  expect(fieldCards).toHaveLength(1);
  const card = fieldCards[0]!;
  for (const id of ['webdav-field-url', 'webdav-field-username', 'webdav-field-password']) {
    expect(within(card).getByTestId(id)).toBeOnTheScreen();
  }
  // httpsHint and securityHint sit at the card foot, after the last field.
  expect(within(card).getByText(httpsHint())).toBeOnTheScreen();
  expect(within(card).getByText(securityHint())).toBeOnTheScreen();
  const cardJson = JSON.stringify(card);
  expect(cardJson.indexOf('webdav-field-password')).toBeLessThan(cardJson.indexOf(httpsHint()));
  expect(cardJson.indexOf(httpsHint())).toBeLessThan(cardJson.indexOf(securityHint()));
  // The link row and the check row are each their own row card.
  for (const id of ['webdav-guide-link', 'webdav-check']) {
    const rowCards = connectCards().filter((candidate) => within(candidate).queryByTestId(id) !== null);
    expect(rowCards).toHaveLength(1);
  }
});

test('renders three fields, the https hint and the awesome-webdav row, which opens in the browser', async () => {
  await render(form());
  for (const id of ['webdav-field-url', 'webdav-field-username', 'webdav-field-password']) {
    expect(screen.getByTestId(id)).toBeTruthy();
  }
  expect(screen.getByText(/https:\/\/ address/)).toBeTruthy();
  expect(screen.getByText(i18n.t('settings.byos.webdav.guideMore'))).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByTestId('webdav-guide-link'));
  });
  expect(Linking.openURL).toHaveBeenCalledWith(AWESOME);
});

test('check → empty probe shows the encrypted-note, password + confirm, no encryption toggle; create shows the warning; confirm connects', async () => {
  const connect = jest.fn(async () => ({ ok: true as const, vaultId: 'v', encryption: 'aes-gcm' as const }));
  const onConnected = jest.fn();
  await render(form({ connect, onConnected }));
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('webdav-field-url'), 'https://dav.example');
    fireEvent.changeText(screen.getByTestId('webdav-field-username'), 'u');
    fireEvent.changeText(screen.getByTestId('webdav-field-password'), 'p');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  await screen.findByTestId('webdav-probe-empty');
  expect(screen.queryByTestId('byos-encryption-toggle')).toBeNull();
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('byos-field-password'), 'pw');
    fireEvent.changeText(screen.getByTestId('byos-field-password-confirm'), 'pw');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('byos-create'));
  });
  expect(await screen.findByText(/permanently loses access/)).toBeTruthy();
  const buttons = screen.getAllByRole('button', { name: 'Create' });
  await act(async () => {
    await userEvent.press(buttons[buttons.length - 1]!);
  });
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw', passwordConfirm: 'pw', probe: { kind: 'empty' } }));
  expect(onConnected).toHaveBeenCalledTimes(1);
});

test('an existing encrypted vault asks for the password only (no confirm, no warning) and joins', async () => {
  const meta = {
    format: 'waifu-deck-byos' as const,
    protocolVersion: 2,
    encryption: 'aes-gcm' as const,
    vaultId: 'v1',
    kdf: { algo: 'scrypt' as const, N: 16384, r: 8, p: 1, saltB64: 'c2FsdA==' },
    keyCheckB64: 'a2V5',
    createdAt: '2026-09-19T00:00:00.000Z',
  };
  const connect = jest.fn(async () => ({ ok: true as const, vaultId: 'v1', encryption: 'aes-gcm' as const }));
  await render(form({ probe: jest.fn(async () => ({ kind: 'existing-encrypted', meta }) as ProbeResult), connect }));
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('webdav-field-url'), 'https://dav.example');
    fireEvent.changeText(screen.getByTestId('webdav-field-username'), 'u');
    fireEvent.changeText(screen.getByTestId('webdav-field-password'), 'p');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  await screen.findByTestId('byos-probe-existing-encrypted');
  expect(screen.queryByTestId('byos-field-password-confirm')).toBeNull();
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('byos-field-password'), 'pw');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('byos-join'));
  });
  expect(screen.queryByText(/permanently loses access/)).toBeNull();
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw', probe: { kind: 'existing-encrypted', meta } }));
});

test('an insecure_url error renders the https copy', async () => {
  await render(form({ probe: jest.fn(async () => ({ kind: 'error', category: 'insecure_url' }) as ProbeResult) }));
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('webdav-field-url'), 'http://x');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  expect(await screen.findByTestId('byos-error')).toHaveTextContent('Enter an https:// address.');
});

test('create validates the password pair locally before the warning: empty → "Enter a password", mismatch → "do not match", no modal, connect never called', async () => {
  const connect = jest.fn(async () => ({ ok: true as const, vaultId: 'v', encryption: 'aes-gcm' as const }));
  await render(form({ connect }));
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('webdav-field-url'), 'https://dav.example');
    fireEvent.changeText(screen.getByTestId('webdav-field-username'), 'u');
    fireEvent.changeText(screen.getByTestId('webdav-field-password'), 'p');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  await screen.findByTestId('webdav-probe-empty');

  await act(async () => {
    await userEvent.press(screen.getByTestId('byos-create'));
  });
  expect(screen.getByTestId('byos-error')).toHaveTextContent('Enter a password.');
  expect(screen.queryByText(/permanently loses access/)).toBeNull();

  await act(async () => {
    fireEvent.changeText(screen.getByTestId('byos-field-password'), 'pw');
  });
  // Typing clears the stale error, as the S3 form does.
  expect(screen.queryByTestId('byos-error')).toBeNull();
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('byos-field-password-confirm'), 'other');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('byos-create'));
  });
  expect(screen.getByTestId('byos-error')).toHaveTextContent('The passwords do not match.');
  expect(screen.queryByText(/permanently loses access/)).toBeNull();
  expect(connect).not.toHaveBeenCalled();
});

// A WebDAV `network` failure is the server itself not answering, not a
// sign-in provider: the form keeps plain `errorKey`, never the drive forms'
// `signInFlowErrorKey` (P12-D Task 8).
test('a network probe failure renders the generic address copy, naming no sign-in provider', async () => {
  await render(form({ probe: jest.fn(async () => ({ kind: 'error', category: 'network' }) as ProbeResult) }));
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('webdav-field-url'), 'https://dav.example');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  const error = await screen.findByTestId('byos-error');
  expect(error).toHaveTextContent('Could not reach that address. Check your network and endpoint.');
  expect(error).not.toHaveTextContent(/Microsoft|Google/);
});

// Owner ruling 2026-10-12 (U4-design): the 「去哪里拿 WebDAV 地址？」 help block is
// deleted (title + 123 云盘 paragraph + NAS / Nextcloud / 自建 paragraph). The
// community awesome-webdav row stays, in place, above the address field.
test('U4-design: the help block is gone in every locale, and the awesome-webdav row stays before the address field', async () => {
  await render(form());
  const marks = formMarks();
  const urlAt = marks.indexOf('#webdav-field-url');
  expect(urlAt).toBeGreaterThanOrEqual(0);
  expect(marks.indexOf('#webdav-guide-link')).toBeGreaterThanOrEqual(0);
  expect(marks.indexOf('#webdav-guide-link')).toBeLessThan(urlAt);
  for (const lng of ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const) {
    for (const key of ['guideTitle', 'guide123', 'guideNas']) {
      expect(i18n.getResource(lng, 'translation', `settings.byos.webdav.${key}`)).toBeUndefined();
    }
    expect(i18n.getResource(lng, 'translation', 'settings.byos.webdav.guideMore')).toBeDefined();
  }
  expect(screen.queryByText(/123pan|123 云盘|123 雲盤/)).toBeNull();
  expect(screen.queryByText(/NAS \/ Nextcloud/)).toBeNull();
});

test('U4-design: the root-path field is gone and probes carry no rootPath (default root stays "/")', async () => {
  const probe = jest.fn(async (_fields: WebdavConnectFields) => ({ kind: 'empty' }) as ProbeResult);
  await render(form({ probe }));
  expect(screen.queryByTestId('webdav-field-root')).toBeNull();
  expect(i18n.getResource('en', 'translation', 'settings.byos.webdav.rootPath')).toBeUndefined();
  expect(i18n.getResource('en', 'translation', 'settings.byos.webdav.rootPathPlaceholder')).toBeUndefined();
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('webdav-field-url'), 'https://dav.example');
    fireEvent.changeText(screen.getByTestId('webdav-field-username'), 'u');
    fireEvent.changeText(screen.getByTestId('webdav-field-password'), 'p');
  });
  await act(async () => {
    await userEvent.press(screen.getByTestId('webdav-check'));
  });
  const sent = probe.mock.calls[0]![0] as Record<string, unknown>;
  // No rootPath key at all: the default "/" comes from the flow (pinned in
  // byos-connect-flow.test.ts), exactly as the empty field sent it.
  expect('rootPath' in sent).toBe(false);
  expect(sent).toMatchObject({ baseUrl: 'https://dav.example', username: 'u', password: 'p' });
});
