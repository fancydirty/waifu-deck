import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metrics } from './metrics';

test('settings metrics pin the mockup geometry and named frame tokens', () => {
  expect(metrics.settingsGutter).toBe(14);
  expect(metrics.settingsGroupGap).toBe(14);
  expect(metrics.settingsBlockTitleGap).toBe(10);
  expect(metrics.settingsLegendRowGap).toBe(6);
  expect(metrics.settingsLegendColumnGap).toBe(14);
  expect(metrics.settingsLegendSwatchGap).toBe(5);
  expect(metrics.settingsFieldBorderWidth).toBe(1.5);
  expect(metrics.gestureInset).toBe(24);
  expect(metrics.settingsRadius).toEqual({ track: 10, segment: 8, button: 10, cloud: 18, swatch: 3, tile: 12, field: 12 });
});

test('U3b choice-sheet geometry pins mockup v4 §3 values', () => {
  expect(metrics.settingsSheet).toEqual({
    radius: 18,
    paddingH: 14,
    paddingTop: 8,
    paddingBottom: 16,
    grabWidth: 36,
    grabHeight: 4,
    grabTopGap: 2,
    grabBottomGap: 12,
    headerGap: 12,
    rowMinHeight: 52,
    rowPaddingV: 12,
    rowPaddingH: 14,
    rowContentGap: 12,
    radioSize: 18,
    radioBorderWidth: 2,
    radioDotInset: 3,
  });
});

test('U3c dialog geometry pins the mockup v4 §3 .wd-dialog values', () => {
  // Independent mockup numbers (v4 §3 CSS), not derived from metrics.ts.
  expect(metrics.settingsDialog).toEqual({
    radius: 18,
    paddingTop: 18,
    paddingH: 16,
    paddingBottom: 14,
    borderWidth: 1,
    shadow: '0 18px 40px -18px rgba(84, 75, 72, 0.55)',
    titleGap: 8,
    inputTopGap: 12,
    inputPaddingV: 10,
    inputPaddingH: 12,
    actionTopGap: 14,
    actionGap: 8,
    actionMinHeight: 34,
    actionFrame: 7,
    actionPaddingH: 12,
  });
  // .wd-input / .wd-btn.small share the U2c2 field and U1 button vocabulary.
  expect(metrics.settingsFieldBorderWidth).toBe(1.5);
  expect(metrics.settingsRadius.field).toBe(12);
  expect(metrics.settingsRadius.button).toBe(10);
  // The 34 dp pill inside a ±7 frame is the 48 dp action floor.
  expect(metrics.settingsDialog.actionMinHeight + 2 * metrics.settingsDialog.actionFrame)
    .toBeGreaterThanOrEqual(metrics.minimumHitArea);
});

test('metrics source keeps the settings entries inside the as-const object', () => {
  const source = readFileSync(join(__dirname, 'metrics.ts'), 'utf8');
  expect(source).toContain('settingsGutter: 14');
  expect(source).toContain('settingsGroupGap: 14');
  expect(source).toContain('settingsFieldBorderWidth: 1.5');
  expect(source).toContain('settingsRadius: { track: 10, segment: 8, button: 10, cloud: 18, swatch: 3, tile: 12, field: 12 }');
  expect(source).toContain('settingsSheet: {');
  expect(source).toContain('settingsDialog: {');
  expect(source).toMatch(/export const metrics = \{[\s\S]*\} as const;/);
});

test('the U3c chip vocabulary pins the v4 .wd-chip geometry', () => {
  expect(metrics.settingsChip).toMatchObject({
    paddingV: 5,
    paddingLeft: 11,
    paddingRight: 8,
    gap: 6,
    iconSize: 14,
    minTouch: 36,
  });
});

test('U4-design visual pass pins the connect supplement field-card and icon-tile geometry', () => {
  // Independent mockup numbers (settings-unify-v4-connect.html CSS), not
  // derived from metrics.ts: the field card's fit compensation (.wd-block
  // padding 14 → 10, .wd-input padding 12 → 8) so the endpoint placeholder
  // fits at 375 dp — at 360 dp it clips ~1.3 chars, accepted by the owner
  // 2026-10-12 (placeholder keeps its https:// scheme), plus the .wd-form /
  // .wd-p 10 gap and the picker's .wd-ico 30 / 9 / 17–18 tile.
  expect(metrics.settingsConnect).toEqual({
    fieldCardPaddingH: 10,
    fieldPaddingH: 8,
    stackGap: 10,
    iconTile: 30,
    iconTileRadius: 9,
    iconTileIcon: 18,
  });
});
