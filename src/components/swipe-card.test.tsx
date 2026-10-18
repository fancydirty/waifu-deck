import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { createRef } from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, State } from 'react-native-gesture-handler';
import { fireGestureHandler } from 'react-native-gesture-handler/jest-utils';
import { isWorkletFunction } from 'react-native-worklets';

import {
  getSwipeCardImageLayout,
  getSwipeDecision,
  getSwipeMotionConfig,
  SwipeCard,
  type SwipeCardHandle,
} from '@/components/swipe-card';
import type { StoredImage } from '@/features/images/image-repository';

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { ExternalLink: Icon, Heart: Icon, X: Icon };
});
// Jest's bundled reanimated mock hardcodes finished:true, so the cancelled-exit
// branch (withTiming reporting finished:false) is unreachable. This seam keeps
// the real mock and lets a test deliver that cancellation explicitly.
const timingCallbacks: ((finished: boolean) => void)[] = [];
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return {
    ...actual,
    __esModule: true,
    default: actual.default,
    withTiming: (toValue: number, config: unknown, callback?: (f: boolean) => void) => {
      if (callback) {
        timingCallbacks.push(callback);
        return toValue;
      }
      return actual.withTiming(toValue, config);
    },
  };
});

function cancelPendingTiming() {
  const callback = timingCallbacks.shift();
  callback?.(false);
}

jest.mock('expo-haptics', () => ({
  AndroidHaptics: { Segment_Tick: 'segment-tick' },
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
}));

