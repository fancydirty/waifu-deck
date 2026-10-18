/**
 * Board #12, spec §8: the append-only protocol's convergence proof.
 *
 * Two independent sync engines — separate databases, separate file stores,
 * separate session ports, separate reconciliation/cloud ports — over ONE
 * `CloudObjectStore` whose listing lags 500 ms behind its writes. Everything
 * above the store is the production stack the composition root binds for a
 * cloud-drive backend (`library-integration-impl.ts`): the real protect
 * action, local/account/trash actions, batch orchestrator, sync engine, apply
 * writer, reconciler, outbox, sweep, and the durable ETag index.
 *
 * What differs from the composition root's cloud-drive branch, all of it at
 * or below the store seam: the two ports beneath the engine are the
 * append-only pair (`createAppendLibraryReconciliationPort` +
 * `createAppendLibraryCloudClient`) instead of the CAS pair; the transport is
 * `createMemoryCloudObjectStore` with a 500 ms listing lag instead of a live
 * backend, reading staged blobs back off disk so the production
 * `putFromFile` path still runs; blob staging is the Node tmp-dir port and
 * the file port, SQLite adapter, and crypto are this suite's doubles
 * (`expo-file-system` and `expo-sqlite` have no native module under Jest);
 * the vault meta is hand-written, so no connect flow and no scrypt; there is
 * no derived-image pipeline; and each device sees the ONE shared store
 * through a passthrough recorder, because the shared `store.calls` cannot say
 * which device issued a read.
 *
 * What it proves: sequential cross-device writes to the SAME asset — A
 * collects+protects, B trashes what it discovered, A restores what it
 * discovered — leave both devices projecting the identical head, with exactly
 * one live note per asset per writer (each writer deletes its own previous
 * note) and the greatest ULID winning.
 *
 * Also pinned: zero own-note GETs even INSIDE the listing lag (a device
 * never pays to be told what it just said itself); the durable index head
 * equals the local projection on both devices, not just the projection
 * alone; and the E10 lost-restore scenario, where a restore decided inside
 * this device's own lag window is not lost.
 */

jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import {
  assetIdOf,
  createAppendDevice as createDevice,
  headOf,
  imageBytes,
  notesIn,
  readStagedFile,
} from '@/test/append-two-device-harness';

