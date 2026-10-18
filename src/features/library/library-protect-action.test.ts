jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

/**
 * K6-1e Task 1: counts every `sha256PlaintextHex` call made through the real
 * module during a test, so a test can assert that `protect` does NOT re-hash
 * the local original. Measured on device (spec §2, diagnostic build
 * 2026-09-13 23:50), that pure-JS @noble hash cost 1334 ms of JS thread for a
 * 6 MB image — spent re-verifying bytes this app hashed and named seconds
 * earlier in `library-ingest.ts`. The wrapper delegates to the real
 * implementation, so every other consumer keeps its true behaviour.
 */
const mockShaCalls = { count: 0 };
jest.mock('@/features/library/library-identity', () => {
  const actual = jest.requireActual('@/features/library/library-identity');
  return {
    ...actual,
    sha256PlaintextHex: (plaintext: Uint8Array): string => {
      mockShaCalls.count += 1;
      return actual.sha256PlaintextHex(plaintext);
    },
  };
});

import type {
  LibraryActionResult,
  LibraryFailureCategory,
  LibraryProtectionRecord,
} from '@/features/library/library-actions-types';
import {
  deriveLibraryAccountScope,
  sha256PlaintextHex,
} from '@/features/library/library-identity';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import { createLibraryIngestService } from '@/features/library/library-ingest';
import {
  createLibraryProtectAction,
  type LibraryProtectAction,
} from '@/features/library/library-protect-action';
import {
  createActionsHarness,
  createFailingLibraryDerivedImages,
  TEST_ACCOUNT_SCOPE,
  TEST_DEVICE_ID,
  TEST_MASTER_KEY,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import {
  createFakeDecodeGate,
  JPEG_FIXTURE,
} from '@/features/library/library-test-support';
import { createLibraryTransferProgress } from '@/features/library/library-transfer-progress';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const bytes = Uint8Array.from([10, 20, 30, 40, 50]);
const digest = sha256PlaintextHex(bytes);
const DIGEST = digest;
const SCOPE = TEST_ACCOUNT_SCOPE;

let harness: ActionsHarness;
let action: LibraryProtectAction;

function derivedDouble(
  mode: 'ok' | 'fail',
  onDerive?: () => void,
): LibraryDerivedImages {
  if (mode === 'fail') {
    return {
      async derive() {
        onDerive?.();
        throw new Error('derive failed');
      },
    };
  }
  return {
    async derive() {
      onDerive?.();
      return {
        thumbnail: {
          role: 'thumbnail',
          bytes: new Uint8Array([1, 2, 3]),
          width: 8,
          height: 8,
          format: 'webp',
        },
        preview: {
          role: 'preview',
          bytes: new Uint8Array([4, 5, 6, 7]),
          width: 16,
          height: 16,
          format: 'webp',
        },
        animated: false,
        failed: false,
      };
    },
  };
}

/**
 * K7 ⑨: `protect` answers as soon as the ORIGINAL is durable and leaves the
 * derived (thumbnail/preview) upload + its one follow-up state.json patch
 * running behind it. The tail is deliberately unobservable from the action's
 * public surface — nothing in the app waits for it — so a test that asserts on
 * it polls for the condition instead.
 */
async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let tick = 0; tick < 2000; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function protectHarness(options: Readonly<{
  derived: 'ok' | 'fail';
  onDerive?: () => void;
}>): Promise<Readonly<{
  action: LibraryProtectAction;
  cloud: ActionsHarness['cloud'];
  protection: ActionsHarness['protection'];
  outbox: ActionsHarness['outbox'];
  port: ActionsHarness['port'];
  assetId: string;
  localOriginalUri: string;
  cipher: ActionsHarness['cipher'];
  close(): void;
}>> {
  const current = await createActionsHarness();
  await current.seedLocalAsset({ plaintextSha256: DIGEST, bytes });
  const built = createLibraryProtectAction({
    repository: current.repository,
    protection: current.protection,
    outbox: current.outbox,
    files: current.files,
    cipher: current.cipher,
    cloud: current.s3,
    reconciliation: current.reconciliation,
    session: { async current() { return current.session.value; } },
    derived: derivedDouble(options.derived, options.onDerive),
    readSource: current.protectDependencies.readSource,
    clock: current.clock,
    newGenerationId: current.newGenerationId,
  });
  return {
    action: built,
    cloud: current.cloud,
    protection: current.protection,
    outbox: current.outbox,
    port: current.port,
    assetId: current.assetIdFor(DIGEST),
    localOriginalUri: current.originalUriFor(DIGEST),
    cipher: current.cipher,
    close: () => current.close(),
  };
}

/**
 * K6-1b: a brand-new asset's `collect` and `protect` ride in ONE batch, so the
 * protect is no longer whatever sits at index 0. Select it by kind.
 */
function lastProtectMutation(cloud: ActionsHarness['cloud']) {
  const submitted = cloud.mutations.at(-1)!.mutations;
  const mutation = submitted.find((entry) => entry.kind === 'protect');
  if (mutation === undefined) {
    throw new Error(
      `no protect mutation in the last batch: ${submitted.map((e) => e.kind).join()}`,
    );
  }
  return mutation;
}

/**
 * A real ingest service bound to the harness's own account scope, so
 * `enrichLocalAssetForAccount` writes the `collect` intent under the exact
 * scope the harness session reports. Used as the K6-3a `reenroll` dependency,
 * which is what the Direct composition wires in production.
 */
function ingestFor(current: ActionsHarness) {
  let sequence = 900;
  return createLibraryIngestService({
    files: current.files,
    repository: current.repository,
    decodeGate: createFakeDecodeGate(),
    account: {
      async vaultMasterKey() { return TEST_MASTER_KEY; },
      async deviceId() { return current.deviceId; },
      async accountScope() { return TEST_ACCOUNT_SCOPE; },
    },
    newMutationId: () => {
      sequence += 1;
      return `00000000-0000-4000-c000-${sequence.toString().padStart(12, '0')}`;
    },
    clock: current.clock,
  });
}

function build(
  current: ActionsHarness,
  derived: LibraryDerivedImages = createFailingLibraryDerivedImages(),
): LibraryProtectAction {
  return createLibraryProtectAction({
    repository: current.repository,
    protection: current.protection,
    outbox: current.outbox,
    files: current.files,
    cipher: current.cipher,
    cloud: current.s3,
    reconciliation: current.reconciliation,
    session: { async current() { return current.session.value; } },
    derived,
    readSource: current.protectDependencies.readSource,
    clock: current.clock,
    newGenerationId: current.newGenerationId,
  });
}

beforeEach(async () => {
  resetExpoCryptoDouble();
  harness = await createActionsHarness();
  action = build(harness);
});

afterEach(() => {
  harness.close();
});

describe('protect with Cloud Vault', () => {
  it('uploads all three role blobs, each under its own generationId, and commits them', async () => {
    const caseHarness = await protectHarness({ derived: 'ok' });
    try {
      const result = await caseHarness.action.protect(DIGEST);

      expect(result).toEqual({ status: 'applied' });
      // K7 ⑨: the derived roles land BEHIND the answer now, so wait for the
      // tail before counting them. What is unchanged is the outcome: three
      // blobs, three distinct generation ids, all three referenced.
      await waitFor(
        () => caseHarness.cloud.blobPuts.length === 3,
        'all three role blobs',
      );
      // Content-addressed `putBlob` carries no role (unlike the old wide
      // `putObject`); role association only exists in the mutation's
      // `generationsPatch`, asserted below. BYOS drops quota reservations
      // entirely (decision #13), so there is nothing to check there either.
      const generationIds = caseHarness.cloud.blobPuts.map((put) => put.generationId);
      expect(new Set(generationIds).size).toBe(3);

      await waitFor(
        () => caseHarness.cloud.mutations.length === 2,
        'the derived generations patch',
      );
      const mutation = lastProtectMutation(caseHarness.cloud);
      expect(mutation.generationsPatch?.thumbnail).toBeDefined();
      expect(mutation.generationsPatch?.preview).toBeDefined();
      // Each derived blob opens under its own role: one sealed under another
      // scope would be referenced but unreadable on every device.
      for (const [role, plaintext] of [
        ['thumbnail', [1, 2, 3]],
        ['preview', [4, 5, 6, 7]],
      ] as const) {
        const put = caseHarness.cloud.blobPuts.find(
          (entry) => entry.generationId === mutation.generationsPatch?.[role],
        );
        const opened = await caseHarness.cipher.open({
          masterKey: TEST_MASTER_KEY,
          assetId: caseHarness.assetId,
          scope: role,
          envelope: put!.bytes,
        });
        expect(Array.from(opened)).toEqual(plaintext);
      }
      const remote = caseHarness.cloud.remote.get(caseHarness.assetId);
      expect(remote?.generations.original).toBeDefined();

      const record = await caseHarness.protection.findByAssetId(
        SCOPE, caseHarness.assetId,
      );
      expect(record?.protection).toBe('protected');
      expect(record?.verifiedAt).not.toBeNull();
      expect(record?.originalGenerationId).not.toBeNull();
      expect(record?.thumbnailGenerationId).not.toBeNull();
      expect(record?.previewGenerationId).not.toBeNull();
    } finally {
      caseHarness.close();
    }
  });

  it('spends exactly two round trips on a brand-new asset: the original blob, then one merged submit', async () => {
    // K6-1b (spec §2's five-second bar, §4.5): a never-seen asset used to pay
    // six sequential round trips — a readRemoteState GET, the collect submit's
    // own GET+PUT, the three blob PUTs, then the protect submit's GET+PUT. The
    // local database already knows this device has never collected this asset,
    // so the pre-flight read proves nothing: skip it, upload the blobs in
    // parallel, and let ONE submitMutations carry both the collect and the
    // protect.
    //
    // K7 ⑨ narrows it further: the two round trips the USER waits for are the
    // ORIGINAL's PUT and that merged submit. The derived blobs and their one
    // follow-up patch are still paid for, just not before the answer.
    const caseHarness = await protectHarness({ derived: 'ok' });
    try {
      const result = await caseHarness.action.protect(DIGEST);

      expect(result).toEqual({ status: 'applied' });
      // No pre-flight state.json read for an asset this device has never seen.
      expect(caseHarness.cloud.requests).toEqual([]);
      // One submit, carrying both mutations, after all three blobs are durable.
      expect(caseHarness.cloud.mutations).toHaveLength(1);
      expect(
        caseHarness.cloud.mutations[0]!.mutations.map((mutation) => mutation.kind),
      ).toEqual(['collect', 'protect']);
      expect(caseHarness.cloud.blobPuts).toHaveLength(1);

      const [collect, protectMutation] = caseHarness.cloud.mutations[0]!.mutations;
      // The collect still carries the sealed metadata envelope a second device
      // needs to materialize the asset, under the stored intent's mutationId.
      expect(collect!.meta).toBeDefined();
      const intent = await caseHarness.outbox.findCollectIntent(SCOPE, caseHarness.assetId);
      expect(collect!.mutationId).toBe(intent?.mutationId ?? 'no-intent');
      expect(protectMutation!.generationsPatch?.original).toBeDefined();

      const record = await caseHarness.protection.findByAssetId(
        SCOPE, caseHarness.assetId,
      );
      expect(record?.protection).toBe('protected');
      expect(record?.verifiedAt).not.toBeNull();

      // The rest of the work is real, and finishes; it just never gated the
      // answer above.
      await waitFor(
        () => caseHarness.cloud.blobPuts.length === 3
          && caseHarness.cloud.mutations.length === 2,
        'the derived tail',
      );
      const settled = await caseHarness.protection.findByAssetId(
        SCOPE, caseHarness.assetId,
      );
      expect(settled?.thumbnailGenerationId).not.toBeNull();
      expect(settled?.previewGenerationId).not.toBeNull();
    } finally {
      caseHarness.close();
    }
  });

  it('uploads the three role blobs concurrently, not one after another', async () => {
    const caseHarness = await protectHarness({ derived: 'ok' });
    const realPutBlob = caseHarness.cloud.client.putBlob.bind(caseHarness.cloud.client);
    let inFlight = 0;
    let maxInFlight = 0;
    const mutableClient = caseHarness.cloud.client as {
      putBlob: (generationId: string, envelope: Uint8Array) => Promise<void>;
    };
    mutableClient.putBlob = async (
      generationId: string,
      envelope: Uint8Array,
    ) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so a serial caller (awaiting each PUT before the next) can never
      // reach three in flight, while a concurrent caller launches all three
      // before any resolves.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return realPutBlob(generationId, envelope);
    };
    try {
      const result = await caseHarness.action.protect(DIGEST);
      expect(result).toEqual({ status: 'applied' });
      await waitFor(
        () => caseHarness.cloud.blobPuts.length === 3,
        'all three role blobs',
      );
      // All three role blobs are in flight at once: S3 handles thousands of
      // parallel requests against the user's own single-tenant bucket, so
      // there is nothing to serialize (spec G0/G4, owner "no throttling").
      expect(maxInFlight).toBe(3);
    } finally {
      caseHarness.close();
    }
  });

  it('uploads one copy when two callers protect the same digest at once', async () => {
    // K6-1c (spec G3/G7: "written objects = referenced objects"). The save
    // path fires `applySavePolicyAfterIngest` -> protect(sha) the instant the
    // image lands, and the very next K4 sync round's `mirrorUp` still lists the
    // row as a protect candidate and calls protect(sha) for the same digest.
    // Both ran the whole upload: the owner's bucket held 15 objects for 3
    // images (measured 2026-09-13 23:26), every blob written twice under a
    // different generationId, and the duplicate traffic is part of why the
    // stopwatch read 3.9/5.0/6.8 s against a five-second bar.
    //
    // The second caller must join the FIRST call's in-flight work: not a second
    // upload, and not "wait, then run again" either — a re-run would find the
    // finished row and answer `noop`, so both callers answering `applied`
    // is what proves they share one result.
    const caseHarness = await protectHarness({ derived: 'ok' });
    const realPutBlob = caseHarness.cloud.client.putBlob.bind(caseHarness.cloud.client);
    let reachedPutBlob!: () => void;
    const inPutBlob = new Promise<void>((resolve) => {
      reachedPutBlob = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const mutableClient = caseHarness.cloud.client as {
      putBlob: (generationId: string, envelope: Uint8Array) => Promise<void>;
    };
    mutableClient.putBlob = async (
      generationId: string,
      envelope: Uint8Array,
    ) => {
      reachedPutBlob();
      // Hold every blob in flight until the second caller has been admitted,
      // so the race this test describes is the real one: a second protect that
      // arrives while the first one's bytes are still going up.
      await gate;
      return realPutBlob(generationId, envelope);
    };
    try {
      const first = caseHarness.action.protect(DIGEST);
      await inPutBlob;
      const second = caseHarness.action.protect(DIGEST);
      openGate();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual({ status: 'applied' });
      expect(secondResult).toEqual({ status: 'applied' });
      // Three blobs for three roles, once — not six for two callers.
      await waitFor(
        () => caseHarness.cloud.blobPuts.length >= 3,
        'all three role blobs',
      );
      expect(caseHarness.cloud.blobPuts).toHaveLength(3);
      expect(new Set(caseHarness.cloud.blobPuts.map((put) => put.generationId)).size)
        .toBe(3);
      // One commit, and (K7 ⑨) one derived patch behind it — the run's two
      // writes, not one run's writes twice over.
      await waitFor(
        () => caseHarness.cloud.mutations.length >= 2,
        'the derived generations patch',
      );
      expect(caseHarness.cloud.mutations).toHaveLength(2);
      expect(
        caseHarness.cloud.mutations[0]!.mutations.map((entry) => entry.kind),
      ).toEqual(['collect', 'protect']);
      expect(caseHarness.cloud.mutations[1]!.mutations).toHaveLength(1);

      const record = await caseHarness.protection.findByAssetId(
        SCOPE, caseHarness.assetId,
      );
      expect(record?.protection).toBe('protected');
      expect(record?.verifiedAt).not.toBeNull();
    } finally {
      caseHarness.close();
    }
  });

  it('claims the asset while its upload is live and releases it when it settles', async () => {
    // K6-3a: the sync engine's drain only knows assetIds, so the in-flight map
    // K6-1c already keeps per digest must answer under that identity too. This
    // is the whole ownership signal — while a protect is uploading, the drain
    // must not replay its rows and delete the collect intent out from under it.
    const caseHarness = await protectHarness({ derived: 'ok' });
    const realPutBlob = caseHarness.cloud.client.putBlob.bind(
      caseHarness.cloud.client,
    );
    let reachedPutBlob!: () => void;
    const inPutBlob = new Promise<void>((resolve) => {
      reachedPutBlob = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const mutableClient = caseHarness.cloud.client as {
      putBlob: (generationId: string, envelope: Uint8Array) => Promise<void>;
    };
    mutableClient.putBlob = async (
      generationId: string,
      envelope: Uint8Array,
    ) => {
      reachedPutBlob();
      await gate;
      return realPutBlob(generationId, envelope);
    };
    try {
      expect(caseHarness.action.isInFlight(caseHarness.assetId)).toBe(false);

      const running = caseHarness.action.protect(DIGEST);
      await inPutBlob;
      expect(caseHarness.action.isInFlight(caseHarness.assetId)).toBe(true);

      openGate();
      await expect(running).resolves.toEqual({ status: 'applied' });
      // Released on settle, so a genuinely crashed row is replayable again.
      expect(caseHarness.action.isInFlight(caseHarness.assetId)).toBe(false);
    } finally {
      caseHarness.close();
    }
  });

  it('board #24: settled(digest) joins the in-flight upload and resolves at once when idle', async () => {
    // Spec §5.4.2 step 3: the removal of a rewound save waits for an upload of
    // the same bytes that is already running, so its writes land before the
    // cleanup deletes the rows they belong to. Joining, never starting one.
    const caseHarness = await protectHarness({ derived: 'ok' });
    const realPutBlob = caseHarness.cloud.client.putBlob.bind(
      caseHarness.cloud.client,
    );
    let reachedPutBlob!: () => void;
    const inPutBlob = new Promise<void>((resolve) => {
      reachedPutBlob = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const mutableClient = caseHarness.cloud.client as {
      putBlob: (generationId: string, envelope: Uint8Array) => Promise<void>;
    };
    mutableClient.putBlob = async (
      generationId: string,
      envelope: Uint8Array,
    ) => {
      reachedPutBlob();
      await gate;
      return realPutBlob(generationId, envelope);
    };
    try {
      // Idle: nothing to join, and nothing is started either.
      await expect(caseHarness.action.settled(DIGEST)).resolves.toBeUndefined();
      expect(caseHarness.cloud.blobPuts).toHaveLength(0);

      const running = caseHarness.action.protect(DIGEST);
      await inPutBlob;
      let joined = false;
      const settled = caseHarness.action.settled(DIGEST).then(() => {
        joined = true;
      });
      // Another digest has nothing in flight.
      await expect(caseHarness.action.settled('f'.repeat(64))).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(joined).toBe(false);

      openGate();
      await expect(running).resolves.toEqual({ status: 'applied' });
      await settled;
      expect(joined).toBe(true);
    } finally {
      caseHarness.close();
    }
  });

  it('settledAll() waits for every running upload and starts none', async () => {
    // Spec §5.4 step 3: join whatever is uploading now, whichever way it ends.
    // Idle answers at once and does not start an upload.
    const caseHarness = await protectHarness({ derived: 'ok' });
    const realPutBlob = caseHarness.cloud.client.putBlob.bind(
      caseHarness.cloud.client,
    );
    let reachedPutBlob!: () => void;
    const inPutBlob = new Promise<void>((resolve) => {
      reachedPutBlob = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const mutableClient = caseHarness.cloud.client as {
      putBlob: (generationId: string, envelope: Uint8Array) => Promise<void>;
    };
    mutableClient.putBlob = async (
      generationId: string,
      envelope: Uint8Array,
    ) => {
      reachedPutBlob();
      await gate;
      return realPutBlob(generationId, envelope);
    };
    try {
      await expect(caseHarness.action.settledAll()).resolves.toBeUndefined();
      expect(caseHarness.cloud.blobPuts).toHaveLength(0);

      const running = caseHarness.action.protect(DIGEST);
      await inPutBlob;
      let settled = false;
      const waiting = caseHarness.action.settledAll().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(settled).toBe(false);

      openGate();
      await expect(running).resolves.toEqual({ status: 'applied' });
      await waiting;
      expect(settled).toBe(true);
    } finally {
      caseHarness.close();
    }
  });

  it('does not read the committed original back to verify it', async () => {
    const caseHarness = await protectHarness({ derived: 'ok' });
    const getObjectSpy = jest.spyOn(caseHarness.cloud.client, 'getObject');
    try {
      const result = await caseHarness.action.protect(DIGEST);

      expect(result).toEqual({ status: 'applied' });
      // First principles (spec §1 F4 / G4): the mirror always keeps the local
      // original and the S3 200 + content-addressed blob already prove the
      // bytes landed, so downloading the object back to re-hash it is pure
      // waste — the single largest per-image request. It must not happen.
      expect(getObjectSpy).not.toHaveBeenCalled();

      const record = await caseHarness.protection.findByAssetId(
        SCOPE, caseHarness.assetId,
      );
      expect(record?.protection).toBe('protected');
      expect(record?.verifiedAt).not.toBeNull();
    } finally {
      getObjectSpy.mockRestore();
      caseHarness.close();
    }
  });

  it('does not re-hash the local original it just wrote', async () => {
    // K6-1e (spec §2's five-second bar). `library-ingest.ts:252` computed this
    // digest when it wrote the file, named the file after it, and made it the
    // `device_library_assets` primary key. Re-hashing the same bytes here only
    // re-verifies a file this app wrote seconds ago, and on Hermes (no JIT)
    // the pure-JS @noble sha256 cost 1334 ms of JS thread for a 6 MB original
    // — before the upload even started. Zero calls, not "fewer".
    const caseHarness = await protectHarness({ derived: 'ok' });
    try {
      mockShaCalls.count = 0;
      const result = await caseHarness.action.protect(DIGEST);

      expect(result).toEqual({ status: 'applied' });
      expect(mockShaCalls.count).toBe(0);
    } finally {
      caseHarness.close();
    }
  });

  it('protects bytes whose size matches without re-verifying their digest', async () => {
    // The discriminating half of the cut: same byte count, different content.
    // The digest comparison used to block this as `integrity`; the byte-count
    // fallback that replaces it cannot see it, and that is deliberate — the
    // only failure this guard exists for is a truncated/partial local file,
    // not bytes silently rewritten behind the app's back.
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    harness.port.files.set(
      harness.originalUriFor(digest),
      Uint8Array.from([99, 98, 97, 96, 95]),
    );

    expect(await action.protect(digest)).toEqual({ status: 'applied' });
    expect(harness.cloud.blobPuts).toHaveLength(1);
  });

  it('blocks with integrity when the local original is truncated', async () => {
    // The zero-cost fallback that replaces the digest comparison: a file the
    // store hands back short of its recorded `byteSize` is a real local
    // corruption, and nothing is uploaded.
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    harness.port.files.set(harness.originalUriFor(digest), bytes.slice(0, 2));

    expect(await action.protect(digest)).toEqual({
      status: 'blocked', category: 'integrity',
    });
    expect(harness.cloud.blobPuts).toEqual([]);
    expect(harness.cloud.submitted).toEqual([]);
    expect(
      (await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest))
        ?.failureCategory,
    ).toBe('integrity');
  });

  describe('K7 ⑨ the original alone decides when the cloud turns orange', () => {
    // The audit's finding: the `[collect, protect]` write that flips the tile
    // to «已备份» used to wait for two native decode+encode passes, two AES
    // seals and two more PUTs — on a cold connection, 10-85 s of handshake for
    // objects this device never reads (its local original always wins in
    // `library-render-tiers.ts`). The original's own PUT had finished long
    // before. So: commit on the original, patch the derived references in
    // afterwards.

    it('commits [collect, protect] while derivation is still running', async () => {
      let releaseDerive!: () => void;
      const derivePending = new Promise<void>((resolve) => {
        releaseDerive = resolve;
      });
      const slowDerived: LibraryDerivedImages = {
        async derive(input) {
          await derivePending;
          return derivedDouble('ok').derive(input);
        },
      };
      const built = build(harness, slowDerived);
      await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });
      try {
        // Derivation has NOT been released: on the pre-K7 code this never
        // settles, because the submit waited for it.
        const result = await built.protect(DIGEST);

        expect(result).toEqual({ status: 'applied' });
        // One state write, and only the original is on the wire.
        expect(harness.cloud.mutations).toHaveLength(1);
        expect(
          harness.cloud.mutations[0]!.mutations.map((entry) => entry.kind),
        ).toEqual(['collect', 'protect']);
        expect(harness.cloud.blobPuts).toHaveLength(1);
        const patch = lastProtectMutation(harness.cloud).generationsPatch;
        expect(patch?.original).toBeDefined();
        expect(patch?.thumbnail).toBeUndefined();
        expect(patch?.preview).toBeUndefined();

        // The user-visible outcome: orange cloud, now.
        const record = await harness.protection.findByAssetId(
          SCOPE, harness.assetIdFor(DIGEST),
        );
        expect(record?.protection).toBe('protected');
        expect(record?.verifiedAt).not.toBeNull();
      } finally {
        releaseDerive();
        await waitFor(
          () => harness.cloud.blobPuts.length === 3,
          'the derived tail to drain',
        ).catch(() => {});
      }
    });

    it('folds the derived references in afterwards with ONE follow-up state write', async () => {
      const caseHarness = await protectHarness({ derived: 'ok' });
      try {
        expect(await caseHarness.action.protect(DIGEST)).toEqual({
          status: 'applied',
        });

        await waitFor(
          () => caseHarness.cloud.mutations.length === 2,
          'the derived generations patch',
        );
        // Exactly one follow-up, carrying ONLY the derived roles.
        const follow = caseHarness.cloud.mutations[1]!.mutations;
        expect(follow).toHaveLength(1);
        expect(follow[0]!.kind).toBe('protect');
        expect(follow[0]!.generationsPatch?.original).toBeUndefined();
        expect(follow[0]!.generationsPatch?.thumbnail).toBeDefined();
        expect(follow[0]!.generationsPatch?.preview).toBeDefined();
        expect(follow[0]!.newBlob).toBeNull();

        // The bucket's state.json ends up naming all three roles, which is
        // what a second device reads to draw its grid without the original.
        const remote = caseHarness.cloud.remote.get(caseHarness.assetId);
        expect(Object.keys(remote?.generations ?? {}).sort()).toEqual([
          'original', 'preview', 'thumbnail',
        ]);
        expect(remote?.protection).toBe('protected');
        expect(remote?.lifecycle).toBe('active');

        // ...and this device's own row learns them too, so nothing has to wait
        // for a sync round that the ETag index would (correctly) skip.
        const record = await caseHarness.protection.findByAssetId(
          SCOPE, caseHarness.assetId,
        );
        expect(record?.protection).toBe('protected');
        expect(record?.verifiedAt).not.toBeNull();
        expect(record?.thumbnailGenerationId).toBe(
          follow[0]!.generationsPatch?.thumbnail,
        );
        expect(record?.previewGenerationId).toBe(
          follow[0]!.generationsPatch?.preview,
        );
      } finally {
        caseHarness.close();
      }
    });

    it('leaves the asset protected when the derived patch itself fails', async () => {
      const caseHarness = await protectHarness({ derived: 'ok' });
      const client = caseHarness.cloud.client as {
        submitMutations: (input: {
          mutations: readonly unknown[];
        }) => Promise<unknown>;
      };
      const realSubmit = client.submitMutations.bind(caseHarness.cloud.client);
      let submits = 0;
      let patchAttempted = false;
      client.submitMutations = async (input) => {
        submits += 1;
        if (submits === 2) {
          patchAttempted = true;
          throw new LibraryCloudError(
            0, 'network', 'offline', 'derived patch failed', false,
          );
        }
        return realSubmit(input);
      };
      try {
        expect(await caseHarness.action.protect(DIGEST)).toEqual({
          status: 'applied',
        });
        await waitFor(() => patchAttempted, 'the derived patch attempt');

        // Protection is the original's, and a derived extra can never take it
        // away — the same rule a failed derived UPLOAD already obeyed.
        const record = await caseHarness.protection.findByAssetId(
          SCOPE, caseHarness.assetId,
        );
        expect(record?.protection).toBe('protected');
        expect(record?.verifiedAt).not.toBeNull();
        expect(record?.failureCategory).toBeNull();
        const remote = caseHarness.cloud.remote.get(caseHarness.assetId);
        expect(remote?.protection).toBe('protected');
      } finally {
        caseHarness.close();
      }
    });

    it('writes no follow-up at all when derivation produced nothing', async () => {
      const caseHarness = await protectHarness({ derived: 'fail' });
      try {
        expect(await caseHarness.action.protect(DIGEST)).toEqual({
          status: 'applied',
        });
        // Give a tail every chance to appear before asserting it does not.
        await waitFor(() => true, 'nothing');
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(caseHarness.cloud.mutations).toHaveLength(1);
        expect(caseHarness.cloud.blobPuts).toHaveLength(1);
      } finally {
        caseHarness.close();
      }
    });
  });

  it('starts the original upload before derivation has produced anything', async () => {
    // K6-1e Task 3 (spec §2's five-second bar). Derivation is decode + resize
    // + re-encode on the JS thread: measured 1618 ms for a 6 MB original, and
    // every millisecond of it used to be spent BEFORE the original's first
    // byte left the device, even though the original's sealed envelope was
    // already in hand. The original is the payload the user is waiting on; the
    // thumbnail and preview are regenerable extras that must ride alongside
    // it, never ahead of it.
    let releaseDerive!: () => void;
    const derivePending = new Promise<void>((resolve) => {
      releaseDerive = resolve;
    });
    let deriveEntered!: () => void;
    const deriveStarted = new Promise<void>((resolve) => {
      deriveEntered = resolve;
    });
    let blobPutsWhenDeriveStarted = -1;
    const slowDerived: LibraryDerivedImages = {
      async derive(input) {
        blobPutsWhenDeriveStarted = harness.cloud.blobPuts.length;
        deriveEntered();
        await derivePending;
        return derivedDouble('ok').derive(input);
      },
    };
    const built = build(harness, slowDerived);
    let run: Promise<LibraryActionResult> | null = null;
    try {
      await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
      run = built.protect(digest);
      await deriveStarted;
      // The original's PUT is already on the wire while derivation is still
      // blocked — that is the whole point of the reordering.
      expect(blobPutsWhenDeriveStarted).toBe(1);

      releaseDerive();
      expect(await run).toEqual({ status: 'applied' });
      // ...and the derived roles still ride along and still get referenced —
      // K7 ⑨ moved that behind the answer, it did not drop it.
      await waitFor(
        () => harness.cloud.blobPuts.length === 3
          && harness.cloud.mutations.length === 2,
        'the derived tail',
      );
      const mutation = lastProtectMutation(harness.cloud);
      expect(mutation.generationsPatch?.thumbnail).toBeDefined();
      expect(mutation.generationsPatch?.preview).toBeDefined();
    } finally {
      // Never leave the action running against a harness `afterEach` closes.
      releaseDerive();
      await run?.catch(() => {});
    }
  });

  it('still protects on the original alone when derivation fails', async () => {
    const caseHarness = await protectHarness({ derived: 'fail' });
    try {
      const result = await caseHarness.action.protect(DIGEST);

      expect(result).toEqual({ status: 'applied' });
      expect(caseHarness.cloud.blobPuts).toHaveLength(1);
      const mutation = lastProtectMutation(caseHarness.cloud);
      expect(mutation.generationsPatch?.thumbnail).toBeUndefined();
      expect(mutation.generationsPatch?.preview).toBeUndefined();

      const record = await caseHarness.protection.findByAssetId(
        SCOPE, caseHarness.assetId,
      );
      expect(record?.protection).toBe('protected');
      expect(record?.verifiedAt).not.toBeNull();
      // A derived failure is not a protection failure.
      expect(record?.failureCategory).toBeNull();
    } finally {
      caseHarness.close();
    }
  });

  it('still protects when a derived upload fails after the derived bytes existed', async () => {
    const caseHarness = await protectHarness({ derived: 'ok' });
    const realPutBlob = caseHarness.cloud.client.putBlob.bind(caseHarness.cloud.client);
    const mutableClient = caseHarness.cloud.client as {
      putBlob: (generationId: string, envelope: Uint8Array) => Promise<void>;
    };
    let putCalls = 0;
    // K6-1e: the original is now the FIRST blob on the wire, so the harness's
    // one-shot `failNextBlobPut` knob would take down the ORIGINAL rather than
    // a derived role and this test would assert the opposite of its name. Fail
    // the first DERIVED upload explicitly instead — the derived loop still
    // walks thumbnail before preview, so call #1 is the original, #2 the
    // thumbnail. What is proven is unchanged: one derived role's upload
    // failure does not block protection using the rest.
    mutableClient.putBlob = async (generationId: string, envelope: Uint8Array) => {
      putCalls += 1;
      if (putCalls === 2) throw new Error('derived blob put failed');
      return realPutBlob(generationId, envelope);
    };
    try {
      const result = await caseHarness.action.protect(DIGEST);

      expect(result).toEqual({ status: 'applied' });
      // K7 ⑨: the surviving derived role still reaches the bucket, in the one
      // follow-up patch; the one that failed is simply absent from it.
      await waitFor(
        () => caseHarness.cloud.mutations.length === 2,
        'the derived generations patch',
      );
      const mutation = lastProtectMutation(caseHarness.cloud);
      expect(mutation.generationsPatch?.thumbnail).toBeUndefined();
      expect(mutation.generationsPatch?.preview).toBeDefined();
      expect(mutation.originalGenerationId).not.toBeNull();
      const record = await caseHarness.protection.findByAssetId(
        SCOPE, caseHarness.assetId,
      );
      expect(record?.protection).toBe('protected');
      expect(record?.failureCategory).toBeNull();
      expect(record?.thumbnailGenerationId).toBeNull();
      expect(record?.previewGenerationId).not.toBeNull();
    } finally {
      caseHarness.close();
    }
  });

  it('fails protection when the original upload fails, even if the derived ones succeed', async () => {
    // K6-1 semantics, re-guarded for K6-1e: the original now starts first and
    // its promise is awaited only after derivation settles, so its rejection
    // has to be held and re-raised rather than swallowed. A thumbnail and a
    // preview in the bucket are not protection.
    const caseHarness = await protectHarness({ derived: 'ok' });
    const realPutBlob = caseHarness.cloud.client.putBlob.bind(caseHarness.cloud.client);
    const mutableClient = caseHarness.cloud.client as {
      putBlob: (generationId: string, envelope: Uint8Array) => Promise<void>;
    };
    let putCalls = 0;
    mutableClient.putBlob = async (generationId: string, envelope: Uint8Array) => {
      putCalls += 1;
      // Call #1 is the original (K6-1e ordering).
      if (putCalls === 1) throw new Error('original blob put failed');
      return realPutBlob(generationId, envelope);
    };
    try {
      expect(await caseHarness.action.protect(DIGEST)).toEqual({
        status: 'blocked', category: 'retryable_transfer',
      });
      // Nothing was allowed to reference the missing original.
      expect(caseHarness.cloud.mutations).toEqual([]);
      const record = await caseHarness.protection.findByAssetId(
        SCOPE, caseHarness.assetId,
      );
      expect(record?.protection).toBe('failed');
      expect(record?.failureCategory).toBe('retryable_transfer');
      expect(record?.verifiedAt).toBeNull();
    } finally {
      caseHarness.close();
    }
  });

  it('never writes a derived plaintext into durable local storage', async () => {
    const caseHarness = await protectHarness({ derived: 'ok' });
    try {
      await caseHarness.action.protect(DIGEST);
      const originals = await caseHarness.port.listOriginals();
      expect(originals).toEqual([caseHarness.localOriginalUri]);
    } finally {
      caseHarness.close();
    }
  });

  it('resumes a committed original without re-deriving or re-uploading', async () => {
    // A prior attempt already uploaded the triad and wrote state.json but the
    // process stopped before the terminal verified projection was durable:
    // protection is pending, the committed generation ids are known, and
    // verifiedAt is null. There is no download-back knob any more — the resume
    // must trust the committed generation directly.
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    const assetId = harness.assetIdFor(digest);
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: digest,
      lifecycle: 'active',
      protection: 'pending',
      generation: 1,
      revision: 1,
      originalGenerationId: 'gen-original',
      originalCiphertextBytes: 128,
      thumbnailGenerationId: 'gen-thumb',
      previewGenerationId: 'gen-preview',
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    const { mutationId } = await harness.outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      assetId,
      kind: 'protect',
      baseRevision: 0,
      observedGeneration: 1,
      payload: {
        assetId,
        plaintextSha256: digest,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'gen-original',
        originalCiphertextBytes: 128,
        queuedAt: harness.now,
      },
    });
    expect(mutationId).not.toBeNull();

    let deriveCount = 0;
    const resuming = build(harness, derivedDouble('ok', () => { deriveCount += 1; }));

    expect(await resuming.protect(digest)).toEqual({ status: 'applied' });
    // The resume neither re-derives nor re-uploads; it adopts the committed
    // generation and preserves the derived generation ids.
    expect(deriveCount).toBe(0);
    expect(harness.cloud.blobPuts).toEqual([]);

    const record = await harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId);
    expect(record?.protection).toBe('protected');
    expect(record?.verifiedAt).not.toBeNull();
    expect(record?.originalGenerationId).toBe('gen-original');
    expect(record?.thumbnailGenerationId).toBe('gen-thumb');
    expect(record?.previewGenerationId).toBe('gen-preview');
    // The retained intent is cleared once the terminal projection is durable.
    expect(await harness.outbox.find(TEST_ACCOUNT_SCOPE, assetId, 'protect')).toBeNull();
  });

  it('an adopted protected row is verified from its committed generation without reading, uploading or submitting', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    const assetId = harness.assetIdFor(digest);
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: digest,
      lifecycle: 'active',
      protection: 'protected',
      generation: 3,
      revision: 5,
      originalGenerationId: 'gen-adopted-original',
      originalCiphertextBytes: null,
      thumbnailGenerationId: 'gen-adopted-thumb',
      previewGenerationId: 'gen-adopted-preview',
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    const { mutationId } = await harness.outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      assetId,
      kind: 'protect',
      baseRevision: 0,
      observedGeneration: 3,
      payload: {
        assetId,
        plaintextSha256: digest,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'gen-adopted-original',
        originalCiphertextBytes: null,
        queuedAt: harness.now,
      },
    });
    expect(mutationId).not.toBeNull();

    const readTemp = jest.spyOn(harness.files, 'readTemp');
    const putBlob = jest.spyOn(harness.cloud.client, 'putBlob');
    const submitMutations = jest.spyOn(harness.cloud.client, 'submitMutations');
    const getAssetState = jest.spyOn(harness.reconciliation, 'getAssetState');

    expect(await action.protect(digest)).toEqual({ status: 'applied' });

    const record = await harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId);
    expect(record?.protection).toBe('protected');
    expect(record?.verifiedAt).toBe(harness.now);
    expect(record?.generation).toBe(3);
    expect(record?.revision).toBe(5);
    expect(record?.originalGenerationId).toBe('gen-adopted-original');
    expect(record?.originalCiphertextBytes).toBeNull();
    expect(record?.thumbnailGenerationId).toBe('gen-adopted-thumb');
    expect(record?.previewGenerationId).toBe('gen-adopted-preview');
    expect((await harness.protection.readDeviceState(digest))?.lastVerifiedAt)
      .toBe(record?.verifiedAt);
    expect(readTemp).not.toHaveBeenCalled();
    expect(putBlob).not.toHaveBeenCalled();
    expect(submitMutations).not.toHaveBeenCalled();
    expect(getAssetState).not.toHaveBeenCalled();
    expect(await harness.outbox.find(TEST_ACCOUNT_SCOPE, assetId, 'protect')).toBeNull();
  });

  it('a projection applied while an adopted row is being verified is kept', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    const assetId = harness.assetIdFor(digest);
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: digest,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 1,
      originalGenerationId: 'gen-adopted-original',
      originalCiphertextBytes: null,
      thumbnailGenerationId: 'gen-adopted-thumb',
      previewGenerationId: 'gen-adopted-preview',
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    await harness.outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      assetId,
      kind: 'protect',
      baseRevision: 0,
      observedGeneration: 1,
      payload: {
        assetId,
        plaintextSha256: digest,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'gen-adopted-original',
        originalCiphertextBytes: null,
        queuedAt: harness.now,
      },
    });

    const retainedFind = harness.outbox.find.bind(harness.outbox);
    let projected: LibraryProtectionRecord | null = null;
    jest.spyOn(harness.outbox, 'find').mockImplementation(async (scope, id, kind) => {
      await harness.protection.upsertProtection({
        accountScope: TEST_ACCOUNT_SCOPE,
        assetId,
        plaintextSha256: digest,
        lifecycle: 'active',
        protection: 'unprotected',
        generation: 2,
        revision: 2,
        originalGenerationId: null,
        originalCiphertextBytes: null,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        failureCategory: null,
        trashedAt: null,
      });
      projected = await harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId);
      return retainedFind(scope, id, kind);
    });
    const readTemp = jest.spyOn(harness.files, 'readTemp');
    const putBlob = jest.spyOn(harness.cloud.client, 'putBlob');
    const submitMutations = jest.spyOn(harness.cloud.client, 'submitMutations');
    const getAssetState = jest.spyOn(harness.reconciliation, 'getAssetState');

    expect(await action.protect(digest)).toEqual({
      status: 'noop', reason: 'not-applicable',
    });

    expect(await harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId))
      .toEqual(projected);
    expect((await harness.protection.readDeviceState(digest))?.lastVerifiedAt ?? null)
      .toBeNull();
    expect(await retainedFind(TEST_ACCOUNT_SCOPE, assetId, 'protect'))
      .not.toBeNull();
    expect(readTemp).not.toHaveBeenCalled();
    expect(putBlob).not.toHaveBeenCalled();
    expect(submitMutations).not.toHaveBeenCalled();
    expect(getAssetState).not.toHaveBeenCalled();
  });

  it('a resumed pending commit is not verified over a newer projection', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    const assetId = harness.assetIdFor(digest);
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: digest,
      lifecycle: 'active',
      protection: 'pending',
      generation: 1,
      revision: 1,
      originalGenerationId: 'gen-resumed-original',
      originalCiphertextBytes: 128,
      thumbnailGenerationId: 'gen-resumed-thumb',
      previewGenerationId: 'gen-resumed-preview',
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    await harness.outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      assetId,
      kind: 'protect',
      baseRevision: 0,
      observedGeneration: 1,
      payload: {
        assetId,
        plaintextSha256: digest,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'gen-resumed-original',
        originalCiphertextBytes: 128,
        queuedAt: harness.now,
      },
    });

    const retainedFind = harness.outbox.find.bind(harness.outbox);
    let projected: LibraryProtectionRecord | null = null;
    jest.spyOn(harness.outbox, 'find').mockImplementation(async (scope, id, kind) => {
      await harness.protection.upsertProtection({
        accountScope: TEST_ACCOUNT_SCOPE,
        assetId,
        plaintextSha256: digest,
        lifecycle: 'active',
        protection: 'unprotected',
        generation: 2,
        revision: 2,
        originalGenerationId: null,
        originalCiphertextBytes: null,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        failureCategory: null,
        trashedAt: null,
      });
      projected = await harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId);
      return retainedFind(scope, id, kind);
    });
    const readTemp = jest.spyOn(harness.files, 'readTemp');
    const putBlob = jest.spyOn(harness.cloud.client, 'putBlob');
    const submitMutations = jest.spyOn(harness.cloud.client, 'submitMutations');
    const getAssetState = jest.spyOn(harness.reconciliation, 'getAssetState');

    expect(await action.protect(digest)).toEqual({
      status: 'noop', reason: 'not-applicable',
    });

    expect(await harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId))
      .toEqual(projected);
    expect((await harness.protection.readDeviceState(digest))?.lastVerifiedAt ?? null)
      .toBeNull();
    expect(await retainedFind(TEST_ACCOUNT_SCOPE, assetId, 'protect'))
      .not.toBeNull();
    expect(readTemp).not.toHaveBeenCalled();
    expect(putBlob).not.toHaveBeenCalled();
    expect(submitMutations).not.toHaveBeenCalled();
    expect(getAssetState).not.toHaveBeenCalled();
  });

  it('seals the original, uploads it, and commits it protected', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    expect(await action.protect(digest)).toEqual({ status: 'applied' });

    expect(harness.cloud.blobPuts).toHaveLength(1);
    const expectedGenerationId = harness.cloud.blobPuts[0]!.generationId;

    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record).toMatchObject({
      protection: 'protected',
      originalGenerationId: expectedGenerationId,
      failureCategory: null,
    });
    expect(record?.verifiedAt).not.toBeNull();

    const kinds = harness.cloud.submitted.map((mutation) => mutation.kind);
    expect(kinds).toEqual(['collect', 'protect']);
    const protectMutation = harness.cloud.submitted.at(-1)!;
    // BYOS has no quota reservation (decision #13), so a submitted mutation
    // carries no reservation field at all any more.
    expect(protectMutation).not.toHaveProperty('reservationId');
    expect(protectMutation.originalGenerationId).toBe(expectedGenerationId);
    expect(protectMutation.generationsPatch?.thumbnail).toBeUndefined();
    expect(protectMutation.generationsPatch?.preview).toBeUndefined();

    const local = await harness.repository.findLocalAsset(digest);
    expect(local?.residency).toBe('local-original');
    expect(local?.localOriginalUri).not.toBeNull();
  });

  it('an asset with a long tag list is collected and protected with the real cipher', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    const tags = Array.from(
      { length: 300 },
      (_, index) => `tag_${index.toString().padStart(4, '0')}`,
    );
    const sourceImageId = await harness.seedSourceImage({
      plaintextSha256: digest,
      overrides: { tags_json: JSON.stringify(tags) },
    });

    expect(await action.protect(digest)).toEqual({ status: 'applied' });

    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record).toMatchObject({ protection: 'protected', failureCategory: null });
    const collect = harness.cloud.submitted.find((mutation) => mutation.kind === 'collect');
    expect(typeof collect?.meta).toBe('string');
    const opened = await harness.cipher.openMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId: harness.assetIdFor(digest),
      sealed: collect!.meta as string,
    });
    expect(opened.version).toBe(3);
    expect(opened.importClassification).toBe('unknown');
    expect(opened.source).toBeDefined();
    expect(opened.tags.length).toBeGreaterThan(0);
    expect(opened.tags.length).toBeLessThan(tags.length);
    expect(opened.tags).toEqual(tags.slice(0, opened.tags.length));
    expect(opened.source?.tags).toEqual(opened.tags);
    // The local row is never trimmed: only the sealed envelope is.
    const row = await harness.database.getFirst<{ tags_json: string }>(
      'SELECT tags_json FROM images WHERE id = ?',
      [sourceImageId],
    );
    expect(JSON.parse(row!.tags_json)).toEqual(tags);
  });

  it('re-enrolls an enrolled asset whose collect intent went missing', async () => {
    // K6-3a self-heal. `object_missing` is a terminal verdict — the row is
    // retried and re-failed every round forever (PROJECT-STATUS K7's "retry a
    // dead row forever"). It must mean the OBJECT is really gone, never merely
    // that a local intent row is. An asset this account has enrolled can
    // always have its intent rebuilt from durable local state, so a lost
    // intent is repairable, not fatal.
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    const assetId = harness.assetIdFor(digest);
    // Exactly the state the proven race left behind: enrolled, no intent, no
    // remote record.
    await harness.database.run(
      `DELETE FROM library_outbox WHERE kind = 'collect'`,
    );
    expect(
      await harness.outbox.findCollectIntent(TEST_ACCOUNT_SCOPE, assetId),
    ).toBeNull();
    expect(harness.cloud.remote.has(assetId)).toBe(false);

    const reenrolled: string[] = [];
    const healing = createLibraryProtectAction({
      ...harness.protectDependencies,
      derived: createFailingLibraryDerivedImages(),
      reenroll: async (sha) => {
        reenrolled.push(sha);
        await ingestFor(harness).enrichLocalAssetForAccount(sha);
      },
    });

    expect(await healing.protect(digest)).toEqual({ status: 'applied' });

    expect(reenrolled).toEqual([digest]);
    // The asset really exists in the bucket now — not merely "not failed".
    expect(harness.cloud.remote.has(assetId)).toBe(true);
    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record).toMatchObject({
      protection: 'protected',
      failureCategory: null,
    });
  });

  it('still reports object_missing when re-enrolment cannot help', async () => {
    // The honest terminal case survives: if the asset cannot be re-enrolled,
    // this is a real `object_missing`, reported as such and not dressed up.
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    await harness.database.run(
      `DELETE FROM library_outbox WHERE kind = 'collect'`,
    );
    await harness.cloud.seedRemoteAsset({ plaintextSha256: digest });
    // Remote record exists, so `ensureCollected` returns before any intent
    // lookup; drop it again to reach the intent path with a dead re-enrol.
    harness.cloud.removeRemoteAsset(digest);

    const healing = createLibraryProtectAction({
      ...harness.protectDependencies,
      derived: createFailingLibraryDerivedImages(),
      reenroll: async () => {
        // A re-enrol that restores nothing (no local row, no account).
      },
    });

    expect(await healing.protect(digest)).toEqual({
      status: 'blocked', category: 'object_missing',
    });
  });

  it('keeps the local original and queues the intent while offline', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    harness.cloud.offline = true;
    expect(await action.protect(digest)).toEqual({
      status: 'queued', category: 'offline',
    });
    const record = await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(record?.protection).toBe('pending');
    expect(record?.verifiedAt).toBeNull();
    expect((await harness.outbox.list(TEST_ACCOUNT_SCOPE))[0]).toMatchObject({
      kind: 'protect', state: 'pending',
    });
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('local-original');
  });

  it('refuses an oversize original before any upload', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: digest, bytes, protectEligible: false,
    });
    expect(await action.protect(digest)).toEqual({
      status: 'blocked', category: 'unsupported_image',
    });
    expect(harness.cloud.submitted).toEqual([]);
    expect(LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES).toBe(64 * 1024 * 1024 - 96);
  });

  it('reports auth attention with no account', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    harness.session.value = null;
    expect(await action.protect(digest)).toEqual({
      status: 'blocked', category: 'auth_attention',
    });
    expect(harness.cloud.submitted).toEqual([]);
  });

  /**
   * Spec §4: `quota_full` is a stop-and-wait state exactly like
   * `auth_attention`. A row already failed either way must re-report the
   * block without re-deriving, re-sealing or re-uploading anything — the
   * blocking state has not changed, so every request the retry spends is
   * guaranteed to fail the same way (507 / 403).
   */
  it.each<LibraryFailureCategory>(['auth_attention', 'quota_full'])(
    'short-circuits a row already failed with %s, spending no request',
    async (category) => {
      await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
      await harness.protection.upsertProtection({
        accountScope: TEST_ACCOUNT_SCOPE,
        assetId: harness.assetIdFor(digest),
        plaintextSha256: digest,
        lifecycle: 'active',
        protection: 'failed',
        generation: 1,
        revision: 1,
        originalGenerationId: null,
        originalCiphertextBytes: null,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        failureCategory: category,
        trashedAt: null,
      });

      expect(await action.protect(digest)).toEqual({
        status: 'blocked', category,
      });
      expect(harness.cloud.blobPuts).toEqual([]);
      expect(harness.cloud.submitted).toEqual([]);
    },
  );

  it('keeps a dispatched protect in sending when the response is lost', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    // The Worker commits the protect; the answer never arrives.
    harness.cloud.loseResponseAfterCommit = 'protect';

    expect(await action.protect(digest)).toEqual({
      status: 'queued', category: 'offline',
    });

    expect(harness.cloud.blobPuts).toHaveLength(1);
    const expectedGenerationId = harness.cloud.blobPuts[0]!.generationId;
    const [row] = await harness.outbox.list(TEST_ACCOUNT_SCOPE);
    // Outcome unknown: the stored generation id stays replayable. BYOS has
    // no quota reservation (decision #13), so the payload's reservationId
    // stays null rather than a real value to replay.
    expect(row).toMatchObject({ kind: 'protect', state: 'sending' });
    expect(row?.payload).toMatchObject({
      reservationId: null,
      originalGenerationId: expectedGenerationId,
    });
    // Nothing claims a verified protection while the outcome is unknown.
    expect(
      (await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest))
        ?.verifiedAt ?? null,
    ).toBeNull();
  });

  it('marks a refused protect failed, because nothing was applied', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    // The account already knows the asset, so only the protect POST is refused.
    await harness.cloud.seedRemoteAsset({ plaintextSha256: digest });
    harness.cloud.submitError = new LibraryCloudError(
      403, 's3_credential', 'auth_attention', 'refused', true,
    );

    expect(await action.protect(digest)).toEqual({
      status: 'blocked', category: 'auth_attention',
    });

    expect((await harness.outbox.list(TEST_ACCOUNT_SCOPE))[0]).toMatchObject({
      kind: 'protect', state: 'failed',
    });
  });

  it('surfaces stale_client instead of retrying a rejected mutation', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    harness.cloud.rejectNext = 'resync_required';
    expect(await action.protect(digest)).toEqual({
      status: 'blocked', category: 'stale_client',
    });
    expect((await harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, digest))
      ?.failureCategory).toBe('stale_client');
  });

  it('mirrors every freshly ingested asset unconditionally', async () => {
    // C1 (owner mirror ruling 2026-09-09): when BYOS is connected, ingest
    // always uploads and never evicts the local original. C4b deleted the
    // save-policy store, so there is no longer any input that could gate this
    // upload — the invariant is now unconditional rather than policy-independent.
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });

    expect(await action.applySavePolicyAfterIngest(digest)).toEqual({ status: 'applied' });
    expect(harness.cloud.submitted.length).toBeGreaterThan(0);
    expect((await harness.repository.findLocalAsset(digest))?.residency)
      .toBe('local-original');
    expect((await harness.repository.findLocalAsset(digest))?.localOriginalUri)
      .not.toBeNull();
  });

  it('mirrors and never evicts the local original after ingest', async () => {
    // C1 discriminating guard (owner mirror ruling 2026-09-09): the removed
    // eviction tail (deleteOriginal + setResidency('cloud-only')) would flip
    // residency and null the local uri, failing this test. C4b deleted the
    // 'cloud-only' policy that used to select that branch, so the guard now
    // asserts the post-ingest state directly: the original stays on device.
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    expect(await action.applySavePolicyAfterIngest(digest)).toEqual({ status: 'applied' });
    expect(harness.cloud.submitted.length).toBeGreaterThan(0);
    const local = await harness.repository.findLocalAsset(digest);
    expect(local?.residency).toBe('local-original');
    expect(local?.localOriginalUri).not.toBeNull();
  });

  it('queues the mirror upload and keeps the local original when offline', async () => {
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
    harness.cloud.offline = true;
    expect(await action.applySavePolicyAfterIngest(digest)).toEqual({
      status: 'queued', category: 'offline',
    });
    const local = await harness.repository.findLocalAsset(digest);
    expect(local?.residency).toBe('local-original');
    expect(local?.localOriginalUri).not.toBeNull();
  });

  it('does not re-upload or evict an asset that is collected again as a duplicate', async () => {
    // Real SP6 ingest, so Layer B writes the `collect` intent under the scope
    // the master key derives. The session must use that same scope here.
    const scope = deriveLibraryAccountScope(TEST_MASTER_KEY);
    harness.session.value = {
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      accountScope: scope,
    };

    let sequence = 500;
    const applied: Promise<LibraryActionResult>[] = [];
    const ingest = createLibraryIngestService({
      files: harness.files,
      repository: harness.repository,
      decodeGate: createFakeDecodeGate(),
      account: {
        async vaultMasterKey() { return TEST_MASTER_KEY; },
        async deviceId() { return TEST_DEVICE_ID; },
        async accountScope() { return deriveLibraryAccountScope(TEST_MASTER_KEY); },
      },
      newMutationId: () => {
        sequence += 1;
        return `00000000-0000-4000-9000-${sequence.toString().padStart(12, '0')}`;
      },
      clock: harness.clock,
      // Exactly the Task 11 Direct observer wiring.
      onIngestOutcome: (outcome) => {
        if (outcome.status !== 'ingested') return;
        applied.push(
          action.applySavePolicyAfterIngest(outcome.asset.plaintextSha256),
        );
      },
    });

    const first = await ingest.ingestBytes({
      bytes: JPEG_FIXTURE, origin: 'import',
    });
    expect(first.status).toBe('ingested');
    await Promise.all(applied);
    const fixtureDigest = sha256PlaintextHex(JPEG_FIXTURE);

    // The first (real) ingest mirrored exactly once: mirror = every collect
    // uploads, and it keeps the local original.
    expect(applied).toHaveLength(1);
    const mirroredCount = harness.cloud.submitted.length;
    expect(mirroredCount).toBeGreaterThan(0);
    expect(await harness.protection.findByDigest(scope, fixtureDigest)).not.toBeNull();

    // Collecting the same image again is a duplicate of an existing asset, not
    // a new collection, so it never mirrors or evicts a second time.
    const second = await ingest.ingestBytes({
      bytes: JPEG_FIXTURE, origin: 'import',
    });
    expect(second.status).toBe('duplicate');
    await Promise.all(applied);

    // Still exactly one mirror-triggering ingest; the duplicate uploaded nothing.
    expect(applied).toHaveLength(1);
    expect(harness.cloud.submitted.length).toBe(mirroredCount);
    const local = await harness.repository.findLocalAsset(fixtureDigest);
    expect(local?.residency).toBe('local-original');
    expect(local?.localOriginalUri).not.toBeNull();

    // Protecting an already-mirrored asset is a satisfied no-op that never
    // evicts the local original.
    expect(await action.protect(fixtureDigest)).toEqual({
      status: 'noop', reason: 'already-satisfied',
    });
    expect((await harness.repository.findLocalAsset(fixtureDigest))?.residency)
      .toBe('local-original');
  });
});
// --- K6-2: the tile's percentage ring is fed by real upload bytes -----------

