package expo.modules.waifusync;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.function.Predicate;

final class BatterySettingsOrder {
  static final List<String> ACTIONS = Collections.unmodifiableList(Arrays.asList(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS",
      "android.settings.APPLICATION_DETAILS_SETTINGS"));

  static String firstResolvable(Predicate<String> resolves) {
    for (String action : ACTIONS) {
      if (resolves.test(action)) return action;
    }
    return null;
  }

  static boolean needsPackageUri(String action) {
    return ACTIONS.get(0).equals(action) || ACTIONS.get(2).equals(action);
  }
}
