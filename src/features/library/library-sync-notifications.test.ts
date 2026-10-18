import { PermissionsAndroid, Platform } from 'react-native';

import {
  requestPostNotificationsPermission,
} from '@/features/library/library-sync-notifications';

describe('requestPostNotificationsPermission', () => {
  const request = jest.spyOn(PermissionsAndroid, 'request');

  // `jest-expo` runs this project's suite on the iOS platform shim, so the
  // Android branch — the only one that exists in production — has to be pinned
  // explicitly. The iOS case is covered by its own test below.
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    Object.defineProperty(Platform, 'Version', { value: 34, configurable: true });
  });

  afterEach(() => {
    request.mockReset();
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  it('asks for POST_NOTIFICATIONS on API 33 and up', async () => {
    request.mockResolvedValue('granted' as never);
    await expect(requestPostNotificationsPermission()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS');
  });

  it('reports a denial without throwing', async () => {
    request.mockResolvedValue('denied' as never);
    await expect(requestPostNotificationsPermission()).resolves.toBe(false);
  });

  it('does not ask below API 33, where the permission does not exist', async () => {
    Object.defineProperty(Platform, 'Version', { value: 31, configurable: true });
    await expect(requestPostNotificationsPermission()).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('treats a failed request as a denial, never a crash', async () => {
    request.mockRejectedValue(new Error('no activity'));
    await expect(requestPostNotificationsPermission()).resolves.toBe(false);
  });

  it('never asks on a non-Android platform', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    await expect(requestPostNotificationsPermission()).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
