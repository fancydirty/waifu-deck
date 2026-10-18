export type DataResetMutationOptions = {
  abort?: () => void;
};

export type DataResetLease = {
  release(): void;
};

export type DataResetParticipant = () => void | Promise<void>;

export interface DataResetCoordinator {
  runMutation<T>(
    operation: () => Promise<T>,
    options?: DataResetMutationOptions,
  ): Promise<T>;
  registerResetParticipant(participant: DataResetParticipant): () => void;
  beginReset(): Promise<DataResetLease>;
  /**
   * Holds off every mutation and reset, as beginReset does, but aborts nothing
   * and runs no reset participant: for work that reads the data and changes
   * none of it (a backup export; a restore's pick and prepare). Board #32.
   */
  beginExclusive(): Promise<DataResetLease>;
}

type ResetState = {
  released: Promise<void>;
  resolveReleased: () => void;
};

export function createDataResetCoordinator(): DataResetCoordinator {
  const activeMutations = new Map<Promise<unknown>, (() => void) | undefined>();
  const resetParticipants = new Set<DataResetParticipant>();
  let resetState: ResetState | null = null;

  const runMutation = <T>(
    operation: () => Promise<T>,
    options: DataResetMutationOptions = {},
  ): Promise<T> => {
    if (resetState) {
      return resetState.released.then(() => runMutation(operation, options));
    }

    let current: Promise<T>;
    try {
      current = operation();
    } catch (error) {
      current = Promise.reject(error);
    }
    activeMutations.set(current, options.abort);
    const remove = () => activeMutations.delete(current);
    void current.then(remove, remove);
    return current;
  };

  const acquire = (kind: 'reset' | 'exclusive'): Promise<DataResetLease> => {
    if (resetState) {
      return resetState.released.then(() => acquire(kind));
    }

    let resolveReleased!: () => void;
    const state: ResetState = {
      released: new Promise((resolve) => {
        resolveReleased = resolve;
      }),
      resolveReleased: () => resolveReleased(),
    };
    resetState = state;

    const active = [...activeMutations.entries()];
    if (kind === 'reset') {
      for (const [, abort] of active) {
        try {
          abort?.();
        } catch {
          // Reset still drains the mutation when its cancellation callback fails.
        }
      }
    }

    return Promise.allSettled(active.map(([mutation]) => mutation)).then(async () => {
      if (kind === 'reset') {
        const participantResets = [...resetParticipants].map((participant) => {
          try {
            return Promise.resolve(participant());
          } catch (error) {
            return Promise.reject(error);
          }
        });
        await Promise.allSettled(participantResets);
      }

      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          if (resetState === state) resetState = null;
          state.resolveReleased();
        },
      };
    });
  };

  const beginReset = (): Promise<DataResetLease> => acquire('reset');
  const beginExclusive = (): Promise<DataResetLease> => acquire('exclusive');

  const registerResetParticipant = (participant: DataResetParticipant): (() => void) => {
    resetParticipants.add(participant);
    return () => resetParticipants.delete(participant);
  };

  return { runMutation, registerResetParticipant, beginReset, beginExclusive };
}
