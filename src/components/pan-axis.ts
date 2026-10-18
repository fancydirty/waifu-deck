export const AXIS_UNLOCKED = 0;
export const AXIS_HORIZONTAL = 1;
export const AXIS_VERTICAL = 2;

/**
 * Movement needed to commit to an axis. The card is motionless until this is
 * crossed, so it is a dead zone layered on top of the gesture handler's own pan
 * activation slop (~8dp on Android). Keep it at or below that slop: any larger
 * value spends real finger travel on a frozen card, which reads as lag rather
 * than as intent detection.
 */
export const PAN_AXIS_LOCK_PX = 6;
export const PEEK_TRAVEL_PX = 190;
export const PEEK_SETTLE_RATIO = 0.5;

/** 0=未锁,1=水平(滑卡),2=垂直(peek)。锁定后不再改变,直到手势结束。 */
export function getPanAxisLock(
  previous: number,
  translationX: number,
  translationY: number,
): number {
  'worklet';
  if (previous !== AXIS_UNLOCKED) return previous;
  const ax = Math.abs(translationX);
  const ay = Math.abs(translationY);
  if (ax >= PAN_AXIS_LOCK_PX && ax > ay) return AXIS_HORIZONTAL;
  if (ay >= PAN_AXIS_LOCK_PX && ay > ax) return AXIS_VERTICAL;
  return AXIS_UNLOCKED;
}

/** 松手后 peek 收敛目标:1 全展开 / 0 弹回。 */
export function getPeekSettle(peekRatio: number): 0 | 1 {
  'worklet';
  return peekRatio >= PEEK_SETTLE_RATIO ? 1 : 0;
}

/** Applies a pan's vertical delta to the progress at gesture start. */
export function getPeekProgressForTranslation(
  startProgress: number,
  translationY: number,
): number {
  'worklet';
  return Math.max(0, Math.min(1, startProgress - translationY / PEEK_TRAVEL_PX));
}
