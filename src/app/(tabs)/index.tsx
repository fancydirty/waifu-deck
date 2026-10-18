import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DiscoverScreen } from '@/screens/discover/discover-screen';

export default function DiscoverRoute() {
  // R8.17: all four tabs run headerless now, so the discover screen owns its
  // top safe area again — pass the real status-bar inset down.
  const insets = useSafeAreaInsets();
  return <DiscoverScreen safeAreaTop={insets.top} />;
}
