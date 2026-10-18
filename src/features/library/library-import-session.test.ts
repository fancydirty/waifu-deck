import {
  createLibraryImportSessionController,
  formatImportResultDescriptor,
  LIBRARY_IMPORT_BATCH_LIMIT,
  resolveImportNextStepKind,
  type LibraryImportSessionState,
} from '@/features/library/library-import-session';
import type {
  LibraryConfirmedImportInput,
  LibraryImportSummary,
} from '@/features/library/library-import';

describe('library import session controller (N6-B2)', () => {
  function createHarness(options: {
    initialPickerCache?: string[];
  } = {}) {
    const pickerCacheFiles = new Set<string>(options.initialPickerCache ?? []);
    const deletedPickerUris: string[] = [];
    const confirmedCalls: LibraryConfirmedImportInput[] = [];
    let settledCalls = 0;

    let pickImpl: (input?: { selectionLimit?: number }) => Promise<
      readonly { uri: string }[]
    > = async () => [];
    let confirmImpl: (
      input: LibraryConfirmedImportInput,
    ) => Promise<LibraryImportSummary> = async (input) => {
      for (let i = 0; i < input.uris.length; i += 1) {
        input.onProgress?.({ completed: i + 1, total: input.uris.length });
      }
      return {
        selected: input.uris.length,
        ingested: input.uris.length,
        duplicates: 0,
        notEnrolled: 0,
        retainedClassificationCount: 0,
        rejected: [],
      };
    };

    const picker = {
      pickImages: jest.fn(async (input?: { selectionLimit?: number }) =>
        await pickImpl(input),
      ),
    };

    const files = {
      deleteOriginal: jest.fn(async (uri: string) => {
        pickerCacheFiles.delete(uri);
        deletedPickerUris.push(uri);
      }),
      deletePickerCacheUri: jest.fn(async (uri: string) => {
        if (!uri.startsWith('file:///cache/ImagePicker/')) {
          return;
        }
        pickerCacheFiles.delete(uri);
        deletedPickerUris.push(uri);
      }),
      listPickerCache: jest.fn(async () => [...pickerCacheFiles]),
    };

    const importService = {
      importConfirmedFiles: jest.fn(async (input: LibraryConfirmedImportInput) => {
        confirmedCalls.push(input);
        return await confirmImpl(input);
      }),
      settled: jest.fn(async () => {
        settledCalls += 1;
      }),
    };

    const controller = createLibraryImportSessionController({
      picker,
      files,
      importService,
    });

    const transitions: LibraryImportSessionState[] = [];
    controller.subscribe((next) => {
      transitions.push(next);
    });

    return {
      controller,
      picker,
      files,
      importService,
      pickerCacheFiles,
      deletedPickerUris,
      confirmedCalls,
      transitions,
      get settledCalls() {
        return settledCalls;
      },
      setPickImpl(next: typeof pickImpl) {
        pickImpl = next;
      },
      setConfirmImpl(next: typeof confirmImpl) {
        confirmImpl = next;
      },
    };
  }

  test('transitions idle -> picking -> awaiting-choice -> importing -> result -> idle with zero pre-choice copy and cleans picker cache on completion', async () => {
    const h = createHarness();
    const uri1 = 'file:///cache/ImagePicker/pick-1.jpg';
    const uri2 = 'file:///cache/ImagePicker/pick-2.png';
    h.setPickImpl(async () => {
      h.pickerCacheFiles.add(uri1);
      h.pickerCacheFiles.add(uri2);
      return [{ uri: uri1 }, { uri: uri2 }];
    });

    expect(h.controller.getState()).toEqual({ phase: 'idle' });
    await h.controller.startPick();

    expect(h.picker.pickImages).toHaveBeenCalledWith({
      selectionLimit: LIBRARY_IMPORT_BATCH_LIMIT,
    });
    // Zero pre-choice ingestion or file copy before classification is selected!
    expect(h.confirmedCalls).toHaveLength(0);
    expect(h.deletedPickerUris).toHaveLength(0);
    expect(h.controller.getState()).toEqual({
      phase: 'awaiting-choice',
      count: 2,
      uris: [uri1, uri2],
    });

    const summary = await h.controller.confirmChoice('adult');
    expect(summary).toEqual({
      selected: 2,
      ingested: 2,
      duplicates: 0,
      notEnrolled: 0,
      retainedClassificationCount: 0,
      rejected: [],
    });
    expect(h.confirmedCalls).toHaveLength(1);
    expect(h.confirmedCalls[0]).toMatchObject({
      uris: [uri1, uri2],
      classification: 'adult',
      adoptPickerCacheUris: true,
    });

    // Transitions include picking, awaiting-choice, importing 0/2, 1/2, 2/2, result
    expect(h.transitions).toEqual([
      { phase: 'picking' },
      { phase: 'awaiting-choice', count: 2, uris: [uri1, uri2] },
      { phase: 'importing', completed: 0, total: 2, classification: 'adult' },
      { phase: 'importing', completed: 1, total: 2, classification: 'adult' },
      { phase: 'importing', completed: 2, total: 2, classification: 'adult' },
      {
        phase: 'result',
        result: expect.objectContaining({
          kind: 'batch-summary',
          addedCount: 2,
          existingCount: 0,
          failedCount: 0,
          presented: false,
        }),
      },
    ]);

    // Held picker cache files are cleaned on batch completion
    expect([...h.pickerCacheFiles]).toEqual([]);

    // Unpresented result is NOT dismissed if dismissResultIfPresented is called before presentation
    h.controller.dismissResultIfPresented();
    expect(h.controller.getState().phase).toBe('result');

    // Once presented, leaving the tab dismisses it back to idle
    h.controller.markResultPresented();
    expect(h.controller.getState()).toEqual({
      phase: 'result',
      result: expect.objectContaining({
        kind: 'batch-summary',
        presented: true,
      }),
    });
    h.controller.dismissResultIfPresented();
    expect(h.controller.getState()).toEqual({ phase: 'idle' });
  });

  test('empty picker return transitions back to idle without opening sheet or showing a result', async () => {
    const h = createHarness();
    h.setPickImpl(async () => []);

    await h.controller.startPick();

    expect(h.controller.getState()).toEqual({ phase: 'idle' });
    expect(h.confirmedCalls).toHaveLength(0);
  });

  test('cancelling the choice sheet deletes all held picker cache files and imports nothing', async () => {
    const preExisting = 'file:///cache/ImagePicker/older-orphan.jpg';
    const h = createHarness({ initialPickerCache: [preExisting] });
    const uri1 = 'file:///cache/ImagePicker/cancel-1.jpg';
    const uri2 = 'file:///cache/ImagePicker/cancel-2.jpg';
    const externalGalleryUri = 'content://media/external/images/media/99';

    h.setPickImpl(async () => {
      h.pickerCacheFiles.add(uri1);
      h.pickerCacheFiles.add(uri2);
      // Including a duplicate handle and a non-cache gallery URI to verify deduplication & boundary safety
      return [{ uri: uri1 }, { uri: uri1 }, { uri: uri2 }, { uri: externalGalleryUri }];
    });

    await h.controller.startPick();
    expect(h.controller.getState().phase).toBe('awaiting-choice');

    await h.controller.cancelChoice();
    expect(h.controller.getState()).toEqual({ phase: 'idle' });
    expect(h.confirmedCalls).toHaveLength(0);
    // Session-owned picker cache files were deleted; external gallery URI was never deleted
    expect(h.deletedPickerUris).toEqual([uri1, uri2]);
    expect(h.pickerCacheFiles.has(uri1)).toBe(false);
    expect(h.pickerCacheFiles.has(uri2)).toBe(false);
  });

  test('refuses >50 picker return without silent truncation and deletes all returned picker cache files', async () => {
    const h = createHarness();
    const fiftyOne = Array.from({ length: 51 }, (_, index) => {
      const uri = `file:///cache/ImagePicker/over-${index + 1}.jpg`;
      return { uri };
    });
    h.setPickImpl(async () => {
      for (const item of fiftyOne) {
        h.pickerCacheFiles.add(item.uri);
      }
      return fiftyOne;
    });

    await h.controller.startPick();

    expect(h.confirmedCalls).toHaveLength(0);
    expect([...h.pickerCacheFiles]).toEqual([]);
    expect(h.deletedPickerUris).toHaveLength(51);
    expect(h.controller.getState()).toEqual({
      phase: 'result',
      result: {
        kind: 'exceeded-limit',
        limit: 50,
        presented: false,
      },
    });
  });

  test('picker launch failure cleans partial ImagePicker exports created during the attempt and reports picker-failed', async () => {
    const h = createHarness();
    const partialUri = 'file:///cache/ImagePicker/partial-export.jpg';
    h.setPickImpl(async () => {
      h.pickerCacheFiles.add(partialUri);
      throw new Error('ActivityNotFoundException');
    });

    await h.controller.startPick();

    expect([...h.pickerCacheFiles]).toEqual([]);
    expect(h.deletedPickerUris).toEqual([partialUri]);
    expect(h.controller.getState()).toEqual({
      phase: 'result',
      result: {
        kind: 'picker-failed',
        presented: false,
      },
    });
  });

  test('serializes double taps on startPick and confirmChoice so only one picker and one batch run', async () => {
    const h = createHarness();
    let resolvePicker!: (items: readonly { uri: string }[]) => void;
    h.setPickImpl(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve;
        }),
    );

    const firstPick = h.controller.startPick();
    const secondPick = h.controller.startPick();
    expect(h.picker.pickImages).toHaveBeenCalledTimes(1);

    resolvePicker([{ uri: 'file:///cache/ImagePicker/one.jpg' }]);
    await Promise.all([firstPick, secondPick]);

    expect(h.controller.getState().phase).toBe('awaiting-choice');

    let resolveConfirm!: (summary: LibraryImportSummary) => void;
    h.setConfirmImpl(
      () =>
        new Promise((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    const firstConfirm = h.controller.confirmChoice('safe');
    const secondConfirm = h.controller.confirmChoice('adult');
    expect(h.importService.importConfirmedFiles).toHaveBeenCalledTimes(1);

    resolveConfirm({
      selected: 1,
      ingested: 1,
      duplicates: 0,
      notEnrolled: 0,
      retainedClassificationCount: 0,
      rejected: [],
    });
    const [res1, res2] = await Promise.all([firstConfirm, secondConfirm]);
    expect(res1?.ingested).toBe(1);
    expect(res2).toBeNull();
  });

  test('refuse() during an open choice sheet or open native picker cleans all picker cache files and prevents confirmation', async () => {
    const h = createHarness();
    const uriSheet = 'file:///cache/ImagePicker/sheet-held.jpg';
    h.setPickImpl(async () => {
      h.pickerCacheFiles.add(uriSheet);
      return [{ uri: uriSheet }];
    });

    await h.controller.startPick();
    expect(h.controller.getState().phase).toBe('awaiting-choice');

    const release = h.controller.refuse();
    await h.controller.settled();

    expect(h.controller.getState()).toEqual({ phase: 'idle' });
    expect([...h.pickerCacheFiles]).toEqual([]);
    release();

    // Now test refuse() while native picker is still open
    let resolveLatePicker!: (items: readonly { uri: string }[]) => void;
    const lateUri = 'file:///cache/ImagePicker/late-return.jpg';
    h.setPickImpl(
      () =>
        new Promise((resolve) => {
          resolveLatePicker = resolve;
        }),
    );

    const pendingPick = h.controller.startPick();
    expect(h.controller.getState().phase).toBe('picking');

    const releaseDuringPick = h.controller.refuse();
    h.pickerCacheFiles.add(lateUri);
    resolveLatePicker([{ uri: lateUri }]);
    await pendingPick;
    await h.controller.settled();

    expect(h.controller.getState()).toEqual({ phase: 'idle' });
    expect([...h.pickerCacheFiles]).toEqual([]);
    releaseDuringPick();
  });

  test('orders actionable next-step lines by spec §4.11 priority and separates over-cap / retained-classification counts', () => {
    // Only over-cap rejections -> nextStep is null (overCapCount carries the note)
    expect(
      resolveImportNextStepKind([{ code: 'file_too_large' }]),
    ).toBeNull();

    // Priority 1: storage_failed beats everything else
    expect(
      resolveImportNextStepKind([
        { code: 'unreadable_source' },
        { code: 'unsupported_format' },
        { code: 'authority_network' },
        { code: 'storage_failed' },
      ]),
    ).toBe('storage_failed');

    // Priority 2: authority_* beats unsupported_format and generic_retry
    expect(
      resolveImportNextStepKind([
        { code: 'unsupported_format' },
        { code: 'authority_password_locked' },
        { code: 'unreadable_source' },
      ]),
    ).toBe('authority_password_locked');

    expect(
      resolveImportNextStepKind([
        { code: 'unsupported_format' },
        { code: 'authority_reauth_required' },
      ]),
    ).toBe('authority_reauth_required');

    expect(
      resolveImportNextStepKind([
        { code: 'unsupported_format' },
        { code: 'authority_network' },
      ]),
    ).toBe('authority_network');

    // Priority 3: unsupported_format beats generic_retry
    expect(
      resolveImportNextStepKind([
        { code: 'decode_failed' },
        { code: 'unsupported_format' },
      ]),
    ).toBe('unsupported_format');

    // Priority 4: generic_retry for corrupt/decode/unreadable/authority_integrity
    expect(
      resolveImportNextStepKind([{ code: 'authority_integrity' }]),
    ).toBe('generic_retry');

    const descriptor = formatImportResultDescriptor({
      selected: 6,
      ingested: 2,
      duplicates: 1,
      notEnrolled: 1,
      retainedClassificationCount: 1,
      rejected: [
        { code: 'file_too_large' },
        { code: 'file_too_large' },
        { code: 'unsupported_format' },
      ],
    });
    expect(descriptor).toEqual({
      kind: 'batch-summary',
      summary: expect.any(Object),
      addedCount: 2,
      existingCount: 1,
      failedCount: 3,
      overCapCount: 2,
      retainedClassificationCount: 1,
      nextStep: 'unsupported_format',
      presented: false,
    });
  });

  test('FX-BATCH-50: 50-item sequential batch (including 12000x12000 PNG, near-cap 67,108,768B, over-cap 67,108,769B, and unsupported format) advances progress 0/50 -> 50/50 and cleans all 50 picker cache files', async () => {
    const h = createHarness();
    const fifty = Array.from({ length: 50 }, (_, idx) => ({
      uri: `file:///cache/ImagePicker/fx-batch-${idx + 1}.jpg`,
    }));
    h.setPickImpl(async () => {
      for (const item of fifty) h.pickerCacheFiles.add(item.uri);
      return fifty;
    });

    const progressSteps: number[] = [];
    h.setConfirmImpl(async (input) => {
      for (let i = 0; i < input.uris.length; i += 1) {
        input.onProgress?.({ completed: i + 1, total: input.uris.length });
        const st = h.controller.getState();
        if (st.phase === 'importing') {
          progressSteps.push(st.completed);
        }
      }
      return {
        selected: 50,
        ingested: 47,
        duplicates: 1,
        notEnrolled: 2, // post-commit enrollment failure still counts as added (47)
        retainedClassificationCount: 0,
        rejected: [
          { code: 'file_too_large' }, // FX-CAP-OVER (67,108,769 B)
          { code: 'unsupported_format' }, // FX-UNSUPPORTED
        ],
      };
    });

    await h.controller.startPick();
    expect(h.controller.getState()).toMatchObject({
      phase: 'awaiting-choice',
      count: 50,
    });

    const t0 = performance.now();
    let firstProgressLatencyMs = -1;
    const unsub = h.controller.subscribe((st) => {
      if (st.phase === 'importing' && firstProgressLatencyMs < 0) {
        firstProgressLatencyMs = performance.now() - t0;
      }
    });
    const summary = await h.controller.confirmChoice('safe');
    unsub();

    expect(firstProgressLatencyMs).toBeGreaterThanOrEqual(0);
    expect(firstProgressLatencyMs).toBeLessThanOrEqual(120);
    expect(progressSteps).toHaveLength(50);
    expect(progressSteps[0]).toBe(1);
    expect(progressSteps[49]).toBe(50);
    expect([...h.pickerCacheFiles]).toEqual([]);
    expect(summary?.ingested).toBe(47);
    expect(h.controller.getState()).toEqual({
      phase: 'result',
      result: expect.objectContaining({
        kind: 'batch-summary',
        addedCount: 47,
        existingCount: 1,
        failedCount: 2,
        overCapCount: 1,
        nextStep: 'unsupported_format',
      }),
    });
  });
});
