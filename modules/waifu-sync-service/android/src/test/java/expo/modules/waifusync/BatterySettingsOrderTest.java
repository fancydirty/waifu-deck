package expo.modules.waifusync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class BatterySettingsOrderTest {
  private static final String DIALOG = "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS";
  private static final String LIST = "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS";
  private static final String DETAILS = "android.settings.APPLICATION_DETAILS_SETTINGS";

  @Test
  public void allResolveOpensDialog() {
    assertEquals(DIALOG, BatterySettingsOrder.firstResolvable(action -> true));
  }

  @Test
  public void listAndDetailsResolveOpensList() {
    assertEquals(LIST, BatterySettingsOrder.firstResolvable(action -> !DIALOG.equals(action)));
  }

  @Test
  public void onlyDetailsResolvesOpensDetails() {
    assertEquals(DETAILS, BatterySettingsOrder.firstResolvable(DETAILS::equals));
  }

  @Test
  public void noneResolveChecksAllThreeInOrderAndReturnsNull() {
    List<String> asked = new ArrayList<>();
    assertNull(BatterySettingsOrder.firstResolvable(action -> {
      asked.add(action);
      return false;
    }));
    assertEquals(Arrays.asList(DIALOG, LIST, DETAILS), asked);
  }

  @Test
  public void dialogAndDetailsNeedPackageUriButListDoesNot() {
    assertTrue(BatterySettingsOrder.needsPackageUri(DIALOG));
    assertFalse(BatterySettingsOrder.needsPackageUri(LIST));
    assertTrue(BatterySettingsOrder.needsPackageUri(DETAILS));
  }
}