describe('protect reports real transfer bytes for the tile ring', () => {
  type Sample = { sent: number; total: number } | null;

  function watch(store: ReturnType<typeof createLibraryTransferProgress>) {
    const samples: Sample[] = [];
    // This suite only ever uploads (never a P12-B download with no
    // announced length), so the store never reports `total: null` here —
    // narrow the shared type back to this suite's plain byte-count shape.
    store.subscribe(DIGEST, () => samples.push(store.get(DIGEST) as Sample));
    return samples;
  }

  /**
   * Wraps the harness cloud so every blob upload reports the byte counts a
   * native upload task would: nothing sent yet, then the whole ciphertext.
   */
  function reportingCloud(current: ActionsHarness) {
    return {
      submitMutations: current.s3.submitMutations,
      async putBlob(
        generationId: string,
        blobBytes: Uint8Array,
        onProgress?: (progress: { sent: number; total: number }) => void,
      ) {
        onProgress?.({ sent: 0, total: blobBytes.byteLength });
        await current.s3.putBlob(generationId, blobBytes);
        onProgress?.({ sent: blobBytes.byteLength, total: blobBytes.byteLength });
      },
    };
  }

  function buildWithProgress(
    current: ActionsHarness,
    store: ReturnType<typeof createLibraryTransferProgress>,
    derived: LibraryDerivedImages,
  ): LibraryProtectAction {
    return createLibraryProtectAction({
      repository: current.repository,
      protection: current.protection,
      outbox: current.outbox,
      files: current.files,
      cipher: current.cipher,
      cloud: reportingCloud(current),
      reconciliation: current.reconciliation,
      session: { async current() { return current.session.value; } },
      derived,
      readSource: current.protectDependencies.readSource,
      clock: current.clock,
      newGenerationId: current.newGenerationId,
      transferProgress: store,
    });
  }

  it('publishes 0 bytes of the original the moment the upload starts', async () => {
    const store = createLibraryTransferProgress();
    const samples = watch(store);
    const built = buildWithProgress(harness, store, derivedDouble('ok'));
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    await built.protect(DIGEST);

    const first = samples[0]!;
    expect(first).not.toBeNull();
    expect(first!.sent).toBe(0);
    // The original's ciphertext is the only work known at that instant.
    const original = harness.cloud.blobPuts[0]!.bytes.byteLength;
    expect(first!.total).toBe(original);
  });

  it('shows the ring before the upload task has reported anything', async () => {
    // A native upload task can take seconds to emit its first progress event
    // (connect + TLS, spec §4.5). Waiting for it would leave the tile blank
    // through exactly the window spec §2 G2「立刻」is about, so the run
    // publishes the original's 0/total itself the moment the PUT is launched.
    const store = createLibraryTransferProgress();
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const built = createLibraryProtectAction({
      repository: harness.repository,
      protection: harness.protection,
      outbox: harness.outbox,
      files: harness.files,
      cipher: harness.cipher,
      cloud: {
        submitMutations: harness.s3.submitMutations,
        async putBlob(generationId: string, blobBytes: Uint8Array) {
          await held;
          await harness.s3.putBlob(generationId, blobBytes);
        },
      },
      reconciliation: harness.reconciliation,
      session: { async current() { return harness.session.value; } },
      // Derivation is held too, so the only thing that can have published at
      // the observation point below is the original's own launch.
      derived: {
        async derive() {
          await held;
          return derivedDouble('ok').derive({
            sourceUri: 'file:///x', format: 'jpeg', width: 8, height: 8,
          });
        },
      },
      readSource: harness.protectDependencies.readSource,
      clock: harness.clock,
      newGenerationId: harness.newGenerationId,
      transferProgress: store,
    });
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    const run = built.protect(DIGEST);
    // The run reaches the PUT after a handful of awaits (session, file read,
    // seal). Poll until it publishes — the upload itself is still held, so any
    // value observed here was published without a single progress report.
    for (let tick = 0; tick < 500 && store.get(DIGEST) === null; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const during = store.get(DIGEST);
    expect(during).not.toBeNull();
    expect(during!.sent).toBe(0);
    expect(during!.total).toBeGreaterThan(0);

    release!();
    await run;
    expect(store.get(DIGEST)).toBeNull();
  });

  it('the ring is Σ sent ÷ Σ ciphertext of the payload the user waits for', async () => {
    // K7 ⑨ changed what that payload is. The ring used to include the
    // thumbnail and preview, because «已备份» waited for them; now the commit
    // lands on the original alone, so the ring's total is the original's
    // ciphertext and it reaches 100% exactly when the tile turns orange.
    // Nothing is estimated either way — every number here is a real report.
    const store = createLibraryTransferProgress();
    const samples = watch(store);
    const built = buildWithProgress(harness, store, derivedDouble('ok'));
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    await built.protect(DIGEST);

    const original = harness.cloud.blobPuts[0]!.bytes.byteLength;
    const peak = samples.reduce<Sample>(
      (best, sample) =>
        sample !== null && (best === null || sample.sent > best.sent) ? sample : best,
      null,
    );
    expect(peak).toEqual({ sent: original, total: original });

    // The derived roles do upload — they just never touch the ring, so a
    // report arriving after the commit can never redraw one over an asset the
    // database already calls protected.
    await waitFor(
      () => harness.cloud.blobPuts.length === 3,
      'the derived tail',
    );
    expect(store.get(DIGEST)).toBeNull();
    const after = samples.reduce<Sample>(
      (best, sample) =>
        sample !== null && (best === null || sample.total > best.total) ? sample : best,
      null,
    );
    expect(after!.total).toBe(original);
  });

  it('never publishes more sent than total — the ring can never exceed 100%', async () => {
    const store = createLibraryTransferProgress();
    const samples = watch(store);
    const built = buildWithProgress(harness, store, derivedDouble('ok'));
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    await built.protect(DIGEST);
    for (const sample of samples) {
      if (sample === null) continue;
      expect(sample.sent).toBeLessThanOrEqual(sample.total);
    }
  });

  it('clears the digest once the commit lands, so the orange cloud takes over', async () => {
    const store = createLibraryTransferProgress();
    const built = buildWithProgress(harness, store, derivedDouble('ok'));
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    const result = await built.protect(DIGEST);
    expect(result.status).toBe('applied');
    expect(store.get(DIGEST)).toBeNull();
  });

  it('clears the digest when the upload fails, so no ring is left stranded', async () => {
    const store = createLibraryTransferProgress();
    const built = buildWithProgress(harness, store, derivedDouble('ok'));
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });
    harness.cloud.failNextBlobPut = true;

    const result = await built.protect(DIGEST);
    expect(result.status).not.toBe('applied');
    expect(store.get(DIGEST)).toBeNull();
  });

  it('a derived role that never uploads still leaves a finished original at 100%', async () => {
    const store = createLibraryTransferProgress();
    const samples = watch(store);
    const built = buildWithProgress(harness, store, derivedDouble('fail'));
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    await built.protect(DIGEST);
    const peak = samples.reduce<Sample>(
      (best, sample) =>
        sample !== null && (best === null || sample.sent > best.sent) ? sample : best,
      null,
    );
    expect(peak!.sent).toBe(peak!.total);
    expect(harness.cloud.blobPuts).toHaveLength(1);
  });

  it('K6-1c dedupe still means one progress source per digest', async () => {
    const store = createLibraryTransferProgress();
    const samples = watch(store);
    const built = buildWithProgress(harness, store, derivedDouble('ok'));
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    await Promise.all([built.protect(DIGEST), built.protect(DIGEST)]);

    // Three blobs, not six: the second caller joined the first run, so the
    // totals were never counted twice.
    await waitFor(
      () => harness.cloud.blobPuts.length >= 3,
      'the derived tail',
    );
    expect(harness.cloud.blobPuts).toHaveLength(3);
    const original = harness.cloud.blobPuts[0]!.bytes.byteLength;
    const peak = samples.reduce<Sample>(
      (best, sample) =>
        sample !== null && (best === null || sample.total > best.total) ? sample : best,
      null,
    );
    // One original, counted once (K7 ⑨: derived bytes are not in the ring).
    expect(peak!.total).toBe(original);
  });
});

