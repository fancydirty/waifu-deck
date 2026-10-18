import { render } from '@testing-library/react-native';

import type { LibraryStorageModeControl } from '@/features/library/library-integration-types';
import { ByosSettingsSlot } from '@/screens/settings/byos-settings-slot';
import { renderCloudMessage } from '@/test/cloud-message-fixture';
import { CloudLibraryContext } from './cloud-library-context';
import { cloudSnapshot } from '@/test/cloud-library-fixtures';
jest.mock('@/providers/app-services', () => ({ useAppServices: jest.fn() }));
jest.mock('expo-router', () => ({ usePathname: () => '/settings' }));
jest.mock('lucide-react-native', () => ({ Check: () => null, ChevronRight: () => null, Cloud: () => null, Lock: () => null, Server: () => null }));

let mockSectionProps: Record<string, unknown> | null = null;

jest.mock('@/features/byos/byos-connect-flow', () => ({
  probeBucket: jest.fn(),
  connectToBucket: jest.fn(),
  probeWebdav: jest.fn(),
  connectWebdav: jest.fn(),
  signInWithMicrosoft: jest.fn(),
  probeOneDrive: jest.fn(),
  connectOneDrive: jest.fn(),
  reauthOneDrive: jest.fn(),
  signInWithGoogle: jest.fn(),
  probeGdrive: jest.fn(),
  connectGdrive: jest.fn(),
  reauthGdrive: jest.fn(),
  disconnectDevice: jest.fn(),
}));
jest.mock('@/features/byos/byos-credentials', () => ({
  createByosCredentialStore: jest.fn(() => ({
    load: jest.fn(async () => null),
    loadBinding: jest.fn(async () => null),
  })),
}));
jest.mock('@/screens/settings/byos-settings-section', () => ({
  ByosSettingsSection: (props: Record<string, unknown>) => {
    mockSectionProps = props;
    return null;
  },
}));

function renderSlot(storageMode: LibraryStorageModeControl | null) {
  return render(
    <CloudLibraryContext.Provider value={cloudSnapshot({ status: 'unconfigured' })}>
    <ByosSettingsSlot
      renderCloudMessage={renderCloudMessage}
      byosStatus={{ status: 'unconfigured' }}
      actions={null}
      sync={null}
      libraryChanges={null}
      storageMode={storageMode}
      onReload={() => undefined}
    />
    </CloudLibraryContext.Provider>,
  );
}

describe('ByosSettingsSlot storage mode (board #27 S3b)', () => {
  beforeEach(() => {
    mockSectionProps = null;
  });

  it("hands the section the composition's storage mode", async () => {
    const control: LibraryStorageModeControl = { read: jest.fn(), set: jest.fn() };

    await renderSlot(control);

    expect(mockSectionProps!.storageMode).toBe(control);
  });

  it('no control, no prop', async () => {
    await renderSlot(null);

    expect(mockSectionProps).not.toBeNull();
    expect(mockSectionProps!.storageMode).toBeUndefined();
  });
});
