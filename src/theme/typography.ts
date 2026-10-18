export const fontFamilies = {
  sans: 'Nunito_700Bold',
  sansMedium: 'Nunito_600SemiBold',
  sansHeavy: 'Nunito_800ExtraBold',
  mono: 'IBMPlexMono_500Medium',
} as const;

export const peachTypography = {
  screenTitle: { fontSize: 22, fontFamily: fontFamilies.sansHeavy },
  rowTitle: { fontSize: 13, fontFamily: fontFamilies.sans },
  body: { fontSize: 12.5, fontFamily: fontFamilies.sansMedium },
  monoCaption: { fontSize: 9.5, fontFamily: fontFamilies.mono },
};

export const cloudTypography = {
  provider: peachTypography.screenTitle,
  stat: { ...peachTypography.screenTitle, fontVariant: ['tabular-nums'] as ('tabular-nums')[] },
  statUnit: peachTypography.body,
  statLabel: peachTypography.body,
  footer: peachTypography.rowTitle,
  identity: peachTypography.rowTitle,
  group: { fontSize: 12, fontFamily: fontFamilies.sansHeavy },
  pill: { fontSize: 12, fontFamily: fontFamilies.sansHeavy },
};

export const settingsTypography = {
  pageTitle: peachTypography.screenTitle,
  subpageHeader: { fontSize: 18, fontFamily: fontFamilies.sansHeavy },
  // U3b: v4 §3 sheet header (17 / 800).
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
  // U3c: v4 §3 .wd-dialog body (13.5 / 600 / 1.55) and .wd-input (15 / mono;
  // the loaded mono face is 500 Medium, so the mockup's 800 mono stack weight
  // is not representable — the mono read matters more than the weight).
  dialogBody: { fontSize: 13.5, fontFamily: fontFamilies.sansMedium, lineHeight: 20.925 },
  dialogInput: { fontSize: 15, fontFamily: fontFamilies.mono },
  // U3c chips (mockup v4 §3 .wd-chip): 13 / mono / 800 (loaded face is 500 Medium — same
  // representability note as dialogInput); the label colour is theme.saveDeep.
  chipLabel: { fontSize: 13, fontFamily: fontFamilies.mono },
  // U4-design visual pass: the connect supplement's .wd-p hint prose
  // (13 / 600 / 1.55) — the region hint, the WebDAV footnotes and the Drive
  // explanation paragraphs.
  connectHint: { fontSize: 13, fontFamily: fontFamilies.sansMedium, lineHeight: 20.15 },
} as const;
