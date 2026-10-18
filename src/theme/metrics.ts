export const metrics = {
  iconButton: 52,
  minimumHitArea: 48,
  contentPadding: 20,
  settingsGutter: 14,
  settingsGroupGap: 14,
  settingsBlockTitleGap: 10,
  settingsLegendRowGap: 6,
  settingsLegendColumnGap: 14,
  settingsLegendSwatchGap: 5,
  settingsFieldBorderWidth: 1.5,
  gestureInset: 24,
  stateMinHeight: 280,
  radius: {
    small: 4,
    medium: 6,
    large: 8,
    card: 14,
    circle: 999,
  },
  settingsRadius: { track: 10, segment: 8, button: 10, cloud: 18, swatch: 3, tile: 12, field: 12 },
  // U3b choice sheet (mockup v4 §3): bottom sheet, grab bar, header, option
  // rows in a group card, radio dots. Values are the §3 markup's geometry.
  settingsSheet: {
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
  },
  // U3c confirm dialogs (mockup v4 §3): the .wd-dialog card, .wd-input delete
  // box and .wd-actions row with .wd-btn.small pills. The 34 dp pill sits in a
  // ±7 frame (the U1 SettingsButton pattern), so the layout box stays 34 dp
  // while the touch box is 48 dp — the plan's "48 dp actions" floor. The
  // .wd-input border/radius and the pill radius share the U2c2 field and U1
  // button vocabulary (settingsFieldBorderWidth / settingsRadius).
  settingsDialog: {
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
  },
  // U4-design visual pass (mockup `settings-unify-v4-connect.html` §1–5): the
  // connect surfaces' field cards and the picker's icon tiles. The field-card
  // pair is the mockup's fit compensation (.wd-block 14 → 10, .wd-input 12 → 8
  // after the by-eye round): the endpoint placeholder fits at 375 dp; at 360 dp
  // it clips ~1.3 chars, which the owner accepted 2026-10-12 (placeholder keeps
  // its https:// scheme on purpose). stackGap is the .wd-form column gap and the .wd-p
  // margin-top (both 10); the cards themselves take metrics.settingsGutter
  // (margins), metrics.spacing.medium (the first card's 12) and
  // metrics.settingsGroupGap (14 between later cards).
  settingsConnect: {
    fieldCardPaddingH: 10,
    fieldPaddingH: 8,
    stackGap: 10,
    iconTile: 30,
    iconTileRadius: 9,
    iconTileIcon: 18,
  },
  // U3c chips (mockup v4 §3 .wd-chip): padding 5/8/5/11, gap 6, radius circle, X 14.
  // minTouch 36 keeps the historical chip touch box (the mockup draws ~26 dp tall — the
  // U3b-class touch-floor note, recorded in the plan's U3c revision).
  settingsChip: {
    paddingV: 5,
    paddingLeft: 11,
    paddingRight: 8,
    gap: 6,
    iconSize: 14,
    minTouch: 36,
  },
  spacing: {
    small: 8,
    medium: 12,
    large: 20,
  },
} as const;
