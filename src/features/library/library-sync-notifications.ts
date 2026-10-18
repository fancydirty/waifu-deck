import { PermissionsAndroid, Platform } from 'react-native';

/**
 * K6-3. Asks for POST_NOTIFICATIONS so the foreground service's notification is
 * actually visible.
 *
 * The answer never gates anything. A denied permission costs the user the
 * "syncing 2/3" line; the foreground service — and with it the unfrozen process
 * that lets the upload finish at all — starts either way. Below API 33 the
 * permission does not exist and notifications are granted by installing, so
 * there is nothing to ask.
 */
export async function requestPostNotificationsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (typeof Platform.Version === 'number' && Platform.Version < 33) return true;
  try {
    const result = await PermissionsAndroid.request(
      'android.permission.POST_NOTIFICATIONS' as Parameters<
        typeof PermissionsAndroid.request
      >[0],
    );
    return result === 'granted';
  } catch {
    return false;
  }
}