describe('append-only protocol v2: two devices, one store (spec §8)', () => {
  jest.setTimeout(30_000);

  test('two devices, one store with 500 ms listing lag: A collects+protects, B trashes after seeing it, A restores after seeing that — both end on the same head', async () => {
    let now = 1_000_000;
    const clock = () => now;
    const store = createMemoryCloudObjectStore({ clock, readFile: readStagedFile, chaos: { listingDelayMs: 500 } });
    const A = await createDevice({ deviceId: 'device-A-uuid', store, clock });
    const B = await createDevice({ deviceId: 'device-B-uuid', store, clock });

    try {
      const plaintext = imageBytes(4096, 3);
      const digest = sha256PlaintextHex(plaintext);

      await A.ingest(digest, plaintext);
      const protectResult = await A.protect(digest);
      expect(protectResult.status).toBe('applied');
      expect((await A.recordOf(digest))?.lifecycle).toBe('active');

      // The lag is load-bearing, not decorative: a full sync cycle before it
      // elapses discovers nothing at all, even though the note is already
      // durable and `get`-able. Reconciliation must never read "absent from
      // the listing" as "never written".
      await B.sync();
      expect(await B.recordOf(digest)).toBeNull();

      // B cannot see the note until the listing lag has elapsed.
      now += 600;
      await B.sync();
      const seenByB = await B.recordOf(digest);
      expect(seenByB?.lifecycle).toBe('active');
      expect(seenByB?.protection).toBe('protected');

      // Mirror restore uses the append client's file-backed fallback and the
      // same stream-temp lifecycle as production; no blob-sized JS path is
      // allowed to leave a temp behind.
      expect(await B.download(digest)).toEqual({ status: 'applied' });
      await expect(B.streamFiles()).resolves.toEqual([]);

      // B trashes what it discovered: a new note by B, sorting above A's.
      expect((await B.removeFromLibrary(digest)).status).toBe('applied');
      await B.sync();

      // Mid-flight, both writers' notes coexist: B appended its own and left
      // A's alone. A foreign note is only swept once its successor has been
      // the head for longer than the 7-day window, so no device can ever pull
      // a note out from under a peer that has not read it yet.
      const midNotes = notesIn(store);
      expect(midNotes).toHaveLength(2);
      expect(midNotes.filter((n) => n.writer === 'device-A')).toHaveLength(1);
      expect(midNotes.filter((n) => n.writer === 'device-B')).toHaveLength(1);
      expect(headOf(midNotes).writer).toBe('device-B');

      now += 600;
      await A.sync();
      expect((await A.recordOf(digest))?.lifecycle).toBe('trash');

      // A restores: a new note by A, sorting above B's.
      await A.restore(digest);
      await A.sync();

      now += 600;
      await B.sync();

      const [ra, rb] = [await A.recordOf(digest), await B.recordOf(digest)];
      expect(ra?.lifecycle).toBe('active');
      expect(rb?.lifecycle).toBe('active');
      expect(ra?.revision).toBe(rb?.revision);
      // Four mutations, one revision each, even though they landed as only
      // three notes: protect carries the queued `collect` into the SAME
      // `submitMutations` call (collect=1, protect=2), then B's trash=3 and
      // A's restore=4. Revision counts MUTATIONS, not notes — the append
      // protocol coalesces a group into one note without skipping a revision.
      expect(ra?.revision).toBe(4);
      // Pinned non-null first, so the cross-device equality below cannot pass
      // by both sides being empty.
      expect(ra?.originalGenerationId).toEqual(expect.any(String));
      expect(ra?.generation).toBeGreaterThanOrEqual(1);
      expect(ra?.generation).toBe(rb?.generation);
      expect(ra?.originalGenerationId).toBe(rb?.originalGenerationId);

      // Converged: exactly ONE note survives for the asset, and it is A's
      // restore — the greatest ULID. A dropped its own superseded note as it
      // appended the successor (`lastMine`), and B dropped its own superseded
      // trash note the moment its final discovery saw A's note become the
      // head (own notes skip the 7-day window — this device already knows its
      // own head). Neither device ever deleted the other's.
      const notes = notesIn(store);
      expect(notes).toHaveLength(1);
      expect(headOf(notes).writer).toBe('device-A');
      expect(notes.filter((n) => n.writer === 'device-B')).toHaveLength(0);
      expect(notes[0]!.assetId).toBe(assetIdOf(digest));

      // The head each device would decide its NEXT write against is the same
      // note on both, and it is exactly what each one projected. Pinned
      // separately from the projections above because the two can disagree
      // silently: a device that dropped a note of its own would still project
      // correctly here (the apply writer's revision guard swallows the stale
      // re-projection) while holding a stale head — the state in which the
      // next trash or restore is decided wrongly and lost.
      const [ha, hb] = [await A.head(digest), await B.head(digest)];
      expect(ha?.mutationId).toBe(hb?.mutationId);
      expect(ha?.record.lifecycle).toBe('active');
      expect(ha?.record.revision).toBe(4);
      expect(ha?.record.lifecycle).toBe(ra?.lifecycle);
      expect(ha?.record.revision).toBe(ra?.revision);
      expect(hb?.record.lifecycle).toBe(rb?.lifecycle);
      expect(hb?.record.revision).toBe(rb?.revision);

      // Neither device ever paid to be told what it had said itself.
      expect(A.ownStateGets()).toEqual([]);
      expect(B.ownStateGets()).toEqual([]);

      // Without this pin, dropping `blobStaging` would silently fall back to a
      // buffer PUT — the K6-2 streaming path is exercised, not bypassed.
      expect(store.calls.some((c) => c.op === 'putFromFile')).toBe(true);
    } finally {
      A.close();
      B.close();
    }
  });

  test('sanity: a protect round-trips through the append client and is read back from the durable index — zero own-note GETs, including INSIDE the listing lag', async () => {
    let now = 2_000_000;
    const clock = () => now;
    const store = createMemoryCloudObjectStore({ clock, readFile: readStagedFile, chaos: { listingDelayMs: 500 } });
    const A = await createDevice({ deviceId: 'device-A-uuid', store, clock });

    try {
      const plaintext = imageBytes(2048, 29);
      const digest = sha256PlaintextHex(plaintext);
      await A.ingest(digest, plaintext);
      expect((await A.protect(digest)).status).toBe('applied');

      // A full sync INSIDE the lag window, where the listing still omits the
      // note this device just wrote. The writer remembered it, so the note is
      // not dropped here...
      await A.sync();
      expect((await A.head(digest))?.record.lifecycle).toBe('active');

      // ...and when the listing catches up it is already known, so discovery
      // never pays to be told what this device just said.
      now += 600;
      await A.sync();

      expect((await A.recordOf(digest))?.lifecycle).toBe('active');
      expect(notesIn(store)).toHaveLength(1);
      expect(A.ownStateGets()).toEqual([]);
    } finally {
      A.close();
    }
  });

  /**
   * The lost-restore scenario (T9 review E10). Everything here happens inside
   * ONE device's own listing lag: B trashes, syncs again before the backend's
   * listing shows the note it just wrote, and only then restores. A device
   * that read that absence as a deletion would evict its own note, fall back
   * to A's older 'active' note as its head, and decide the restore against
   * THAT — producing no note at all, so B's trash stands on the cloud and the
   * user's restore is silently lost on both devices. The local projection
   * does not reveal it: the apply writer's
   * `excluded.revision > existing.revision` guard swallows the stale
   * re-projection, so B still reads 'trash' locally while the head it writes
   * against has regressed.
   */
  test('E10: a restore decided inside the device\'s own listing lag is not lost — both devices end active at revision 4', async () => {
    let now = 3_000_000;
    const clock = () => now;
    const store = createMemoryCloudObjectStore({ clock, readFile: readStagedFile, chaos: { listingDelayMs: 500 } });
    const A = await createDevice({ deviceId: 'device-A-uuid', store, clock });
    const B = await createDevice({ deviceId: 'device-B-uuid', store, clock });

    try {
      const plaintext = imageBytes(4096, 11);
      const digest = sha256PlaintextHex(plaintext);

      await A.ingest(digest, plaintext);
      expect((await A.protect(digest)).status).toBe('applied');

      now += 600;                       // A's note becomes listable
      await B.sync();
      expect((await B.recordOf(digest))?.lifecycle).toBe('active');

      expect((await B.removeFromLibrary(digest)).status).toBe('applied');
      await B.sync();                   // B's trash note: written, then remembered

      // The lag window, entered: this sync's listing still omits the note B
      // wrote a moment ago. B's head must stay B's own trash note.
      await B.sync();
      expect((await B.head(digest))?.record.lifecycle).toBe('trash');
      expect((await B.head(digest))?.record.revision).toBe(3);

      // Still inside the window, the user restores. Decided against the head
      // above, this is a real mutation and becomes a real note.
      expect((await B.restore(digest)).status).toBe('queued');
      await B.sync();
      expect((await B.recordOf(digest))?.lifecycle).toBe('active');

      now += 600;                       // B's restore note becomes listable
      await A.sync();

      const [ra, rb] = [await A.recordOf(digest), await B.recordOf(digest)];
      expect(ra?.lifecycle).toBe('active');
      expect(rb?.lifecycle).toBe('active');
      // collect=1, protect=2 (A's one note), B's trash=3, B's restore=4.
      expect(ra?.revision).toBe(4);
      expect(rb?.revision).toBe(4);

      const [ha, hb] = [await A.head(digest), await B.head(digest)];
      expect(ha?.mutationId).toBe(hb?.mutationId);
      expect(ha?.record.lifecycle).toBe('active');
      expect(ha?.record.revision).toBe(4);
      expect(A.ownStateGets()).toEqual([]);
      expect(B.ownStateGets()).toEqual([]);
    } finally {
      A.close();
      B.close();
    }
  });
});
