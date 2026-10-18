import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import type {
  SwipeCardHandle,
  SwipeCardProps,
} from '@/components/swipe-card';
import type { StoredImage } from '@/features/images/image-repository';
import {
  DiscoverView,
  getDiscoverDeckSize,
  getDiscoverPeekChromeStyle,
  type DiscoverViewModel,
} from '@/screens/discover/discover-screen';
import { lightColors } from '@/theme/colors';

jest.mock('lucide-react-native', () => {
  const { createElement } = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  // Board #24: each icon is a tagged host view that keeps its props, so a test
  // can tell RotateCcw from X and read its size, stroke and colour.
  const icon = (name: string) => function MockIcon(props: Record<string, unknown>) {
    return createElement(View, { testID: `icon-${name}`, ...props });
  };
  return {
    ExternalLink: icon('ExternalLink'),
    Heart: icon('Heart'),
    RotateCcw: icon('RotateCcw'),
    WifiOff: icon('WifiOff'),
    X: icon('X'),
  };
});

function image(
  id: number,
  overrides: Partial<StoredImage> = {},
): StoredImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: `https://source.example.com/${id}`,
    artistName: `Artist ${id}`,
    artistUrl: null,
    width: 1200,
    height: 1800,
    byteSize: 500_000,
    extension: 'jpg',
    dominantColor: '#7A6B86',
    contentRating: 'safe',
    nativeRating: null,
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
    decision: id === 1 ? 'active' : 'queued',
    presentedAt: id === 1 ? 1 : null,
    decidedAt: null,
    queueOrdinal: id,
    decisionOrdinal: null,
    localUri: null,
    downloadState: 'none',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

const active = image(1);
const next = image(2, { width: 800, height: 1200 });

