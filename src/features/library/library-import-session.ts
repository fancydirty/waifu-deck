import type { LibraryFileStore } from '@/features/library/library-file-store';
import type {
  LibraryConfirmedImportInput,
  LibraryImportRejection,
  LibraryImportService,
  LibraryImportSummary,
} from '@/features/library/library-import';
import type { LibraryPickerPort } from '@/features/library/library-picker';
import type { LibraryImportClassification } from '@/features/library/library-types';

export const LIBRARY_IMPORT_BATCH_LIMIT = 50;

export type LibraryImportNextStepKind =
  | 'storage_failed'
  | 'authority_network'
  | 'authority_password_locked'
  | 'authority_reauth_required'
  | 'unsupported_format'
  | 'generic_retry';

export type LibraryImportResultDescriptor =
  | Readonly<{
    kind: 'picker-failed';
    presented: boolean;
  }>
  | Readonly<{
    kind: 'exceeded-limit';
    limit: number;
    presented: boolean;
  }>
  | Readonly<{
    kind: 'batch-summary';
    summary: LibraryImportSummary;
    addedCount: number;
    existingCount: number;
    failedCount: number;
    overCapCount: number;
    retainedClassificationCount: number;
    nextStep: LibraryImportNextStepKind | null;
    presented: boolean;
  }>;

export type LibraryImportSessionState =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'picking' }>
  | Readonly<{
    phase: 'awaiting-choice';
    count: number;
    uris: readonly string[];
  }>
  | Readonly<{
    phase: 'importing';
    completed: number;
    total: number;
    classification: Exclude<LibraryImportClassification, 'unknown'>;
  }>
  | Readonly<{
    phase: 'result';
    result: LibraryImportResultDescriptor;
  }>;

export type LibraryImportSessionListener = (
  state: LibraryImportSessionState,
) => void;

export interface LibraryImportSessionController {
  getState(): LibraryImportSessionState;
  subscribe(listener: LibraryImportSessionListener): () => void;
  startPick(): Promise<void>;
  confirmChoice(
    classification: Exclude<LibraryImportClassification, 'unknown'>,
  ): Promise<LibraryImportSummary | null>;
  cancelChoice(): Promise<void>;
  markResultPresented(): void;
  dismissResultIfPresented(): void;
  /**
   * Refuses new picks, cancels any unconfirmed choice sheet (cleaning its
   * picker cache files), and marks any in-flight native picker session so its
   * returned files are cleaned and discarded without opening a sheet.
   */
  refuse(): () => void;
  /** Waits for any in-flight picker cleanup or confirmed batch to settle. */
  settled(): Promise<void>;
}

export function resolveImportNextStepKind(
  rejected: readonly LibraryImportRejection[],
): LibraryImportNextStepKind | null {
  const nonOverCap = rejected.filter((item) => item.code !== 'file_too_large');
  if (nonOverCap.length === 0) {
    return null;
  }

  // Spec §4.11 priority 1: local space failure.
  if (nonOverCap.some((item) => item.code === 'storage_failed')) {
    return 'storage_failed';
  }

  // Spec §4.11 priority 2: categorized authority failure.
  if (nonOverCap.some((item) => item.code === 'authority_password_locked')) {
    return 'authority_password_locked';
  }
  if (nonOverCap.some((item) => item.code === 'authority_reauth_required')) {
    return 'authority_reauth_required';
  }
  if (nonOverCap.some((item) => item.code === 'authority_network')) {
    return 'authority_network';
  }

  // Spec §4.11 priority 3: unsupported picks.
  if (nonOverCap.some((item) => item.code === 'unsupported_format')) {
    return 'unsupported_format';
  }

  // Spec §4.11 priority 4: generic retry (unreadable_source, corrupt_image,
  // decode_failed, authority_integrity, etc.).
  return 'generic_retry';
}

export function formatImportResultDescriptor(
  summary: LibraryImportSummary,
  presented = false,
): Extract<LibraryImportResultDescriptor, { kind: 'batch-summary' }> {
  const addedCount = summary.ingested;
  const existingCount = summary.duplicates;
  const failedCount = summary.rejected.length;
  const overCapCount = summary.rejected.filter(
    (item) => item.code === 'file_too_large',
  ).length;
  const retainedClassificationCount = summary.retainedClassificationCount ?? 0;

  return {
    kind: 'batch-summary',
    summary,
    addedCount,
    existingCount,
    failedCount,
    overCapCount,
    retainedClassificationCount,
    nextStep: resolveImportNextStepKind(summary.rejected),
    presented,
  };
}

