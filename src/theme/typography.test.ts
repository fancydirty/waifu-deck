import { fontFamilies, peachTypography, cloudTypography, settingsTypography } from './typography';
import { metrics } from './metrics';

describe('peach typography tokens', () => {
  test('families map to loaded google fonts', () => {
    expect(fontFamilies.sans).toBe('Nunito_700Bold');
    expect(fontFamilies.sansMedium).toBe('Nunito_600SemiBold');
    expect(fontFamilies.sansHeavy).toBe('Nunito_800ExtraBold');
    expect(fontFamilies.mono).toBe('IBMPlexMono_500Medium');
  });

  test('screen title and body sizes defined', () => {
    expect(peachTypography.screenTitle).toEqual({
      fontSize: 22,
      fontFamily: fontFamilies.sansHeavy,
    });
    expect(peachTypography.monoCaption).toEqual({
      fontSize: 9.5,
      fontFamily: fontFamilies.mono,
    });
  });

  test('cloud card uses the approved radius, typography and tabular stat figures', () => {
    expect(metrics.radius.card).toBe(14);
    expect(cloudTypography).toEqual({
      provider: peachTypography.screenTitle,
      stat: { ...peachTypography.screenTitle, fontVariant: ['tabular-nums'] },
      statUnit: peachTypography.body,
      statLabel: peachTypography.body,
      footer: peachTypography.rowTitle,
      identity: peachTypography.rowTitle,
      group: { fontSize: 12, fontFamily: fontFamilies.sansHeavy },
      pill: { fontSize: 12, fontFamily: fontFamilies.sansHeavy },
    });
  });

  test('every token uses a declared family', () => {
    const families = Object.values(fontFamilies);
    [...Object.values(peachTypography), ...Object.values(cloudTypography)].forEach((style) => {
      expect(families).toContain(style.fontFamily);
    });
  });

  test('settings typography pins every mockup role to a loaded family', () => {
    expect(settingsTypography).toEqual({
      pageTitle: peachTypography.screenTitle,
      subpageHeader: { fontSize: 18, fontFamily: fontFamilies.sansHeavy },
      sheetTitle: { fontSize: 17, fontFamily: fontFamilies.sansHeavy },
      rowTitle: { fontSize: 15, fontFamily: fontFamilies.sansHeavy },
      detail: { fontSize: 12.5, fontFamily: fontFamilies.sansMedium },
      hint: { fontSize: 12.5, fontFamily: fontFamilies.sansMedium, lineHeight: 18.75 },
      value: { fontSize: 13.5, fontFamily: fontFamilies.sans },
      groupLabel: { fontSize: 12, fontFamily: fontFamilies.sansHeavy, letterSpacing: 0.72 },
      segmentLabel: { fontSize: 13, fontFamily: fontFamilies.sansHeavy },
      buttonLabel: { fontSize: 13, fontFamily: fontFamilies.sansHeavy },
      field: { fontSize: 15, fontFamily: fontFamilies.sansHeavy },
      footer: { fontSize: 12, fontFamily: fontFamilies.sans },
      plainPill: { fontSize: 12, fontFamily: fontFamilies.sans },
      storageUnit: { fontSize: 13, fontFamily: fontFamilies.sans },
      storageLegend: { fontSize: 12.5, fontFamily: fontFamilies.sans },
      cloudName: { fontSize: 16, fontFamily: fontFamilies.sansHeavy },
      cloudSub: { fontSize: 12.5, fontFamily: fontFamilies.sans },
      cloudStat: { fontSize: 20, fontFamily: fontFamilies.sansHeavy },
      cloudStatUnit: { fontSize: 12, fontFamily: fontFamilies.sans },
      cloudStatLabel: { fontSize: 12, fontFamily: fontFamilies.sans },
      cloudFooter: { fontSize: 12.5, fontFamily: fontFamilies.sansHeavy },
      cloudMessage: { fontSize: 13, fontFamily: fontFamilies.sansMedium, lineHeight: 19.5 },
      // U3c: v4 §3 .wd-dialog body (13.5 / 600 / 1.55) and .wd-input (15,
      // mono — the only loaded mono face is 500 Medium, so the 800 weight of
      // the mockup's system mono stack is not representable).
      dialogBody: { fontSize: 13.5, fontFamily: fontFamilies.sansMedium, lineHeight: 20.925 },
      dialogInput: { fontSize: 15, fontFamily: fontFamilies.mono },
      // U3c chips: v4 §3 .wd-chip (13 / mono).
      chipLabel: { fontSize: 13, fontFamily: fontFamilies.mono },
      // U4-design visual pass: the connect supplement's .wd-p hint prose
      // (13 / 600 / 1.55).
      connectHint: { fontSize: 13, fontFamily: fontFamilies.sansMedium, lineHeight: 20.15 },
    });
  });

  test('settings typography source uses named font-family tokens', () => {
    expect(Object.values(settingsTypography).every((style) => Object.values(fontFamilies).includes(style.fontFamily))).toBe(true);
  });
});

test('the chip label is the v4 .wd-chip 13/mono', () => {
  expect(settingsTypography.chipLabel).toMatchObject({ fontSize: 13, fontFamily: fontFamilies.mono });
});

test('the connect hint is the supplement .wd-p 13/600/1.55', () => {
  expect(settingsTypography.connectHint).toMatchObject({
    fontSize: 13,
    fontFamily: fontFamilies.sansMedium,
    lineHeight: 20.15, // 13 * 1.55 (the literal, as U3c pins dialogBody's 20.925)
  });
});
