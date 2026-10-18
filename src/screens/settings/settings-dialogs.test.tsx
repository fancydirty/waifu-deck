import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, userEvent, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import i18n from '@/i18n';
import { actionColors, colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { fontFamilies, settingsTypography } from '@/theme/typography';
import { ChoiceModal, ConfirmModal, DeleteAllModal, type SettingsChoiceOption } from './settings-dialogs';

/**
 * U3b RED pins (plan `2026-10-11-n7-u3-settings-sheets-dialogs.md`): ChoiceModal
 * matches mockup v4 §3 「选择表和确认框（改后）」 — bottom sheet with scrim, grab
 * bar, 17/800 header, option rows in a group card, radio-dot selected state and
 * bottom safe-area clearance. Behaviour is frozen: copy, option order, roles,
 * accessible names, selection writes and close/cancel stay byte-for-byte, so
 * every caller (language, numeric pickers, storage mode) keeps working with the
 * same semantics.
 */

// Independent literals and values (CD11): never derived from settings-options.ts.
const OPTIONS: readonly SettingsChoiceOption[] = [
  { label: 'No limit', value: 0 },
  { label: '720 px', value: 720 },
  { label: '1080 px', value: 1080 },
  { label: '1440 px', value: 1440 },
];
const LABELS = OPTIONS.map((option) => option.label);

type FlatStyle = { [key: string]: unknown };

function flattened(node: unknown): FlatStyle | undefined {
  return StyleSheet.flatten((node as { props: { style?: unknown } }).props.style) as FlatStyle | undefined;
}

function sheetView() {
  const [sheet] = screen.container.queryAll((node) => {
    const style = flattened(node);
    return style?.borderTopLeftRadius === metrics.settingsSheet.radius
      && style?.borderTopRightRadius === metrics.settingsSheet.radius;
  });
  return sheet;
}

function scrimView() {
  const [scrim] = screen.container.queryAll((node) =>
    flattened(node)?.backgroundColor === actionColors.sheetScrim);
  return scrim;
}

function groupCard() {
  const [group] = screen.container.queryAll((node) => {
    const style = flattened(node);
    return style?.borderRadius === metrics.radius.card
      && style?.borderWidth === 1
      && style?.overflow === 'hidden';
  });
  return group;
}

function grabBar() {
  const [grab] = screen.container.queryAll((node) => {
    const style = flattened(node);
    return style?.width === metrics.settingsSheet.grabWidth
      && style?.height === metrics.settingsSheet.grabHeight;
  });
  return grab;
}

function radioRings() {
  return screen.container.queryAll((node) => {
    const style = flattened(node);
    return style?.width === metrics.settingsSheet.radioSize
      && style?.height === metrics.settingsSheet.radioSize
      && style?.borderRadius === metrics.radius.circle;
  });
}

function filledDots() {
  return screen.container.queryAll((node) => {
    const style = flattened(node);
    return style?.position === 'absolute'
      && style?.top === metrics.settingsSheet.radioDotInset
      && style?.backgroundColor === colors.light.save;
  });
}

function preorder() {
  const out: unknown[] = [];
  const walk = (node: { children: unknown[] }) => {
    out.push(node);
    for (const child of node.children) {
      if (typeof child !== 'string') walk(child as typeof node);
    }
  };
  walk(screen.container as unknown as { children: unknown[] });
  return out;
}

async function renderSheet(overrides: {
  selectedValue?: number | string | null;
  safeAreaBottom?: number;
  onSelect?: (value: number | string) => void;
  onClose?: () => void;
} = {}) {
  const onSelect = overrides.onSelect ?? jest.fn();
  const onClose = overrides.onClose ?? jest.fn();
  await render(
    <ChoiceModal
      title="Minimum width"
      options={OPTIONS}
      visible
      onSelect={onSelect}
      onClose={onClose}
      selectedValue={overrides.selectedValue}
      safeAreaBottom={overrides.safeAreaBottom}
    />,
  );
  return { onSelect, onClose };
}

test('the scrim is the v4 sheet scrim and the sheet anchors to the bottom edge', async () => {
  await renderSheet();
  const scrim = scrimView();
  expect(scrim).toHaveStyle({
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: actionColors.sheetScrim,
  });

  const sheet = sheetView();
  expect(sheet).toHaveStyle({
    backgroundColor: colors.light.surfaceSecondary,
    borderTopLeftRadius: metrics.settingsSheet.radius,
    borderTopRightRadius: metrics.settingsSheet.radius,
    borderTopWidth: 1,
    borderTopColor: colors.light.border,
    paddingTop: metrics.settingsSheet.paddingTop,
    paddingHorizontal: metrics.settingsSheet.paddingH,
  });
  // Gesture-band clamp: the reported Honor inset (~0) must still clear the
  // 24 dp gesture band (U2c2 `Math.max(insets.bottom, metrics.gestureInset)`).
  expect(flattened(sheet)!.paddingBottom).toBe(
    metrics.settingsSheet.paddingBottom + Math.max(0, metrics.gestureInset),
  );
});

// Independent expected clearances (16 + the clamped bottom inset).
test.each([
  [undefined, 40],
  [4, 40],
  [48, 64],
] as const)('sheet bottom safe area sums padding and the bottom inset (%p)', async (safeAreaBottom, expected) => {
  await renderSheet({ safeAreaBottom });
  expect(flattened(sheetView())!.paddingBottom).toBe(expected);
});

test('grab bar and sheet header follow the v4 tokens and keep their order', async () => {
  await renderSheet();
  const grab = grabBar();
  expect(grab).toHaveStyle({
    width: metrics.settingsSheet.grabWidth,
    height: metrics.settingsSheet.grabHeight,
    borderRadius: metrics.radius.circle,
    backgroundColor: colors.light.border,
    alignSelf: 'center',
    marginTop: metrics.settingsSheet.grabTopGap,
    marginBottom: metrics.settingsSheet.grabBottomGap,
  });

  const title = screen.getByText('Minimum width');
  expect(title).toHaveStyle({
    ...settingsTypography.sheetTitle,
    color: colors.light.text,
    marginBottom: metrics.settingsSheet.headerGap,
  });

  const order = preorder();
  expect(order.indexOf(grab)).toBeLessThan(order.indexOf(title));
  expect(order.indexOf(title)).toBeLessThan(order.indexOf(groupCard()));
});

test('option rows keep order, roles, names and the v4 row geometry', async () => {
  await renderSheet();
  const rows = screen.getAllByRole('button');
  expect(rows.map((row) => row.props.accessibilityLabel)).toEqual(LABELS);

  for (const row of rows) {
    const style = flattened(row)!;
    expect(style.minHeight).toBe(metrics.settingsSheet.rowMinHeight);
    // Plan floor: every option row keeps a >= 48 dp touch frame.
    expect(style.minHeight).toBeGreaterThanOrEqual(metrics.minimumHitArea);
    expect(row).toHaveStyle({
      flexDirection: 'row',
      alignItems: 'center',
      gap: metrics.settingsSheet.rowContentGap,
      paddingVertical: metrics.settingsSheet.rowPaddingV,
      paddingHorizontal: metrics.settingsSheet.rowPaddingH,
    });
    expect(within(row).getByText(row.props.accessibilityLabel as string)).toHaveStyle({
      ...settingsTypography.rowTitle,
      color: colors.light.text,
    });
  }

  expect(flattened(rows[0])!.borderTopWidth).toBe(0);
  for (const row of rows.slice(1)) {
    expect(row).toHaveStyle({ borderTopWidth: 1, borderTopColor: colors.light.hair });
  }

  // Rest look is pinned here; the held look (pressed 0.62 vs disabled 0.38,
  // CD12) is device-measured like U1/U3a, and the pressed branch keeps the
  // row/button convention (see the behaviour-freeze audit).
  expect(flattened(rows[0])!.opacity).toBe(1);
});

test('the selected option draws the v4 filled radio and the others stay empty', async () => {
  await renderSheet({ selectedValue: 1080 });
  const rows = screen.getAllByRole('button');
  const rings = radioRings();
  expect(rings).toHaveLength(OPTIONS.length);
  for (const row of rows) {
    // The radio is decorative: it never becomes its own button target.
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
  }

  for (const ring of rings) {
    expect(ring).toHaveStyle({
      width: metrics.settingsSheet.radioSize,
      height: metrics.settingsSheet.radioSize,
      borderRadius: metrics.radius.circle,
      borderWidth: metrics.settingsSheet.radioBorderWidth,
    });
  }
  expect(rings[2]).toHaveStyle({ borderColor: colors.light.save });
  for (const ring of [rings[0], rings[1], rings[3]]) {
    expect(ring).toHaveStyle({ borderColor: colors.light.border });
  }

  const dots = filledDots();
  expect(dots).toHaveLength(1);
  expect(dots[0]).toHaveStyle({
    position: 'absolute',
    top: metrics.settingsSheet.radioDotInset,
    left: metrics.settingsSheet.radioDotInset,
    right: metrics.settingsSheet.radioDotInset,
    bottom: metrics.settingsSheet.radioDotInset,
    borderRadius: metrics.radius.circle,
    backgroundColor: colors.light.save,
  });
  expect(rings[2]!.queryAll((node) => flattened(node)?.position === 'absolute')).toHaveLength(1);
  for (const ring of [rings[0]!, rings[1]!, rings[3]!]) {
    expect(ring.queryAll((node) => flattened(node)?.position === 'absolute')).toHaveLength(0);
  }
});

test('without a selected value every radio dot stays empty', async () => {
  await renderSheet({ selectedValue: null });
  expect(radioRings()).toHaveLength(OPTIONS.length);
  expect(filledDots()).toHaveLength(0);
});

test('selection stays a pure visual: names, order and writes are byte-frozen', async () => {
  const { onSelect, onClose } = await renderSheet({ selectedValue: 720 });
  const rows = screen.getAllByRole('button');

  // Accessible names stay exactly the caller's option labels (CD10).
  expect(rows.map((row) => row.props.accessibilityLabel)).toEqual(LABELS);
  for (const label of LABELS) {
    expect(screen.getAllByText(label)).toHaveLength(1);
  }

  await userEvent.press(rows[3]!);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith(1440);
  expect(onClose).not.toHaveBeenCalled();

  // Android back: the Modal forwards onRequestClose to its host view
  // (RCTModalHostView), which is the only fireable close surface in RNTL 14.
  const [modalHost] = screen.container.queryAll((node) =>
    typeof (node.props as { onRequestClose?: unknown }).onRequestClose === 'function');
  expect(modalHost).toBeDefined();
  fireEvent(modalHost!, 'requestClose');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('ChoiceModal draws only from tokens and callers publish the current value', () => {
  const source = readFileSync(join(__dirname, 'settings-dialogs.tsx'), 'utf8');
  const choiceBody = source.slice(
    source.indexOf('export function ChoiceModal'),
    source.indexOf('export function ConfirmModal'),
  );
  expect(choiceBody).toContain('theme.sheetScrim');
  expect(choiceBody).toContain('settingsTypography.sheetTitle');
  expect(choiceBody).toContain('metrics.settingsSheet.');
  expect(choiceBody).toContain('Math.max(bottomInset, metrics.gestureInset)');
  expect(choiceBody).not.toMatch(/rgba\(/);
  expect(choiceBody).not.toMatch(/fontSize:\s*\d/);
  expect(choiceBody).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);

  // Supplementary wiring guards (CD11: source guards are not behavioural
  // mutation evidence): each caller feeds the sheet its current value so the
  // v4 selected mark is drawn on the live option.
  expect(readFileSync(join(__dirname, 'settings-screen.tsx'), 'utf8'))
    .toContain('selectedValue={settings.language}');
  expect(readFileSync(join(__dirname, 'discover-settings-screen.tsx'), 'utf8'))
    .toContain('selectedValue={choice === \'minWidth\' ? settings.minWidth : settings.maxBytes}');
  expect(readFileSync(join(__dirname, 'byos-settings-section.tsx'), 'utf8'))
    .toContain('selectedValue={storageModeValue}');
});

/**
 * U3c RED pins (same plan): ConfirmModal/DeleteAllModal match mockup v4 §3
 * 「选择表和确认框（改后）」 — the .wd-dialog card on the unified sheet scrim,
 * 17/800 title in ordinary text colour, 13.5/600/1.55 body, .wd-actions row
 * (right-aligned, 8 gap, 14 top gap) with ghost + danger-small actions and the
 * .wd-input delete box. Everything below pins v4 numbers as independent
 * literals so a regression cannot hide behind a changed token. Behaviour
 * freeze: prop signatures, roles, accessible names (including the delete
 * cancel's distinct aria-label), onRequestClose/onCancel/onConfirm semantics
 * and the typed-DELETE exact-match guard are unchanged; the reset-settings
 * guard suite stays untouched.
 */

// v4 §3 literals, copied from the mockup CSS — never read back from tokens.
const V4 = {
  dialogRadius: 18,
  dialogPaddingTop: 18,
  dialogPaddingH: 16,
  dialogPaddingBottom: 14,
  dialogBorderWidth: 1,
  dialogShadow: '0 18px 40px -18px rgba(84, 75, 72, 0.55)',
  titleSize: 17,
  titleGap: 8,
  bodySize: 13.5,
  bodyWeight: 1.55,
  inputTopGap: 12,
  inputBorderWidth: 1.5,
  inputRadius: 12,
  inputPaddingV: 10,
  inputPaddingH: 12,
  inputSize: 15,
  actionTopGap: 14,
  actionGap: 8,
  actionPillMinHeight: 34,
  actionFrame: 7,
  actionPaddingH: 12,
  actionRadius: 10,
  actionSize: 13,
} as const;

function dialogCard() {
  const [card] = screen.container.queryAll((node) => {
    const style = flattened(node);
    return style?.borderRadius === V4.dialogRadius
      && style?.borderWidth === V4.dialogBorderWidth
      && style?.paddingTop === V4.dialogPaddingTop;
  });
  return card;
}

function actionsRow() {
  const [row] = screen.container.queryAll((node) => {
    const style = flattened(node);
    return style?.flexDirection === 'row'
      && style?.justifyContent === 'flex-end'
      && style?.gap === V4.actionGap
      && style?.marginTop === V4.actionTopGap;
  });
  return row;
}

function pillOf(button: { children: unknown[] }) {
  return button.children[0];
}

async function renderConfirm(overrides: { cancelLabel?: string } = {}) {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  await render(
    <ConfirmModal
      visible
      title="Reset dismissed history?"
      message="Dismissed images may appear again; your collection stays."
      confirmLabel="Confirm reset"
      cancelLabel={overrides.cancelLabel}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onCancel, onConfirm };
}

async function renderDeleteAll(overrides: { busy?: boolean } = {}) {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  await render(
    <DeleteAllModal visible busy={overrides.busy ?? false} onCancel={onCancel} onConfirm={onConfirm} />,
  );
  return { onCancel, onConfirm };
}

describe('U3c confirm dialogs', () => {
  beforeEach(async () => { await i18n.changeLanguage('zh-Hans'); });

  test('the confirm dialog is the v4 .wd-dialog card on the unified scrim', async () => {
    await renderConfirm();
    const scrim = scrimView();
    expect(scrim).toHaveStyle({
      flex: 1,
      justifyContent: 'center',
      backgroundColor: actionColors.sheetScrim,
    });
    expect(actionColors.sheetScrim).toBe('rgba(28, 20, 18, 0.45)');

    const card = dialogCard();
    expect(card).toBeDefined();
    expect(card).toHaveStyle({
      backgroundColor: colors.light.surfaceSecondary,
      borderRadius: V4.dialogRadius,
      paddingTop: V4.dialogPaddingTop,
      paddingHorizontal: V4.dialogPaddingH,
      paddingBottom: V4.dialogPaddingBottom,
      borderWidth: V4.dialogBorderWidth,
      borderColor: colors.light.border,
    });
    expect(flattened(card)!.boxShadow).toBe(V4.dialogShadow);
  });

  test('title and body take the v4 sheet-title and dialog-body scale', async () => {
    await renderConfirm();
    const title = screen.getByText('Reset dismissed history?');
    expect(flattened(title)).toMatchObject({
      fontSize: V4.titleSize,
      fontFamily: fontFamilies.sansHeavy,
      color: colors.light.text,
    });
    expect(flattened(title)!.marginBottom).toBe(V4.titleGap);

    const body = screen.getByText('Dismissed images may appear again; your collection stays.');
    expect(flattened(body)).toMatchObject({
      fontSize: V4.bodySize,
      fontFamily: fontFamilies.sansMedium,
      color: colors.light.text,
    });
    expect(flattened(body)!.lineHeight).toBeCloseTo(V4.bodySize * V4.bodyWeight, 4);
    expect(body.props.selectable).toBe(true);
  });

  test('action row is right-aligned with the frozen order: cancel left, confirm right', async () => {
    await renderConfirm();
    const row = actionsRow();
    expect(row).toBeDefined();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.props.accessibilityLabel))
      .toEqual(['取消', 'Confirm reset']);
    expect(within(row!).getAllByRole('button').map((button) => button.props.accessibilityLabel))
      .toEqual(['取消', 'Confirm reset']);
    const order = preorder();
    expect(order.indexOf(buttons[0]!)).toBeLessThan(order.indexOf(buttons[1]!));
  });

  test('a custom cancel label keeps its cancel semantics', async () => {
    const { onCancel, onConfirm } = await renderConfirm({ cancelLabel: 'Not now' });
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual(['Not now', 'Confirm reset']);
    expect(within(buttons[0]!).getByText('Not now')).toBeOnTheScreen();
    await userEvent.press(buttons[0]!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('ghost and danger actions follow the v4 fills with no outline', async () => {
    await renderConfirm();
    const [cancel, confirm] = screen.getAllByRole('button');
    const cancelPill = flattened(pillOf(cancel!))!;
    expect(cancelPill).toMatchObject({
      minHeight: V4.actionPillMinHeight,
      paddingHorizontal: V4.actionPaddingH,
      borderRadius: V4.actionRadius,
      backgroundColor: colors.light.controlFill,
    });
    expect(cancelPill.borderWidth).toBeUndefined();
    expect(within(cancel!).getByText('取消')).toHaveStyle({
      fontSize: V4.actionSize,
      fontFamily: fontFamilies.sansHeavy,
      color: colors.light.text,
    });

    // Danger is a solid fill with white ink — an outlined (bordered) danger
    // button must fail here on background, ink and the missing border.
    const confirmPill = flattened(pillOf(confirm!))!;
    expect(confirmPill).toMatchObject({
      minHeight: V4.actionPillMinHeight,
      paddingHorizontal: V4.actionPaddingH,
      borderRadius: V4.actionRadius,
      backgroundColor: colors.light.danger,
    });
    expect(confirmPill.borderWidth).toBeUndefined();
    expect(within(confirm!).getByText('Confirm reset')).toHaveStyle({
      fontSize: V4.actionSize,
      fontFamily: fontFamilies.sansHeavy,
      color: colors.light.destructiveText,
    });
  });

  test('dialog actions keep a >= 48 dp touch frame around the 34 dp pill', async () => {
    await renderConfirm();
    for (const button of screen.getAllByRole('button')) {
      const frame = flattened(button)!;
      expect(frame.paddingVertical).toBe(V4.actionFrame);
      expect(frame.marginVertical).toBe(-V4.actionFrame);
      const pill = flattened(pillOf(button))!;
      expect(pill.minHeight).toBe(V4.actionPillMinHeight);
      expect((pill.minHeight as number) + 2 * (frame.paddingVertical as number))
        .toBeGreaterThanOrEqual(metrics.minimumHitArea);
    }
  });

  test('the delete dialog reads as ordinary text and carries the v4 .wd-input box', async () => {
    await renderDeleteAll();
    const title = screen.getByText('删除全部应用数据');
    expect(flattened(title)).toMatchObject({
      fontSize: V4.titleSize,
      fontFamily: fontFamilies.sansHeavy,
      color: colors.light.text,
    });
    expect(flattened(title)!.color).not.toBe(colors.light.danger);

    const body = screen.getByText(i18n.t('settings.deleteAll.message'));
    expect(flattened(body)).toMatchObject({ color: colors.light.text });

    const input = screen.getByTestId('settings-delete-all-input');
    expect(flattened(input)).toMatchObject({
      marginTop: V4.inputTopGap,
      borderWidth: V4.inputBorderWidth,
      borderRadius: V4.inputRadius,
      paddingVertical: V4.inputPaddingV,
      paddingHorizontal: V4.inputPaddingH,
      fontSize: V4.inputSize,
      fontFamily: fontFamilies.mono,
      color: colors.light.textSecondary,
      minHeight: metrics.minimumHitArea,
    });
    expect(input.props.autoCapitalize).toBe('characters');
    expect(input.props.autoCorrect).toBe(false);
    expect(input).toHaveProp('editable', true);
    // TextInput keeps `aria-label` verbatim on the host node (Pressables map
    // it onto accessibilityLabel instead).
    expect(input.props['aria-label']).toBe('输入 DELETE');
  });

  test('delete actions keep their frozen names and the label/aria split', async () => {
    await renderDeleteAll();
    const cancel = screen.getByRole('button', { name: '取消删除全部应用数据' });
    const confirm = screen.getByTestId('settings-delete-all-confirm');
    // Visible text is the shared short label; only the aria-label carries the
    // longer frozen phrase.
    expect(within(cancel).getByText('取消')).toBeOnTheScreen();
    expect(within(confirm).getByText('删除')).toBeOnTheScreen();
    expect(confirm.props.accessibilityLabel).toBe('确认删除全部应用数据');
    expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel))
      .toEqual(['取消删除全部应用数据', '确认删除全部应用数据']);
  });

  test('the typed-DELETE gate stays exact-match and off dims to 0.38', async () => {
    const { onCancel, onConfirm } = await renderDeleteAll();
    const input = screen.getByTestId('settings-delete-all-input');
    const confirm = screen.getByTestId('settings-delete-all-confirm');
    expect(confirm).toBeDisabled();
    for (const phrase of ['delete', 'Delete', ' DELETE', 'DELETE ', 'DELETE\n', '']) {
      await fireEvent.changeText(input, phrase);
      expect(confirm).toBeDisabled();
      expect(confirm.props.accessibilityState).toMatchObject({ disabled: true });
      await userEvent.press(confirm);
      expect(onConfirm).not.toHaveBeenCalled();
    }
    expect(flattened(confirm)!.opacity).toBe(0.38);

    await fireEvent.changeText(input, 'DELETE');
    expect(confirm).toBeEnabled();
    expect(flattened(confirm)!.opacity).toBe(1);
    await userEvent.press(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await userEvent.press(screen.getByRole('button', { name: '取消删除全部应用数据' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('busy keeps the delete dialog inert and dimmed', async () => {
    await renderDeleteAll({ busy: true });
    expect(screen.getByTestId('settings-delete-all-input')).toHaveProp('editable', false);
    const confirm = screen.getByTestId('settings-delete-all-confirm');
    const cancel = screen.getByRole('button', { name: '取消删除全部应用数据' });
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
    expect(flattened(confirm)!.opacity).toBe(0.38);
    expect(flattened(cancel)!.opacity).toBe(0.38);
  });

  test('confirm dialogs draw only from tokens and keep the exact-match guard', () => {
    const source = readFileSync(join(__dirname, 'settings-dialogs.tsx'), 'utf8');
    const dialogsBody = source.slice(
      source.indexOf('function DialogAction'),
      source.indexOf('export function remainingDeleteMessage'),
    );
    expect(dialogsBody).toContain('theme.sheetScrim');
    expect(dialogsBody).toContain('settingsTypography.sheetTitle');
    expect(dialogsBody).toContain('settingsTypography.dialogBody');
    expect(dialogsBody).toContain('settingsTypography.dialogInput');
    expect(dialogsBody).toContain('settingsTypography.buttonLabel');
    expect(dialogsBody).toContain('metrics.settingsDialog.');
    expect(dialogsBody).toContain("phrase === 'DELETE'");
    expect(dialogsBody).not.toMatch(/rgba\(/);
    expect(dialogsBody).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(dialogsBody).not.toMatch(/fontSize:\s*\d/);
  });
});
