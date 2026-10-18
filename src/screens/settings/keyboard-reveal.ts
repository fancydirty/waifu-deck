import { createContext } from 'react';
import type { HostInstance } from 'react-native';

export const KEYBOARD_REVEAL_GAP = 16;

export type MeasureLayout = (
  relativeTo: HostInstance | number,
  onSuccess: (left: number, top: number, width: number, height: number) => void,
  onFail?: () => void,
) => void;

export type KeyboardRevealContextValue = {
  reveal(measureLayout: MeasureLayout): void;
  release(measureLayout: MeasureLayout): void;
};

export const KeyboardRevealContext = createContext<KeyboardRevealContextValue | null>(null);

export function scrollOffsetToReveal({
  fieldTop,
  fieldHeight,
  currentScrollOffset,
  viewportHeight,
  keyboardHeight,
  bottomInset,
  gap,
}: {
  fieldTop: number;
  fieldHeight: number;
  currentScrollOffset: number;
  viewportHeight: number;
  keyboardHeight: number;
  bottomInset: number;
  gap: number;
}): number {
  if (keyboardHeight <= 0) return Math.max(currentScrollOffset, 0);

  const keyboardTop = viewportHeight - (keyboardHeight + bottomInset);
  const fieldBottom = fieldTop + fieldHeight - currentScrollOffset;
  if (fieldBottom <= keyboardTop - gap) return Math.max(currentScrollOffset, 0);

  return Math.max(
    currentScrollOffset,
    fieldTop + fieldHeight - keyboardTop + gap,
  );
}