function image(id = 1): StoredImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: null,
    artistName: `Artist ${id}`,
    artistUrl: null,
    width: 1000,
    height: 1500,
    byteSize: 100,
    extension: 'jpg',
    dominantColor: '#555555',
    contentRating: 'safe',
    nativeRating: null,
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
    decision: 'active',
    presentedAt: 1,
    decidedAt: null,
    queueOrdinal: id,
    decisionOrdinal: null,
    localUri: null,
    downloadState: 'none',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('SwipeCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    timingCallbacks.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('keeps the image view mounted while a queued card becomes interactive', async () => {
    const props = {
      card: image(),
      cardWidth: 300,
      cardHeight: 420,
      onCommit: jest.fn().mockResolvedValue(true),
      onExitComplete: jest.fn(),
      accessibilityLabel: '测试卡片',
    };
    const view = await render(<SwipeCard {...props} interactive={false} />);
    const findImageView = () => view.container.queryAll(
      (instance) => instance.props.cachePolicy === 'memory-disk',
    )[0];
    const queuedImageView = findImageView();
    expect(queuedImageView).toBeDefined();
    const queuedNativeView = queuedImageView.unstable_fiber?.stateNode;
    expect(queuedNativeView).toBeDefined();

    await view.rerender(<SwipeCard {...props} interactive />);

    expect(findImageView().unstable_fiber?.stateNode === queuedNativeView).toBe(true);
  });

  test('remounts the accessibility overlay when interactivity changes', async () => {
    const props = {
      card: image(),
      cardWidth: 300,
      cardHeight: 420,
      onCommit: jest.fn().mockResolvedValue(true),
      onExitComplete: jest.fn(),
      accessibilityLabel: '测试卡片',
    };
    const view = await render(<SwipeCard {...props} interactive />);
    const findOverlay = () => view.container.queryAll(
      (instance) => instance.props.accessibilityRole === 'imagebutton',
    )[0];
    const interactiveOverlay = findOverlay();
    expect(screen.getByLabelText('测试卡片')).toBe(interactiveOverlay);

    await view.rerender(<SwipeCard {...props} interactive={false} />);

    expect(screen.queryByLabelText('测试卡片', { includeHiddenElements: true })).toBeNull();
    const inertOverlay = findOverlay();
    expect(inertOverlay).not.toBe(interactiveOverlay);

    await view.rerender(<SwipeCard {...props} interactive />);

    const restoredOverlay = screen.getByLabelText('测试卡片');
    expect(restoredOverlay).not.toBe(inertOverlay);
    expect(restoredOverlay).not.toBe(interactiveOverlay);
  });

  test.each([
    ['landscape 16:9', 16, 9, { width: 320, height: 180, left: 0, top: 150 }],
    ['landscape 4:3', 4, 3, { width: 320, height: 240, left: 0, top: 120 }],
    ['square 1:1', 1, 1, { width: 320, height: 320, left: 0, top: 80 }],
    ['portrait 2:3', 2, 3, { width: 320, height: 480, left: 0, top: 0 }],
    ['portrait 9:16', 9, 16, { width: 270, height: 480, left: 25, top: 0 }],
  ] as const)('%s stays inside the card frame without cropping', (_label, imageWidth, imageHeight, expected) => {
    expect(getSwipeCardImageLayout({
      cardWidth: 320,
      cardHeight: 480,
      imageWidth,
      imageHeight,
    })).toEqual(expected);
  });

  test('R8.14: keeps a fixed deck-rectangle frame and contains the artwork inside it', async () => {
    const view = await render(
      <SwipeCard
        card={{ ...image(), width: 1600, height: 900 }}
        cardWidth={320}
        cardHeight={480}
        onCommit={jest.fn().mockResolvedValue(true)}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );

    // The frame is the fixed deck rectangle regardless of artwork ratio.
    const frame = view.getByTestId('swipe-card-frame');
    const frameStyle = StyleSheet.flatten(frame.props.style);
    expect(frameStyle.width).toBe(320);
    expect(frameStyle.height).toBe(480);

    // The artwork is contained at its native aspect ratio (16:9 inside the
    // 320x480 frame: 320x180, centered) — never cropped, never stretched.
    const imageView = view.container.queryAll(
      (instance) => instance.props.cachePolicy === 'memory-disk',
    )[0];
    expect(imageView.props.contentFit).toBe('contain');
    expect(StyleSheet.flatten(imageView.props.style)).toMatchObject({
      width: 320,
      height: 180,
      left: 0,
      top: 150,
    });
  });

  test('R8.14: the letterbox background is the neutral surface, never a saturated fill', async () => {
    const view = await render(
      <SwipeCard
        card={{ ...image(), width: 1600, height: 900 }}
        cardWidth={320}
        cardHeight={480}
        onCommit={jest.fn().mockResolvedValue(true)}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );

    const frame = view.getByTestId('swipe-card-frame');
    const style = StyleSheet.flatten(frame.props.style);
    // The 2026-09-06 review rejected the dominantColor letterbox; a neutral
    // theme surface is the only static fill the card may use.
    expect(style.backgroundColor).toBe('#FDF7F3');
    expect(style.backgroundColor).not.toBe(image().dominantColor);
  });

  test.each([
    ['landscape 16:9', 1600, 900],
    ['landscape 4:3', 1600, 1200],
    ['portrait 2:3', 900, 1600],
    ['portrait 9:16', 900, 1600],
    ['square 1:1', 1000, 1000],
  ])(
    'R8.14: the %s frame stays the fixed deck rectangle for every artwork ratio',
    async (_label, imageWidth, imageHeight) => {
      const view = await render(
        <SwipeCard
          card={{ ...image(), width: imageWidth, height: imageHeight }}
          cardWidth={320}
          cardHeight={480}
          onCommit={jest.fn().mockResolvedValue(true)}
          onExitComplete={jest.fn()}
          accessibilityLabel="测试卡片"
        />,
      );

      // Fixed frame: the owner reverted R8.7-2 on 2026-09-07 — the card has a
      // stable size; only the artwork rectangle adapts inside it.
      const frame = view.getByTestId('swipe-card-frame');
      expect(StyleSheet.flatten(frame.props.style)).toMatchObject({
        width: 320,
        height: 480,
      });
    },
  );

  test('R8.12: shows an honest load-failure state instead of a blank frame when the artwork fails to decode', async () => {
    const view = await render(
      <SwipeCard
        card={image()}
        cardWidth={320}
        cardHeight={480}
        onCommit={jest.fn().mockResolvedValue(true)}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );

    const imageView = view.container.queryAll(
      (instance) => instance.props.cachePolicy === 'memory-disk',
    )[0];
    expect(imageView).toBeDefined();
    expect(imageView.props.onError).toBeInstanceOf(Function);

    // The blank card the owner saw: image errors, nothing re-renders. The
    // card must surface a retryable/informative state, not a colored void.
    await act(async () => {
      imageView.props.onError({ nativeEvent: { error: 'decode' } });
    });
    expect(view.getByTestId('swipe-card-image-failed')).toBeOnTheScreen();
  });

  test('R8.18: renders the medium sampleUrl, not the full-resolution original', async () => {
    const card = {
      ...image(),
      remoteUrl: 'https://cdn.example.com/1-original.png',
      sampleUrl: 'https://cdn.example.com/1-sample.jpg',
    };
    const view = await render(
      <SwipeCard
        card={card}
        cardWidth={320}
        cardHeight={480}
        onCommit={jest.fn().mockResolvedValue(true)}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );

    const imageView = view.container.queryAll(
      (instance) => instance.props.cachePolicy === 'memory-disk',
    )[0];
    // The deck must decode the ~1MB sample, never the multi-megapixel original,
    // which is what froze the swipe animation mid-flight on device. expo-image
    // normalizes a string source to [{ uri }].
    const source = imageView.props.source;
    const uri = typeof source === 'string'
      ? source
      : Array.isArray(source) ? source[0]?.uri : source?.uri;
    expect(uri).toBe('https://cdn.example.com/1-sample.jpg');
  });

  test('R8.28: a gelbooru card carries the provider Referer on its image source', async () => {
    const view = await render(
      <SwipeCard
        card={{
          ...image(),
          providerKey: 'gelbooru',
          remoteUrl: 'https://img4.gelbooru.com/images/a/b/c.jpg',
          sampleUrl: 'https://img4.gelbooru.com/samples/a/b/sample_c.jpg',
        }}
        cardWidth={320}
        cardHeight={480}
        onCommit={jest.fn().mockResolvedValue(true)}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );

    const imageView = view.container.queryAll(
      (instance) => instance.props.cachePolicy === 'memory-disk',
    )[0];
    // Without it img*.gelbooru.com 302s to hotlink.php and Glide decodes HTML.
    // expo-image resolves any source to the native [{ ... }] array; asserting
    // there proves the headers actually reach the native prop.
    expect(imageView.props.source).toEqual([{
      uri: 'https://img4.gelbooru.com/samples/a/b/sample_c.jpg',
      headers: { Referer: 'https://gelbooru.com/' },
    }]);
  });

  test('R8.28: a headerless provider card keeps a bare { uri } source', async () => {
    const view = await render(
      <SwipeCard
        card={{ ...image(), providerKey: 'danbooru' }}
        cardWidth={320}
        cardHeight={480}
        onCommit={jest.fn().mockResolvedValue(true)}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );

    const imageView = view.container.queryAll(
      (instance) => instance.props.cachePolicy === 'memory-disk',
    )[0];
    expect(imageView.props.source).toEqual([{ uri: 'https://cdn.example.com/1.jpg' }]);
    expect(Object.keys(imageView.props.source[0])).toEqual(['uri']);
  });

  test('starts exit immediately, suppresses duplicates, and publishes only after commit succeeds', async () => {
    jest.useFakeTimers();
    const ref = createRef<SwipeCardHandle>();
    const pending = deferred<boolean>();
    const onCommit = jest.fn(() => pending.promise);
    const onExitComplete = jest.fn();
    await render(
      <SwipeCard
        ref={ref}
        card={image()}
        cardWidth={300}
        cardHeight={420}
        onCommit={onCommit}
        onExitComplete={onExitComplete}
        accessibilityLabel="测试卡片"
      />,
    );

    await act(async () => {
      ref.current?.dismiss('right');
      ref.current?.dismiss('left');
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('right');
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(onExitComplete).not.toHaveBeenCalled();

    await act(async () => jest.advanceTimersByTime(220));
    expect(onExitComplete).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(true);
      await Promise.resolve();
    });

    expect(onExitComplete).toHaveBeenCalledWith('right');
  });

  test('a failed commit does not exit and releases the card for a retry', async () => {
    const ref = createRef<SwipeCardHandle>();
    const onCommit = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const onExitComplete = jest.fn();
    await render(
      <SwipeCard
        ref={ref}
        card={image()}
        cardWidth={300}
        cardHeight={420}
        onCommit={onCommit}
        onExitComplete={onExitComplete}
        accessibilityLabel="测试卡片"
      />,
    );

    await act(async () => ref.current?.dismiss('right'));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onExitComplete).not.toHaveBeenCalled();

    await act(async () => ref.current?.dismiss('left'));

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onExitComplete).toHaveBeenCalledWith('left'));
  });

  test('publishes an accepted verdict even after its attempt slot was replaced', async () => {
    // R8.4 requirement 1. The production interruption path clears isBusy while a
    // commit is still in flight (the withTiming finished:false branch), so a
    // second gesture can overwrite the single pendingDismiss slot. When the
    // first, already-durable verdict then resolves, it must still publish —
    // otherwise the row is saved in SQLite while the card stays on screen and
    // both state machines freeze. That is the owner's fatal report:
    // "图片已经进入了收藏但是图片卡本身没来得及被划走，所以无法左滑右滑，就卡死在那".
    const ref = createRef<SwipeCardHandle>();
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const onCommit = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onExitComplete = jest.fn();
    await render(
        <SwipeCard
          ref={ref}
          card={image()}
          cardWidth={300}
          cardHeight={420}
          onCommit={onCommit}
          onExitComplete={onExitComplete}
          accessibilityLabel="测试卡片"
        />,
      );

      await act(async () => ref.current?.dismiss('right'));
      expect(onCommit).toHaveBeenNthCalledWith(1, 'right');

      // Reproduce the interruption the way the device does: the exit withTiming
      // reports finished:false, whose callback clears isBusy while the first write
      // is still in flight. Jest's reanimated mock always reports finished:true,
      // so the cancellation is delivered here explicitly.
      await act(async () => cancelPendingTiming());
      await act(async () => ref.current?.dismiss('left'));
      // The slot is genuinely replaced now — this is what the previous version of
      // this test failed to do, because isBusy silently rejected the second call.
      expect(onCommit).toHaveBeenCalledTimes(2);
      expect(onCommit).toHaveBeenNthCalledWith(2, 'left');

      await act(async () => {
      first.resolve(true);
      await Promise.resolve();
      });

      // The displaced attempt's write landed. It must publish despite no longer
      // owning the slot.
      expect(onExitComplete).toHaveBeenCalledWith('right');

      await act(async () => {
      second.resolve(true);
      await Promise.resolve();
      });

      expect(onExitComplete).toHaveBeenCalledWith('left');
      expect(onExitComplete).toHaveBeenCalledTimes(2);
  });

  test('an accepted commit publishes immediately without waiting for the exit timer', async () => {
    jest.useFakeTimers();
    const ref = createRef<SwipeCardHandle>();
    const pending = deferred<boolean>();
    const onCommit = jest.fn(() => pending.promise);
    const onExitComplete = jest.fn();
    const view = await render(
      <SwipeCard
        ref={ref}
        card={image()}
        cardWidth={300}
        cardHeight={420}
        onCommit={onCommit}
        onExitComplete={onExitComplete}
        accessibilityLabel="测试卡片"
      />,
    );

    await act(async () => ref.current?.dismiss('right'));
    expect(onExitComplete).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(true);
      await Promise.resolve();
    });

    // R8.3: the durable write is the gate, not the animation. No timer advance
    // needed — the deck advances the moment the commit lands, closing the dead
    // input window that used to last the full exit duration.
    expect(onExitComplete).toHaveBeenCalledTimes(1);
    expect(onExitComplete).toHaveBeenCalledWith('right');

    // Unmounting afterwards must not double-publish the same decision.
    await act(async () => view.unmount());
    expect(onExitComplete).toHaveBeenCalledTimes(1);
  });

  test('a rejected commit leaves the card able to accept the next gesture', async () => {
    jest.useFakeTimers();
    const ref = createRef<SwipeCardHandle>();
    const pending = deferred<boolean>();
    const onCommit = jest.fn(() => pending.promise);
    const onExitComplete = jest.fn();
    await render(
      <SwipeCard
        ref={ref}
        card={image()}
        cardWidth={300}
        cardHeight={420}
        onCommit={onCommit}
        onExitComplete={onExitComplete}
        accessibilityLabel="测试卡片"
      />,
    );

    await act(async () => ref.current?.dismiss('right'));
    await act(async () => {
      pending.resolve(false);
      await Promise.resolve();
    });

    // A rejected commit must fully disarm the card, not leave isBusy latched.
    await act(async () => ref.current?.dismiss('left'));

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect(onCommit).toHaveBeenLastCalledWith('left');
  });

  test('exposes save and skip as card accessibility actions', async () => {
    const onCommit = jest.fn().mockResolvedValue(true);
    await render(
      <SwipeCard
        card={image()}
        cardWidth={300}
        cardHeight={420}
        onCommit={onCommit}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );

    const card = screen.getByLabelText('测试卡片');
    expect(card.props.accessible).toBe(true);
    expect(card.props.accessibilityRole).toBe('imagebutton');
    expect(card.props.accessibilityActions).toEqual([
      { name: 'dismiss', label: '略过' },
      { name: 'save', label: '收藏' },
    ]);

    await fireEvent(card, 'accessibilityAction', {
      nativeEvent: { actionName: 'save' },
    });

    expect(onCommit).toHaveBeenCalledWith('right');
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  test('uses bounded reduced-motion durations for exits and image transitions', () => {
    expect(getSwipeMotionConfig(true)).toEqual({
      exitDuration: 1,
      imageTransition: 0,
      resetWithSpring: false,
    });
    expect(getSwipeMotionConfig(false)).toEqual({
      exitDuration: 220,
      imageTransition: 180,
      resetWithSpring: true,
    });
  });

  test('renders symbol-only stamps and no card copy at 2x font scale', async () => {
    const view = await render(
      <SwipeCard
        card={{ ...image(), sourceUrl: 'https://source.example.com/1' }}
        cardWidth={300}
        cardHeight={420}
        onCommit={jest.fn().mockResolvedValue(true)}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );

    // Peach default-state card is info-free: no badge labels, artist,
    // dimensions, or source copy survive at any font scale (spec §3.1).
    // Metadata moves into the Task 5 peek info layer.
    expect(screen.queryByText(/.+/, { includeHiddenElements: true })).toBeNull();

    const stamps = view.container.queryAll(
      (instance) => Array.isArray(instance.props?.style)
        && instance.props.style.some(
          (entry: unknown) => typeof entry === 'object' && entry !== null
            && (entry as { width?: number }).width === 54
            && (entry as { height?: number }).height === 54
            && (entry as { borderRadius?: number }).borderRadius === 27,
        ),
    );
    expect(stamps).toHaveLength(2);
    for (const stamp of stamps) {
      expect(stamp.props['aria-hidden']).toBe(true);
      expect(stamp.props.accessibilityElementsHidden).toBe(true);
      expect(stamp.props.importantForAccessibility).toBe('no-hide-descendants');
    }
    const stampStyles = stamps.map(
      (stamp) => stamp.props.style.filter(
        (entry: unknown) => typeof entry === 'object' && entry !== null,
      ),
    );
    // ✕ stamp: dismiss gray #7A736E, right side, rotated +14deg.
    expect(stampStyles.some((entries) => entries.some(
      (entry: { backgroundColor?: string; right?: number }) =>
        entry.backgroundColor === '#7A736E' && entry.right === 16,
    ))).toBe(true);
    // ♥ stamp: save pink #F0637A, left side, rotated -14deg.
    expect(stampStyles.some((entries) => entries.some(
      (entry: { backgroundColor?: string; left?: number }) =>
        entry.backgroundColor === '#F0637A' && entry.left === 16,
    ))).toBe(true);
    expect(stampStyles.some((entries) => entries.some(
      (entry: { transform?: { rotate?: string }[] }) =>
        entry.transform?.[0]?.rotate === '14deg',
    ))).toBe(true);
    expect(stampStyles.some((entries) => entries.some(
      (entry: { transform?: { rotate?: string }[] }) =>
        entry.transform?.[0]?.rotate === '-14deg',
    ))).toBe(true);
  });

  test('commits a swipe whose last pre-liftoff sample crosses the threshold', async () => {
    // Device evidence, emulator-5554 running release 03a71c7 with temporary
    // gesture diagnostics (a local log):
    //   IGNORED  end axis=1 tx=100    evTx=120.63 vx=0 cw=371.43 -> dir=null
    //   ACCEPTED end axis=1 tx=120.63 evTx=187.30 vx=0 cw=371.43 -> dir=right
    // The pan handler measured 120.63dp of travel across a 371.43dp card —
    // 32.5%, past the 28% threshold — but onEnd judged the swipe on
    // translateX.value, which still held the PREVIOUS onUpdate sample (100dp,
    // 26.9%). The handler's own final translation is only ever delivered on the
    // end event, so the last sample before liftoff is never scored and a swipe
    // that did cross the threshold is discarded in silence: no commit, no card
    // movement, no feedback. PRODUCT.md: "Swiping must remain immediate".
    const onCommit = jest.fn().mockResolvedValue(true);
    const panSpy = jest.spyOn(Gesture, 'Pan');
    await render(
      <SwipeCard
        card={image()}
        cardWidth={371.43}
        cardHeight={520}
        onCommit={onCommit}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );
    // Gesture.Pan() returns the object the component then chains onto, so the
    // spy's result IS the live gesture the GestureDetector mounted.
    const gesture = panSpy.mock.results.at(-1)?.value;
    // The mounted GestureDetector already holds this gesture object; the spy
    // has served its purpose and must not stay wrapped for the rest of the file.
    panSpy.mockRestore();
    expect(gesture.handlerTag).toBeGreaterThan(0);

    await act(async () => {
      fireGestureHandler(gesture, [
        { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0 },
        { state: State.ACTIVE, translationX: 60, translationY: 2, velocityX: 0 },
        { translationX: 100, translationY: 4, velocityX: 0 },
        { state: State.END, translationX: 120.63, translationY: 5, velocityX: 0 },
      ]);
    });

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('right'));
  });

  test('ignores further pans while a commit is still in flight', async () => {
    // onBegin and onUpdate both bail while isBusy, so the card does not follow
    // the finger; onEnd must ignore the gesture too rather than resetPosition()
    // it, which would clear isBusy and let the same card commit twice.
    const pending = deferred<boolean>();
    const onCommit = jest.fn().mockReturnValue(pending.promise);
    const panSpy = jest.spyOn(Gesture, 'Pan');
    await render(
      <SwipeCard
        card={image()}
        cardWidth={371.43}
        cardHeight={520}
        onCommit={onCommit}
        onExitComplete={jest.fn()}
        accessibilityLabel="测试卡片"
      />,
    );
    const gesture = panSpy.mock.results.at(-1)?.value;
    // The mounted GestureDetector already holds this gesture object; the spy
    // has served its purpose and must not stay wrapped for the rest of the file.
    panSpy.mockRestore();
    const pan = (endTranslationX: number) => fireGestureHandler(gesture, [
      { state: State.BEGAN, translationX: 0, translationY: 0, velocityX: 0 },
      { state: State.ACTIVE, translationX: endTranslationX / 2, translationY: 2, velocityX: 0 },
      { state: State.END, translationX: endTranslationX, translationY: 4, velocityX: 0 },
    ]);

    await act(async () => pan(200));
    expect(onCommit).toHaveBeenCalledTimes(1);

    // A stray short pan lands while the first commit is still unresolved.
    await act(async () => pan(8));
    // A second full swipe on the same, still-committing card.
    await act(async () => pan(200));

    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe('getSwipeDecision', () => {
  test('is serializable into the UI-thread gesture', () => {
    expect(isWorkletFunction(getSwipeDecision)).toBe(true);
  });

  test.each([
    [{ translationX: 83.99, velocityX: 799.99, cardWidth: 300 }, null],
    [{ translationX: 84, velocityX: 0, cardWidth: 300 }, 'right'],
    [{ translationX: -84, velocityX: 0, cardWidth: 300 }, 'left'],
    [{ translationX: 2, velocityX: 800, cardWidth: 300 }, 'right'],
    [{ translationX: -2, velocityX: -800, cardWidth: 300 }, 'left'],
  ] as const)('resolves threshold and velocity boundaries for %o', (input, expected) => {
    expect(getSwipeDecision(input)).toBe(expected);
  });
});
