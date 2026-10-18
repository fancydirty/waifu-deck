import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { CloudObjectStore } from '@/features/cloud-store/cloud-object-store';
import type { LibraryMirrorCounts } from '@/features/library/library-protection-repository';
import type { LibraryStorageMode } from '@/features/library/library-storage-mode';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { deriveCloudIdentity, deriveCloudLibraryModel, type CloudIdentity, type CloudLibraryModel, type ReadValue } from './cloud-library-model';
import { LOCATION_LABEL_KEY } from './storage-location-picker';

export type CloudLibraryReaders = Readonly<{
  readStoredIdentity(): Promise<CloudIdentity | null>;
  readMirrorCounts?: () => Promise<LibraryMirrorCounts>;
  readLastSyncedAt?: () => Promise<number | null>;
  readQuotaFullCount?: () => Promise<number>;
  readQuota?: () => ReturnType<CloudObjectStore['quota']>;
  readStorageMode?: () => Promise<LibraryStorageMode>;
  subscribeLibraryChanges?: (listener: () => void) => () => void;
}>;
export type CloudLibraryData = Readonly<{
  model: CloudLibraryModel;
  counts: ReadValue<LibraryMirrorCounts>;
  lastSyncedAt: ReadValue<number | null>;
  quotaFullCount: ReadValue<number>;
  quota: Readonly<{ usedBytes: number; totalBytes: number | null }> | null;
  mode: ReadValue<LibraryStorageMode>;
  readRoundId: number;
  viewNowMs: number;
  refreshStorageMode(): Promise<void>;
}>;
type Snapshot = Omit<CloudLibraryData, 'model' | 'refreshStorageMode'> & { identity: ReadValue<CloudIdentity | null> };
const unread = <T,>(roundId: number | null = null): ReadValue<T> => ({ state: 'unread', fresh: false, roundId });
function stale<T>(value: ReadValue<T>, roundId: number | null, present: boolean): ReadValue<T> {
  if (value.state === 'read') return { ...value, fresh: false, roundId };
  return { state: present ? 'pending' : 'unread', fresh: false, roundId };
}
function settled<T>(old: ReadValue<T>, result: PromiseSettledResult<T> | null, roundId: number | null, fresh: boolean): ReadValue<T> {
  if (result === null) return unread(roundId);
  if (result.status === 'fulfilled') return { state: 'read', value: result.value, fresh, roundId };
  return old.state === 'read' ? { ...old, fresh: false, roundId } : { state: 'error', fresh: false, roundId };
}
// Even a synchronously throwing injected port is a rejected read.
function read<T>(port: (() => Promise<T>) | undefined): Promise<T | undefined> {
  try { return port ? port() : Promise.resolve(undefined); }
  catch (error) { return Promise.reject(error); }
}

/** A generation-local external source: mutable scheduling stays outside React rendering. */
export function createCloudLibrarySource(input: Readonly<{
  readers: CloudLibraryReaders; enabled: boolean; ready: boolean;
  store: CloudObjectStore | null; identity: CloudIdentity | null; locked: boolean;
}>) {
  const { readers, enabled, ready, store, identity, locked } = input;
  const { readMirrorCounts, readLastSyncedAt, readQuotaFullCount, readQuota,
    readStorageMode, readStoredIdentity, subscribeLibraryChanges } = readers;
  const initialLocal = <T,>(present: boolean): ReadValue<T> => enabled && ready && present
    ? { state: 'pending', fresh: false, roundId: 0 } : unread(0);
  let snapshot: Snapshot = {
    identity: identity ? { state: 'read', value: identity, fresh: true, roundId: null }
      : enabled && locked ? { state: 'pending', fresh: false, roundId: null } : unread(),
    counts: initialLocal(!!readMirrorCounts), lastSyncedAt: initialLocal(!!readLastSyncedAt),
    quotaFullCount: initialLocal(!!readQuotaFullCount), mode: unread(),
    quota: null, readRoundId: 0, viewNowMs: 0,
  };
  const listeners = new Set<() => void>();
  let activation = 0;
  let active = false;
  let modeRequest = 0;
  const current = (owner: number) => active && owner === activation;
  const publish = (owner: number, patch: Partial<Snapshot>) => {
    if (!current(owner)) return;
    snapshot = { ...snapshot, ...patch, viewNowMs: Date.now() };
    for (const listener of listeners) listener();
  };
  const refreshStorageMode = async (): Promise<void> => {
    if (!active || !enabled || !ready || !readStorageMode) return;
    const owner = activation;
    const request = ++modeRequest;
    publish(owner, { mode: stale(snapshot.mode, null, true) });
    const [result] = await Promise.allSettled([read(readStorageMode)]);
    if (!current(owner) || request !== modeRequest) return;
    publish(owner, { mode: settled(snapshot.mode, result as PromiseSettledResult<LibraryStorageMode>, null, true) });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshStorageMode,
    start() {
      const owner = ++activation;
      active = true;
      let localInFlight = false;
      let localDirty = false;
      let quotaInFlight = false;
      let quotaDirty = false;
      const localRound = async (): Promise<void> => {
        if (!current(owner)) return;
        if (localInFlight) {
          localDirty = true;
          return;
        }
        localInFlight = true;
        const roundId = snapshot.readRoundId + 1;
        // A7: retain the last settled snapshot throughout a refresh. Only the
        // atomic settlement advances the round; a dirty flight still settles fresh.
        const [counts, at, full] = await Promise.allSettled([
          read(readMirrorCounts), read(readLastSyncedAt), read(readQuotaFullCount),
        ]);
        if (!current(owner)) return;
        publish(owner, {
          readRoundId: roundId,
          counts: settled(snapshot.counts, readMirrorCounts ? counts as PromiseSettledResult<LibraryMirrorCounts> : null, roundId, true),
          lastSyncedAt: settled(snapshot.lastSyncedAt, readLastSyncedAt ? at as PromiseSettledResult<number | null> : null, roundId, true),
          quotaFullCount: settled(snapshot.quotaFullCount, readQuotaFullCount ? full as PromiseSettledResult<number> : null, roundId, true),
        });
        localInFlight = false;
        if (localDirty) { localDirty = false; void localRound(); }
      };
      const quotaRound = async (): Promise<void> => {
        if (!current(owner) || store === null || !readQuota) return;
        if (quotaInFlight) { quotaDirty = true; return; }
        quotaInFlight = true;
        const [result] = await Promise.allSettled([read(readQuota)]);
        if (!current(owner)) return;
        publish(owner, { quota: result.status === 'fulfilled' ? result.value ?? null : null });
        quotaInFlight = false;
        if (quotaDirty) { quotaDirty = false; void quotaRound(); }
      };
      publish(owner, {});
      const appState = AppState.addEventListener('change', (state) => {
        if (state === 'active') publish(owner, {});
      });
      if (enabled && locked) {
        void Promise.allSettled([read(readStoredIdentity)]).then(([result]) => {
          publish(owner, { identity: settled(snapshot.identity, result as PromiseSettledResult<CloudIdentity | null>, null, true) });
        });
      }
      let unsubscribe: (() => void) | undefined;
      if (enabled && ready) {
        void refreshStorageMode();
        void localRound();
        void quotaRound();
        unsubscribe = subscribeLibraryChanges?.(() => {
          if (!current(owner)) return;
          void localRound();
          void quotaRound();
        });
      }
      return () => { active = false; unsubscribe?.(); appState?.remove(); };
    },
  };
}

