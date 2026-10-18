/**
 * P12-C (spec §8): the append-only protocol's two-device convergence over the
 * REAL Microsoft Graph OneDrive backend — the same production stack the
 * composition root binds (`createAppendDevice` from the shared harness), with
 * the memory store swapped for `createOneDriveCloudObjectStore` against the
 * owner's personal account `npm run verify:byos-onedrive` selects. The
 * scenario is the WebDAV suite's first test verbatim; the only change is the
 * backend construction/teardown (OneDrive's `it-<run>/{state,blobs}` folder
 * set under the app folder in place of a WebDAV `<root>/it-<run>/` bind).
 */
import { sha256PlaintextHex } from '@/features/library/library-identity';
import {
  assetIdOf,
  createAppendDevice,
  headOf,
  imageBytes,
  listedNotesIn,
  type AppendDevice,
} from '@/test/append-two-device-harness';

import { configured, createRunLayout, deleteRunFolder, label, storeFor } from './onedrive-test-support';

const describeBackend = configured ? describe : describe.skip;

/** Sync `device` until `predicate` holds (a real listing may lag a write by seconds). */
async function syncUntil(device: AppendDevice, predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await device.sync();
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`gave up waiting for: ${what}`);
}

describeBackend(`append-only protocol v2 over a real OneDrive store — ${label}`, () => {
  jest.setTimeout(300_000);

  test('A collects+protects, B trashes after seeing it, A restores after seeing that — both end on the same head, one note survives', async () => {
    const run = `d${Date.now().toString(36)}`;
    const ids = await createRunLayout(run);
    const store = storeFor(ids);
    await store.ensureLayout();
    const calls: string[] = [];
    // The harness's own per-device recorder answers "did THIS device re-read its
    // own note"; this one only pins that the streaming blob path was exercised.
    const recorded = { ...store, putFromFile: async (...args: Parameters<typeof store.putFromFile>) => { calls.push('putFromFile'); return store.putFromFile(...args); } };
    const A = await createAppendDevice({ deviceId: 'device-A-uuid', store: recorded, clock: Date.now });
    const B = await createAppendDevice({ deviceId: 'device-B-uuid', store: recorded, clock: Date.now });
    try {
      const plaintext = imageBytes(4096, 3);
      const digest = sha256PlaintextHex(plaintext);

      await A.ingest(digest, plaintext);
      expect((await A.protect(digest)).status).toBe('applied');
      expect((await A.recordOf(digest))?.lifecycle).toBe('active');

      await syncUntil(B, async () => (await B.recordOf(digest))?.protection === 'protected', 'B discovers A\'s protect');

      expect((await B.removeFromLibrary(digest)).status).toBe('applied');
      await B.sync();
      const midNotes = await listedNotesIn(store);
      expect(midNotes.filter((n) => n.writer === 'device-B')).toHaveLength(1);
      expect(headOf(midNotes).writer).toBe('device-B');

      await syncUntil(A, async () => (await A.recordOf(digest))?.lifecycle === 'trash', 'A discovers B\'s trash');

      await A.restore(digest);
      await A.sync();
      await syncUntil(B, async () => (await B.recordOf(digest))?.lifecycle === 'active', 'B discovers A\'s restore');

      const [ra, rb] = [await A.recordOf(digest), await B.recordOf(digest)];
      expect(ra?.lifecycle).toBe('active');
      expect(rb?.lifecycle).toBe('active');
      expect(ra?.revision).toBe(4);
      expect(rb?.revision).toBe(4);
      expect(ra?.originalGenerationId).toEqual(expect.any(String));
      expect(ra?.originalGenerationId).toBe(rb?.originalGenerationId);

      // Converged: after both devices have swept, exactly one note survives
      // for the asset and it is A's restore (the greatest ULID).
      await syncUntil(A, async () => (await listedNotesIn(store)).length === 1, 'the superseded notes are swept');
      const notes = await listedNotesIn(store);
      expect(notes).toHaveLength(1);
      expect(headOf(notes).writer).toBe('device-A');
      expect(notes[0]!.assetId).toBe(assetIdOf(digest));

      const [ha, hb] = [await A.head(digest), await B.head(digest)];
      expect(ha?.mutationId).toBe(hb?.mutationId);
      expect(ha?.record.lifecycle).toBe('active');
      expect(ha?.record.revision).toBe(4);

      expect(A.ownStateGets()).toEqual([]);
      expect(B.ownStateGets()).toEqual([]);
      expect(calls).toContain('putFromFile');
    } finally {
      A.close();
      B.close();
      await deleteRunFolder(ids.runFolderId);
    }
  });
});
