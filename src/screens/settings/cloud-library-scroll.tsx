import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Keyboard, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { metrics } from '@/theme/metrics';
import { KeyboardRevealContext, KEYBOARD_REVEAL_GAP, scrollOffsetToReveal, type MeasureLayout } from './keyboard-reveal';
import { addImeHeightListener } from '../../../modules/waifu-sync-service';

/** Stack-page keyboard owner; the header already clears the top safe area. */
export function CloudLibraryScroll({ children }: { children: ReactNode }): ReactElement {
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 0);
  const { t } = useAppTranslation();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const keyboardHeightRef = useRef(0);
  const bottomInsetRef = useRef(bottomInset);
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null!);
  const scrollOffsetRef = useRef(0);
  const scrollViewportHeightRef = useRef(0);
  const focusedMeasureRef = useRef<MeasureLayout | null>(null);

  useEffect(() => { bottomInsetRef.current = bottomInset; }, [bottomInset]);
  const measureAndReveal = useCallback((measureLayout: MeasureLayout) => {
    const content = contentRef.current ?? scrollRef.current?.getInnerViewNode() ?? null;
    if (content === null || keyboardHeightRef.current <= 0 || scrollViewportHeightRef.current <= 0) return;
    measureLayout(content, (_left, fieldTop, _width, fieldHeight) => {
      // A measurement can settle after blur, unmount or a focus change.
      if (focusedMeasureRef.current !== measureLayout) return;
      const currentOffset = scrollOffsetRef.current;
      const nextOffset = scrollOffsetToReveal({ fieldTop, fieldHeight,
        currentScrollOffset: currentOffset, viewportHeight: scrollViewportHeightRef.current,
        keyboardHeight: keyboardHeightRef.current, bottomInset: bottomInsetRef.current,
        gap: KEYBOARD_REVEAL_GAP });
      if (nextOffset <= currentOffset) return;
      scrollOffsetRef.current = nextOffset;
      scrollRef.current?.scrollTo({ y: nextOffset, animated: true });
    }, () => undefined);
  }, []);
  const reveal = useCallback((measureLayout: MeasureLayout) => {
    focusedMeasureRef.current = measureLayout;
    measureAndReveal(measureLayout);
  }, [measureAndReveal]);
  const release = useCallback((measureLayout: MeasureLayout) => {
    if (focusedMeasureRef.current === measureLayout) focusedMeasureRef.current = null;
  }, []);
  const context = useMemo(() => ({ reveal, release }), [reveal, release]);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      const height = Math.max(event.endCoordinates.height, 0);
      keyboardHeightRef.current = height;
      setKeyboardHeight(height);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardHeightRef.current = 0;
      setKeyboardHeight(0);
    });
    // A secure IME can grow without another keyboardDidShow on API 30+.
    const ime = addImeHeightListener((event) => {
      if (event.visible && event.height > 0) {
        keyboardHeightRef.current = event.height;
        setKeyboardHeight(event.height);
      } else if (!event.visible) {
        keyboardHeightRef.current = 0;
        setKeyboardHeight(0);
      }
    });
    return () => { focusedMeasureRef.current = null; show.remove(); hide.remove(); ime.remove(); };
  }, []);
  useEffect(() => {
    if (keyboardHeight > 0 && focusedMeasureRef.current !== null) measureAndReveal(focusedMeasureRef.current);
  }, [keyboardHeight, measureAndReveal]);
  return (
    <KeyboardRevealContext.Provider value={context}>
      <ScrollView ref={scrollRef} innerViewRef={contentRef} testID="cloud-library-scroll"
        aria-label={t('settings.byos.heading')} keyboardShouldPersistTaps="handled"
        onLayout={(event) => { scrollViewportHeightRef.current = event.nativeEvent.layout.height; }}
        onScroll={(event) => { scrollOffsetRef.current = event.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, metrics.gestureInset) + metrics.spacing.large + keyboardHeight }}>
        {children}
      </ScrollView>
    </KeyboardRevealContext.Provider>
  );
}
