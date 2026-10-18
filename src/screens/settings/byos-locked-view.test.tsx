import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text, View } from 'react-native';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import { cloudSnapshot } from '@/test/cloud-library-fixtures';
import { ByosLockedView } from './byos-locked-view';

jest.mock('lucide-react-native', () => ({ Check: () => null, Cloud: () => null, Lock: () => null, Server: () => null, ChevronRight: () => null }));

const status: ByosStatus = { status: 'locked', reason: 'password_required' };
const data = cloudSnapshot(status);

describe('ByosLockedView', () => {
  it('shows three dashes, the action inside the card, and no figures', async () => {
    await render(<ByosLockedView
      data={data}
      password=""
      busy={false}
      onPasswordChange={jest.fn()}
      onUnlock={jest.fn()}
      onReauth={jest.fn()}
      backgroundSync={{ isBatteryOptimizationIgnored: () => false, requestIgnoreBatteryOptimizations: async () => undefined }}
      disconnect={<View testID="disconnect-node" />}
      message={<Text testID="byos-error">Enter your password.</Text>}
    />);
    expect(screen.getByTestId('byos-locked-view')).toBeOnTheScreen();
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.queryByText('0 images')).toBeNull();
    expect(screen.getByTestId('byos-unlock-password').props.secureTextEntry).toBe(true);
    expect(screen.getByTestId('byos-unlock')).toBeOnTheScreen();
    expect(screen.getByTestId('byos-error')).toHaveTextContent('Enter your password.');
    expect(screen.getByTestId('byos-background-sync')).toBeOnTheScreen();
  });

  it('does not render a password field for reauthentication and dispatches the named provider', async () => {
    const reauthData = cloudSnapshot({ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' });
    const onReauth = jest.fn();
    await render(<ByosLockedView
      data={reauthData}
      message={<Text>Sign in again.</Text>}
      password=""
      busy={false}
      onPasswordChange={jest.fn()}
      onUnlock={jest.fn()}
      onReauth={onReauth}
      disconnect={<View testID="disconnect-node" />}
    />);
    expect(screen.queryByTestId('byos-unlock-password')).toBeNull();
    expect(screen.queryByTestId('byos-unlock')).toBeNull();
    await fireEvent.press(screen.getByTestId('byos-reauth'));
    expect(onReauth).toHaveBeenCalledWith('gdrive');
  });
});