describe('board #27 S3: fillDerived', () => {
  const G = 'gen-original-fill';

  type DeriveInput = Parameters<LibraryDerivedImages['derive']>[0];

  /** Honours `roles`, as the real derive does; counts its calls. */
  function rolesDouble(): LibraryDerivedImages & { calls: DeriveInput[] } {
    const calls: DeriveInput[] = [];
    return {
      calls,
      async derive(input) {
        calls.push(input);
        const wants = (role: 'thumbnail' | 'preview') =>
          input.roles === undefined || input.roles.includes(role);
        return {
          thumbnail: wants('thumbnail')
            ? { role: 'thumbnail', bytes: new Uint8Array([1, 2, 3]), width: 8, height: 8, format: 'webp' }
            : null,
          preview: wants('preview')
            ? { role: 'preview', bytes: new Uint8Array([4, 5, 6, 7]), width: 16, height: 16, format: 'webp' }
            : null,
          animated: false,
          failed: false,
        };
      },
    };
  }

  /** A local original plus a protected projection and its remote record. */
  async function seedProtected(
    current: ActionsHarness,
    roles: Readonly<{ thumbnail: string | null; preview: string | null }>,
  ): Promise<void> {
    await current.seedLocalAsset({ plaintextSha256: DIGEST, bytes });
    await current.cloud.seedRemoteAsset({ plaintextSha256: DIGEST, protection: 'protected' });
    await current.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId: current.assetIdFor(DIGEST),
      plaintextSha256: DIGEST,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 3,
      originalGenerationId: G,
      originalCiphertextBytes: 128,
      thumbnailGenerationId: roles.thumbnail,
      previewGenerationId: roles.preview,
      verifiedAt: 5,
      failureCategory: null,
      trashedAt: null,
    });
  }

  const projection = () => harness.protection.findByDigest(TEST_ACCOUNT_SCOPE, DIGEST);

  it('nothing missing: complete, no request', async () => {
    const double = rolesDouble();
    await seedProtected(harness, { thumbnail: 'T0', preview: 'P0' });
    const built = build(harness, double);

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'complete' });
    expect(harness.cloud.blobPuts).toEqual([]);
    expect(harness.cloud.mutations).toEqual([]);
    expect(double.calls).toHaveLength(0);
  });

  it('fills only the missing preview', async () => {
    const double = rolesDouble();
    await seedProtected(harness, { thumbnail: 'T0', preview: null });
    const built = build(harness, double);

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'complete' });
    expect(double.calls).toHaveLength(1);
    expect(double.calls[0]).toEqual(expect.objectContaining({ roles: ['preview'] }));
    expect(harness.cloud.blobPuts).toHaveLength(1);
    const putId = harness.cloud.blobPuts[0]!.generationId;
    expect(lastProtectMutation(harness.cloud).generationsPatch).toEqual({ preview: putId });
    const record = await projection();
    expect(record?.previewGenerationId).toBe(putId);
    expect(record?.thumbnailGenerationId).toBe('T0');
    const opened = await harness.cipher.open({
      masterKey: TEST_MASTER_KEY,
      assetId: harness.assetIdFor(DIGEST),
      scope: 'preview',
      envelope: harness.cloud.blobPuts[0]!.bytes,
    });
    expect(Array.from(opened)).toEqual([4, 5, 6, 7]);
  });

  it('fills only the missing thumbnail and keeps the preview it already had', async () => {
    const double = rolesDouble();
    await seedProtected(harness, { thumbnail: null, preview: 'P0' });
    const built = build(harness, double);

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'complete' });
    expect(double.calls).toHaveLength(1);
    expect(double.calls[0]).toEqual(expect.objectContaining({ roles: ['thumbnail'] }));
    expect(harness.cloud.blobPuts).toHaveLength(1);
    const putId = harness.cloud.blobPuts[0]!.generationId;
    expect(lastProtectMutation(harness.cloud).generationsPatch).toEqual({ thumbnail: putId });
    const record = await projection();
    expect(record?.thumbnailGenerationId).toBe(putId);
    expect(record?.previewGenerationId).toBe('P0');
    const opened = await harness.cipher.open({
      masterKey: TEST_MASTER_KEY,
      assetId: harness.assetIdFor(DIGEST),
      scope: 'thumbnail',
      envelope: harness.cloud.blobPuts[0]!.bytes,
    });
    expect(Array.from(opened)).toEqual([1, 2, 3]);
  });

  it("joins the protect's own patch instead of deriving again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = rolesDouble();
    const held: LibraryDerivedImages & { calls: DeriveInput[] } = {
      calls: inner.calls,
      async derive(input) {
        await gate;
        return inner.derive(input);
      },
    };
    const built = build(harness, held);
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    expect(await built.protect(DIGEST)).toEqual({ status: 'applied' });
    const fill = built.fillDerived(DIGEST);
    let settled = false;
    void fill.then(() => { settled = true; });
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(settled).toBe(false);

    release();
    expect(await fill).toEqual({ status: 'complete' });
    expect(held.calls).toHaveLength(1);
    expect(harness.cloud.mutations).toHaveLength(2);
  });

  it('a fill started while the protect is still in flight joins it', async () => {
    const double = rolesDouble();
    const built = build(harness, double);
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });

    const protecting = built.protect(DIGEST);
    const fill = built.fillDerived(DIGEST);

    expect(await protecting).toEqual({ status: 'applied' });
    expect(await fill).toEqual({ status: 'complete' });
    expect(double.calls).toHaveLength(1); // the protect's own derive, none for the fill
  });

  it('a failed PUT keeps the original: retry', async () => {
    await seedProtected(harness, { thumbnail: null, preview: null });
    const built = build(harness, rolesDouble());
    harness.cloud.failNextBlobPut = true;

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'retry' });
    // The role that did land is patched.
    const patch = lastProtectMutation(harness.cloud).generationsPatch;
    expect(Object.keys(patch ?? {})).toHaveLength(1);
  });

  it('a patch that throws: retry', async () => {
    await seedProtected(harness, { thumbnail: null, preview: null });
    const built = build(harness, rolesDouble());
    harness.cloud.failMutationsOnce = 'offline';

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'retry' });
    expect((await projection())?.previewGenerationId).toBeNull();
  });

  it('a refused patch: unfillable', async () => {
    await seedProtected(harness, { thumbnail: null, preview: null });
    const built = build(harness, rolesDouble());
    harness.cloud.rejectNext = 'generation_conflict';

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'unfillable' });
  });

  it('no session: retry', async () => {
    const double = rolesDouble();
    await seedProtected(harness, { thumbnail: null, preview: null });
    const built = build(harness, double);
    harness.session.signOut();

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'retry' });
    expect(double.calls).toHaveLength(0);
  });

  it('no usable local original: unfillable', async () => {
    const double = rolesDouble();
    await seedProtected(harness, { thumbnail: null, preview: null });
    harness.native.exec(
      `UPDATE device_library_assets SET residency = 'cloud-only', local_original_uri = NULL`,
    );
    const built = build(harness, double);

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'unfillable' });
    expect(double.calls).toHaveLength(0);
  });

  it.each([
    ['not protected', `protection = 'unprotected'`],
    ['trashed', `lifecycle = 'trash'`],
    ['with no original generation', `original_generation_id = NULL`],
  ])('a projection %s: unfillable, nothing derived or uploaded', async (_name, change) => {
    const double = rolesDouble();
    await seedProtected(harness, { thumbnail: null, preview: null });
    harness.native.exec(`UPDATE library_asset_protection SET ${change}`);
    const built = build(harness, double);

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'unfillable' });
    expect(double.calls).toHaveLength(0);
    expect(harness.cloud.blobPuts).toEqual([]);
  });

  it.each([
    ['flagged missing', 'flagged'],
    ['whose file is gone', 'gone'],
  ] as const)('a local original %s: unfillable, nothing derived or uploaded', async (_name, mode) => {
    const double = rolesDouble();
    await seedProtected(harness, { thumbnail: null, preview: null });
    if (mode === 'flagged') {
      harness.native.exec('UPDATE device_library_assets SET missing_original_since = 1');
    } else {
      harness.port.files.delete(harness.originalUriFor(DIGEST));
    }
    const built = build(harness, double);

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'unfillable' });
    expect(double.calls).toHaveLength(0);
    expect(harness.cloud.blobPuts).toEqual([]);
  });

  it('a role the original cannot produce: unfillable', async () => {
    await seedProtected(harness, { thumbnail: null, preview: null });
    const inner = rolesDouble();
    const partial: LibraryDerivedImages = {
      async derive(input) {
        const full = await inner.derive(input);
        return { ...full, preview: null, failed: true };
      },
    };
    const built = build(harness, partial);

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'unfillable' });
    // The role it could make is still patched.
    expect(lastProtectMutation(harness.cloud).generationsPatch).toEqual({
      thumbnail: harness.cloud.blobPuts[0]!.generationId,
    });
  });

  it('never rejects: a read that throws keeps the original', async () => {
    await seedProtected(harness, { thumbnail: null, preview: null });
    const built = build(harness, rolesDouble());
    jest.spyOn(harness.protection, 'findByDigest').mockRejectedValue(new Error('read failed'));

    await expect(built.fillDerived(DIGEST)).resolves.toEqual({ status: 'retry' });
  });

  it('a derive that throws: unfillable', async () => {
    await seedProtected(harness, { thumbnail: null, preview: null });
    const built = build(harness, derivedDouble('fail'));

    expect(await built.fillDerived(DIGEST)).toEqual({ status: 'unfillable' });
    expect(harness.cloud.blobPuts).toEqual([]);
  });

  it('N6 R3: streams original seal and upload via decryptor.sealToFile + cloud.putBlobFromFile without reading the original into JS memory', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST, bytes });
    const readTempSpy = jest.spyOn(harness.files, 'readTemp');
    const sealSpy = jest.spyOn(harness.cipher, 'seal');
    const putBlobFromFileCalls: Array<{
      generationId: string;
      fileUri: string;
      contentSha256: string;
      byteLength: number;
    }> = [];
    const sealToFileCalls: string[] = [];

    const built = createLibraryProtectAction({
      repository: harness.repository,
      protection: harness.protection,
      outbox: harness.outbox,
      files: harness.files,
      cipher: harness.cipher,
      decryptor: {
        async sealToFile(input) {
          sealToFileCalls.push(input.envelopeUri);
          await harness.port.writeBytes(input.envelopeUri, Uint8Array.from([9, 9, 9]));
          return {
            plaintextBytes: bytes.byteLength,
            envelopeBytes: bytes.byteLength + 96,
            plaintextSha256: DIGEST,
            envelopeSha256: 'f'.repeat(64),
          };
        },
      },
      cloud: {
        submitMutations: harness.s3.submitMutations,
        putBlob: harness.s3.putBlob,
        async putBlobFromFile(generationId, fileUri, options) {
          putBlobFromFileCalls.push({
            generationId,
            fileUri,
            contentSha256: options.contentSha256,
            byteLength: options.byteLength,
          });
          options.onProgress?.({ sent: options.byteLength, total: options.byteLength });
          await harness.s3.putBlob(generationId, Uint8Array.from([1, 2, 3]));
        },
      },
      reconciliation: harness.reconciliation,
      session: { async current() { return harness.session.value; } },
      derived: derivedDouble('fail'),
      readSource: harness.protectDependencies.readSource,
      clock: harness.clock,
      newGenerationId: harness.newGenerationId,
    });

    const outcome = await built.protect(DIGEST);
    expect(outcome).toEqual({ status: 'applied' });
    expect(readTempSpy).not.toHaveBeenCalled();
    expect(sealSpy).not.toHaveBeenCalledWith(expect.objectContaining({ scope: 'original' }));
    expect(putBlobFromFileCalls).toHaveLength(1);
    expect(putBlobFromFileCalls[0]).toMatchObject({
      contentSha256: 'f'.repeat(64),
      byteLength: bytes.byteLength + 96,
    });
    expect(await harness.port.listStream()).toEqual([]);
  });
});