function model(
  overrides: Partial<DiscoverViewModel> = {},
): DiscoverViewModel {
  const state = overrides.state ?? { kind: 'ready' as const, deck: { active, queued: [next] } };
  return {
    state,
    isDeciding: false,
    canDecide: state.deck.active !== null,
    canRewind: false,
    decisionError: null,
    commitDecision: jest.fn().mockReturnValue(true),
    rewind: jest.fn(() => false),
    retry: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('DiscoverView states', () => {
  test('R8.17: the deck-height budget derives from the shared tab-bar reserve, not a magic number', () => {
    // The old formula hard-coded "- 210". The new budget must be composed of
    // NAMED parts: tab-bar reserve + action row + column gaps + safe insets,
    // imported from the single geometry module. A change to the bar's height
    // then automatically re-budgets the deck instead of re-breaking it.
    const { TAB_BAR_RESERVE } = jest.requireActual('@/theme/tab-bar-geometry');
    const windowWidth = 360;
    const windowHeight = 800;
    const safeVerticalInsets = 48;
    const { height } = getDiscoverDeckSize(windowWidth, windowHeight, safeVerticalInsets);
    // The deck must consume EXACTLY the safe space minus the named budget:
    // shared tab-bar reserve + action row (76) + the two medium column gaps
    // (deck→actions, actions→root bottom padding). The old formula's -210
    // over-withdrew 24px (stealing card height) and under-specified what the
    // withdrawal was FOR — a bar-height change then re-broke the buttons.
    const { metrics } = jest.requireActual('@/theme/metrics');
    const actionRow = 76;
    const gaps = metrics.spacing.medium * 2 + metrics.spacing.small; // deck→action gap + root TOP padding band + root bottom padding
    const budgetedBottom = windowHeight - safeVerticalInsets - height;
    expect(budgetedBottom).toBe(TAB_BAR_RESERVE + actionRow + gaps);
  });

  test.each([
    ['short portrait', [360, 640, 0], { width: 336, height: 446, horizontalPadding: 12 }],
    ['tall portrait', [360, 800, 48], { width: 336, height: 558, horizontalPadding: 12 }],
    ['wide tall portrait', [430, 932, 0], { width: 390, height: 720, horizontalPadding: 20 }],
    ['landscape', [844, 390, 0], { width: 560, height: 196, horizontalPadding: 20 }],
  ] as const)('%s uses bounded available height', (_name, args, expected) => {
    const [windowWidth, windowHeight, safeVerticalInsets] = args;
    expect(getDiscoverDeckSize(windowWidth, windowHeight, safeVerticalInsets)).toEqual(expected);
  });

  test('applies safeAreaTop to root paddingTop', async () => {
    const viewModel = model();
    await render(
      <DiscoverView viewModel={viewModel} safeAreaTop={32} />,
    );
    const rootView = screen.getByTestId('screen-discover');
    expect(rootView.props.style).toMatchObject({
      paddingTop: 32 + 12, // safeAreaTop + metrics.spacing.medium
    });
  });

  test('when safeAreaTop is zero, paddingTop is just spacing', async () => {
    const viewModel = model();
    await render(
      <DiscoverView viewModel={viewModel} safeAreaTop={0} />,
    );
    const rootView = screen.getByTestId('screen-discover');
    expect(rootView.props.style).toMatchObject({
      paddingTop: 12, // just metrics.spacing.medium
    });
  });

  test('when safeAreaTop is undefined, defaults to zero', async () => {
    const viewModel = model();
    await render(
      <DiscoverView viewModel={viewModel} />,
    );
    const rootView = screen.getByTestId('screen-discover');
    expect(rootView.props.style).toMatchObject({
      paddingTop: 12,
    });
  });

  test('wide phones reserve vertical space for fixed actions without overlap', () => {
    // R8.17: derived budget — 390 safe height minus the 194 composed reserve
    // (bar 86 + actions 76 + gaps 24 + root pad 8) leaves 196 for the deck.
    expect(getDiscoverDeckSize(844, 390, 0)).toEqual({
      width: 560,
      height: 196,
      horizontalPadding: 20,
    });
  });

  test.each([
    ['390px landscape', { width: 844, height: 390, fontScale: 1 }],
    ['390px landscape large text', { width: 844, height: 390, fontScale: 2 }],
    ['small Android portrait', { width: 360, height: 640, fontScale: 1 }],
    ['wide phone', { width: 430, height: 932, fontScale: 1 }],
    ['large text', { width: 360, height: 640, fontScale: 2 }],
  ] as const)('%s keeps rendered deck and actions within a fixed bounded layout', async (_, viewport) => {
    await render(
      <DiscoverView
        viewModel={model({
          state: { kind: 'offline', deck: { active, queued: [next] } },
        })}
        viewport={viewport}
      />,
    );

    const deck = screen.getByLabelText('发现卡组');
    const actions = screen.getByLabelText('发现操作');
    // R8.2: offline is normal browsing, so it shows no persistent feedback bar.
    expect(screen.queryByLabelText('发现反馈')).not.toBeOnTheScreen();
    expect(screen.getByTestId('screen-discover')).toBeOnTheScreen();
    expect(screen.getByTestId('discover-dismiss')).toBeOnTheScreen();
    expect(screen.getByTestId('discover-save')).toBeOnTheScreen();
    // R8.17: the derived budget — viewport minus the composed reserve
    // (TAB_BAR_RESERVE + action row + gaps + root padding) from the shared
    // geometry module. The old literal was -210.
    const { TAB_BAR_RESERVE } = jest.requireActual('@/theme/tab-bar-geometry');
    const composedReserve = TAB_BAR_RESERVE + 76 + 24 + 8;
    expect(deck.props.style.height).toBeLessThanOrEqual(viewport.height - composedReserve);
    // Peach Task 5: the action row is a fixed-height round-button band,
    // independent of font scale (icons don't scale with text).
    expect(actions).toHaveStyle({ minHeight: 76 });
  });

  test.each([
    // R8.17: derived budget (see getDiscoverDeckSize) — heights follow the
    // shared geometry reserve instead of the retired -210 literal.
    ['844x390 landscape', { width: 844, height: 390, fontScale: 2 }, 196],
    ['360x640 portrait', { width: 360, height: 640, fontScale: 2 }, 446],
  ] as const)('%s keeps compact error title, message, and retry bounded at 2x', async (
    _name,
    viewport,
    deckHeight,
  ) => {
    await render(
      <DiscoverView
        viewModel={model({
          state: { kind: 'error', deck: { active: null, queued: [] } },
        })}
        viewport={viewport}
      />,
    );

    expect(screen.getByLabelText('发现卡组')).toHaveStyle({ height: deckHeight });
    expect(screen.getByLabelText('screen-state-error')).toHaveStyle({
      width: '100%',
      height: '100%',
      minHeight: 0,
      gap: 4,
      padding: 8,
    });
    expect(screen.getByText('暂时无法完成').props).toMatchObject({
      numberOfLines: 1,
      adjustsFontSizeToFit: true,
    });
    expect(screen.getByText('请稍后重试').props.numberOfLines).toBe(2);
    expect(screen.getByRole('button', { name: '重试' })).toHaveStyle({ minHeight: 48 });
    for (const copy of ['暂时无法完成', '请稍后重试', '重试']) {
      expect(screen.getByText(copy).props.maxFontSizeMultiplier).toBeUndefined();
    }
  });

  test('loading reserves the same stable deck space as ready', async () => {
    const ready = await render(<DiscoverView viewModel={model()} />);
    const readyStyle = screen.getByLabelText('发现卡组').props.style;
    await ready.unmount();

    await render(
      <DiscoverView
        viewModel={model({
          state: { kind: 'loading', deck: { active: null, queued: [] } },
        })}
      />,
    );

    expect(screen.getByLabelText('发现卡组')).toHaveStyle({
      width: readyStyle.width,
      height: readyStyle.height,
    });
    expect(screen.getByLabelText('screen-state-loading')).toBeOnTheScreen();
  });

  test('ready renders the current image and the next card behind without card copy', async () => {
    await render(
      <DiscoverView
        viewModel={model({
          state: {
            kind: 'ready',
            deck: {
              active: image(1, { artistName: null }),
              queued: [next],
            },
          },
        })}
      />,
    );

    const currentCard = screen.getByLabelText('当前图片 1');
    expect(currentCard).toBeOnTheScreen();
    // Peach Task 4 removed the caption: the default-state card carries no
    // metadata or badge copy (spec §3.1); Task 5's peek info layer restores
    // artist/dimensions/source inside the peek state.
    expect(within(screen.getByTestId('active-card-layer'))
      .queryByText(/.+/, { includeHiddenElements: true })).toBeNull();
    const nextLayer = screen.getByTestId(
      'next-card-layer',
      { includeHiddenElements: true },
    );
    expect(screen.queryByLabelText(
      '下一张图片 2',
      { includeHiddenElements: true },
    )).toBeNull();
    expect(nextLayer.props['aria-hidden']).toBe(true);
    expect(nextLayer.props.accessibilityElementsHidden).toBe(true);
    expect(nextLayer.props.importantForAccessibility).toBe('no-hide-descendants');
    // Regression guard: the active wrapper must stay 'box-none' so taps in
    // the revealed peek band reach the info layer's source button; an 'auto'
    // wrapper swallows them (peach Task 5 review blocker).
    expect(screen.getByTestId('active-card-layer')).toHaveStyle({
      pointerEvents: 'box-none',
    });
    expect(nextLayer).toHaveStyle({ pointerEvents: 'none' });
  });

  test('initial error exposes retry while preserving deck space', async () => {
    const retry = jest.fn();
    await render(
      <DiscoverView
        viewModel={model({
          state: {
            kind: 'error',
            deck: { active: null, queued: [] },
            message: 'Nekos API、Danbooru 暂时不可用，请稍后重试',
          },
          retry,
        })}
      />,
    );

    expect(screen.getByLabelText('发现卡组')).toBeOnTheScreen();
    expect(screen.getByLabelText('screen-state-error')).toBeOnTheScreen();
    expect(screen.getByText('Nekos API、Danbooru 暂时不可用，请稍后重试'))
      .toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('offline with a restored queue remains usable', async () => {
    await render(
      <DiscoverView
        viewModel={model({
          state: { kind: 'offline', deck: { active, queued: [next] } },
        })}
      />,
    );

    expect(screen.getByLabelText('当前图片 1')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '收藏' })).toBeEnabled();
    // R8.2: offline is normal browsing — the usable card and enabled actions
    // are the proof, not a persistent 「离线浏览」 banner.
    expect(screen.queryByText('离线浏览')).not.toBeOnTheScreen();
    expect(screen.queryByLabelText('发现反馈')).not.toBeOnTheScreen();
  });

  test.each([
    ['offline', 'screen-state-offline'],
    ['exhausted', 'screen-state-exhausted'],
  ] as const)('%s empty is distinct and never renders handled content', async (kind, label) => {
    await render(
      <DiscoverView
        viewModel={model({
          state: { kind, deck: { active: null, queued: [] } },
        })}
      />,
    );

    expect(screen.getByLabelText(label)).toBeOnTheScreen();
    expect(screen.queryByLabelText('当前图片 1')).not.toBeOnTheScreen();
    // R8.9: the action row is fixed chrome and stays mounted so the column never
    // reflows; "handled content" means no card is being handled, which is proved
    // by the absent card and the disabled buttons rather than by an absent row.
    expect(screen.getByRole('button', { name: '收藏' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '略过' })).toBeDisabled();
  });
});

const TestSwipeCard = forwardRef<SwipeCardHandle, Omit<SwipeCardProps, 'ref'>>(
  function TestSwipeCard({ card, onCommit, onExitComplete }, ref) {
    const dismiss = (direction: 'left' | 'right') => {
      void onCommit(direction).then((committed) => {
        if (committed) onExitComplete(direction);
      });
    };
    useImperativeHandle(ref, () => ({ dismiss }));
    return (
      <>
        <Text>{`Test card ${card.id}`}</Text>
        <Pressable
          role="button"
          aria-label={`完成${card.id}左滑`}
          onPress={() => dismiss('left')}>
          <Text>Swipe left</Text>
        </Pressable>
        <Pressable
          role="button"
          aria-label={`完成${card.id}右滑`}
          onPress={() => dismiss('right')}>
          <Text>Swipe right</Text>
        </Pressable>
      </>
    );
  },
);

describe('DiscoverView actions', () => {
  // R8.9: the action row must never leave the tree. `active` goes null on every
  // refill window, not only on true exhaustion, so gating the row on it made the
  // buttons vanish mid-session and shifted the gap-based column layout.
  test.each([
    ['refilling with an empty deck', 'loading'],
    ['exhausted', 'exhausted'],
    ['offline with no card', 'offline'],
    ['error', 'error'],
  ] as const)('keeps the heart and X mounted but disabled while %s', async (_name, kind) => {
    await render(
      <DiscoverView
        viewModel={model({
          state: { kind, deck: { active: null, queued: [] } },
        })}
      />,
    );

    expect(screen.getByLabelText('发现操作')).toHaveStyle({ minHeight: 76 });
    for (const testID of ['discover-dismiss', 'discover-save']) {
      const button = screen.getByTestId(testID);
      expect(button).toBeOnTheScreen();
      expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    }
    // Board #24: the rewind button is fixed chrome too; its enabled state
    // follows the rewind history, never the card (see the rewind row tests).
    expect(screen.getByTestId('discover-rewind')).toBeOnTheScreen();
  });

  test('action row survives a deck going empty and refilling', async () => {
    const withCard = model();
    const view = await render(<DiscoverView viewModel={withCard} />);
    expect(screen.getByTestId('discover-save').props.accessibilityState)
      .toMatchObject({ disabled: false });

    await view.rerender(
      <DiscoverView
        viewModel={model({
          state: { kind: 'loading', deck: { active: null, queued: [] } },
        })}
      />,
    );
    expect(screen.getByTestId('discover-save')).toBeOnTheScreen();

    await view.rerender(<DiscoverView viewModel={model()} />);
    expect(screen.getByTestId('discover-save').props.accessibilityState)
      .toMatchObject({ disabled: false });
  });

  test('keeps the main action row stable and moves source opening into metadata peek', async () => {
    await render(
      <DiscoverView
        viewModel={model({
          state: {
            kind: 'ready',
            deck: {
              active: image(1, { sourceUrl: 'https://source.example.com/1' }),
              queued: [next],
            },
          },
        })}
      />,
    );

    expect(screen.getByTestId('discover-dismiss')).toBeOnTheScreen();
    expect(screen.getByTestId('discover-save')).toBeOnTheScreen();
    expect(screen.queryByTestId('discover-source')).toBeNull();

    const metadata = screen.getByLabelText('图片元数据');
    expect(within(metadata).getByRole('button', { name: '查看来源' }))
      .toBeOnTheScreen();
  });

  test('does not render an empty source entry when the card has no source URL', async () => {
    await render(
      <DiscoverView
        viewModel={model({
          state: {
            kind: 'ready',
            deck: {
              active: image(1, { sourceUrl: null }),
              queued: [next],
            },
          },
        })}
      />,
    );

    expect(screen.queryByTestId('discover-source')).toBeNull();
    expect(within(screen.getByLabelText('图片元数据'))
      .queryByRole('button', { name: '查看来源' })).toBeNull();
  });

  test.each([
    ['略过', 'dismissed'],
    ['收藏', 'saved'],
    ['完成1左滑', 'dismissed'],
    ['完成1右滑', 'saved'],
  ] as const)('%s completes through the shared decision path exactly once', async (label, decision) => {
    const commitDecision = jest.fn().mockReturnValue(true);
    await render(
      <DiscoverView
        viewModel={model({ commitDecision })}
        SwipeCardComponent={TestSwipeCard}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(commitDecision).toHaveBeenCalledTimes(1));
    expect(commitDecision).toHaveBeenCalledWith(decision);
  });

  test('a committed decision advances the deck immediately via commitDecision', async () => {
    const commitDecision = jest.fn().mockReturnValue(true);
    await render(
      <DiscoverView
        viewModel={model({ commitDecision })}
        SwipeCardComponent={TestSwipeCard}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: '收藏' }));

    // Backlog #11: the advance is owned by commitDecision (optimistic in the
    // hook); there is no separate publish step and no waiting on the exit.
    expect(commitDecision).toHaveBeenCalledWith('saved');
    expect(commitDecision).toHaveBeenCalledTimes(1);
  });

  test('promotes the queued card without remounting its image subtree', async () => {
    const mountCounts = new Map<number, number>();
    const TrackingSwipeCard = forwardRef<SwipeCardHandle, Omit<SwipeCardProps, 'ref'>>(
      function TrackingSwipeCard(props, ref) {
        const initialCardId = useRef(props.card.id);
        useEffect(() => {
          mountCounts.set(
            initialCardId.current,
            (mountCounts.get(initialCardId.current) ?? 0) + 1,
          );
        }, []);
        return <TestSwipeCard ref={ref} {...props} />;
      },
    );

    function PromotionHarness() {
      const [deck, setDeck] = useState({ active, queued: [next, image(3)] });
      return (
        <DiscoverView
          viewModel={model({
            state: { kind: 'ready', deck },
            commitDecision: () => {
              setDeck((current) => ({
                active: current.queued[0] ?? null,
                queued: current.queued.slice(1),
              }));
              return true;
            },
          })}
          SwipeCardComponent={TrackingSwipeCard}
        />
      );
    }

    await render(<PromotionHarness />);
    expect(mountCounts.get(2)).toBe(1);

    await fireEvent.press(screen.getByRole('button', { name: '完成1右滑' }));
    expect(await screen.findByText('Test card 2')).toBeOnTheScreen();
    expect(mountCounts.get(2)).toBe(1);
  });

  test('keeps the active card gesture callbacks identical across a decision re-render', async () => {
    const seen: { onCommit: unknown; onExitComplete: unknown }[] = [];
    const RecordingSwipeCard = forwardRef<SwipeCardHandle, Omit<SwipeCardProps, 'ref'>>(
      function RecordingSwipeCard(props, ref) {
        if (props.interactive) {
          seen.push({
            onCommit: props.onCommit,
            onExitComplete: props.onExitComplete,
          });
        }
        return <TestSwipeCard ref={ref} {...props} />;
      },
    );

    const deck = { active, queued: [next] };
    const view = await render(
      <DiscoverView
        viewModel={model({ state: { kind: 'ready', deck }, isDeciding: false })}
        SwipeCardComponent={RecordingSwipeCard}
      />,
    );
    await view.rerender(
      <DiscoverView
        viewModel={model({ state: { kind: 'ready', deck }, isDeciding: true })}
        SwipeCardComponent={RecordingSwipeCard}
      />,
    );

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1].onCommit).toBe(seen[0].onCommit);
    expect(seen[seen.length - 1].onExitComplete).toBe(seen[0].onExitComplete);
  });

  function LifecycleHarness() {
    const [deck, setDeck] = useState({ active, queued: [next, image(3)] });
    // Backlog #11: the view advances the deck whenever commitDecision reports a
    // card was advanced. Success/failure of the durable write is the hook's
    // background concern (covered in use-discovery.test) and never rewinds the
    // view, so there is no "failed decision keeps the card" path here any more.
    const commitDecision = jest.fn((): boolean => {
      if (deck.active === null) return false;
      setDeck((current) => ({
        active: current.queued[0] ?? null,
        queued: current.queued.slice(1),
      }));
      return true;
    });

    return (
      <DiscoverView
        viewModel={model({
          state: { kind: 'ready', deck },
          commitDecision,
        })}
      />
    );
  }

  test('successive commits advance the deck to fresh dismissible instances', async () => {
    await render(<LifecycleHarness />);

    await fireEvent.press(screen.getByRole('button', { name: '收藏' }));
    expect(await screen.findByLabelText('当前图片 2')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '收藏' }));

    expect(await screen.findByLabelText('当前图片 3')).toBeOnTheScreen();
  });

  type DiscoverElement = ReturnType<typeof screen.getByTestId>;

  // Labels of the root's DIRECT children only. The floating toast must never
  // appear here: a direct child occupies a slot in the gap-based column and
  // pushes the action row down under the tab bar.
  function directChildLabels(element: DiscoverElement): (string | undefined)[] {
    return element.children
      .filter((child): child is DiscoverElement => typeof child !== 'string')
      .map((child) => child.props['aria-label'] ?? child.props.accessibilityLabel);
  }

  function hostChildren(element: DiscoverElement): DiscoverElement[] {
    return element.children.filter(
      (child): child is DiscoverElement => typeof child !== 'string',
    );
  }

  // Every style layer on a host element, flattened out of nested arrays, so a
  // test can pin a value in each layer rather than only the last one to win.
  function styleLayers(element: DiscoverElement): Record<string, unknown>[] {
    return [element.props.style]
      .flat(Infinity)
      .filter((layer): layer is Record<string, unknown> =>
        layer !== null && typeof layer === 'object');
  }

  // Board #24: the toast survives for errors only (a decide or a rewind that
  // did not land). A decision itself shows nothing.
  function renderWithDecisionError(overrides: Partial<DiscoverViewModel> = {}) {
    return render(
      <DiscoverView
        viewModel={model({ decisionError: '未能完成操作，请重试', ...overrides })}
        viewport={{ width: 844, height: 390, fontScale: 2 }}
      />,
    );
  }

  test('the error toast fades out and stops taking touches while the peek panel is open', async () => {
    const captured: { peek?: SharedValue<number> } = {};
    const PeekCard = forwardRef<SwipeCardHandle, Omit<SwipeCardProps, 'ref'>>(
      function PeekCard({ peekProgress }, ref) {
        useImperativeHandle(ref, () => ({ dismiss: () => undefined }));
        useEffect(() => {
          // Only the active layer is handed the deck's peek progress.
          if (peekProgress) captured.peek = peekProgress;
        }, [peekProgress]);
        return null;
      },
    );
    await render(
      <DiscoverView
        viewModel={model({ decisionError: '未能完成操作，请重试' })}
        SwipeCardComponent={PeekCard}
      />,
    );
    const toast = screen.getByLabelText('发现反馈');
    const animated = () => toast.props.jestAnimatedStyle?.value ?? {};

    // R8.2b: the panel opens against the deck's bottom edge, where the toast
    // sits; the shared chrome rule fades it and lets touches through.
    await act(async () => { captured.peek!.value = 1; });
    await waitFor(() => expect(animated().opacity).toBe(0));
    expect(animated().pointerEvents).toBe('none');

    await act(async () => { captured.peek!.value = 0; });
    await waitFor(() => expect(animated().opacity).toBe(1));
    expect(animated().pointerEvents).toBe('box-none');
  });

  test('the error toast floats over the deck bottom instead of taking layout space', async () => {
    await renderWithDecisionError();

    // The toast is a sticker on the deck: it lives INSIDE the deck wrapper,
    // pinned to its bottom edge, so showing it moves neither card nor buttons.
    const toast = within(screen.getByLabelText('发现卡组'))
      .getByLabelText('发现反馈');
    expect(toast).toBeOnTheScreen();
    expect(toast).toHaveStyle({ position: 'absolute' });
    const toastStyle = StyleSheet.flatten(toast.props.style);
    expect(typeof toastStyle.bottom).toBe('number');
    expect(typeof toastStyle.left).toBe('number');
    expect(typeof toastStyle.right).toBe('number');
    // R8.2's original acceptance: the toast never covers the artwork TOP. A
    // pinned `top` would stretch it over the whole card, so guard its absence.
    expect(toastStyle.top).toBeUndefined();

    // ...and therefore takes no slot of its own in the root column.
    expect(directChildLabels(screen.getByTestId('screen-discover')))
      .not.toContain('发现反馈');
  });

  test('the floating error toast leaves the deck pan alive in its own band', async () => {
    await renderWithDecisionError();
    const toast = within(screen.getByLabelText('发现卡组'))
      .getByLabelText('发现反馈');

    // A gesture-handler traversal walks the deck's children in drawing order,
    // last-first, so the toast (top of the ladder) is visited before the card.
    // An opaque 'auto' view with a background becomes the touch target there
    // and the walk stops, which would kill swipe AND peek inside the toast's
    // band — the exact strip a one-handed thumb rests on — for as long as the
    // error shows. 'box-none' makes the box itself untargetable and lets the
    // walk fall through to the card layer.
    expect(toast).toHaveStyle({ pointerEvents: 'box-none' });
    // Every layer that sets it rests at 'box-none' — the static style too, so
    // the pan stays alive even if the animated peek layer drops the key.
    const pointerLayers = styleLayers(toast).filter((layer) => 'pointerEvents' in layer);
    expect(pointerLayers.length).toBeGreaterThan(0);
    for (const layer of pointerLayers) {
      expect(layer.pointerEvents).toBe('box-none');
    }

    // Recursing past the box is only half the escape. 'box-none' sends the
    // walk into the children, and the message is a <Text> — a leaf, which the
    // traversal treats as a touch target on sight. Only a ReactViewGroup
    // honours pointerEvents on Android, so the message rides inside a 'none'
    // <View>: that subtree is skipped whole and the band stays pannable.
    expect(screen.getByText('未能完成操作，请重试').parent)
      .toHaveStyle({ pointerEvents: 'none' });

    // Board #24: the toast has no control of its own any more — 撤销 is gone,
    // the rewind button in the action row replaced it.
    expect(within(toast).queryByRole('button')).not.toBeOnTheScreen();
  });

  test('bottom-pinned deck chrome yields to the peek panel', () => {
    // The toast and the peek panel's 查看来源 button are both pinned to the
    // deck's bottom edge and overlap there, and the toast paints on top. Deck
    // chrome therefore fades and stops taking touches while the peek panel is
    // open — the rule the action row already follows, now shared so the two
    // cannot drift apart.
    expect(getDiscoverPeekChromeStyle(0, 'box-none'))
      .toEqual({ opacity: 1, pointerEvents: 'box-none' });
    expect(getDiscoverPeekChromeStyle(0, 'auto'))
      .toEqual({ opacity: 1, pointerEvents: 'auto' });
    // Half open: still legible, still inert-by-default for the box.
    expect(getDiscoverPeekChromeStyle(0.5, 'box-none'))
      .toEqual({ opacity: 0.5, pointerEvents: 'box-none' });
    // Settled open: invisible and untouchable, so the source link underneath
    // is both readable and tappable.
    expect(getDiscoverPeekChromeStyle(1, 'box-none'))
      .toEqual({ opacity: 0, pointerEvents: 'none' });
    expect(getDiscoverPeekChromeStyle(1, 'auto'))
      .toEqual({ opacity: 0, pointerEvents: 'none' });
  });

  test('the action row keeps its slot while the error toast is visible', async () => {
    const view = await renderWithDecisionError();
    const withToast = directChildLabels(screen.getByTestId('screen-discover'));

    // Deck, then action row, with nothing wedged between them.
    expect(withToast).toEqual(['发现卡组', '发现操作']);

    await view.rerender(
      <DiscoverView
        viewModel={model({ decisionError: null })}
        viewport={{ width: 844, height: 390, fontScale: 2 }}
      />,
    );
    // Identical column with and without the toast.
    expect(directChildLabels(screen.getByTestId('screen-discover'))).toEqual(withToast);
  });

  test('the error toast stays bounded at large text and leaves once the error clears', async () => {
    const view = await renderWithDecisionError({ decisionError: '无法回退，请继续浏览' });

    // R8.2: the toast is transient and floats over the deck's BOTTOM edge,
    // clear of the artwork top and outside the root's layout column.
    const feedback = screen.getByLabelText('发现反馈');
    expect(within(screen.getByLabelText('发现卡组')).getByLabelText('发现反馈'))
      .toBe(feedback);
    expect(screen.getByText('无法回退，请继续浏览')).toBeOnTheScreen();
    expect(screen.getByText('无法回退，请继续浏览').props.maxFontSizeMultiplier)
      .toBeUndefined();
    expect(feedback).toHaveStyle({ maxHeight: 76 });

    await view.rerender(<DiscoverView viewModel={model({ decisionError: null })} />);
    expect(screen.queryByText('无法回退，请继续浏览')).not.toBeOnTheScreen();
    expect(screen.queryByLabelText('发现反馈')).not.toBeOnTheScreen();
  });

  test('deck feedback shows only an error and stays silent otherwise', async () => {
    const view = await render(
      <DiscoverView
        viewModel={model({
          state: { kind: 'offline', deck: { active, queued: [next] } },
          decisionError: '未能完成操作，请重试',
        })}
      />,
    );
    expect(screen.getByText('未能完成操作，请重试')).toBeOnTheScreen();
    expect(screen.queryByText('离线浏览')).not.toBeOnTheScreen();

    // R8.2: offline is normal browsing — no persistent banner — and board #24:
    // a rewindable history is not a message either.
    await view.rerender(
      <DiscoverView
        viewModel={model({
          state: { kind: 'offline', deck: { active, queued: [next] } },
          canRewind: true,
        })}
      />,
    );
    expect(screen.queryByLabelText('发现反馈')).not.toBeOnTheScreen();
    expect(screen.queryByText('离线浏览')).not.toBeOnTheScreen();
  });

  describe('board #24 rewind row', () => {
    function wrapperOf(testID: string): DiscoverElement {
      return screen.getByTestId(testID).parent as DiscoverElement;
    }

    // A card whose only job is to record which way the buttons dismiss it.
    function spyCard(dismissals: string[]) {
      return forwardRef<SwipeCardHandle, Omit<SwipeCardProps, 'ref'>>(
        function SpyCard(_props, ref) {
          useImperativeHandle(ref, () => ({
            dismiss: (direction) => { dismissals.push(direction); },
          }));
          return null;
        },
      );
    }

    function expectNoDecisionToast() {
      expect(screen.queryByLabelText('发现反馈')).not.toBeOnTheScreen();
      for (const copy of ['已收藏图片', '已略过图片', '撤销']) {
        expect(screen.queryByText(copy, { includeHiddenElements: true }))
          .not.toBeOnTheScreen();
      }
      expect(screen.queryByRole('button', { name: '撤销' })).not.toBeOnTheScreen();
    }

    test('the row is [rewind 52 · heart 72 · X 52] in render and TalkBack order', async () => {
      await render(<DiscoverView viewModel={model({ canRewind: true })} />);

      const row = screen.getByLabelText('发现操作');
      // ACTION_ROW_HEIGHT: the deck budget still reserves exactly this band.
      expect(row).toHaveStyle({ minHeight: 76 });
      expect(hostChildren(row).map(
        (wrapper) => within(wrapper).getByRole('button').props.testID,
      )).toEqual(['discover-rewind', 'discover-save', 'discover-dismiss']);

      expect(wrapperOf('discover-rewind')).toHaveStyle({ width: 52, height: 52 });
      expect(wrapperOf('discover-save')).toHaveStyle({ width: 72, height: 72 });
      expect(wrapperOf('discover-dismiss')).toHaveStyle({ width: 52, height: 52 });
      // Rewind wears the X's chrome: a bordered surfaceSecondary disc...
      for (const testID of ['discover-rewind', 'discover-dismiss']) {
        expect(wrapperOf(testID)).toHaveStyle({
          borderWidth: 1,
          borderColor: lightColors.border,
          backgroundColor: lightColors.surfaceSecondary,
        });
      }
      // ...carrying lucide's circular arrow at the X's size, stroke and colour.
      expect(within(wrapperOf('discover-rewind')).getByTestId('icon-RotateCcw').props)
        .toMatchObject({ size: 20, strokeWidth: 2.2, color: lightColors.textSecondary });
      expect(within(wrapperOf('discover-save')).getByTestId('icon-Heart'))
        .toBeOnTheScreen();
      expect(within(wrapperOf('discover-dismiss')).getByTestId('icon-X'))
        .toBeOnTheScreen();
    });

    test('with nothing to rewind the button is half-transparent, disabled and inert', async () => {
      const rewind = jest.fn(() => true);
      await render(<DiscoverView viewModel={model({ canRewind: false, rewind })} />);

      const button = screen.getByRole('button', { name: '回退上一张' });
      expect(button.props.accessibilityState).toMatchObject({ disabled: true });
      expect(button).toBeDisabled();
      // The whole button fades (owner: 半透明) — the disc and its border, not
      // only the arrow — and the arrow is not faded a second time inside it.
      expect(wrapperOf('discover-rewind')).toHaveStyle({ opacity: 0.38 });
      expect(button).toHaveStyle({ opacity: 1 });
      await fireEvent.press(button);
      expect(rewind).not.toHaveBeenCalled();
      // An empty history says nothing about the card: heart and X stay live.
      expect(screen.getByTestId('discover-save')).toBeEnabled();
      expect(screen.getByTestId('discover-dismiss')).toBeEnabled();
    });

    test('with something to rewind one press rewinds once and never touches the card', async () => {
      const rewind = jest.fn(() => true);
      const dismissals: string[] = [];
      const SpyCard = spyCard(dismissals);
      await render(
        <DiscoverView
          viewModel={model({ canRewind: true, rewind })}
          SwipeCardComponent={SpyCard}
        />,
      );

      const button = screen.getByRole('button', { name: '回退上一张' });
      expect(button).toBeEnabled();
      expect(button).toHaveStyle({ opacity: 1 });
      expect(wrapperOf('discover-rewind')).toHaveStyle({ opacity: 1 });
      await fireEvent.press(button);
      expect(rewind).toHaveBeenCalledTimes(1);
      expect(dismissals).toEqual([]);
    });

    const rewindableStates: [string, Partial<DiscoverViewModel>][] = [
      ['an exhausted, empty deck', {
        state: { kind: 'exhausted', deck: { active: null, queued: [] } },
      }],
      ['a pipeline that is still draining', { isDeciding: true, canDecide: false }],
    ];

    test.each(rewindableStates)('rewind stays pressable on %s while heart and X do not', async (
      _name,
      overrides,
    ) => {
      const rewind = jest.fn(() => true);
      await render(
        <DiscoverView viewModel={model({ canRewind: true, rewind, ...overrides })} />,
      );

      expect(screen.getByTestId('discover-save')).toBeDisabled();
      expect(screen.getByTestId('discover-dismiss')).toBeDisabled();
      const button = screen.getByTestId('discover-rewind');
      expect(button).toBeEnabled();
      await fireEvent.press(button);
      expect(rewind).toHaveBeenCalledTimes(1);
    });

    test('heart and X stay enabled while a decision drains when canDecide is true', async () => {
      const dismissals: string[] = [];
      const SpyCard = spyCard(dismissals);
      await render(
        <DiscoverView
          viewModel={model({ isDeciding: true, canDecide: true })}
          SwipeCardComponent={SpyCard}
        />,
      );

      expect(screen.getByTestId('discover-save')).toBeEnabled();
      expect(screen.getByTestId('discover-dismiss')).toBeEnabled();
      await fireEvent.press(screen.getByTestId('discover-dismiss'));
      expect(dismissals).toEqual(['left']);
    });

    test('heart and X are disabled whenever canDecide is false', async () => {
      const dismissals: string[] = [];
      const SpyCard = spyCard(dismissals);
      await render(
        <DiscoverView
          viewModel={model({ isDeciding: false, canDecide: false })}
          SwipeCardComponent={SpyCard}
        />,
      );

      expect(screen.getByTestId('discover-save')).toBeDisabled();
      expect(screen.getByTestId('discover-dismiss')).toBeDisabled();
      await fireEvent.press(screen.getByTestId('discover-dismiss'));
      expect(dismissals).toEqual([]);
    });

    test('the heart dismisses the card right and X dismisses it left', async () => {
      const dismissals: string[] = [];
      const rewind = jest.fn(() => true);
      const SpyCard = spyCard(dismissals);
      await render(
        <DiscoverView
          viewModel={model({ canRewind: true, rewind })}
          SwipeCardComponent={SpyCard}
        />,
      );

      await fireEvent.press(screen.getByRole('button', { name: '收藏' }));
      await fireEvent.press(screen.getByRole('button', { name: '略过' }));
      expect(dismissals).toEqual(['right', 'left']);
      expect(rewind).not.toHaveBeenCalled();
    });

    test('a swipe grows the heart (right) or X (left), never rewind', async () => {
      const captured: { progress?: SharedValue<number> } = {};
      const ProgressCard = forwardRef<SwipeCardHandle, Omit<SwipeCardProps, 'ref'>>(
        function ProgressCard({ swipeProgress }, ref) {
          useImperativeHandle(ref, () => ({ dismiss: () => undefined }));
          useEffect(() => {
            // Only the active layer is handed the deck's swipe progress.
            if (swipeProgress) captured.progress = swipeProgress;
          }, [swipeProgress]);
          return null;
        },
      );
      await render(
        <DiscoverView
          viewModel={model({ canRewind: true })}
          SwipeCardComponent={ProgressCard}
        />,
      );
      // Reanimated's Jest mode publishes the live animated style on the host as
      // `jestAnimatedStyle`. Its `toHaveAnimatedStyle` matcher reads the same
      // value but throws on the `undefined` entries of the static style.
      const scaleOf = (testID: string): number | undefined =>
        wrapperOf(testID).props.jestAnimatedStyle?.value?.transform?.[0]?.scale;

      // A left swipe past the action threshold (0.28 of the card width). The
      // worklets mock applies it asynchronously, so wait for the button that
      // must grow. Rewind and heart registered their mappers before X (JSX
      // order), so by then both have been recomputed from the same value.
      await act(async () => { captured.progress!.value = -0.28; });
      await waitFor(() => expect(scaleOf('discover-dismiss')).toBeCloseTo(1.06));
      expect(scaleOf('discover-save')).toBe(1);
      expect(scaleOf('discover-rewind')).toBe(1);

      await act(async () => { captured.progress!.value = 0.28; });
      await waitFor(() => expect(scaleOf('discover-save')).toBeCloseTo(1.06));
      expect(scaleOf('discover-dismiss')).toBe(1);
      expect(scaleOf('discover-rewind')).toBe(1);
    });

    const quietStates: [string, Partial<DiscoverViewModel>][] = [
      ['right after a swipe', { canRewind: true, isDeciding: true }],
      ['once the pipeline has drained', { canRewind: true }],
      ['on an exhausted deck', {
        canRewind: true,
        state: { kind: 'exhausted', deck: { active: null, queued: [] } },
      }],
    ];

    test.each(quietStates)('no success toast shows %s', async (_name, overrides) => {
      await render(<DiscoverView viewModel={model(overrides)} />);
      expectNoDecisionToast();
    });

    test('deciding through the heart and X never raises a toast', async () => {
      await render(<LifecycleHarness />);

      await fireEvent.press(screen.getByRole('button', { name: '收藏' }));
      expect(await screen.findByLabelText('当前图片 2')).toBeOnTheScreen();
      expectNoDecisionToast();
      await fireEvent.press(screen.getByRole('button', { name: '略过' }));
      expect(await screen.findByLabelText('当前图片 3')).toBeOnTheScreen();
      expectNoDecisionToast();
    });
  });
});