/** One owner, one atomic local round, separate quota; replacement selects an empty source before paint. */
export function useCloudLibraryData({ byosStatus, readers, enabled }: Readonly<{
  byosStatus: ByosStatus; readers: CloudLibraryReaders; enabled: boolean;
}>): CloudLibraryData {
  const { t } = useAppTranslation();
  const ready = byosStatus.status === 'ready';
  const context = ready ? byosStatus.context : null;
  const binding = context?.kind === 's3' ? context.credentials : context?.binding;
  const store = context?.kind === 'store' ? context.store : null;
  const lock = byosStatus.status === 'locked' ? `${byosStatus.reason}/${'detail' in byosStatus ? byosStatus.detail : ''}/${'provider' in byosStatus ? byosStatus.provider : ''}` : '';
  const { readStoredIdentity, readMirrorCounts, readLastSyncedAt, readQuotaFullCount,
    readQuota, readStorageMode, subscribeLibraryChanges } = readers;
  const source = useMemo(() => createCloudLibrarySource({ enabled, ready, store, locked: lock !== '',
    identity: binding ? deriveCloudIdentity(binding, (key) => key) : null,
    readers: { readStoredIdentity, readMirrorCounts, readLastSyncedAt, readQuotaFullCount,
      readQuota, readStorageMode, subscribeLibraryChanges },
  }), [enabled, ready, binding, store, lock, readStoredIdentity, readMirrorCounts,
    readLastSyncedAt, readQuotaFullCount, readQuota, readStorageMode, subscribeLibraryChanges]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const activeSource = useRef<ReturnType<typeof createCloudLibrarySource> | null>(null);
  // Writes may finish after navigation replaced their source. Keep the consumer
  // callback stable and route that completion to the current Settings source.
  const refreshStorageMode = useCallback(async (): Promise<void> => {
    await activeSource.current?.refreshStorageMode();
  }, []);
  useEffect(() => {
    activeSource.current = enabled && ready ? source : null;
    const stop = source.start();
    return () => {
      activeSource.current = null;
      stop();
    };
  }, [source, enabled, ready]);
  const { identity: storedIdentity, ...data } = snapshot;
  const identity: ReadValue<CloudIdentity | null> = storedIdentity.state === 'read' && storedIdentity.value !== null
    ? { ...storedIdentity, value: { ...storedIdentity.value,
        label: storedIdentity.value.kind === 'webdav' ? 'WebDAV'
          : storedIdentity.value.kind === 's3' && storedIdentity.value.label !== LOCATION_LABEL_KEY.s3
          ? storedIdentity.value.label : t(LOCATION_LABEL_KEY[storedIdentity.value.kind]) } }
    : storedIdentity;
  return { ...data, model: deriveCloudLibraryModel({ ...data, identity, byosStatus }), refreshStorageMode };
}