export function createLibraryImportSessionController({
  picker,
  files,
  importService,
  selectionLimit = LIBRARY_IMPORT_BATCH_LIMIT,
}: Readonly<{
  picker: Readonly<{
    pickImages(
      input?: Pick<Parameters<LibraryPickerPort['pickImages']>[0] & object, 'selectionLimit'>,
    ): Promise<readonly Readonly<{ uri: string }>[]>;
  }>;
  files: Pick<
    LibraryFileStore,
    | 'deleteOriginal'
    | 'deletePickerCacheUri'
    | 'listPickerCache'
  >;
  importService: Pick<
    LibraryImportService,
    'importConfirmedFiles' | 'settled'
  >;
  selectionLimit?: number;
}>): LibraryImportSessionController {
  let state: LibraryImportSessionState = { phase: 'idle' };
  const currentPhase = (): LibraryImportSessionState['phase'] => state.phase;
  let refusals = 0;
  let refusalEpoch = 0;
  const listeners = new Set<LibraryImportSessionListener>();
  const activeOperations = new Set<Promise<unknown>>();

  const track = <T>(work: Promise<T>): Promise<T> => {
    activeOperations.add(work);
    void work.then(
      () => {
        activeOperations.delete(work);
      },
      () => {
        activeOperations.delete(work);
      },
    );
    return work;
  };

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // Isolate subscriber errors.
      }
    }
  };

  const setState = (next: LibraryImportSessionState): void => {
    state = next;
    notify();
  };

  const deletePickerUris = async (uris: readonly string[]): Promise<void> => {
    const seen = new Set<string>();
    const deleteUri = files.deletePickerCacheUri ?? files.deleteOriginal;
    for (const uri of uris) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      try {
        await deleteUri.call(files, uri);
      } catch {
        // Best-effort cleanup of session-owned picker exports.
      }
    }
  };

  const readPickerCacheSnapshot = async (): Promise<ReadonlySet<string>> => {
    if (typeof files.listPickerCache !== 'function') {
      return new Set<string>();
    }
    try {
      return new Set(await files.listPickerCache());
    } catch {
      return new Set<string>();
    }
  };

  const cleanNewPickerCacheExports = async (
    baseline: ReadonlySet<string>,
  ): Promise<void> => {
    if (typeof files.listPickerCache !== 'function') {
      return;
    }
    try {
      const current = await files.listPickerCache();
      const created = current.filter((uri) => !baseline.has(uri));
      if (created.length > 0) {
        await deletePickerUris(created);
      }
    } catch {
      // Best-effort cleanup of partial native picker exports.
    }
  };

  return {
    getState() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async startPick() {
      if (refusals > 0) {
        return;
      }
      if (
        state.phase === 'picking'
        || state.phase === 'awaiting-choice'
        || state.phase === 'importing'
      ) {
        return;
      }

      const startEpoch = refusalEpoch;
      setState({ phase: 'picking' });

      await track((async () => {
        const baselinePromise = readPickerCacheSnapshot();
        let picked;
        try {
          picked = await picker.pickImages({ selectionLimit });
        } catch {
          const baseline = await baselinePromise;
          await cleanNewPickerCacheExports(baseline);
          if (refusals > 0 || refusalEpoch !== startEpoch) {
            if (currentPhase() === 'picking') {
              setState({ phase: 'idle' });
            }
            return;
          }
          setState({
            phase: 'result',
            result: {
              kind: 'picker-failed',
              presented: false,
            },
          });
          return;
        }

        const baseline = await baselinePromise;
        const pickedUris = picked.map((item) => item.uri);

        // If a reset/refusal happened while the native picker was open,
        // discard and clean all returned files + any new cache files.
        if (refusals > 0 || refusalEpoch !== startEpoch) {
          await deletePickerUris(pickedUris);
          await cleanNewPickerCacheExports(baseline);
          if (currentPhase() === 'picking') {
            setState({ phase: 'idle' });
          }
          return;
        }

        if (pickedUris.length === 0) {
          await cleanNewPickerCacheExports(baseline);
          setState({ phase: 'idle' });
          return;
        }

        if (pickedUris.length > selectionLimit) {
          await deletePickerUris(pickedUris);
          await cleanNewPickerCacheExports(baseline);
          setState({
            phase: 'result',
            result: {
              kind: 'exceeded-limit',
              limit: selectionLimit,
              presented: false,
            },
          });
          return;
        }

        setState({
          phase: 'awaiting-choice',
          count: pickedUris.length,
          uris: pickedUris,
        });
      })());
    },

    async cancelChoice() {
      if (state.phase !== 'awaiting-choice') {
        return;
      }
      const { uris } = state;
      setState({ phase: 'idle' });
      await track(deletePickerUris(uris));
    },

    async confirmChoice(classification) {
      if (state.phase !== 'awaiting-choice') {
        return null;
      }
      const { uris } = state;
      if (refusals > 0) {
        setState({ phase: 'idle' });
        await track(deletePickerUris(uris));
        return null;
      }

      const total = uris.length;
      setState({
        phase: 'importing',
        completed: 0,
        total,
        classification,
      });

      return await track((async () => {
        try {
          const input: LibraryConfirmedImportInput = {
            uris,
            classification,
            adoptPickerCacheUris: true,
            onProgress: ({ completed, total: batchTotal }) => {
              if (currentPhase() === 'importing') {
                setState({
                  phase: 'importing',
                  completed,
                  total: batchTotal,
                  classification,
                });
              }
            },
          };
          const summary = await importService.importConfirmedFiles(input);
          await deletePickerUris(uris);
          setState({
            phase: 'result',
            result: formatImportResultDescriptor(summary, false),
          });
          return summary;
        } catch {
          await deletePickerUris(uris);
          const fallbackSummary: LibraryImportSummary = {
            selected: total,
            ingested: 0,
            duplicates: 0,
            notEnrolled: 0,
            retainedClassificationCount: 0,
            rejected: uris.map(() => ({ code: 'storage_failed' as const })),
          };
          setState({
            phase: 'result',
            result: formatImportResultDescriptor(fallbackSummary, false),
          });
          return fallbackSummary;
        }
      })());
    },

    markResultPresented() {
      if (state.phase !== 'result' || state.result.presented) {
        return;
      }
      setState({
        phase: 'result',
        result: {
          ...state.result,
          presented: true,
        },
      });
    },

    dismissResultIfPresented() {
      if (state.phase !== 'result' || !state.result.presented) {
        return;
      }
      setState({ phase: 'idle' });
    },

    refuse() {
      refusals += 1;
      refusalEpoch += 1;
      if (state.phase === 'awaiting-choice') {
        const { uris } = state;
        setState({ phase: 'idle' });
        void track(deletePickerUris(uris));
      } else if (state.phase === 'result') {
        setState({ phase: 'idle' });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refusals -= 1;
      };
    },

    async settled() {
      await Promise.allSettled([
        ...activeOperations,
        importService.settled(),
      ]);
    },
  };
}
