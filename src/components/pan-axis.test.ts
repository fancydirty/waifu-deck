import { isWorkletFunction } from 'react-native-worklets';

import {
  AXIS_UNLOCKED,
  getPanAxisLock,
  getPeekProgressForTranslation,
  getPeekSettle,
  PAN_AXIS_LOCK_PX,
  PEEK_TRAVEL_PX,
} from './pan-axis';

describe('getPanAxisLock', () => {
  test('is serializable into the UI-thread gesture', () => {
    expect(isWorkletFunction(getPanAxisLock)).toBe(true);
  });

  test('locks no later than the platform pan slop already spent', () => {
    // The card cannot move at all until an axis is locked, so this constant is a
    // dead zone stacked on top of the gesture handler's own activation slop
    // (~8dp on Android). Keeping it at or below that slop means the first frame
    // we are given is already decisive, and the card tracks the finger from the
    // first pixel of movement we can actually see.
    expect(PAN_AXIS_LOCK_PX).toBeLessThanOrEqual(8);
    expect(getPanAxisLock(AXIS_UNLOCKED, 8, 0)).toBe(1);
  });

  test('still ignores sub-slop jitter rather than locking on noise', () => {
    expect(getPanAxisLock(AXIS_UNLOCKED, 3, 0)).toBe(0);
    expect(getPanAxisLock(AXIS_UNLOCKED, 0, 3)).toBe(0);
  });

  test('picks the dominant axis, not merely the first to cross', () => {
    expect(getPanAxisLock(AXIS_UNLOCKED, 0, 15)).toBe(2);
    expect(getPanAxisLock(AXIS_UNLOCKED, 20, 25)).toBe(2);
    expect(getPanAxisLock(AXIS_UNLOCKED, 20, 5)).toBe(1);
  });
  test('locked axis stays locked', () => {
    expect(getPanAxisLock(1, 5, 60)).toBe(1);
    expect(getPanAxisLock(2, 90, 5)).toBe(2);
  });
});

describe('getPeekSettle', () => {
  test('is serializable into the UI-thread gesture', () => {
    expect(isWorkletFunction(getPeekSettle)).toBe(true);
  });

  test('settles open past 0.5 ratio, closed below', () => {
    expect(getPeekSettle(0.51)).toBe(1);
    expect(getPeekSettle(0.49)).toBe(0);
  });
  test('travel is the spec distance', () => {
    expect(PEEK_TRAVEL_PX).toBe(190);
  });
});

describe('getPeekProgressForTranslation', () => {
  test('is serializable into the UI-thread gesture', () => {
    expect(isWorkletFunction(getPeekProgressForTranslation)).toBe(true);
  });

  test('closes continuously from an already-open peek on downward drag', () => {
    expect(getPeekProgressForTranslation(1, 95)).toBe(0.5);
    expect(getPeekProgressForTranslation(1, 190)).toBe(0);
  });

  test('preserves partial settle semantics after an interrupted drag', () => {
    expect(getPeekSettle(getPeekProgressForTranslation(1, 76))).toBe(1);
    expect(getPeekSettle(getPeekProgressForTranslation(1, 114))).toBe(0);
  });

  test('supports reversing direction without jumping or locking the axis', () => {
    expect(getPeekProgressForTranslation(0.5, -38)).toBe(0.7);
    expect(getPeekProgressForTranslation(0.5, 38)).toBe(0.3);
  });

  test('clamps horizontal takeover and overscroll to the peek bounds', () => {
    expect(getPeekProgressForTranslation(1, 240)).toBe(0);
    expect(getPeekProgressForTranslation(0, -240)).toBe(1);
  });
});
